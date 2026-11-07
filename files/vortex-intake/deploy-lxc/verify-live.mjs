// Explicit live smoke test: creates FOUR synthetic Plane work items on first run.
// Run in the LXC as root after installation. IDs persist for retries / public replay.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { configFromEnv } from '../adapter/server.mjs';
import { PlaneClient } from '../adapter/plane.mjs';

const [mode, url, credentialPath] = process.argv.slice(2);
const internal = url === 'http://127.0.0.1:8086/intake';
if (mode !== '--execute' || !url || (!internal && (!credentialPath || new URL(url).protocol !== 'https:'))) {
  throw new Error('Usage: verify-live.mjs --execute http://127.0.0.1:8086/intake OR https://host/webhook/vortex-feedback /private/credential-export.json');
}
process.umask(0o077);
const directory = '/var/lib/vortex-intake/verification';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const env = { ...parseEnv(readFileSync('/etc/vortex-intake/adapter.env', 'utf8')),
  ...parseEnv(readFileSync('/etc/vortex-intake/token.env', 'utf8')) };
const config = configFromEnv(env);
const plane = new PlaneClient(config);
let auth = { name: 'X-Vortex-Intake-Token', value: config.token };
if (credentialPath) {
  const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
  auth = credentials.find((c) => c.type === 'httpHeaderAuth').data;
  assert.equal(auth.name.toLowerCase(), 'x-vortex-feedback-token');
}
const cases = [
  { name: 'json', attachment: false, logs: false },
  { name: 'attachment', attachment: true, logs: false },
  { name: 'logs', attachment: false, logs: true },
  { name: 'attachment-logs-max', attachment: true, logs: true },
];
const identityPath = `${directory}/requests.json`;
const identities = existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, 'utf8')) :
  Object.fromEntries(cases.map(({ name }) => [name, randomUUID()]));
writeFileSync(identityPath, JSON.stringify(identities), { mode: 0o600 });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const results = [];
for (const item of cases) {
  const max = item.name.endsWith('-max');
  const attachment = item.attachment ? Buffer.alloc(max ? 5 * 1024 * 1024 : 128, 'A') : null;
  const logs = item.logs ? Buffer.alloc(max ? 2 * 1024 * 1024 : 256, 'L') : null;
  const payload = { schema_version: 2, request_id: identities[item.name], type: 'bug',
    title: `[Verificação técnica] Feedback v2: ${item.name}`,
    description: 'Pedido sintético de validação do rollout n8n/LXC; não corresponde a um erro de utilizador.',
    version: 'rollout-verification', instance: { name: 'Vortex intake rollout 2026-11-07', url: 'https://verification.invalid' },
    user: { name: 'Verificação técnica', username: 'intake-verification' }, reported_at: '2026-11-07T12:00:00Z', website: '',
    logs: logs ? { included: true, hours: 48, bytes: logs.length, truncated: max } : { included: false } };
  let body = JSON.stringify(payload);
  const headers = { [auth.name]: auth.value };
  if (attachment || logs) {
    body = new FormData();
    body.append('payload', JSON.stringify(payload));
    if (attachment) body.append('attachment', new Blob([attachment], { type: 'text/plain' }), 'verification.txt');
    if (logs) body.append('logs', new Blob([logs], { type: 'text/plain; charset=utf-8' }), 'vortex-logs-48h.txt');
  } else headers['Content-Type'] = 'application/json';
  const start = performance.now();
  const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(logs ? 60_000 : 30_000) });
  let result;
  try { result = await response.json(); } catch { result = { code: 'non_json_response' }; }
  // Never print upstream raw errors, signed URLs or credentials.
  console.log(JSON.stringify({ case: item.name, http: response.status, code: result.code ?? null, elapsedMs: Math.round(performance.now() - start) }));
  assert.equal(response.status, 200);
  assert.equal(result.schema_version, 2);
  assert.equal(result.request_id, payload.request_id);
  assert.equal(result.status, 'completed');
  const issue = await plane.issueDetails(result.work_item_id, AbortSignal.timeout(10_000));
  const recovered = await plane.findIssue(`vortex-${payload.request_id}`, AbortSignal.timeout(10_000));
  assert.equal(recovered?.id, result.work_item_id, 'Recovery must find the existing work item');
  const assets = await plane.list(`${result.work_item_id}/attachments/`, {}, AbortSignal.timeout(10_000));
  assert.equal(assets.length, attachment ? 1 : 0, 'Only the user attachment belongs in Plane');
  if (attachment) {
    const asset = await plane.attachment(result.work_item_id, result.attachment_id, AbortSignal.timeout(10_000));
    assert.equal(asset.is_uploaded, true);
    const recoveredAsset = await plane.findAttachment(result.work_item_id, `vortex-${payload.request_id}-file-0`, AbortSignal.timeout(10_000));
    assert.equal(recoveredAsset?.id, result.attachment_id, 'Recovery must find the existing attachment');
  }
  if (logs) {
    assert.match(result.logs_ref, /^VORTEX-\d+_[a-f0-9-]+\.txt$/);
    assert.equal(hash(readFileSync(`${config.directory}/logs/${result.logs_ref}`)), hash(logs));
    assert.ok(issue.description_html.includes(result.logs_ref));
    assert.ok(!issue.description_html.includes('LLLLLLLL'), 'Log content must stay out of Plane');
  }
  const previousPath = `${directory}/${item.name}.json`;
  if (existsSync(previousPath)) assert.deepEqual(result, JSON.parse(readFileSync(previousPath, 'utf8')), 'Replay must preserve every ID');
  writeFileSync(previousPath, JSON.stringify(result), { mode: 0o600 });
  results.push({ case: item.name, workItem: `VORTEX-${issue.sequence_id}`, ...result });
}
console.log(JSON.stringify({ verified: results }, null, 2));
