const { createHmac } = require('crypto');
const input = $input.first().json;
const reply = (status, result) => ({ status, result });
const closeRequested = 'plane.abilio.close_requested';
// The Abílio synchronizer stores the database ID in external_id and prefixes
// the title with ticket_uid. The exact fallback title is "Ticket #<ticket_uid>".
const abilioTitle = /^(?:(TKT-[A-Z0-9][A-Z0-9-]{0,59}): |Ticket #(TKT-[A-Z0-9][A-Z0-9-]{0,59})$)/;

// @plane-only
function completionKey(value) {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  // Normalize the timezone while keeping the precision shared by PostgreSQL and DRF.
  const fraction = value.match(/\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '';
  return `${millis}:${fraction.padEnd(6, '0')}`;
}

// @end-plane-only
function signDelivery() {
  let event = input.event;
  if (source === 'plane') {
    const { statusCode, body: issue } = input;
    if (statusCode === 404) return reply(200, 'ignored');
    if (statusCode !== 200 || !issue || !Object.hasOwn(issue, 'external_source')) {
      return reply(502, 'plane_unavailable');
    }

    const candidate = $('Verify and filter').first().json;
    const reference = typeof issue.name === 'string' && abilioTitle.exec(issue.name);
    if (issue.id !== candidate.issueId || issue.project !== candidate.projectId ||
        issue.workspace !== candidate.workspaceId || issue.external_source !== 'abilio' || !reference) {
      return reply(200, 'ignored');
    }
    // @plane-only
    if (candidate.stateEventId && (issue.state?.id !== candidate.stateId ||
        issue.state.name !== 'Fechar no Abílio' || issue.state.group !== 'completed' ||
        completionKey(issue.completed_at) !== completionKey(candidate.completedAt))) {
      return { ...reply(200, 'ignored'), reason: 'state_no_longer_eligible' };
    }
    // @end-plane-only
    event = {
      event_type: closeRequested,
      event_id: `${closeRequested}:${candidate.commentId}`,
      ticket_reference: reference[1] ?? reference[2],
      plane_issue_id: issue.id,
      ...(candidate.confirmedVersion ? { confirmed_version: candidate.confirmedVersion } : {}),
    };
    // @plane-only
    if (candidate.stateEventId) event.event_id = `${closeRequested}:state:${candidate.stateEventId}`;
    // @end-plane-only
  }

  const url = $env.HERMES_BRIDGE_OUTBOUND_URL;
  const secret = $env.HERMES_BRIDGE_OUTBOUND_SECRET;
  if (!/^https?:\/\//i.test(url ?? '') || !secret) return reply(503, 'bridge_unconfigured');

  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(timestamp + '.').update(body, 'utf8').digest('hex');
  return { url, body, timestamp, signature, requestId: event.event_id };
}

return [{ json: signDelivery() }];
