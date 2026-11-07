import assert from 'node:assert/strict';
import { readFileSync, statSync, utimesSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import vm from 'node:vm';
import { normalize, MAX_LOGS_BYTES } from '../adapter/contract.mjs';
import { LogStore } from '../adapter/logstore.mjs';
import { PlaneError } from '../adapter/plane.mjs';
import { createIntakeServer, parseBody } from '../adapter/server.mjs';
import { payload, issueId, textFile, setup, logsFile, logsText, withLogs } from './helpers.mjs';

const ref = `VORTEX-14_${payload.request_id}.txt`;
const workflow = JSON.parse(readFileSync(new URL('../../../workflows/vortex-intake.workflow.json', import.meta.url), 'utf8'));
function run(name, item, references = {}) {
  const source = workflow.nodes.find((node) => node.name === name).parameters.jsCode;
  return vm.runInNewContext(`(function(){${source}\n})()`, { $input: { first: () => item }, $: (r) => ({ first: () => references[r] }) });
}
function stream(bytes, type) {
  const req = Readable.from([Buffer.from(bytes)]); req.headers = { 'content-type': type }; return req;
}

// ── Contract ────────────────────────────────────────────────────────────────
test('logs: valid snapshot is accepted; missing key and included:false mean no logs', () => {
  const input = normalize(withLogs(), null, logsFile());
  assert.equal(input.logs.size, Buffer.byteLength(logsText)); assert.equal(input.logs.truncated, false);
  assert.equal(normalize(payload).logs, null);
  assert.equal(normalize({ ...payload, logs: { included: false } }).logs, null);
  const exact = logsFile('# Vortex\n' + 'a'.repeat(MAX_LOGS_BYTES - 9));
  assert.equal(normalize(withLogs(exact), null, exact).logs.size, MAX_LOGS_BYTES);
  assert.equal(normalize(withLogs(), textFile(), logsFile()).attachment.name, 'sample.txt');
});
test('logs: every contract violation is rejected with a specific code', () => {
  const big = logsFile('a'.repeat(MAX_LOGS_BYTES + 1));
  const cases = [
    [{ ...payload, logs: { included: false } }, logsFile(), 'logs_mismatch'],
    [withLogs(), null, 'logs_mismatch'],
    [{ ...withLogs(), type: 'feature' }, logsFile(), 'logs_not_allowed'],
    [withLogs(), { ...logsFile(), name: 'other.txt' }, 'invalid_logs_filename'],
    [withLogs(), { ...logsFile(), type: 'application/octet-stream' }, 'unsupported_logs'],
    [withLogs(), { ...logsFile(), type: 'text/plain; charset=latin1' }, 'unsupported_logs'],
    [withLogs(logsFile(''), { bytes: 0 }), logsFile(''), 'empty_logs'],
    [withLogs(big), big, 'logs_too_large'],
    [withLogs(logsFile(), { bytes: 3 }), logsFile(), 'logs_size_mismatch'],
    [withLogs(logsFile(), { hours: 24 }), logsFile(), 'invalid_logs'],
    [withLogs(logsFile(), { truncated: 'no' }), logsFile(), 'invalid_logs'],
    [{ ...payload, logs: { included: 'yes' } }, null, 'invalid_logs'],
    [{ ...payload, logs: [] }, null, 'invalid_logs'],
  ];
  const binary = { ...logsFile(), bytes: Buffer.from([0x23, 0xff, 0xfe]) };
  cases.push([withLogs(binary), binary, 'logs_content_mismatch']);
  for (const [p, file, code] of cases) assert.throws(() => normalize(p, null, file), { code }, code);
  const ansi = logsFile('# Vortex\n\x1b[31mred\x1b[0m\n');
  assert.throws(() => normalize(withLogs(ansi), null, ansi), { code: 'logs_content_mismatch' });
  const { schema_version, request_id, ...legacy } = withLogs();
  assert.throws(() => normalize(legacy, null, logsFile()), { code: 'attachment_requires_v2' });
});
test('logs: bytes are part of the request identity, report time is not', () => {
  const a = normalize(withLogs(), null, logsFile());
  assert.equal(normalize({ ...withLogs(), reported_at: 'later' }, null, logsFile()).fingerprint, a.fingerprint);
  const other = logsFile(logsText + 'x');
  assert.notEqual(normalize(withLogs(other), null, other).fingerprint, a.fingerprint);
  assert.notEqual(normalize(payload).fingerprint, a.fingerprint);
});

// ── Delivery ────────────────────────────────────────────────────────────────
test('logs: stored privately as <ticket>_<request_id>.txt; Plane only gets a note', async (t) => {
  const ctx = setup(t);
  const result = await ctx.intake.submit(withLogs(), null, logsFile());
  assert.deepEqual(result, { status: 200, body: { schema_version: 2, request_id: payload.request_id, status: 'completed',
    work_item_id: issueId, attachment_id: null, logs_ref: ref } });
  assert.equal(readFileSync(join(ctx.logsDir, ref), 'utf8'), logsText);
  assert.equal(statSync(join(ctx.logsDir, ref)).mode & 0o777, 0o600);
  assert.equal(statSync(ctx.logsDir).mode & 0o777, 0o700);
  assert.equal(ctx.plane.count('createAttachment'), 0);
  const html = ctx.plane.issues[0].description_html;
  assert.match(html, /O utilizador enviou logs das últimas 48 horas\.<\/strong><br>\d+ bytes, truncado: não; guardados no n8n: <code>VORTEX-14_/);
  assert.ok(!html.includes('local.ERROR'), 'log content must never reach Plane');
  assert.ok(!JSON.stringify(ctx.plane.calls).includes('local.ERROR'));
  assert.ok(!JSON.stringify(ctx.ledger.get(payload.request_id)).includes('local.ERROR'), 'ledger keeps no content');
});
test('logs + attachment: attachment goes to Plane, logs stay local, both before completed', async (t) => {
  const ctx = setup(t);
  const result = await ctx.intake.submit(withLogs(), textFile(), logsFile());
  assert.ok(result.body.attachment_id); assert.equal(result.body.logs_ref, ref);
  assert.equal(ctx.plane.attachments.length, 1); assert.equal(ctx.plane.attachments[0].is_uploaded, true);
  assert.equal(ctx.plane.calls.find((c) => c.method === 'createAttachment').args[2].name, 'sample.txt');
});
test('logs: replay is idempotent and different bytes for the same UUID conflict', async (t) => {
  const ctx = setup(t);
  await ctx.intake.submit(withLogs(), null, logsFile()); ctx.restart();
  const again = await ctx.intake.submit({ ...withLogs(), reported_at: 'later' }, null, logsFile());
  assert.equal(again.body.logs_ref, ref);
  assert.equal(ctx.plane.count('createIssue'), 1); assert.equal(ctx.plane.count('updateDescription'), 1);
  assert.deepEqual(readdirSync(ctx.logsDir), [ref]);
  const other = logsFile(logsText + 'x');
  await assert.rejects(ctx.intake.submit(withLogs(other), null, other), { code: 'request_id_conflict', status: 409 });
  await assert.rejects(ctx.intake.submit(payload), { code: 'request_id_conflict' });
});
test('logs: failed note is retried without rewriting or duplicating anything', async (t) => {
  const ctx = setup(t); ctx.plane.fail('updateDescription', new PlaneError(503));
  await assert.rejects(ctx.intake.submit(withLogs(), null, logsFile()), { code: 'plane_unavailable' });
  assert.equal(ctx.ledger.get(payload.request_id).logs.stage, 'stored');
  const mtime = statSync(join(ctx.logsDir, ref)).mtimeMs; ctx.restart();
  assert.equal((await ctx.intake.submit(withLogs(), null, logsFile())).status, 200);
  assert.equal(statSync(join(ctx.logsDir, ref)).mtimeMs, mtime);
  assert.equal(ctx.plane.count('createIssue'), 1); assert.equal(ctx.plane.count('updateDescription'), 2);
});
test('logs: lost create response recovers the ticket number before naming the file', async (t) => {
  const ctx = setup(t); ctx.plane.fail('createIssue', new PlaneError(0), true);
  await assert.rejects(ctx.intake.submit(withLogs(), null, logsFile()));
  assert.deepEqual(readdirSync(ctx.logsDir), []); ctx.restart();
  assert.equal((await ctx.intake.submit(withLogs(), null, logsFile())).body.logs_ref, ref);
  assert.equal(ctx.plane.count('createIssue'), 1);
});
test('logs: unknown sequence (older ledger row) is read from Plane', async (t) => {
  const ctx = setup(t);
  const create = ctx.plane.createIssue.bind(ctx.plane);
  ctx.plane.createIssue = async (body) => ({ id: (await create(body)).id, sequenceId: null });
  assert.equal((await ctx.intake.submit(withLogs(), null, logsFile())).body.logs_ref, ref);
  assert.equal(ctx.plane.count('issueSequence'), 1);
});
test('logs: storage failure never yields completed', async (t) => {
  const ctx = setup(t);
  ctx.logStore.store = () => { throw Object.assign(new Error('disk'), { status: 503, code: 'logs_storage_unavailable' }); };
  await assert.rejects(ctx.intake.submit(withLogs(), null, logsFile()), { code: 'logs_storage_unavailable' });
  assert.equal(ctx.ledger.get(payload.request_id).stage, 'issue_created');
});

// ── LogStore ────────────────────────────────────────────────────────────────
test('LogStore never overwrites different bytes and prunes after retention', (t) => {
  const ctx = setup(t); const store = new LogStore(ctx.logsDir, 90);
  store.store(ref, Buffer.from('a')); store.store(ref, Buffer.from('a'));
  assert.throws(() => store.store(ref, Buffer.from('b')), { code: 'request_id_conflict' });
  assert.throws(() => store.store('../escape.txt', Buffer.from('a')), { code: 'invalid_logs_ref' });
  const fresh = `VORTEX-15_${payload.request_id}.txt`;
  store.store(fresh, Buffer.from('new'));
  writeFileSync(join(ctx.logsDir, 'unrelated.json'), '{}');
  const old = (Date.now() - 91 * 86_400_000) / 1000;
  utimesSync(join(ctx.logsDir, ref), old, old); utimesSync(join(ctx.logsDir, 'unrelated.json'), old, old);
  assert.equal(store.prune(), 1);
  assert.deepEqual(readdirSync(ctx.logsDir).sort(), [fresh, 'unrelated.json'].sort());
});

// ── HTTP transport ──────────────────────────────────────────────────────────
async function server(t) {
  const ctx = setup(t); const http = createIntakeServer(ctx.intake, 'test-token', { warn() {} });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise((resolve) => { http.closeAllConnections(); http.close(resolve); }));
  return { ...ctx, url: `http://127.0.0.1:${http.address().port}/intake` };
}
function form(p, parts) {
  const body = new FormData(); body.append('payload', JSON.stringify(p));
  for (const [name, file] of parts) body.append(name, new Blob([file.bytes], { type: file.type }), file.name);
  return body;
}
test('loopback multipart: logs only, and attachment + logs, complete with logs_ref', async (t) => {
  const ctx = await server(t);
  const only = await fetch(ctx.url, { method: 'POST', headers: { 'X-Vortex-Intake-Token': 'test-token' }, body: form(withLogs(), [['logs', logsFile()]]) });
  assert.equal(only.status, 200); assert.equal((await only.json()).logs_ref, ref);
  assert.equal(readFileSync(join(ctx.logsDir, ref), 'utf8'), logsText);
  const both = await fetch(ctx.url, { method: 'POST', headers: { 'X-Vortex-Intake-Token': 'test-token' },
    body: form({ ...withLogs(), request_id: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d' }, [['attachment', textFile()], ['logs', logsFile()]]) });
  const body = await both.json();
  assert.equal(both.status, 200); assert.ok(body.attachment_id); assert.match(body.logs_ref, /^VORTEX-14_0b1c2d3e/);
});
test('multipart part rules: payload alone, duplicate logs and unknown parts are rejected', async () => {
  const encode = async (body) => { const r = new Request('http://x', { method: 'POST', body }); return [await r.arrayBuffer(), r.headers.get('content-type')]; };
  const cases = [form(payload, []), form(withLogs(), [['logs', logsFile()], ['logs', logsFile()]]), form(withLogs(), [['logs', logsFile()], ['other', logsFile()]])];
  for (const body of cases) await assert.rejects(parseBody(stream(...await encode(body))), { code: 'invalid_parts' });
  const parsed = await parseBody(stream(...await encode(form(withLogs(), [['logs', logsFile()]]))));
  assert.equal(parsed.file, null); assert.equal(parsed.logs.name, 'vortex-logs-48h.txt');
  assert.match(parsed.logs.type, /^text\/plain/);
});

// ── n8n Code nodes ──────────────────────────────────────────────────────────
test('n8n normalizer routes logs and attachment binaries', () => {
  const json = { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: { payload: JSON.stringify(withLogs()) } };
  const n = (binary) => run('Normalize request', {}, { Webhook: { json, binary } })[0];
  assert.deepEqual([n({ logs: {} }).json.hasLogs, n({ logs: {} }).json.hasAttachment, n({ logs: {} }).json.hasBinary], [true, false, true]);
  const both = n({ attachment: { a: 1 }, logs: { l: 1 } });
  assert.equal(both.json.hasAttachment && both.json.hasLogs, true); assert.equal(JSON.stringify(both.binary), '{"attachment":{"a":1},"logs":{"l":1}}');
  assert.equal(n({ logs: {}, extra: {} }).json.response.code, 'invalid_parts');
  assert.equal(n({ logs0: {}, logs1: {} }).json.response.code, 'invalid_parts');
});
test('n8n response gate requires a matching logs_ref when logs were sent', () => {
  const gate = (body) => run('Validate confirmation', { json: { statusCode: 200, body } },
    { 'Normalize request': { json: { payload: withLogs(), hasAttachment: false, hasLogs: true } } })[0].json.httpStatus;
  const ok = { schema_version: 2, request_id: payload.request_id, status: 'completed', work_item_id: issueId, attachment_id: null, logs_ref: ref };
  assert.equal(gate(ok), 200);
  assert.equal(gate({ ...ok, logs_ref: null }), 502);
  assert.equal(gate({ ...ok, logs_ref: 'VORTEX-14_0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.txt' }), 502);
  assert.equal(gate({ ...ok, logs_ref: '../VORTEX-14.txt' }), 502);
});
test('workflow wires four delivery variants with proportional timeouts', () => {
  const parts = (name) => workflow.nodes.find((n) => n.name === name).parameters.bodyParameters?.parameters.map((p) => p.name);
  assert.deepEqual(parts('Deliver attachment and logs'), ['payload', 'attachment', 'logs']);
  assert.deepEqual(parts('Deliver logs'), ['payload', 'logs']);
  assert.deepEqual(parts('Deliver with attachment'), ['payload', 'attachment']);
  for (const name of ['Deliver attachment and logs', 'Deliver logs']) {
    assert.equal(workflow.nodes.find((n) => n.name === name).parameters.options.timeout, 50000);
  }
  for (const name of ['Deliver attachment and logs', 'Deliver with attachment', 'Deliver logs', 'Deliver JSON']) {
    assert.equal(workflow.connections[name].main[0][0].node, 'Validate confirmation');
  }
});
