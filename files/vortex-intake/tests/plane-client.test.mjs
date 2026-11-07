import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlaneClient } from '../adapter/plane.mjs';
import { normalize } from '../adapter/contract.mjs';
import { config, payload, issueId, textFile } from './helpers.mjs';

const aid = '37b14dc6-ef98-4dfc-a337-000000000001';
const signal = () => AbortSignal.timeout(1000);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
test('Plane v2 upload envelope, storage form and confirm endpoints use actual wire contract', async () => {
  const calls = [];
  const client = new PlaneClient(config, async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://storage.invalid/upload') return new Response(null, { status: 204 });
    if (options.method === 'PATCH') return json({ id: aid, is_uploaded: true });
    if (options.method === 'GET') return json({ id: aid, is_uploaded: true });
    return json({ asset_id: aid, attachment: { id: aid, is_uploaded: false }, asset_url: '/api/assets/example/',
      upload_data: { url: 'https://storage.invalid/upload', fields: { key: 'uploads/sample.txt', policy: 'fake-policy', 'Content-Type': 'text/plain' } } });
  });
  const file = normalize(payload, textFile()).attachment;
  const created = await client.createAttachment(issueId, 'external-file-id', file, signal());
  assert.equal(created.id, aid); await client.upload(created.upload, file, signal());
  await client.confirm(issueId, aid, signal());
  assert.match(calls[0].url, new RegExp(`/work-items/${issueId}/attachments/$`));
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: file.name, size: file.size, type: 'text/plain', external_id: 'external-file-id', external_source: 'vortex-intake' });
  assert.equal(calls[0].options.headers['X-Api-Key'], config.apiKey);
  assert.equal(calls[1].options.headers, undefined, 'Plane credentials must never reach storage');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.body.get('policy'), 'fake-policy');
  assert.deepEqual(Buffer.from(await calls[1].options.body.get('file').arrayBuffer()), file.bytes);
  assert.deepEqual(JSON.parse(calls[2].options.body), { is_uploaded: true });
  assert.equal(calls[3].options.method, 'GET', 'confirm must verify actual uploaded state');
});
test('reconciliation reads all v2 offset pages and filters by exact correlation pair', async () => {
  const urls = [];
  const client = new PlaneClient(config, async (url) => {
    urls.push(new URL(url));
    return urls.length === 1 ? json({ data: [{ id: aid, external_id: 'other', external_source: 'other' }], next: 200 }) :
      json({ data: [{ id: issueId, external_id: 'wanted', external_source: 'vortex-intake' }], next: null });
  });
  assert.equal((await client.findIssue('wanted', signal())).id, issueId);
  assert.equal(urls[0].searchParams.get('external_source'), 'vortex-intake');
  assert.equal(urls[0].searchParams.get('archived'), 'true'); assert.equal(urls[1].searchParams.get('offset'), '200');
});
test('ambiguous matches or incomplete pages cannot trigger another create', async () => {
  const row = { id: issueId, external_id: 'wanted', external_source: 'vortex-intake' };
  const duplicate = new PlaneClient(config, async () => json({ data: [row, row], next: null }));
  await assert.rejects(duplicate.findIssue('wanted', signal()), { code: 'reconciliation_required' });
  const unknown = new PlaneClient(config, async () => json({ data: [], has_more: true, next_cursor: 'opaque' }));
  await assert.rejects(unknown.findIssue('wanted', signal()), { code: 'invalid_plane_pagination' });
});
test('unknown storage origins, userinfo, invalid fields and redirect outcomes fail closed', async () => {
  let calls = 0;
  const client = new PlaneClient(config, async () => { calls++; return new Response(null, { status: 307 }); });
  const file = normalize(payload, textFile()).attachment;
  for (const upload of [{ url: 'https://attacker.invalid', fields: { key: 'x' } },
    { url: 'https://user:password@storage.invalid', fields: { key: 'x' } },
    { url: 'https://storage.invalid', fields: { file: 'override' } }]) {
    await assert.rejects(client.upload(upload, file, signal()));
  }
  assert.equal(calls, 0);
  await assert.rejects(client.upload({ url: 'https://storage.invalid', fields: { key: 'x' } }, file, signal()), { code: 'storage_unavailable' });
});
test('confirm failure cannot count as completed and storage403 is retriable with new credentials', async () => {
  const client = new PlaneClient(config, async (url, options) => {
    if (url.startsWith('https://storage.invalid')) return new Response(null, { status: 403 });
    return json({ id: aid, is_uploaded: false });
  });
  await assert.rejects(client.confirm(issueId, aid, signal()), { code: 'attachment_not_confirmed' });
  await assert.rejects(client.upload({ url: 'https://storage.invalid', fields: { key: 'x' } }, normalize(payload, textFile()).attachment, signal()), { code: 'upload_credentials_expired' });
});
test('non-JSON 2xx and network failure during creation keep an unknown commit outcome', async () => {
  for (const fn of [async () => new Response('not-json'), async () => { throw new Error('secret URL'); }]) {
    const client = new PlaneClient(config, fn);
    await assert.rejects(client.createIssue({}, signal()), (e) => e.code === 'plane_unavailable' && e.definitelyRejected === false && !e.message.includes('secret'));
  }
});
test('older Plane v2 uses the exact v1 correlation lookup when sparse fields are unsupported', async () => {
  const urls = [];
  const client = new PlaneClient(config, async (url) => {
    urls.push(new URL(url));
    if (url.includes('/v2/')) return json({ error: 'unsupported sparse fields' }, 400);
    return json({ id: issueId, external_id: 'wanted', external_source: 'vortex-intake', sequence_id: 18 });
  });
  assert.equal((await client.findIssue('wanted', signal())).id, issueId);
  assert.match(urls[1].pathname, /\/api\/v1\/.*\/issues\/$/);
  assert.equal(urls[1].searchParams.get('external_id'), 'wanted');
  assert.equal(urls[1].searchParams.get('archived'), 'true');
});
test('legacy reconciliation fails closed for malformed responses and never hides auth failures', async () => {
  for (const item of [{ results: [] }, { id: issueId }, []]) {
    const client = new PlaneClient(config, async (url) => url.includes('/v2/') ? json({}, 400) : json(item));
    await assert.rejects(client.findIssue('wanted', signal()), { code: 'invalid_plane_response' });
  }
  const missing = new PlaneClient(config, async (url) => json({}, url.includes('/v2/') ? 400 : 404));
  assert.equal(await missing.findIssue('wanted', signal()), null);
  const wrong = new PlaneClient(config, async (url) => url.includes('/v2/') ? json({}, 400) : json({ id: issueId, external_id: 'another', external_source: 'vortex-intake' }));
  assert.equal(await wrong.findIssue('wanted', signal()), null);
  let calls = 0;
  const denied = new PlaneClient(config, async () => { calls++; return json({}, 403); });
  await assert.rejects(denied.findIssue('wanted', signal()), { upstreamStatus: 403 });
  assert.equal(calls, 1);
});
test('description verification reads v1 only when v2 omits the description', async () => {
  const client = new PlaneClient(config, async (url) => json({ id: issueId, ...(url.includes('/v1/') ? { description_html: '<p>Logs reference</p>' } : {}) }));
  assert.equal((await client.issueDetails(issueId, signal())).description_html, '<p>Logs reference</p>');
  const malformed = new PlaneClient(config, async () => json({ id: aid, description_html: 'wrong issue' }));
  await assert.rejects(malformed.issueDetails(issueId, signal()), { code: 'invalid_plane_response' });
});
