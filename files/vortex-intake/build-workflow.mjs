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
function condition(name, field, x) {
  return node(name, 'if', 2.2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
    conditions: [{ id: field, leftValue: `={{ $json.${field} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and' }, options: {} }, x);
}
function http(name, multipart, y) {
  return node(name, 'httpRequest', 4.2, {
    method: 'POST', url: "={{ $('Config').first().json.intakeUrl }}",
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true,
    ...(multipart ? { contentType: 'multipart-form-data', bodyParameters: { parameters: [
      { parameterType: 'formData', name: 'payload', value: '={{ JSON.stringify($json.payload) }}' },
      { parameterType: 'formBinaryData', name: 'attachment', inputDataFieldName: 'attachment' },
    ] } } : { contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.payload) }}' }),
    options: { timeout: 22000, redirect: { redirect: { followRedirects: false } },
      response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
  }, 1100, y, { retryOnFail: false, onError: 'continueRegularOutput',
    credentials: { httpHeaderAuth: { id: 'REPLACE_ME_INTAKE', name: 'Vortex Intake Internal' } } });
}
const note = original('Sticky Note - Setup');
note.parameters.content = '## Vortex feedback v2 → Plane\n\nLocal candidate — NOT PUBLISHED.\n\nSee files/vortex-intake/README.md for deployment, credentials, recovery and tests.\n\nSame public URL/token. JSON legacy + JSON v2; multipart payload + attachment.\nV2: only HTTP 200 completed after issue/attachment confirmation. Legacy JSON retains early202 (no delivery guarantee).\n\nPrivate adapter uses a SQLite ledger and a single-instance lock; client retains bytes on failure.\nConfigure Vortex Shared Secret and Vortex Intake Internal (X-Vortex-Intake-Token).\nNever enable blind HTTP retries.\n\nTelegram/email remain disabled and disconnected. Rewire only after successful completion, with independent failure handling.';
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
  condition('Has attachment?', 'hasAttachment', 880),
  http('Deliver with attachment', true, 140), http('Deliver JSON', false, 400),
  node('Validate confirmation', 'code', 2, { mode: 'runOnceForAllItems', jsCode: code('response.js') }, 1320),
  condition('V2 response?', 'v2', 1420),
  node('Respond to Vortex', 'respondToWebhook', 1.5, { respondWith: 'json', responseBody: '={{ JSON.stringify($json.response) }}',
    options: { responseCode: '={{ $json.httpStatus }}', responseHeaders: { entries: [
      { name: 'Cache-Control', value: 'no-store' }, { name: 'Retry-After', value: "={{ $json.retryAfter || '0' }}" },
    ] } } }, 1540), ...disabled];
const connections = {};
function edge(from, to, output = 0) {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
}
edge('Webhook', 'Config'); edge('Config', 'Normalize request'); edge('Normalize request', 'Valid transport?');
edge('Valid transport?', 'Legacy client?'); edge('Valid transport?', 'Respond to Vortex', 1);
edge('Legacy client?', 'Legacy received'); edge('Legacy client?', 'Has attachment?', 1);
edge('Legacy received', 'Has attachment?');
edge('Has attachment?', 'Deliver with attachment'); edge('Has attachment?', 'Deliver JSON', 1);
edge('Deliver with attachment', 'Validate confirmation'); edge('Deliver JSON', 'Validate confirmation');
edge('Validate confirmation', 'V2 response?'); edge('V2 response?', 'Respond to Vortex');
const candidate = { name: current.name, nodes, connections,
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false },
  meta: { templateCredsSetupCompleted: false } };
const output = JSON.stringify(candidate, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (output !== readFileSync(target, 'utf8')) throw new Error('Workflow differs from sources; run build-workflow.mjs');
} else writeFileSync(target, output);
