// Live check of the one-time logs links WITHOUT Plane and WITHOUT real logs.
// Creates one synthetic file (VORTEX-0_<uuid>.txt) plus its link row directly in
// the adapter database, then exercises the public URL exactly like a browser or
// agent would. Prints only HTTP statuses/codes: never the token or the content.
//
// Installed next to the adapter; run as the service user so file ownership matches:
//   runuser -u vortex-intake -- node /opt/vortex-intake/verify-links.mjs --execute https://<host>/vortex-logs/
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';

const lib = existsSync(new URL('./links.mjs', import.meta.url)) ? './' : '../adapter/';
const { LinkStore, newToken, DAY_MS } = await import(`${lib}links.mjs`);
const { LogStore } = await import(`${lib}logstore.mjs`);
if (process.getuid?.() === 0) throw new Error('Run as the vortex-intake user (runuser -u vortex-intake --), not root');

const [mode, base, dataDir = '/var/lib/vortex-intake'] = process.argv.slice(2);
if (mode !== '--execute' || !base) throw new Error('Usage: verify-links.mjs --execute https://<host>/<path>/ [data-dir]');
const url = new URL(base);
if (url.protocol !== 'https:' || !url.pathname.endsWith('/') || url.search || url.hash) throw new Error('Expected the HTTPS link base');
try {
  const env = parseEnv(readFileSync('/etc/vortex-intake/adapter.env', 'utf8'));
  if (env.VORTEX_INTAKE_LOGS_LINK_BASE !== base) throw new Error('Base differs from VORTEX_INTAKE_LOGS_LINK_BASE');
} catch (error) { if (error.code !== 'EACCES' && error.code !== 'ENOENT') throw error; }
process.umask(0o077);

const bytes = Buffer.from(`# Vortex verificação sintética de links (${new Date().toISOString()})\nsem dados reais\n`);
const sha = createHash('sha256').update(bytes).digest('hex');
const ref = `VORTEX-0_${randomUUID()}.txt`;
const store = new LogStore(join(dataDir, 'logs'));
const db = new DatabaseSync(join(dataDir, 'intake.sqlite'));
db.exec('PRAGMA busy_timeout=5000');
const links = new LinkStore(db);
const token = newToken();
store.store(ref, bytes);
links.transaction(() => links.insert(token, { ref, bytes: bytes.length, sha256: sha }, Date.now(), DAY_MS));
const form = { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${token}` };
const step = (name, response, code = null) => console.log(JSON.stringify({ step: name, http: response.status, code }));
try {
  for (const method of ['GET', 'HEAD']) {
    const page = await fetch(base, { method, redirect: 'error' });
    await page.arrayBuffer();
    step(`${method} page`, page);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.ok(!page.headers.get('cf-cache-status') || /DYNAMIC|BYPASS/.test(page.headers.get('cf-cache-status')), 'must not be cached');
  }
  const getRedeem = await fetch(`${base}redeem`, { redirect: 'error' });
  step('GET redeem', getRedeem); assert.equal(getRedeem.status, 405);
  const status = await fetch(`${base}status`, form);
  const state = await status.json();
  step('POST status', status, state.state); assert.equal(state.state, 'available');
  const redeem = await fetch(`${base}redeem`, form);
  const body = Buffer.from(await redeem.arrayBuffer());
  step('POST redeem', redeem); assert.equal(redeem.status, 200);
  assert.equal(createHash('sha256').update(body).digest('hex'), sha, 'delivered bytes match');
  assert.equal(redeem.headers.get('x-vortex-logs-sha256'), sha);
  assert.match(redeem.headers.get('cache-control') ?? '', /no-store/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const replay = await fetch(`${base}redeem`, form);
  const replayBody = await replay.json();
  step('POST redeem again', replay, replayBody.code); assert.equal(replayBody.code, 'link_used');
  console.log(JSON.stringify({ verified: true, synthetic_file_removed: !existsSync(join(dataDir, 'logs', ref)) }));
} finally {
  // Never leave the synthetic link usable.
  db.prepare("UPDATE log_links SET state = 'expired', updated_at = ? WHERE ref = ? AND state = 'active'").run(Date.now(), ref);
  store.remove(ref);
  db.close();
}
