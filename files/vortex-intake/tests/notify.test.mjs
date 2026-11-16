import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { payload, issueId } from './helpers.mjs';

const workflow = JSON.parse(readFileSync(new URL('../../../workflows/vortex-intake.workflow.json', import.meta.url), 'utf8'));
const source = workflow.nodes.find((node) => node.name === 'Build Telegram message').parameters.jsCode;
const logsRef = `VORTEX-22_${payload.request_id}.txt`;

// Same approach as http-workflow.test.mjs: run the stored Code node with a fake `$`.
// chatId: null simulates a Config node without the telegramChatId key at all.
function notify({ request, outcome, chatId = '123456789' }) {
  const refs = {
    'Normalize request': request && { json: request },
    'Validate confirmation': outcome && { json: outcome },
    Config: { json: chatId === null ? {} : { telegramChatId: chatId } },
  };
  const result = vm.runInNewContext(`(function(){${source}\n})()`, { $: (name) => ({ first: () => refs[name] }) });
  return JSON.parse(JSON.stringify(result));
}
const valid = (p = payload, extra = {}) => ({ valid: true, payload: p, legacy: false, hasBinary: false, hasAttachment: false, hasLogs: false, ...extra });
const confirmed = (extra = {}) => ({ v2: true, httpStatus: 200,
  response: { schema_version: 2, request_id: payload.request_id, status: 'completed', work_item_id: issueId, attachment_id: null, logs_ref: null, ...extra } });
const text = (args) => { const [item] = notify(args); assert.ok(item, 'expected one message'); return item.json.notifyText; };

test('a confirmed bug becomes one plain-text message with the essentials', () => {
  assert.equal(text({ request: valid(), outcome: confirmed() }), [
    '🐞 Bug de NUC de teste', 'Teste de anexo', '', 'Um exemplo local, sem dados pessoais.', '',
    'Por: Utilizador de teste (teste) · Vortex 3.1.0', 'Instância: https://nuc.invalid',
  ].join('\n'));
  assert.equal(notify({ request: valid(), outcome: confirmed() }).length, 1);
  assert.ok(text({ request: valid({ ...payload, type: 'feature' }), outcome: confirmed() }).startsWith('✨ Feature de NUC de teste\n'));
});

test('nothing is sent unless the intake was confirmed as completed', () => {
  for (const outcome of [
    { v2: true, httpStatus: 502, response: { status: 'error', code: 'intake_unavailable' } },
    { v2: true, httpStatus: 429, response: { status: 'error', code: 'rate_limited' } },
    { v2: false, httpStatus: 200, response: { status: 'ignored' } },
    { v2: true, httpStatus: 200, response: { status: 'accepted' } },
    { v2: true, httpStatus: 202, response: { status: 'completed' } },
    undefined, {},
  ]) assert.deepEqual(notify({ request: valid(), outcome }), []);
});

test('a rejected transport never reaches Telegram and never needs the delivery node', () => {
  // Valid transport? (false) → Respond to Vortex → Build Telegram message: Validate confirmation never ran.
  assert.deepEqual(notify({ request: { valid: false, httpStatus: 422, response: { status: 'error', code: 'invalid_parts' } }, outcome: undefined }), []);
  assert.deepEqual(notify({ request: undefined, outcome: confirmed() }), []);
});

test('legacy clients (no UUID) are notified after their confirmed completion too', () => {
  const { schema_version, request_id, ...legacy } = payload;
  const out = { v2: false, httpStatus: 200, response: { status: 'completed', work_item_id: issueId } };
  assert.match(text({ request: valid(legacy, { legacy: true }), outcome: out }), /^🐞 Bug de NUC de teste\nTeste de anexo\n/);
});

test('stays silent until a real chat id is configured (placeholder, empty, junk)', () => {
  for (const chatId of ['CHANGE-ME-chat-id', '', '   ', null, 'abc', '12', '123456789; drop', '@x']) {
    assert.deepEqual(notify({ request: valid(), outcome: confirmed(), chatId }), [], JSON.stringify(chatId));
  }
  for (const chatId of ['123456789', '-1001234567890', '@canal_vortex']) {
    assert.equal(notify({ request: valid(), outcome: confirmed(), chatId }).length, 1, chatId);
  }
});

test('attachment and logs are only mentioned, never included; the ticket number comes from logs_ref', () => {
  const withLogs = { ...payload, logs: { included: true, hours: 48, bytes: 2097152, truncated: true, secret: 'must not appear' } };
  const message = text({ request: valid(withLogs, { hasAttachment: true, hasLogs: true }), outcome: confirmed({ attachment_id: issueId, logs_ref: logsRef }) });
  assert.ok(message.includes('📎 Anexo · 🧾 Logs 48 h: 2097152 bytes (truncados)'));
  assert.ok(message.endsWith('\nTicket: VORTEX-22'));
  assert.ok(!message.includes('must not appear') && !message.includes(payload.request_id));
  assert.ok(!/Ticket:/.test(text({ request: valid(), outcome: confirmed() })));
  assert.ok(!/Ticket:/.test(text({ request: valid(), outcome: confirmed({ logs_ref: 42 }) })));
});

test('user e-mail and the Telegram-looking username are never turned into mentions or addresses', () => {
  const message = text({ request: valid({ ...payload, user: { name: 'Ana', username: 'ana', email: 'ana@example.invalid' } }), outcome: confirmed() });
  assert.ok(message.includes('Por: Ana (ana)'));
  assert.ok(!message.includes('@') && !message.includes('example.invalid'));
});

test('long or hostile text is capped, cleaned and never split inside a character', () => {
  const emoji = text({ request: valid({ ...payload, description: '😀'.repeat(600), title: '😀'.repeat(300) }), outcome: confirmed() });
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji), 'no lone surrogates');
  assert.ok(emoji.includes(`${'😀'.repeat(499)}…`) && !emoji.includes('😀'.repeat(500)));
  assert.ok(emoji.includes(`${'😀'.repeat(159)}…`));
  assert.ok(emoji.length < 4096);
  const dirty = text({ request: valid({ ...payload, description: 'a\u001b[31mred\u202Ereversed\r\n\r\n\r\n\r\nz <b>x</b> & _y_ *z*' }), outcome: confirmed() });
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\r]/.test(dirty));
  assert.ok(dirty.includes('a [31mred reversed\n\nz &lt;b&gt;x&lt;/b&gt; &amp; _y_ *z*'), 'user markup is HTML-escaped and stays literal');
});

test('every user-written field is HTML-escaped: the text is always valid for parse_mode HTML', () => {
  // The Telegram node applies Markdown unless told otherwise, so we send HTML and escape &, < and > everywhere.
  const hostile = ['<b>x</b>', '</i><script>alert(1)</script>', 'a & b', '&amp; &lt; &#60; &#x3C;', '5 < 6 > 4', '_a_b*c[d](e)`f`\\g', '<'];
  const raw = (value) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const value of hostile) {
    const message = text({ request: valid({ ...payload, title: value, description: value, version: value,
      instance: { name: value, url: value }, user: { name: value, username: value } }), outcome: confirmed() });
    assert.ok(!/[<>]/.test(message), `raw angle bracket in ${JSON.stringify(value)}`);
    assert.ok(!/&(?!amp;|lt;|gt;)/.test(message), `unescaped ampersand in ${JSON.stringify(value)}`);
    assert.ok(raw(message).includes(value), `round trip of ${JSON.stringify(value)}`);
  }
});

test('malformed payloads never throw: they yield a message or nothing', () => {
  for (const bad of [{}, { title: 42, description: { a: 1 }, instance: 'x', user: null, logs: 'no' }, [], null, 'text']) {
    const result = notify({ request: valid(bad), outcome: confirmed() });
    assert.ok(Array.isArray(result) && result.length <= 1);
  }
  assert.deepEqual(notify({ request: { valid: true, payload: payload }, outcome: { httpStatus: 200, response: null } }), []);
});

test('graph: the notification runs only after the answer to Vortex and cannot affect the intake', () => {
  const byName = (name) => workflow.nodes.find((node) => node.name === name);
  const incoming = (target) => Object.entries(workflow.connections).flatMap(([from, { main }]) => main.flatMap((targets, output) =>
    targets.filter((t) => t.node === target).map(() => `${from}#${output}`))).sort();
  // v2: Respond to Vortex → builder. legacy: V2 response? (false output) → builder. Never straight from the delivery nodes.
  assert.deepEqual(incoming('Build Telegram message'), ['Respond to Vortex#0', 'V2 response?#1']);
  assert.deepEqual(incoming('Telegram'), ['Build Telegram message#0']);
  assert.equal(workflow.connections['Telegram'], undefined);
  for (const name of ['Build Telegram message', 'Telegram']) {
    const node = byName(name);
    assert.equal(node.disabled, undefined, name);
    assert.equal(node.onError, 'continueRegularOutput', name);
    assert.equal(node.retryOnFail, false, name);
  }
  const telegram = byName('Telegram');
  assert.equal(telegram.type, 'n8n-nodes-base.telegram');
  // parse_mode must be explicit: left unset the node applies Markdown, which mangles or rejects user text.
  assert.deepEqual(telegram.parameters.additionalFields, { appendAttribution: false, disable_web_page_preview: true, parse_mode: 'HTML' });
  assert.equal(telegram.parameters.text, '={{ $json.notifyText }}');
  assert.equal(telegram.parameters.chatId, "={{ $('Config').first().json.telegramChatId }}");
  assert.equal(telegram.credentials.telegramApi.id, 'REPLACE_ME');
});

test('secrets and the real chat id stay out of the committed workflow', () => {
  const raw = readFileSync(new URL('../../../workflows/vortex-intake.workflow.json', import.meta.url), 'utf8');
  assert.ok(!/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/.test(raw), 'no Telegram bot token');
  const chat = workflow.nodes.find((n) => n.name === 'Config').parameters.assignments.assignments.find((a) => a.name === 'telegramChatId');
  assert.equal(chat.value, 'CHANGE-ME-chat-id');
});
