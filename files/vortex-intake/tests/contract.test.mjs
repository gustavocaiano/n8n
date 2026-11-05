import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize, validateFile, MAX_FILE_BYTES, planeIssue } from '../adapter/contract.mjs';
import { config, payload, fixture, textFile } from './helpers.mjs';

for (const [name, mime] of [['sample.png', 'image/png'], ['sample.jpg', 'image/jpeg'], ['sample.pdf', 'application/pdf'], ['sample.txt', 'text/plain']]) {
  test(`accepts real ${name} bytes with coherent extension and MIME`, () => {
    const input = normalize(payload, fixture(name, mime));
    assert.equal(input.attachment.type, mime);
    assert.equal(input.attachment.size, fixture(name, mime).bytes.length);
  });
}
test('legacy and v2 support trim, Unicode limits, username and version', () => {
  const input = normalize({ ...payload, title: ' 😀 ', description: ' x ' });
  assert.equal(input.data.title, '😀'); assert.equal(input.data.description, 'x');
  assert.equal(normalize({ ...payload, title: '😀'.repeat(160) }).data.title.length, 320);
  assert.throws(() => normalize({ ...payload, title: '😀'.repeat(161) }), { code: 'invalid_title' });
  const issue = planeIssue(input, config);
  assert.match(issue.description_html, /teste/); assert.match(issue.description_html, /3\.1\.0/);
  const { schema_version, request_id, ...legacy } = payload;
  assert.equal(normalize(legacy).v2, false);
  assert.throws(() => normalize(legacy, textFile()), { code: 'attachment_requires_v2' });
});
test('stable request identity ignores reported_at and transport metadata', () => {
  const a = normalize(payload, textFile());
  const b = normalize({ ...payload, reported_at: '2026-11-06', version: '3.1.1', title: '  '+payload.title+'  ' }, textFile());
  assert.equal(a.fingerprint, b.fingerprint);
  for (const variant of [{ ...textFile(), name: 'renamed.txt' }, { ...textFile(), bytes: Buffer.from('changed') }]) {
    assert.notEqual(normalize(payload, variant).fingerprint, a.fingerprint);
  }
});
for (const change of [{ schema_version: '2' }, { request_id: 'bad' }, { schema_version: 3 }, { title: '  ' }, { description: '' }, { description: 'x'.repeat(4001) }, { type: 'other' }, { instance: [] }, { user: 42 }, { website: 'bot' }]) {
  test(`rejects invalid payload ${Object.keys(change)[0]} ${String(Object.values(change)[0]).slice(0, 15)}`, () => {
    assert.throws(() => normalize({ ...payload, ...change }), { status: 422 });
  });
}
for (const name of ['../sample.txt', 'a\\b.txt', 'a\u0000.txt', 'a\n.txt', 'a\u202e.txt', 'é'.repeat(126)+'.txt']) {
  test(`rejects unsafe filename ${JSON.stringify(name).slice(0,40)}`, () => assert.throws(() => validateFile({ ...textFile(), name }), { code: 'invalid_filename' }));
}
test('checks real bytes, not client metadata, with inclusive 5 MiB limit', () => {
  const file = { ...textFile(), bytes: Buffer.alloc(MAX_FILE_BYTES, 65), size: 1 };
  assert.equal(validateFile(file).size, MAX_FILE_BYTES);
  assert.throws(() => validateFile({ ...file, bytes: Buffer.alloc(MAX_FILE_BYTES + 1) }), { status: 413 });
  assert.throws(() => validateFile({ ...file, bytes: Buffer.alloc(0) }), { status: 422 });
  assert.throws(() => validateFile({ ...file, bytes: Buffer.from([0xff,0xfe]) }), { status: 415 });
  assert.throws(() => validateFile({ ...textFile(), type: 'image/png', name: 'fake.png' }), { status: 415 });
  assert.throws(() => validateFile({ ...fixture('sample.png', 'image/png'), name: 'wrong.jpg' }), { status: 415 });
  assert.throws(() => validateFile({ ...textFile(), name: 'x.exe' }), { status: 415 });
});
test('escapes all reporter metadata and unsafe URLs in Plane HTML', () => {
  const input = normalize({ ...payload, description: '<script>alert(1)</script>', user: { name: '<x>', username: '"test"' }, instance: { name: '<n>', url: 'javascript:alert(1)' } });
  const issue = planeIssue(input, config);
  assert.ok(!issue.description_html.includes('<script>')); assert.ok(!issue.description_html.includes('<a href='));
  assert.match(issue.description_html, /&lt;x&gt;/);
});
