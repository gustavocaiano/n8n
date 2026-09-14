#!/usr/bin/env node
/**
 * Vortex Announcements — publisher sidecar.
 *
 * Single-purpose HTTP service (internal docker network only, no published
 * ports) that owns the feed volume for the "Vortex announcement publishing
 * automation" spec (docs/plans/vortex-announcements.md).
 *
 * Contract (called by the n8n workflow "Vortex Announcements Publisher"):
 *   POST /publish
 *     headers: X-Publisher-Token: $VORTEX_SIDECAR_TOKEN   (constant-time check)
 *              X-Idempotency-Key: <uuid>
 *     body:    the CANONICAL JSON serialization of the feed file, exactly as
 *              it must appear on disk — either
 *              {"notification":null}  (clear)  or
 *              {"notification":{"id":...,"title":...,"body":...[,"starts_at":...],"expires_at":...}}  (publish)
 *
 * Guarantees implemented here (spec section 3/4):
 *   - single writer: all mutations serialized through a mkdir-based lock
 *     (crash-safe: stale locks older than 60s are broken)
 *   - atomicity: tmp file + fsync + rename + directory fsync, then read-back
 *     verification (sha256) before acknowledging
 *   - idempotency: state.json journals every operation; replays of a
 *     completed Idempotency-Key return the recorded response (journal
 *     resolution happens BEFORE expiry validation, so a replay after the
 *     notification expired still gets its recorded 200); a different
 *     payload for the same key is rejected with 409 idempotency_conflict
 *   - crash recovery: a journaled-but-unfinalized op (pending) is re-run when
 *     the same key arrives; a DIFFERENT key arriving while a pending op exists
 *     marks the old op "superseded" (its outcome is unknowable once we
 *     overwrite the feed) and later retries of that key get 409 superseded
 *   - single process: the mkdir lock is not ownership-safe across processes,
 *     but exactly one node process ever exists (the entrypoint execs it as
 *     PID 1) and the in-process queue serializes requests, so lock
 *     contention only occurs across a crash-restart boundary — covered by
 *     the stale-lock break
 *   - the journal is append-only and unbounded: evicting old entries would
 *     let a retry of a long-gone key resurrect as a NEW op and clobber a
 *     newer publication. Entries are ~200 bytes on a dedicated volume.
 *
 * Responses (JSON, passed through to the publisher client by n8n):
 *   200 {"status":"published"|"cleared","notification_id":...}
 *   401 {"status":"error","code":"unauthorized"}
 *   413 {"status":"error","code":"payload_too_large"}  (transport cap only)
 *   422 {"status":"error","code":"invalid_json"|"invalid_idempotency_key"|
 *        "invalid_payload"|"non_canonical_payload"|"invalid_date_range"|
 *        "already_expired"|"payload_too_large"}
 *   409 {"status":"error","code":"idempotency_conflict"|"superseded"}
 *   503 {"status":"error","code":"publish_busy"}
 *   500 {"status":"error","code":"publish_failed"|"server_misconfigured"}
 *
 * Privacy: request bodies are never logged; only status, key prefix and mode.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8085);
const TOKEN = process.env.VORTEX_SIDECAR_TOKEN || '';
const DATA_DIR = process.env.VORTEX_DATA_DIR || '/data';
const PUBLIC_DIR = path.join(DATA_DIR, 'public');
const WORK_DIR = path.join(DATA_DIR, 'work');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const FEED_FILE = path.join(PUBLIC_DIR, 'latest.json');
const LOCK_DIR = path.join(WORK_DIR, '.publish.lock');

const MAX_BODY_BYTES = 64 * 1024; // transport cap; the feed itself is capped at 32 KiB below
const MAX_FEED_BYTES = 32768;     // hard cap enforced by the Vortex consumer (32 KiB)
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 60_000;
const SWEEP_MS = 60 * 60 * 1000;
const QUEUE_LIMIT = 100; // requests waiting for the publish slot before 503

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;
// Strict timestamp parser: rejects impossible calendar dates (2099-02-31,
// Feb 29 in non-leap years), hours > 23, minutes/seconds > 59, years
// 0000-0099 (JS Date collapses them into 19xx), and offsets beyond ±23:59.
// Date.parse accepts several of those.
const parseTs = (s) => {
  const m = typeof s === 'string' ? TS_RE.exec(s) : null;
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), se = Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return null;
  const cal = new Date(Date.UTC(y, mo - 1, d));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return null;
  let ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const off = m[7];
  if (off !== 'Z') {
    const oh = Number(off.slice(1, 3)), om = Number(off.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    ms += (off[0] === '-' ? 1 : -1) * (oh * 60 + om) * 60000;
  }
  return ms;
};
const ID_RE = /^[a-zA-Z0-9_-]+$/;

class HttpError extends Error {
  constructor(statusCode, body) {
    super((body && body.code) || 'error');
    this.statusCode = statusCode;
    this.body = body;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ─── bootstrap ─────────────────────────────────────────────────────────── */

function bootstrap() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  // The container starts as root (stock node image): fix volume ownership on
  // first boot, then drop privileges before opening the socket.
  if (process.getuid && process.getuid() === 0) {
    for (const dir of [DATA_DIR, PUBLIC_DIR, WORK_DIR]) {
      try { fs.chownSync(dir, 1000, 1000); } catch { /* already owned */ }
    }
    for (const file of [STATE_FILE, FEED_FILE]) {
      try { fs.chownSync(file, 1000, 1000); } catch { /* does not exist yet */ }
    }
    process.setuid(1000);
  }
  // Seed the feed so the static server never 404s before the first publish.
  if (!fs.existsSync(FEED_FILE)) {
    writeFileAtomic(FEED_FILE, JSON.stringify({ notification: null }));
  }
  // Validate/migrate state.
  const state = readState();
  writeStateAtomic(state);
  console.log(`vortex-publisher: listening on :${PORT}, data dir ${DATA_DIR}`);
}

/* ─── durable file primitives ───────────────────────────────────────────── */

const FSYNC_DIR_BENIGN = new Set(['EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);
function fsyncDir(dir) {
  // Directory fsync is unsupported or forbidden on some filesystems (some
  // overlay/NFS configurations): those failures are benign. REAL I/O errors
  // (EIO etc.) must fail the write — swallowing them would acknowledge
  // publishes whose rename may not be durable.
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
  } catch (err) {
    if (!FSYNC_DIR_BENIGN.has(err.code)) throw err;
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    if (!FSYNC_DIR_BENIGN.has(err.code)) throw err;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function writeFileAtomic(filePath, content) {
  const tmp = path.join(WORK_DIR, `tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  fsyncDir(path.dirname(filePath));
}

function readState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { version: 1, seq: 0, current: null, recent: [], superseded: [], pending: null };
    }
    throw err;
  }
  // A state file that exists but cannot be parsed is an integrity problem:
  // silently resetting it would lose idempotency history (duplicate
  // publishes / lost 409-conflict protection). Fail closed instead — the
  // container crash-loops visibly while the feed itself keeps serving.
  const state = JSON.parse(raw);
  // Full schema validation: a partially-shaped state file (e.g. missing
  // `superseded`, or a malformed entry) must fail closed here rather than
  // crash on the first publish — or worse, silently lose journal history.
  const isStr = (v) => typeof v === 'string';
  const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  const isMode = (v) => v === 'publish' || v === 'clear';
  const validResponse = (v) => v && typeof v === 'object'
    && (v.status === 'published' || v.status === 'cleared')
    && (v.notification_id === null || isStr(v.notification_id));
  const validRecent = (e) => e && typeof e === 'object' && isStr(e.key) && isMode(e.mode)
    && (e.notificationId === null || isStr(e.notificationId)) && isSha(e.fileSha256)
    && validResponse(e.response) && isStr(e.at);
  const validSuperseded = (e) => e && typeof e === 'object' && isStr(e.key)
    && isSha(e.fileSha256) && isStr(e.at);
  const validPending = (e) => e === null || (e && typeof e === 'object' && isStr(e.key)
    && isMode(e.mode) && (e.notificationId === null || isStr(e.notificationId))
    && isSha(e.fileSha256) && isStr(e.at));
  const validCurrent = (e) => e === null || (e && typeof e === 'object' && Number.isInteger(e.seq)
    && isMode(e.mode) && (e.notificationId === null || isStr(e.notificationId))
    && isSha(e.fileSha256) && isStr(e.at));
  const valid = state && typeof state === 'object' && !Array.isArray(state)
    && state.version === 1 && Number.isInteger(state.seq) && state.seq >= 0
    && validCurrent(state.current)
    && Array.isArray(state.recent) && state.recent.every(validRecent)
    && Array.isArray(state.superseded) && state.superseded.every(validSuperseded)
    && validPending(state.pending);
  if (!valid) {
    throw new Error(`unrecognized state.json (version ${state && state.version})`);
  }
  return state;
}

function writeStateAtomic(state) {
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/* ─── lock (single writer, crash-safe) ──────────────────────────────────── */

class LockTimeout extends Error {}

async function acquireLock(deadline) {
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(LOCK_DIR);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          console.warn('vortex-publisher: broke stale publish lock');
          continue;
        }
      } catch {
        /* lock vanished between mkdir and stat — retry */
      }
      if (Date.now() > deadline) throw new LockTimeout();
      await sleep(100);
    }
  }
}

function releaseLock() {
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ─── payload validation (defense in depth; n8n validates first) ────────── */

function validatePayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(422, { status: 'error', code: 'invalid_payload', message: 'body must be a JSON object' });
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'notification') {
    throw new HttpError(422, { status: 'error', code: 'invalid_payload', message: 'body must contain exactly one top-level key: notification' });
  }
  const n = parsed.notification;
  if (n === null) {
    return { mode: 'clear', fileString: JSON.stringify({ notification: null }), notificationId: null };
  }
  if (typeof n !== 'object' || Array.isArray(n)) {
    throw new HttpError(422, { status: 'error', code: 'invalid_payload', message: 'notification must be an object or null' });
  }
  for (const k of Object.keys(n)) {
    if (!['id', 'title', 'body', 'starts_at', 'expires_at'].includes(k)) {
      throw new HttpError(422, { status: 'error', code: 'invalid_payload', message: `unknown field: ${k}` });
    }
  }
  if (typeof n.id !== 'string' || !ID_RE.test(n.id) || n.id.length > 100) {
    throw new HttpError(422, { status: 'error', code: 'invalid_payload', message: 'id must match ^[a-zA-Z0-9_-]+$ (max 100 chars)' });
  }
  if (typeof n.title !== 'string' || !/\S/.test(n.title) || n.title.length > 160) {
    throw new HttpError(422, { status: 'error', code: 'invalid_payload', message: 'title is required (1-160 chars, not blank)' });
  }
  if (typeof n.body !== 'string' || !/\S/.test(n.body) || n.body.length > 4000) {
    throw new HttpError(422, { status: 'error', code: 'invalid_payload', message: 'body is required (1-4000 chars, not blank)' });
  }
  const hasStartsAt = n.starts_at !== undefined && n.starts_at !== null;
  const startsMs = hasStartsAt ? parseTs(n.starts_at) : null;
  if (hasStartsAt && startsMs === null) {
    throw new HttpError(422, { status: 'error', code: 'invalid_payload', message: 'starts_at must be a valid calendar date: YYYY-MM-DDTHH:MM:SS(Z|±HH:MM)' });
  }
  const expiresMs = parseTs(n.expires_at);
  if (expiresMs === null) {
    throw new HttpError(422, { status: 'error', code: 'invalid_payload', message: 'expires_at is required: valid calendar date YYYY-MM-DDTHH:MM:SS(Z|±HH:MM)' });
  }
  if (hasStartsAt && expiresMs <= startsMs) {
    throw new HttpError(422, { status: 'error', code: 'invalid_date_range', message: 'expires_at must be after starts_at' });
  }
  // NOTE: already_expired is deliberately NOT enforced here. Journal
  // resolution happens first (see performPublish step 3b), and expiry
  // applies only to genuinely-new operations — a replay of a recorded key
  // must return its recorded 200 even after the notification has expired.
  const file = { id: n.id, title: n.title, body: n.body };
  if (hasStartsAt) file.starts_at = n.starts_at;
  file.expires_at = n.expires_at;
  // Canonical form of the whole feed file — this is what the HTTP body must
  // equal byte-for-byte (the caller re-checks against the raw bytes).
  const fileString = JSON.stringify({ notification: file });
  const bytes = Buffer.byteLength(fileString, 'utf8');
  if (bytes > MAX_FEED_BYTES) {
    throw new HttpError(422, { status: 'error', code: 'payload_too_large', message: `serialized feed file is ${bytes} bytes (max ${MAX_FEED_BYTES})` });
  }
  return { mode: 'publish', fileString, notificationId: n.id, expiresMs };
}

/* ─── the publish state machine ─────────────────────────────────────────── */

function sweepWork() {
  try {
    const cutoff = Date.now() - SWEEP_MS;
    for (const name of fs.readdirSync(WORK_DIR)) {
      if (name === '.publish.lock' || !name.startsWith('tmp-')) continue;
      const full = path.join(WORK_DIR, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch { /* raced away */ }
    }
  } catch { /* work dir unreadable — nothing sensible to do */ }
}

async function performPublish(op, deadline) {
  await acquireLock(deadline);
  try {
    const state = readState();

    // 1. Completed operation? Replay or conflict.
    const recent = state.recent.find((e) => e.key === op.key);
    if (recent) {
      if (recent.fileSha256 === op.hash) {
        console.log(`replay key=${op.key.slice(0, 8)}… mode=${op.mode}`);
        return { statusCode: 200, body: recent.response };
      }
      throw new HttpError(409, { status: 'error', code: 'idempotency_conflict', message: 'Idempotency-Key was already used with different content' });
    }

    // 2. Burned key? An interrupted op that a later publish displaced.
    if (state.superseded.some((e) => e.key === op.key)) {
      throw new HttpError(409, { status: 'error', code: 'superseded', message: 'This Idempotency-Key refers to an interrupted operation that has been superseded; use a new key' });
    }

    // 3. Crash recovery / displacement.
    if (state.pending) {
      if (state.pending.key === op.key) {
        if (state.pending.fileSha256 !== op.hash) {
          throw new HttpError(409, { status: 'error', code: 'idempotency_conflict', message: 'Idempotency-Key was already used with different content' });
        }
        console.warn(`recovering interrupted publish key=${op.key.slice(0, 8)}…`);
      } else {
        state.superseded.unshift({ key: state.pending.key, fileSha256: state.pending.fileSha256, at: new Date().toISOString() });
      }
    }

    // 3b. Expiry is enforced ONLY for genuinely-new operations. A replay of
    // a recorded key already returned in step 1; a crash-recovery re-run of
    // a pending key (resuming) must complete so the client finally gets a
    // definitive recorded response instead of a zombie pending op.
    const resuming = state.pending && state.pending.key === op.key && state.pending.fileSha256 === op.hash;
    if (!resuming && op.mode === 'publish' && op.expiresMs !== null && op.expiresMs <= Date.now()) {
      throw new HttpError(422, { status: 'error', code: 'already_expired', message: 'expires_at must be in the future' });
    }

    // 4. Journal intent (visible after a crash → recovery path above).
    state.pending = {
      key: op.key,
      mode: op.mode,
      notificationId: op.notificationId,
      fileSha256: op.hash,
      at: new Date().toISOString(),
    };
    writeStateAtomic(state);

    // 5. Atomic replace + read-back verification.
    writeFileAtomic(FEED_FILE, op.fileString);
    const readBack = fs.readFileSync(FEED_FILE, 'utf8');
    if (sha256(readBack) !== op.hash) {
      throw new Error('read-back verification failed');
    }

    // 6. Finalize.
    state.seq += 1;
    const response = op.mode === 'clear'
      ? { status: 'cleared', notification_id: null }
      : { status: 'published', notification_id: op.notificationId };
    state.current = {
      seq: state.seq,
      mode: op.mode,
      notificationId: op.notificationId,
      fileSha256: op.hash,
      at: new Date().toISOString(),
    };
    state.recent.unshift({
      key: op.key,
      mode: op.mode,
      notificationId: op.notificationId,
      fileSha256: op.hash,
      response,
      at: new Date().toISOString(),
    });
    // The journal is append-only and unbounded (see header): eviction would
    // let a retry of an old key resurrect as a new op and clobber a newer
    // publication. ~200 bytes/entry on a dedicated volume.
    state.pending = null;
    writeStateAtomic(state);

    sweepWork();
    console.log(`published seq=${state.seq} key=${op.key.slice(0, 8)}… mode=${op.mode}`);
    return { statusCode: 200, body: response };
  } finally {
    releaseLock();
  }
}

/* ─── HTTP layer ────────────────────────────────────────────────────────── */

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // burn comparable time before failing
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) {
        // Stop buffering but do NOT destroy the socket: the 413 response
        // must still be deliverable to the client.
        reject(new HttpError(413, { status: 'error', code: 'payload_too_large', message: `body exceeds ${cap} bytes` }));
        req.removeAllListeners('data');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function send(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

// Serialize every publish through one in-process queue; the on-disk lock then
// only has to guard against cross-restart concurrency (e.g. crash mid-publish).
// Bounded and deadline-aware: a request that waits too long for the publish
// slot fails fast with 503 publish_busy instead of silently blowing through
// the caller's HTTP timeout (n8n's HTTP node allows 20s). The deadline
// covers queue wait + lock wait together, so total time stays well under it.
let queue = Promise.resolve();
let queueDepth = 0;
function enqueue(job) {
  if (queueDepth >= QUEUE_LIMIT) {
    throw new HttpError(503, { status: 'error', code: 'publish_busy', message: 'publish queue is full; retry shortly' });
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const start = () => {
    if (Date.now() > deadline) {
      throw new HttpError(503, { status: 'error', code: 'publish_busy', message: 'request waited too long for the publish slot; retry shortly' });
    }
    return job(deadline);
  };
  const run = queue.then(start, start);
  queueDepth += 1;
  queue = run.then(() => { queueDepth -= 1; }, () => { queueDepth -= 1; });
  return run;
}

async function handle(req, res) {
  const pathname = (req.url || '').split('?')[0];
  if (req.method === 'GET' && pathname === '/healthz') {
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST' || pathname !== '/publish') {
    return send(res, 404, { status: 'error', code: 'not_found' });
  }
  if (!TOKEN) {
    return send(res, 500, { status: 'error', code: 'server_misconfigured', message: 'VORTEX_SIDECAR_TOKEN is not set' });
  }
  const auth = req.headers['x-publisher-token'] || '';
  if (!timingSafeEqualStr(auth, TOKEN)) {
    return send(res, 401, { status: 'error', code: 'unauthorized' });
  }
  const key = String(req.headers['x-idempotency-key'] || '');
  if (!UUID_RE.test(key)) {
    return send(res, 422, { status: 'error', code: 'invalid_idempotency_key', message: 'X-Idempotency-Key must be a UUID' });
  }
  const rawBuf = await readBody(req, MAX_BODY_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(rawBuf.toString('utf8'));
  } catch {
    return send(res, 422, { status: 'error', code: 'invalid_json', message: 'body is not valid JSON' });
  }
  const op = validatePayload(parsed);
  // Byte-level canonicality: comparing the RAW request bytes against the
  // canonical serialization (not the decoded string) also rejects payloads
  // with malformed UTF-8 — decoding replaces bad bytes with U+FFFD, which
  // would pass a string comparison while meaning different bytes on disk.
  if (!rawBuf.equals(Buffer.from(op.fileString, 'utf8'))) {
    return send(res, 422, { status: 'error', code: 'non_canonical_payload', message: 'body must be the canonical JSON serialization of the feed file' });
  }
  const result = await enqueue((deadline) => performPublish({ ...op, key, hash: sha256(op.fileString) }, deadline));
  return send(res, result.statusCode, result.body);
}

bootstrap();
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof HttpError) {
      send(res, err.statusCode, err.body);
    } else if (err instanceof LockTimeout) {
      send(res, 503, { status: 'error', code: 'publish_busy', message: 'another publish holds the lock; retry shortly' });
    } else if (res.headersSent) {
      res.destroy();
    } else {
      console.error('vortex-publisher: internal error', err);
      send(res, 500, { status: 'error', code: 'publish_failed', message: String((err && err.message) || err) });
    }
  });
});
server.listen(PORT);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
