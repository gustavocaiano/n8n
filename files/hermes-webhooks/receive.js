const { createHmac, timingSafeEqual } = require('crypto');
const reply = (status, result) => ({ status, result });
const uuid = (value) => typeof value === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const integrationMarker = (value) => value != null && value !== '';
const maxBodyBytes = 1024 * 1024;
const ticketCreated = 'abilio.ticket.created';
const commentCreated = 'workitem.comment.created';
const closeCommand = /^@hermes fecha no Abílio(?: — disponível na (v?[0-9]{1,4}(?:\.[0-9]{1,4}){0,2}))?$/u;

async function receive() {
  const abilio = source === 'abilio';
  const secret = abilio ? $env.HERMES_BRIDGE_ABILIO_WEBHOOK_SECRET : $env.HERMES_BRIDGE_PLANE_WEBHOOK_SECRET;
  if (!secret) return reply(503, 'bridge_unconfigured');

  const input = $input.first();
  const headers = input.json.headers ?? {};
  const signature = headers[abilio ? 'x-abilio-ticket-signature' : 'x-plane-signature'];
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) {
    return reply(401, 'invalid_signature');
  }
  const binary = input.binary?.data;
  if (!binary) return reply(400, 'missing_body');
  if (!Number.isSafeInteger(binary.bytes) || binary.bytes < 1 || binary.bytes > maxBodyBytes) {
    return reply(413, 'body_too_large');
  }

  // The Webhook node streams the body as binary before n8n's JSON parser runs.
  const raw = await this.helpers.getBinaryDataBuffer(0, 'data');
  if (raw.length > maxBodyBytes) return reply(413, 'body_too_large');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
    return reply(401, 'invalid_signature');
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] ?? '') ||
      (headers['content-encoding'] && headers['content-encoding'] !== 'identity')) {
    return reply(415, 'unsupported_media_type');
  }

  let event;
  try {
    const text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) return reply(400, 'invalid_json');
    event = JSON.parse(text);
  } catch {
    return reply(400, 'invalid_json');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return reply(400, 'invalid_json');

  if (abilio) {
    const { ticket_reference, event_id } = event;
    if (event.event_type !== ticketCreated || typeof ticket_reference !== 'string' ||
        !/^TKT-[A-Z0-9][A-Z0-9-]{0,59}$/.test(ticket_reference) ||
        event_id !== `${ticketCreated}:${ticket_reference}`) {
      return reply(422, 'invalid_event');
    }
    return { event: { event_type: ticketCreated, event_id, ticket_reference } };
  }

  const ignored = reply(200, 'ignored');
  if (event.version !== 'v2' || event.event !== commentCreated ||
      event.entity_type !== 'issue' || !uuid(event.event_id) || !uuid(event.workspace_id)) {
    return ignored;
  }
  const { id: issueId, project_id: eventProjectId, comment } = event.data ?? {};
  if (!uuid(issueId) || event.entity_id !== issueId || comment?.issue_id !== issueId ||
      !uuid(comment.id) || !uuid(comment.actor_id) || comment.edited_at != null ||
      integrationMarker(comment.external_source) || integrationMarker(comment.external_id)) {
    return ignored;
  }
  const match = typeof comment.comment_stripped === 'string' && closeCommand.exec(comment.comment_stripped);
  if (!match || match[0] !== comment.comment_stripped) return ignored;

  const projectId = $env.HERMES_BRIDGE_PLANE_PROJECT_ID;
  const operators = ($env.HERMES_BRIDGE_PLANE_OPERATOR_IDS ?? '').split(',').map((id) => id.trim());
  if (!uuid(projectId) || !operators.every(uuid)) return reply(503, 'bridge_unconfigured');
  if (!operators.includes(comment.actor_id) ||
      (eventProjectId !== undefined && eventProjectId !== projectId)) return ignored;

  const planeUrl = $env.HERMES_BRIDGE_PLANE_URL;
  const workspace = $env.HERMES_BRIDGE_PLANE_WORKSPACE;
  if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?\/?$/i.test(planeUrl ?? '') ||
      !/^[a-z0-9_-]+$/i.test(workspace ?? '') || !$env.HERMES_BRIDGE_PLANE_API_KEY) {
    return reply(503, 'bridge_unconfigured');
  }
  const issueUrl = `${planeUrl.replace(/\/$/, '')}/api/v1/workspaces/${workspace}/projects/${projectId}/work-items/${issueId}/`;
  return {
    issueUrl,
    issueId,
    projectId,
    workspaceId: event.workspace_id,
    commentId: comment.id,
    actorId: comment.actor_id,
    confirmedVersion: match[1],
  };
}

return [{ json: await receive.call(this) }];
