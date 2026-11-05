// Consume bytes exported by Vortex's REAL FeedbackService; never open a socket.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import { parseBody } from './adapter/server.mjs';
import { normalize } from './adapter/contract.mjs';

if (!process.argv[2]) throw new Error('Usage: node verify-vortex-fixtures.mjs /path/to/feedback-contract');
const directory = resolve(process.argv[2]);
for (const name of ['json', 'png', 'txt']) {
  const meta = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
  const request = Readable.from([readFileSync(join(directory, `${name}.body`))]);
  request.headers = { 'content-type': meta.content_type };
  const { payload, file } = await parseBody(request);
  const input = normalize(payload, file);
  assert.equal(input.v2, true);
  assert.equal(input.requestId, payload.request_id);
  assert.equal(Boolean(input.attachment), name !== 'json');
  if (file) assert.deepEqual(input.attachment.bytes, file.bytes);
  console.log(`${name}: parsed, validated and preserved exact request_id / attachment bytes`);
}
