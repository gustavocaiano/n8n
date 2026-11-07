// Consume bytes exported by Vortex's REAL FeedbackService; never open a socket.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import { parseBody } from './adapter/server.mjs';
import { normalize } from './adapter/contract.mjs';

if (!process.argv[2]) throw new Error('Usage: node verify-vortex-fixtures.mjs /path/to/feedback-contract');
const directory = resolve(process.argv[2]);
for (const name of ['json', 'png', 'txt', 'logs', 'png-logs']) {
  const meta = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
  const request = Readable.from([readFileSync(join(directory, `${name}.body`))]);
  request.headers = { 'content-type': meta.content_type };
  const { payload, file, logs } = await parseBody(request);
  const input = normalize(payload, file, logs);
  assert.equal(input.v2, true);
  assert.equal(input.requestId, payload.request_id);
  assert.equal(Boolean(input.attachment), ['png', 'txt', 'png-logs'].includes(name));
  assert.equal(Boolean(input.logs), ['logs', 'png-logs'].includes(name));
  if (file) assert.deepEqual(input.attachment.bytes, file.bytes);
  for (const [part, expected] of [[input.attachment, meta.attachment_sha256], [input.logs, meta.logs_sha256]]) {
    assert.equal(part ? createHash('sha256').update(part.bytes).digest('hex') : null, expected);
  }
  if (logs) {
    assert.deepEqual(input.logs.bytes, logs.bytes);
    assert.equal(payload.logs.bytes, logs.bytes.length);
    assert.equal(payload.logs.hours, 48);
    assert.equal(typeof payload.logs.truncated, 'boolean');
  }
  console.log(`${name}: validated request_id, metadata and exact attachment/logs hashes`);
}
