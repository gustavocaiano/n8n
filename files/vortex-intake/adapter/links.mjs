import { createHash, randomBytes } from 'node:crypto';
import { IntakeError } from './contract.mjs';

// One-time HTTPS links to a single private logs snapshot.
//
// The raw token (32 CSPRNG bytes, base64url) exists only in the Plane note and,
// briefly, in the ledger row of an intake that has not yet written that note.
// This table stores its SHA-256, the exact file it unlocks and the expiry: the
// HTTP side never derives a path from client input or from the ticket number.
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_TTL_DAYS = 15;
export const DAY_MS = 86_400_000;
const ROW_RETENTION_MS = 90 * DAY_MS;
const STATES = ['active', 'delivering', 'used', 'expired', 'unavailable'];

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// The link puts the token in the fragment: user agents never send it to the
// server, proxies or analytics, and never include it in a Referer header.
export function linkUrl(base, token) {
  if (!TOKEN.test(token)) throw new IntakeError(500, 'invalid_link_token');
  return `${base}#t=${token}`;
}

export class LinkStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS log_links (
      token_hash TEXT PRIMARY KEY,
      ref TEXT NOT NULL UNIQUE,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN (${STATES.map((s) => `'${s}'`).join(',')})),
      updated_at INTEGER NOT NULL)`);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Called inside the caller's transaction (with the ledger state update).
  insert(token, { ref, bytes, sha256 }, now, ttlMs) {
    const existing = this.byRef(ref);
    if (existing) throw new IntakeError(503, 'logs_link_conflict');
    this.db.prepare('INSERT INTO log_links VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(tokenHash(token), ref, bytes, sha256, now, now + ttlMs, 'active', now);
    return now + ttlMs;
  }

  get(hash) {
    return this.db.prepare('SELECT * FROM log_links WHERE token_hash = ?').get(hash) ?? null;
  }

  byRef(ref) {
    return this.db.prepare('SELECT * FROM log_links WHERE ref = ?').get(ref) ?? null;
  }

  refs() {
    return new Set(this.db.prepare('SELECT ref FROM log_links').all().map((row) => row.ref));
  }

  setState(hash, from, to, now) {
    const marks = from.map(() => '?').join(',');
    return this.db.prepare(`UPDATE log_links SET state = ?, updated_at = ? WHERE token_hash = ? AND state IN (${marks})`)
      .run(to, now, hash, ...from).changes === 1;
  }

  // Non-consuming view, for the page and for agents.
  status(hash, now) {
    const row = this.get(hash);
    if (!row) return { state: 'not_found' };
    if (row.state === 'active' && row.expires_at <= now) return { state: 'expired' };
    return { state: row.state === 'delivering' ? 'in_use' : row.state === 'active' ? 'available' : row.state,
      ...(row.state === 'active' ? { bytes: row.bytes, expires_at: new Date(row.expires_at).toISOString() } : {}) };
  }

  // Atomic compare-and-set: exactly one concurrent caller wins the delivery.
  claim(hash, now) {
    return this.transaction(() => {
      const row = this.get(hash);
      if (!row) return { outcome: 'not_found' };
      if (row.state === 'active' && row.expires_at <= now) {
        this.setState(hash, ['active'], 'expired', now);
        return { outcome: 'expired', row };
      }
      if (row.state === 'delivering') return { outcome: 'in_use' };
      if (row.state !== 'active') return { outcome: row.state };
      this.setState(hash, ['active'], 'delivering', now);
      return { outcome: 'claimed', row };
    });
  }

  // A delivery that never reached the end goes back to active (no data was
  // confirmed handed over); one that did becomes used and is never re-served.
  release(hash, now) { return this.setState(hash, ['delivering'], 'active', now); }
  finish(hash, now) { return this.setState(hash, ['delivering'], 'used', now); }
  unavailable(hash, now) { return this.setState(hash, ['delivering', 'active'], 'unavailable', now); }

  // After a crash no response can still be in flight. Re-arm instead of losing
  // the file; the next delivery is still single-use.
  recoverInterrupted(now) {
    return this.db.prepare("UPDATE log_links SET state = 'active', updated_at = ? WHERE state = 'delivering'").run(now).changes;
  }

  // Expires links, deletes their files when no longer deliverable and returns the
  // set of linked refs, which the legacy mtime retention must not touch.
  prune(logStore, now, graceMs = 0) {
    let removed = 0;
    this.db.prepare("UPDATE log_links SET state = 'expired', updated_at = ? WHERE state = 'active' AND expires_at <= ?").run(now, now);
    for (const row of this.db.prepare("SELECT ref, state, updated_at FROM log_links WHERE state IN ('used', 'expired', 'unavailable')").all()) {
      if (row.state === 'used' && now - row.updated_at < graceMs) continue;
      if (logStore.remove(row.ref)) removed++;
    }
    this.db.prepare("DELETE FROM log_links WHERE state IN ('used', 'expired', 'unavailable') AND updated_at < ?").run(now - ROW_RETENTION_MS);
    return removed;
  }
}
