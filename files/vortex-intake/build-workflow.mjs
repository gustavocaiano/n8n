import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const target = new URL('workflows/vortex-intake.workflow.json', root);
const code = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const current = JSON.parse(readFileSync(target, 'utf8'));
const original = (name) => current.nodes.find((node) => node.name === name);
const webhook = original('Webhook');
webhook.parameters = { httpMethod: 'POST', path: 'vortex-feedback', authentication: 'headerAuth', responseMode: 'responseNode', options: { ignoreBots: false } };
webhook.position = [0, 240];
const config = original('Config');
config.parameters = { assignments: { assignments: [
  { id: 'intake-url', name: 'intakeUrl', value: 'http://vortex-intake:8086/intake', type: 'string' },
  ...config.parameters.assignments.assignments.filter((assignment) => ['telegramChatId', 'notifyEmail'].includes(assignment.name)),
] }, includeOtherFields: true, options: {} };
config.position = [220, 240];
function node(name, type, version, parameters, x, y = 240, extra = {}) {
  return { id: `vortex-intake-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`, name,
    type: `n8n-nodes-base.${type}`, typeVersion: version, position: [x, y], parameters, ...extra };
}
function condition(name, field, x, y = 240) {
  return node(name, 'if', 2.2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
    conditions: [{ id: field, leftValue: `={{ $json.${field} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and' }, options: {} }, x, y);
}
// parts: binary fields sent as multipart files, in addition to the payload text part.
function http(name, parts, y) {
  const multipart = parts.length > 0;
  // Logs requests may take longer: Vortex waits 60s, the adapter budget is 45s.
  const timeout = parts.includes('logs') ? 50000 : 22000;
  return node(name, 'httpRequest', 4.2, {
    method: 'POST', url: "={{ $('Config').first().json.intakeUrl }}",
    // Same pattern as the Plane key: the value lives in the n8n container env, never in JSON.
    sendHeaders: true, headerParameters: { parameters: [
      { name: 'X-Vortex-Intake-Token', value: '={{ $env.VORTEX_INTAKE_TOKEN }}' },
    ] }, sendBody: true,
    ...(multipart ? { contentType: 'multipart-form-data', bodyParameters: { parameters: [
      { parameterType: 'formData', name: 'payload', value: '={{ JSON.stringify($json.payload) }}' },
      ...parts.map((part) => ({ parameterType: 'formBinaryData', name: part, inputDataFieldName: part })),
    ] } } : { contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.payload) }}' }),
    options: { timeout, redirect: { redirect: { followRedirects: false } },
      response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
  }, 1280, y, { retryOnFail: false, onError: 'continueRegularOutput' });
}
const note = original('Sticky Note - Setup');
note.parameters.content = '## Vortex feedback v2 → Plane\n\nLocal candidate — NOT PUBLISHED.\n\nSee files/vortex-intake/README.md for deployment, credentials, recovery and tests.\n\nSame public URL/token. JSON legacy + JSON v2; multipart payload + attachment and/or logs (bug only).\nV2: only HTTP 200 completed after issue + every file (attachment, logs) is confirmed. Legacy JSON retains early202 (no delivery guarantee).\n\nPrivate adapter uses a SQLite ledger and a single-instance lock; client retains bytes on failure.\nWebhook uses Vortex Shared Secret; adapter header X-Vortex-Intake-Token comes from $env.VORTEX_INTAKE_TOKEN.\nNever enable blind HTTP retries.\n\nTelegram/email remain disabled and disconnected. Rewire only after successful completion, with independent failure handling.';
note.position = [0, -220];
note.parameters.width = 720;
note.parameters.height = 380;
const disabled = ['Telegram (desativado)', 'Email (desativado)'].map((name, i) => {
  const n = original(name); n.disabled = true; n.position = [i * 280, 740]; return n;
});
const nodes = [note, webhook, config,
  node('Normalize request', 'code', 2, { mode: 'runOnceForAllItems', jsCode: code('normalize.js') }, 440),
  condition('Valid transport?', 'valid', 660), condition('Legacy client?', 'legacy', 800),
  node('Legacy received', 'respondToWebhook', 1.5, { respondWith: 'json', responseBody: '{"status":"received"}', options: { responseCode: 202 } }, 880, -40),
  condition('Has files?', 'hasBinary', 880), condition('Has attachment?', 'hasAttachment', 960, 100),
  condition('Attachment and logs?', 'hasLogs', 1040, 0),
  http('Deliver attachment and logs', ['attachment', 'logs'], -100), http('Deliver with attachment', ['attachment'], 60),
  http('Deliver logs', ['logs'], 220), http('Deliver JSON', [], 400),
  node('Validate confirmation', 'code', 2, { mode: 'runOnceForAllItems', jsCode: code('response.js') }, 1500),
  condition('V2 response?', 'v2', 1720),
  node('Respond to Vortex', 'respondToWebhook', 1.5, { respondWith: 'json', responseBody: '={{ JSON.stringify($json.response) }}',
    options: { responseCode: '={{ $json.httpStatus }}', responseHeaders: { entries: [
      { name: 'Cache-Control', value: 'no-store' }, { name: 'Retry-After', value: "={{ $json.retryAfter || '0' }}" },
    ] } } }, 1940), ...disabled];
const connections = {};
function edge(from, to, output = 0) {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
}
edge('Webhook', 'Config'); edge('Config', 'Normalize request'); edge('Normalize request', 'Valid transport?');
edge('Valid transport?', 'Legacy client?'); edge('Valid transport?', 'Respond to Vortex', 1);
edge('Legacy client?', 'Legacy received'); edge('Legacy client?', 'Has files?', 1);
edge('Legacy received', 'Has files?');
edge('Has files?', 'Has attachment?'); edge('Has files?', 'Deliver JSON', 1);
edge('Has attachment?', 'Attachment and logs?'); edge('Has attachment?', 'Deliver logs', 1);
edge('Attachment and logs?', 'Deliver attachment and logs'); edge('Attachment and logs?', 'Deliver with attachment', 1);
for (const name of ['Deliver attachment and logs', 'Deliver with attachment', 'Deliver logs', 'Deliver JSON']) edge(name, 'Validate confirmation');
edge('Validate confirmation', 'V2 response?'); edge('V2 response?', 'Respond to Vortex');
const candidate = { name: current.name, nodes, connections,
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false },
  meta: { templateCredsSetupCompleted: false } };
const output = JSON.stringify(candidate, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (output !== readFileSync(target, 'utf8')) throw new Error('Workflow differs from sources; run build-workflow.mjs');
} else writeFileSync(target, output);
