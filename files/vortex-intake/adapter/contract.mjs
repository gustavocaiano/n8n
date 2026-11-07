import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 5_242_880;
export const MAX_LOGS_BYTES = 2_097_152;
export const LOGS_FILENAME = 'vortex-logs-48h.txt';
export const LOGS_HOURS = 48;
export const MAX_BODY_BYTES = MAX_FILE_BYTES + MAX_LOGS_BYTES + 65_536;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class IntakeError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value, field, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new IntakeError(422, `invalid_${field}`);
  const trimmed = value.trim();
  if ((required && !trimmed) || Array.from(trimmed).length > max) {
    throw new IntakeError(422, `invalid_${field}`);
  }
  return trimmed;
}

export function validateFile(file) {
  if (!file) return null;
  const { name, type, bytes } = file;
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 255 ||
      /[\p{Cc}\p{Cf}/\\]/u.test(name) || name === '.' || name === '..') {
    throw new IntakeError(422, 'invalid_filename');
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new IntakeError(422, 'empty_attachment');
  if (bytes.length > MAX_FILE_BYTES) throw new IntakeError(413, 'attachment_too_large');
  const extension = name.split('.').pop().toLowerCase();
  const expected = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', txt: 'text/plain' }[extension];
  if (!expected || type !== expected) throw new IntakeError(415, 'unsupported_attachment');
  let matches = false;
  if (expected === 'image/png') {
    matches = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  } else if (expected === 'image/jpeg') {
    matches = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  } else if (expected === 'application/pdf') {
    matches = /^%PDF-[12]\.\d/.test(bytes.toString('ascii', 0, 8));
  } else {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      matches = !/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text);
    } catch { /* Non-UTF-8 bytes are not accepted as text. */ }
  }
  if (!matches) throw new IntakeError(415, 'attachment_content_mismatch');
  return { name, type: expected, size: bytes.length, sha256: digest(bytes), bytes };
}

// Logs are a fixed-name, Vortex-generated text snapshot (bug reports only).
// The client strips C0/DEL controls except \t\n\r, so anything else is a mismatch.
export function validateLogs(meta, file, type) {
  if (meta !== undefined && !object(meta)) throw new IntakeError(422, 'invalid_logs');
  const included = meta?.included ?? false;
  if (typeof included !== 'boolean') throw new IntakeError(422, 'invalid_logs');
  if (included !== Boolean(file)) throw new IntakeError(422, 'logs_mismatch');
  if (!included) return null;
  if (type !== 'bug') throw new IntakeError(422, 'logs_not_allowed');
  if (meta.hours !== LOGS_HOURS || typeof meta.truncated !== 'boolean') throw new IntakeError(422, 'invalid_logs');
  const { name, type: mime, bytes } = file;
  if (name !== LOGS_FILENAME) throw new IntakeError(422, 'invalid_logs_filename');
  const [essence, ...params] = String(mime ?? '').toLowerCase().split(';').map((part) => part.trim());
  const charset = params.find((param) => param.startsWith('charset='));
  if (essence !== 'text/plain' || (charset && charset.replace(/^charset="?|"?$/g, '') !== 'utf-8')) {
    throw new IntakeError(415, 'unsupported_logs');
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new IntakeError(422, 'empty_logs');
  if (bytes.length > MAX_LOGS_BYTES) throw new IntakeError(413, 'logs_too_large');
  if (!Number.isInteger(meta.bytes) || meta.bytes !== bytes.length) throw new IntakeError(422, 'logs_size_mismatch');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new IntakeError(415, 'logs_content_mismatch'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new IntakeError(415, 'logs_content_mismatch');
  return { name, type: 'text/plain', size: bytes.length, sha256: digest(bytes), bytes,
    hours: meta.hours, truncated: meta.truncated };
}

export function normalize(payload, file = null, logsFile = null) {
  if (!object(payload)) throw new IntakeError(422, 'invalid_payload');
  const v2 = payload.schema_version !== undefined || payload.request_id !== undefined;
  if (v2 && (payload.schema_version !== 2 || typeof payload.request_id !== 'string' || !UUID.test(payload.request_id))) {
    throw new IntakeError(422, 'invalid_protocol');
  }
  if ((file || logsFile) && !v2) throw new IntakeError(422, 'attachment_requires_v2');
  const website = string(payload.website, 'website', 4000);
  if (website) throw new IntakeError(422, 'honeypot');
  const type = string(payload.type, 'type', 7, true);
  if (!['bug', 'feature'].includes(type)) throw new IntakeError(422, 'invalid_type');
  for (const key of ['instance', 'user']) {
    if (payload[key] !== undefined && !object(payload[key])) throw new IntakeError(422, `invalid_${key}`);
  }
  const data = {
    type,
    title: string(payload.title, 'title', 160, true),
    description: string(payload.description, 'description', 4000, true),
    version: string(payload.version, 'version', 128),
    instance: {
      name: string(payload.instance?.name, 'instance_name', 512),
      url: string(payload.instance?.url, 'instance_url', 2048),
    },
    user: {
      name: string(payload.user?.name, 'user_name', 512),
      username: string(payload.user?.username ?? payload.user?.email, 'username', 512),
    },
    reported_at: string(payload.reported_at, 'reported_at', 80),
    website: '',
  };
  const attachment = validateFile(file);
  const logs = validateLogs(payload.logs, logsFile, type);
  // Match Vortex's retry identity: metadata/report time can change between attempts.
  // The logs snapshot is frozen per draft by Vortex, so its bytes are identity too.
  const identity = { type, title: data.title, description: data.description,
    attachment: attachment ? { name: attachment.name, sha256: attachment.sha256 } : null,
    ...(logs ? { logs: { sha256: logs.sha256, truncated: logs.truncated } } : {}) };
  const fingerprint = digest(JSON.stringify(identity));
  const key = v2 ? payload.request_id.toLowerCase() : `legacy-${digest(JSON.stringify(data))}`;
  return { v2, requestId: v2 ? payload.request_id : null, key, fingerprint, data, attachment, logs };
}

export function errorResponse(error, payload) {
  const known = error instanceof IntakeError;
  const body = { status: 'error', code: known ? error.code : 'intake_unavailable' };
  if (payload?.schema_version === 2) {
    body.schema_version = 2;
    if (typeof payload.request_id === 'string' && UUID.test(payload.request_id)) body.request_id = payload.request_id;
  }
  return { status: known ? error.status : 503, body };
}

export function completed(input, state) {
  const body = { status: 'completed', work_item_id: state.issueId,
    attachment_id: state.files?.attachment?.attachmentId ?? null,
    logs_ref: input.logs ? state.logs?.ref ?? null : null };
  if (input.v2) Object.assign(body, { schema_version: 2, request_id: input.requestId });
  return { status: 200, body };
}

// Logs never reach Plane: only this short note, appended once the file is stored.
export function logsNote(input, ref) {
  const { hours, size, truncated } = input.logs;
  return `<p><strong>Logs:</strong> ${hours} h, ${size} bytes, truncado: ${truncated ? 'sim' : 'não'}; ` +
    `guardados no n8n: <code>${ref.replace(/[^A-Za-z0-9._-]/g, '')}</code></p>`;
}

export function planeIssue(input, config) {
  const { data } = input;
  const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const url = data.instance.url;
  const instanceUrl = /^https?:\/\/[^\s<>"']+$/i.test(url) ? `<a href="${escape(url)}" rel="noopener noreferrer">${escape(url)}</a>` : escape(url);
  return {
    name: `${data.type === 'bug' ? '[Bug]' : '[Feature]'} ${data.title}`,
    description_html: `<p>${escape(data.description).replace(/\n/g, '<br>')}</p><hr>` +
      `<p><strong>Instância:</strong> ${escape(data.instance.name)} ${instanceUrl}</p>` +
      `<p><strong>Reportado por:</strong> ${escape(data.user.name)} &lt;${escape(data.user.username)}&gt;</p>` +
      `<p><strong>Versão:</strong> ${escape(data.version)}</p>` +
      `<p><strong>Data:</strong> ${escape(data.reported_at)}</p>`,
    priority: 'none', external_id: `vortex-${input.key}`, external_source: 'vortex-intake',
    label_ids: [data.type === 'bug' ? config.bugLabel : config.featureLabel].filter(Boolean),
  };
}
