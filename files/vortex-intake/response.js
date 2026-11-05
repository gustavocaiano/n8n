// Never pass through a successful HTTP status without the agreed confirmation.
const incoming = $input.first().json;
const payload = $('Normalize request').first().json.payload;
const hasAttachment = $('Normalize request').first().json.hasAttachment;
const v2 = payload?.schema_version !== undefined || payload?.request_id !== undefined;
let body = incoming.body;
if (typeof body === 'string') {
  try { body = JSON.parse(body); } catch { body = null; }
}
const response = { status: 'error', code: 'intake_unavailable' };
if (v2) Object.assign(response, { schema_version: 2, request_id: payload.request_id });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const confirmed = incoming.statusCode === 200 && body?.status === 'completed' &&
  uuid.test(body.work_item_id || '') && (!hasAttachment || uuid.test(body.attachment_id || '')) &&
  (!v2 || (body.schema_version === 2 && body.request_id === payload.request_id));
if (confirmed) return [{ json: { v2, httpStatus: 200, response: body } }];
if (!v2 && incoming.statusCode === 200 && body?.status === 'ignored') {
  return [{ json: { v2: false, httpStatus: 200, response: { status: 'ignored' } } }];
}
const allowed = [400, 401, 403, 409, 413, 415, 422, 429, 500, 502, 503, 504];
const httpStatus = allowed.includes(incoming.statusCode) ? incoming.statusCode : 502;
if (body?.status === 'error' && typeof body.code === 'string' && /^[a-z_]{1,64}$/.test(body.code)) response.code = body.code;
return [{ json: { v2, httpStatus, response, retryAfter: httpStatus === 429 ? '720' : '2' } }];
