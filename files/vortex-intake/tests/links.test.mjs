import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { PlaneError } from '../adapter/plane.mjs';
import { LogStore } from '../adapter/logstore.mjs';
import { DAY_MS, newToken, tokenHash, TOKEN } from '../adapter/links.mjs';
import { createDownloadServer } from '../adapter/download.mjs';
import { configFromEnv } from '../adapter/server.mjs';
import { prepareEnvironment } from '../deploy-lxc/configure.mjs';
import { payload, setup, logsFile, logsText, withLogs, linkBase } from './helpers.mjs';

const ref = `VORTEX-14_${payload.request_id}.txt`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' };

function tokenFrom(html) {
  const match = /href="https:\/\/logs\.invalid\/vortex-logs\/#t=([A-Za-z0-9_-]{43})"/.exec(html);
  assert.ok(match, 'note must carry the one-time link');
  return match[1];
}
async function linked(t, options = {}) {
  const ctx = setup(t, 20_000, { links: true, ...options });
  const result = await ctx.intake.submit(withLogs(), null, logsFile());
  assert.equal(result.status, 200);
  return Object.assign(Object.create(ctx), { result, token: tokenFrom(ctx.plane.issues[0].description_html) });
}
async function serve(t, ctx, options = {}) {
  const events = [];
  const logger = { warn: (line) => events.push(line), info: (line) => events.push(line) };
  const server = createDownloadServer({ links: ctx.links, logStore: ctx.logStore, basePath: '/vortex-logs/', logger,
    now: () => ctx.clock.now, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/vortex-logs/`;
  const post = (path, token, headers = FORM) => fetch(base + path, { method: 'POST', headers, body: `token=${encodeURIComponent(token)}` });
  const state = async (token) => (await (await post('status', token)).json()).state;
  return Object.assign(Object.create(ctx), { base, post, state, events, server });
}

// ── Intake: link creation ───────────────────────────────────────────────────
test('links: 256-bit CSPRNG tokens, unique, base64url, only the hash is stored', () => {
  const tokens = new Set(Array.from({ length: 1000 }, newToken));
  assert.equal(tokens.size, 1000);
  for (const token of tokens) { assert.match(token, TOKEN); assert.equal(Buffer.from(token, 'base64url').length, 32); }
  assert.match(tokenHash(newToken()), /^[0-9a-f]{64}$/);
});
test('links: note carries the link in the fragment; ledger and table keep no raw token', async (t) => {
  const ctx = await linked(t);
  const html = ctx.plane.issues[0].description_html;
  assert.match(html, /O utilizador enviou logs das últimas 48 horas/, 'existing note is preserved');
  assert.match(html, /guardados no n8n: <code>VORTEX-14_/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /expira a \d{4}-\d{2}-\d{2}/);
  assert.ok(!html.includes('local.ERROR'), 'log content never reaches Plane');
  assert.ok(!JSON.stringify(ctx.result).includes(ctx.token), 'the n8n/Vortex response never carries the token');
  assert.ok(!JSON.stringify(ctx.ledger.get(payload.request_id)).includes(ctx.token), 'token dropped from the ledger once noted');
  const rows = ctx.ledger.db.prepare('SELECT * FROM log_links').all();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(ctx.token));
  assert.equal(rows[0].token_hash, tokenHash(ctx.token));
  assert.equal(rows[0].ref, ref);
  assert.equal(rows[0].expires_at - rows[0].created_at, 15 * DAY_MS);
});
test('links: failed note is retried with the SAME token and a single link row', async (t) => {
  const ctx = setup(t, 20_000, { links: true });
  ctx.plane.fail('updateDescription', new PlaneError(503));
  await assert.rejects(ctx.intake.submit(withLogs(), null, logsFile()), { code: 'plane_unavailable' });
  assert.equal(ctx.ledger.get(payload.request_id).logs.stage, 'linked');
  ctx.restart();
  assert.equal((await ctx.intake.submit(withLogs(), null, logsFile())).status, 200);
  const [first, second] = ctx.plane.calls.filter((c) => c.method === 'updateDescription').map((c) => c.args[1]);
  assert.equal(first, second, 'idempotent full-description replacement');
  assert.equal(ctx.ledger.db.prepare('SELECT count(*) AS n FROM log_links').get().n, 1);
});
test('links: lost PATCH response (written, but unconfirmed) does not mint a second link', async (t) => {
  const ctx = setup(t, 20_000, { links: true });
  ctx.plane.fail('updateDescription', new PlaneError(0), true);
  await assert.rejects(ctx.intake.submit(withLogs(), null, logsFile()));
  const token = tokenFrom(ctx.plane.issues[0].description_html);
  await ctx.intake.submit(withLogs(), null, logsFile());
  assert.equal(tokenFrom(ctx.plane.issues[0].description_html), token);
});
test('links: completed replays and concurrent retries never create or change a link', async (t) => {
  const ctx = await linked(t);
  const html = ctx.plane.issues[0].description_html;
  ctx.restart();
  const replay = await ctx.intake.submit({ ...withLogs(), reported_at: 'later' }, null, logsFile());
  assert.deepEqual(replay, ctx.result);
  assert.equal(ctx.plane.count('updateDescription'), 1);
  assert.equal(ctx.plane.issues[0].description_html, html);
  assert.equal(ctx.ledger.db.prepare('SELECT count(*) AS n FROM log_links').get().n, 1);
});
test('links: in-flight duplicate submission gets 409, then a single link', async (t) => {
  const ctx = setup(t, 20_000, { links: true });
  const [a, b] = await Promise.allSettled([ctx.intake.submit(withLogs(), null, logsFile()), ctx.intake.submit(withLogs(), null, logsFile())]);
  assert.equal(a.status, 'fulfilled'); assert.equal(b.reason.code, 'request_in_progress');
  assert.equal(ctx.ledger.db.prepare('SELECT count(*) AS n FROM log_links').get().n, 1);
});
test('links disabled: note is exactly the previous one and no row is created', async (t) => {
  const ctx = setup(t);
  await ctx.intake.submit(withLogs(), null, logsFile());
  assert.ok(!ctx.plane.issues[0].description_html.includes('href="https://logs'));
  assert.equal(ctx.ledger.db.prepare('SELECT count(*) AS n FROM log_links').get().n, 0);
});
test('links: rollback mid-flight (linked, then disabled) writes the note without the link', async (t) => {
  const ctx = setup(t, 20_000, { links: true });
  ctx.plane.fail('updateDescription', new PlaneError(503));
  await assert.rejects(ctx.intake.submit(withLogs(), null, logsFile()));
  const { Intake } = await import('../adapter/intake.mjs');
  const { config } = await import('./helpers.mjs');
  const disabled = new Intake(ctx.ledger, ctx.plane, config, 20_000, { logStore: ctx.logStore, links: ctx.links });
  assert.equal((await disabled.submit(withLogs(), null, logsFile())).status, 200);
  assert.ok(!ctx.plane.issues[0].description_html.includes('#t='));
});

// ── HTTP: scanners, previews and explicit redemption ─────────────────────────
test('download: GET/HEAD/OPTIONS and token-in-query never consume the link', async (t) => {
  const ctx = await serve(t, await linked(t));
  for (const [method, path] of [['GET', ''], ['HEAD', ''], ['GET', `?t=${ctx.token}`], ['GET', 'redeem'], ['HEAD', 'redeem'],
    ['GET', `redeem?token=${ctx.token}`], ['OPTIONS', 'redeem'], ['GET', 'status'], ['PUT', 'redeem']]) {
    const response = await fetch(ctx.base + path, { method, headers: { 'X-Forwarded-Proto': 'https' } });
    await response.arrayBuffer();
    assert.ok([200, 405].includes(response.status), `${method} ${path} → ${response.status}`);
  }
  assert.equal(await ctx.state(ctx.token), 'available');
  assert.ok(existsSync(join(ctx.logsDir, ref)));
});
test('download: page is static, uncacheable, CSP-hashed and contains no token or data', async (t) => {
  const ctx = await serve(t, await linked(t));
  const response = await fetch(ctx.base, { headers: { 'X-Forwarded-Proto': 'https' } });
  const html = await response.text();
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('cache-control'), /no-transform/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  const csp = response.headers.get('content-security-policy');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`), 'only our inline script may run');
  assert.match(csp, /default-src 'none'/); assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!html.includes(ctx.token) && !html.includes('local.ERROR') && !html.includes(ref));
  assert.match(html, /redeem/); assert.match(html, /Agentes/);
  assert.match(script, /history\.replaceState/, 'fragment is removed from the address bar');
  assert.ok(script.indexOf('replaceState') < script.indexOf('DOMContentLoaded'), 'before any later script');
});
test('download: explicit POST delivers once, with integrity headers, then deletes the file', async (t) => {
  const ctx = await serve(t, await linked(t));
  const response = await ctx.post('redeem', ctx.token);
  assert.equal(response.status, 200);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.toString(), logsText);
  assert.equal(response.headers.get('x-vortex-logs-sha256'), sha(body));
  assert.equal(Number(response.headers.get('content-length')), body.length);
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="${ref}"`);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!existsSync(join(ctx.logsDir, ref)), 'file removed after delivery');
  const replay = await ctx.post('redeem', ctx.token);
  assert.equal(replay.status, 410);
  assert.deepEqual(await replay.json(), { status: 'error', code: 'link_used' });
  assert.equal(await ctx.state(ctx.token), 'used');
});
test('download: concurrent redemptions deliver exactly once', async (t) => {
  const ctx = await serve(t, await linked(t));
  const responses = await Promise.all(Array.from({ length: 12 }, () => ctx.post('redeem', ctx.token)));
  const bodies = await Promise.all(responses.map((r) => r.text()));
  const ok = responses.filter((r) => r.status === 200);
  assert.equal(ok.length, 1);
  assert.equal(bodies.filter((b) => b === logsText).length, 1);
  for (const r of responses.filter((x) => x.status !== 200)) assert.ok([409, 410].includes(r.status));
  assert.equal(await ctx.state(ctx.token), 'used');
});
test('download: whole pasted link is accepted; unknown/malformed tokens are indistinguishable', async (t) => {
  const ctx = await serve(t, await linked(t));
  for (const bad of [newToken(), 'short', '../../etc/passwd', `${ctx.token}x`, '']) {
    assert.equal(await ctx.state(bad), 'not_found');
    const r = await ctx.post('redeem', bad);
    assert.equal(r.status, 404); assert.deepEqual(await r.json(), { status: 'error', code: 'link_not_found' });
  }
  assert.equal(await ctx.state(`${linkBase}#t=${ctx.token}`), 'available');
  assert.equal((await ctx.post('redeem', `${linkBase}#t=${ctx.token}`)).status, 200);
});
test('download: expiry after 15 days returns 410 link_expired and removes the file', async (t) => {
  const ctx = await serve(t, await linked(t));
  ctx.clock.now += 15 * DAY_MS - 1;
  assert.equal(await ctx.state(ctx.token), 'available');
  ctx.clock.now += 1;
  assert.equal(await ctx.state(ctx.token), 'expired');
  const r = await ctx.post('redeem', ctx.token);
  assert.equal(r.status, 410); assert.deepEqual(await r.json(), { status: 'error', code: 'link_expired' });
  assert.ok(!existsSync(join(ctx.logsDir, ref)));
  assert.equal((await ctx.post('redeem', ctx.token)).status, 410);
});
test('download: tampered or missing file is never served', async (t) => {
  const ctx = await serve(t, await linked(t));
  writeFileSync(join(ctx.logsDir, ref), 'tampered');
  const r = await ctx.post('redeem', ctx.token);
  assert.equal(r.status, 410); assert.deepEqual(await r.json(), { status: 'error', code: 'link_unavailable' });
  assert.equal(await ctx.state(ctx.token), 'unavailable');
});
test('download: interrupted transfer (client gone before the last byte) re-arms the link', async (t) => {
  const ctx = setup(t, 20_000, { links: true });
  // Larger than any socket buffer so the server cannot finish without the client.
  const big = Buffer.alloc(48 * 1024 * 1024, 'L');
  const name = `VORTEX-99_${payload.request_id}.txt`;
  ctx.logStore.store(name, big);
  const token = newToken();
  ctx.links.transaction(() => ctx.links.insert(token, { ref: name, bytes: big.length, sha256: sha(big) }, ctx.clock.now, 15 * DAY_MS));
  const srv = await serve(t, ctx);
  const port = srv.server.address().port;
  const body = `token=${token}`;
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`POST /vortex-logs/redeem HTTP/1.1\r\nHost: x\r\nX-Forwarded-Proto: https\r\n` +
    `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  await once(socket, 'data');
  socket.pause();
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.destroy();
  for (let i = 0; i < 50 && (await srv.state(token)) !== 'available'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await srv.state(token), 'available');
  assert.ok(existsSync(join(ctx.logsDir, name)));
  assert.ok(srv.events.some((e) => e.includes('vortex_logs_link_interrupted')));
  const full = await srv.post('redeem', token);
  assert.equal(full.status, 200);
  assert.equal(sha(Buffer.from(await full.arrayBuffer())), sha(big));
  for (let i = 0; i < 50 && (await srv.state(token)) !== 'used'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await srv.state(token), 'used');
});
test('download: crash during delivery is recovered as available on restart', async (t) => {
  const ctx = await linked(t);
  const hash = tokenHash(ctx.token);
  assert.equal(ctx.links.claim(hash, ctx.clock.now).outcome, 'claimed');
  assert.equal(ctx.links.claim(hash, ctx.clock.now).outcome, 'in_use');
  ctx.restart();
  assert.equal(ctx.links.recoverInterrupted(ctx.clock.now), 1);
  assert.equal(ctx.links.status(hash, ctx.clock.now).state, 'available');
});
test('download: refuses non-HTTPS forwarding, unexpected peers, wrong content type and large bodies', async (t) => {
  const ctx = await serve(t, await linked(t));
  const plain = await ctx.post('redeem', ctx.token, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(plain.status, 421);
  assert.equal((await ctx.post('redeem', ctx.token, { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' })).status, 415);
  const huge = await fetch(`${ctx.base}redeem`, { method: 'POST', headers: FORM, body: `token=${'a'.repeat(4096)}` });
  assert.equal(huge.status, 413);
  for (const path of ['../../../etc/passwd', '%2e%2e/%2e%2e/etc/passwd', `logs/${ref}`, ref]) {
    assert.equal((await fetch(ctx.base + path, { headers: { 'X-Forwarded-Proto': 'https' } })).status, 404);
  }
  assert.equal(await ctx.state(ctx.token), 'available');
  const locked = await serve(t, ctx, { allowedPeers: ['10.9.9.9'] });
  await assert.rejects(locked.post('status', ctx.token));
  assert.equal(await ctx.state(ctx.token), 'available');
});
test('download: no token is ever written to logs', async (t) => {
  const ctx = await serve(t, await linked(t));
  await ctx.post('status', ctx.token); await ctx.post('redeem', ctx.token); await ctx.post('redeem', ctx.token);
  await ctx.post('redeem', newToken());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ctx.events.length > 0);
  assert.ok(!ctx.events.join('\n').includes(ctx.token));
  assert.ok(!ctx.events.join('\n').includes('local.ERROR'));
});

// ── Retention ───────────────────────────────────────────────────────────────
test('retention: linked files follow the link; existing unlinked files keep the 90-day policy', async (t) => {
  const ctx = await linked(t);
  const legacy = `VORTEX-7_${'0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'}.txt`;
  ctx.logStore.store(legacy, Buffer.from('legacy'));
  const store = new LogStore(ctx.logsDir, 90);
  const age = (days) => { const s = (ctx.clock.now - days * DAY_MS) / 1000; utimesSync(join(ctx.logsDir, legacy), s, s); };
  const prune = (now) => { ctx.links.prune(store, now); store.prune(now, ctx.links.refs()); };
  age(20); prune(ctx.clock.now);
  assert.ok(existsSync(join(ctx.logsDir, legacy)), 'pre-link file older than 15 days is NOT deleted');
  assert.ok(existsSync(join(ctx.logsDir, ref)));
  prune(ctx.clock.now + 15 * DAY_MS);
  assert.ok(!existsSync(join(ctx.logsDir, ref)), 'unused link expired after 15 days');
  assert.equal(ctx.links.status(tokenHash(ctx.token), ctx.clock.now).state, 'expired');
  age(91); prune(ctx.clock.now);
  assert.deepEqual(readdirSync(ctx.logsDir), []);
});
test('retention: optional delivered grace keeps a used file for operator recovery only', async (t) => {
  const ctx = await serve(t, await linked(t), { graceMs: 3_600_000 });
  assert.equal((await ctx.post('redeem', ctx.token)).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(existsSync(join(ctx.logsDir, ref)));
  assert.equal((await ctx.post('redeem', ctx.token)).status, 410, 'never re-served over HTTP');
  ctx.links.prune(ctx.logStore, ctx.clock.now + 3_599_000, 3_600_000);
  assert.ok(existsSync(join(ctx.logsDir, ref)));
  ctx.links.prune(ctx.logStore, ctx.clock.now + 3_600_000, 3_600_000);
  assert.ok(!existsSync(join(ctx.logsDir, ref)));
});

// ── Configuration ───────────────────────────────────────────────────────────
test('config: links are disabled by default and the base/listener are validated', () => {
  const prepared = prepareEnvironment({ VORTEX_INTAKE_PLANE_API_KEY: 'plane-existing-key' });
  const env = { ...prepared.adapter, ...prepared.shared };
  const base = configFromEnv(env);
  assert.equal(base.logsLinkBase, ''); assert.equal(base.logsLinkTtlDays, 15);
  assert.equal(base.logsRetentionDays, 90); assert.equal(base.downloadListenHost, '127.0.0.1');
  const on = configFromEnv({ ...env, VORTEX_INTAKE_LOGS_LINK_BASE: 'https://logs.example.com/vortex-logs/' });
  assert.equal(on.downloadBasePath, '/vortex-logs/');
  for (const [key, value] of [
    ['VORTEX_INTAKE_LOGS_LINK_BASE', 'http://logs.example.com/'],
    ['VORTEX_INTAKE_LOGS_LINK_BASE', 'https://logs.example.com/x?y=1'],
    ['VORTEX_INTAKE_LOGS_LINK_BASE', 'https://logs.example.com/vortex-logs'],
    ['VORTEX_INTAKE_LOGS_LINK_BASE', 'https://user:pw@logs.example.com/'],
    ['VORTEX_INTAKE_LOGS_LINK_TTL_DAYS', '16'],
    ['VORTEX_INTAKE_LOGS_LINK_TTL_DAYS', '0'],
    ['VORTEX_INTAKE_LOGS_DELIVERED_GRACE_HOURS', '-1'],
    ['VORTEX_INTAKE_DOWNLOAD_LISTEN_HOST', '10.0.0.5'],
    ['VORTEX_INTAKE_DOWNLOAD_LISTEN_HOST', 'example.com'],
    ['VORTEX_INTAKE_DOWNLOAD_PORT', '8086'],
    ['VORTEX_INTAKE_DOWNLOAD_ALLOWED_PEERS', 'not-an-ip'],
  ]) assert.throws(() => configFromEnv({ ...env, [key]: value }), undefined, `${key}=${value}`);
  const lan = configFromEnv({ ...env, VORTEX_INTAKE_DOWNLOAD_LISTEN_HOST: '10.0.0.5', VORTEX_INTAKE_DOWNLOAD_ALLOWED_PEERS: '10.0.0.2' });
  assert.deepEqual(lan.downloadAllowedPeers, ['10.0.0.2']);
  const kept = prepareEnvironment({ VORTEX_INTAKE_PLANE_API_KEY: 'k' },
    { ...prepared.adapter, VORTEX_INTAKE_LOGS_LINK_BASE: 'https://logs.example.com/' }, prepared.shared);
  assert.equal(kept.adapter.VORTEX_INTAKE_LOGS_LINK_BASE, 'https://logs.example.com/', 'reinstall keeps the operator choice');
});
test('download: storage/database errors answer 503 without crashing or consuming', async (t) => {
  const ctx = await serve(t, await linked(t));
  const claim = ctx.links.claim;
  ctx.links.claim = () => { throw new Error('database is locked'); };
  const r = await ctx.post('redeem', ctx.token);
  assert.equal(r.status, 503);
  ctx.links.claim = claim;
  const read = ctx.logStore.read;
  ctx.logStore.read = () => { throw new Error('EIO'); };
  assert.equal((await ctx.post('redeem', ctx.token)).status, 503);
  ctx.logStore.read = read;
  assert.equal(await ctx.state(ctx.token), 'available');
  assert.equal((await ctx.post('redeem', ctx.token)).status, 200);
});
test('page script: strips the fragment, checks status without consuming, redeems only on click and verifies sha256', async (t) => {
  const ctx = await serve(t, await linked(t));
  const html = await (await fetch(ctx.base, { headers: { 'X-Forwarded-Proto': 'https' } })).text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const elements = { state: { textContent: '' }, go: { disabled: true, listeners: {}, addEventListener(e, f) { this.listeners[e] = f; } } };
  const clicks = [];
  let ready;
  const replaced = [];
  const sandbox = {
    location: { hash: `#t=${ctx.token}`, pathname: '/vortex-logs/', search: '' },
    history: { replaceState: (_s, _t, url) => replaced.push(url) },
    document: {
      addEventListener: (_e, f) => { ready = f; },
      getElementById: (id) => elements[id],
      createElement: () => ({ click() { clicks.push(this.download); } }),
      body: { appendChild() {} },
    },
    fetch: (path, init) => fetch(ctx.base + path, { ...init, headers: { 'X-Forwarded-Proto': 'https' } }),
    URLSearchParams, Blob, crypto: globalThis.crypto, URL: { createObjectURL: () => 'blob:x' }, Uint8Array, Array, Error,
  };
  const { runInNewContext } = await import('node:vm');
  runInNewContext(script, sandbox);
  assert.deepEqual(replaced, ['/vortex-logs/'], 'token removed from the address bar immediately');
  ready();
  const wait = async (predicate) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10)); };
  await wait(() => !elements.go.disabled);
  assert.match(elements.state.textContent, /^Disponível/);
  assert.equal(await ctx.state(ctx.token), 'available', 'opening the page does not consume');
  elements.go.listeners.click();
  await wait(() => clicks.length > 0);
  assert.deepEqual(clicks, [ref]);
  assert.match(elements.state.textContent, /Entregue e verificado/);
  assert.equal(await ctx.state(ctx.token), 'used');
});
