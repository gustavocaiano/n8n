// n8n Code node: parse the transport, preserve its binary reference, never fetch.
const input = $('Webhook').first();
const headers = input.json.headers || {};
const contentType = String(headers['content-type'] || '').toLowerCase();
const binary = input.binary || {};
const keys = Object.keys(binary);
let payload = input.json.body;
let code;
let httpStatus = 422;
if (contentType.startsWith('multipart/form-data')) {
  if (!payload || typeof payload.payload !== 'string' || Object.keys(payload).length !== 1 || keys.length < 1 ||
      keys.length > 2 || keys.some((key) => !['attachment', 'logs'].includes(key))) {
    code = 'invalid_parts';
  } else {
    try { payload = JSON.parse(payload.payload); }
    catch { code = 'invalid_json'; httpStatus = 400; }
  }
} else if (/^application\/json(?:;|$)/.test(contentType)) {
  if (keys.length) code = 'unexpected_attachment';
} else {
  code = 'unsupported_transport';
  httpStatus = 415;
}
if (!code && (!payload || typeof payload !== 'object' || Array.isArray(payload))) code = 'invalid_payload';
const legacy = payload?.schema_version === undefined && payload?.request_id === undefined;
if (!code && keys.length && legacy) code = 'attachment_requires_v2';
if (code) {
  const response = { status: 'error', code };
  if (payload?.schema_version === 2) {
    response.schema_version = 2;
    if (typeof payload.request_id === 'string') response.request_id = payload.request_id;
  }
  return [{ json: { valid: false, httpStatus, response } }];
}
const hasAttachment = keys.includes('attachment');
const hasLogs = keys.includes('logs');
const files = {};
if (hasAttachment) files.attachment = binary.attachment;
if (hasLogs) files.logs = binary.logs;
return [{ json: { valid: true, payload, legacy, hasBinary: keys.length > 0, hasAttachment, hasLogs },
  ...(keys.length ? { binary: files } : {}) }];
