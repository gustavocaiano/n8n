import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { test } from 'node:test';
import vm from 'node:vm';
import { createIntakeServer, parseBody } from '../adapter/server.mjs';
import { Readable } from 'node:stream';
import { payload, textFile, setup, issueId } from './helpers.mjs';

const workflow = JSON.parse(readFileSync(new URL('../../../workflows/vortex-intake.workflow.json', import.meta.url), 'utf8'));
function run(name, item, references = {}) {
  const source = workflow.nodes.find((node) => node.name === name).parameters.jsCode;
  return vm.runInNewContext(`(function(){${source}\n})()`, {
    $input: { first: () => item }, $: (ref) => ({ first: () => references[ref] }),
  });
}
function normalized(json, binary = {}) {
  return run('Normalize request', {}, { Webhook: { json, binary } })[0];
}
function classified(result, p = payload, hasAttachment = false) {
  return JSON.parse(JSON.stringify(run('Validate confirmation', { json: result }, { 'Normalize request': { json: { payload: p, hasAttachment } } })[0].json));
}
async function server(t) {
  const ctx = setup(t); const http = createIntakeServer(ctx.intake, 'test-token', { warn() {} });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise((resolve) => { http.closeAllConnections(); http.close(resolve); }));
  return { ...ctx, url: `http://127.0.0.1:${http.address().port}/intake` };
}
function stream(bytes, type) {
  const req = Readable.from([Buffer.from(bytes)]); req.headers = { 'content-type': type }; return req;
}
test('actual stored normalizer preserves opaque binary references (not base64 assumptions)', () => {
  const binary = { id: 'filesystem-v2:opaque', fileName: 'sample.txt', mimeType: 'text/plain', data: 'filesystem-v2' };
  const result = normalized({ headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: { payload: JSON.stringify(payload) } }, { attachment: binary });
  assert.equal(result.json.valid, true); assert.equal(result.binary.attachment, binary); assert.equal(result.json.payload.request_id, payload.request_id);
});
test('stored normalizer rejects extra/missing parts and preserves legacy JSON', () => {
  const input = { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: { payload: JSON.stringify(payload) } };
  assert.equal(normalized(input).json.response.code, 'invalid_parts');
  assert.equal(normalized(input, { attachment: {}, attachment1: {} }).json.response.code, 'invalid_parts');
  assert.equal(normalized({ ...input, body: { payload: '{' } }, { attachment: {} }).json.httpStatus, 400);
  const { schema_version, request_id, ...legacy } = payload;
  assert.equal(normalized({ headers: { 'content-type': 'application/json' }, body: legacy }).json.valid, true);
});
test('stored response gate rejects premature/malformed acknowledgements and wrong IDs', () => {
  const success = { schema_version: 2, request_id: payload.request_id, status: 'completed', work_item_id: issueId, attachment_id: null };
  assert.equal(classified({ statusCode: 200, body: success }).httpStatus, 200);
  for (const result of [{ statusCode: 202, body: success }, { statusCode: 200, body: { message: 'Workflow was started' } },
    { statusCode: 200, body: { ...success, request_id: 'another-id' } }, { statusCode: 200, body: { ...success, schema_version: '2' } },
    { statusCode: 200, body: { ...success, status: 'accepted' } }, { error: 'internal network details must not leak' }]) {
    const output = classified(result); assert.equal(output.httpStatus, 502); assert.equal(output.response.status, 'error');
    assert.ok(!JSON.stringify(output).includes('internal network'));
  }
  assert.equal(classified({ statusCode: 200, body: success }, payload, true).httpStatus, 502);
});
test('workflow isolates the legacy ACK from the v2 completion gate and disables blind retries', () => {
  assert.equal(workflow.nodes.find((n) => n.name === 'Webhook').parameters.responseMode, 'responseNode');
  assert.equal(workflow.nodes.filter((n) => n.type.endsWith('.respondToWebhook')).length, 2);
  assert.equal(workflow.nodes.find((n) => n.name === 'Legacy received').parameters.options.responseCode, 202);
  assert.equal(workflow.connections['Legacy client?'].main[0][0].node, 'Legacy received');
  assert.equal(workflow.connections['Legacy client?'].main[1][0].node, 'Has files?');
  for (const n of workflow.nodes.filter((n) => n.type.endsWith('.httpRequest'))) {
    assert.equal(n.retryOnFail, false);
    assert.equal(n.parameters.options.timeout, n.name.includes('logs') ? 50000 : 22000);
    assert.equal(n.parameters.options.redirect.redirect.followRedirects, false);
  }
  for (const n of workflow.nodes.filter((n) => /desativado/.test(n.name))) {
    assert.equal(n.disabled, true); assert.equal(workflow.connections[n.name], undefined);
    assert.ok(!JSON.stringify(workflow.connections).includes(n.name));
  }
  const parts = workflow.nodes.find((n) => n.name === 'Deliver with attachment').parameters.bodyParameters.parameters;
  assert.deepEqual(parts.map((p) => p.name), ['payload', 'attachment']);
  assert.equal(parts[1].parameterType, 'formBinaryData');
});
test('real loopback HTTP JSON v2 → adapter → mocked Plane returns completion', async (t) => {
  const ctx = await server(t);
  const response = await fetch(ctx.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vortex-Intake-Token': 'test-token' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).request_id, payload.request_id);
  assert.equal(ctx.plane.issues.length, 1);
});
test('real loopback multipart bytes reach mocked Plane unmodified', async (t) => {
  const ctx = await server(t); const file = textFile();
  const form = new FormData(); form.append('payload', JSON.stringify(payload)); form.append('attachment', new Blob([file.bytes], { type: file.type }), file.name);
  const response = await fetch(ctx.url, { method: 'POST', headers: { 'X-Vortex-Intake-Token': 'test-token' }, body: form });
  assert.equal(response.status, 200); assert.ok((await response.json()).attachment_id);
  assert.deepEqual(ctx.plane.calls.find((c) => c.method === 'upload').args[1].bytes, file.bytes);
});
test('authentication failure and malformed payload do not reach Plane', async (t) => {
  const ctx = await server(t);
  const denied = await fetch(ctx.url, { method: 'POST', body: '{}' }); assert.equal(denied.status, 401);
  const invalid = await fetch(ctx.url, { method: 'POST', headers: { 'X-Vortex-Intake-Token': 'test-token', 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400); assert.equal(ctx.plane.calls.length, 0);
});
test('every reproducible multipart fixture parses with exact bytes and payload', async () => {
  const base = new URL('../fixtures/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('multipart-manifest.json', base)));
  for (const fixture of manifest) {
    const parsed = await parseBody(stream(readFileSync(new URL(fixture.body, base)), fixture.content_type));
    assert.deepEqual(parsed.payload, payload); assert.deepEqual(parsed.file.bytes, readFileSync(new URL(fixture.name, base)));
    assert.equal(parsed.file.name, fixture.name); assert.equal(parsed.file.type, fixture.mime);
  }
});
test('duplicate file parts and malformed multipart are rejected', async () => {
  const form = new FormData(); form.append('payload', JSON.stringify(payload));
  form.append('attachment', new Blob(['text']), 'a.txt'); form.append('attachment', new Blob(['text']), 'b.txt');
  const req = new Request('http://localhost', { method: 'POST', body: form });
  await assert.rejects(parseBody(stream(await req.arrayBuffer(), req.headers.get('content-type'))), { code: 'invalid_parts' });
  await assert.rejects(parseBody(stream('invalid', 'multipart/form-data; boundary=bad')), { code: 'invalid_multipart' });
});
