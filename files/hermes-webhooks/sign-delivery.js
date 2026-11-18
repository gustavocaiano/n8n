const { createHmac } = require('crypto');
const input = $input.first().json;
const reply = (status, result) => ({ status, result });
const closeRequested = 'plane.abilio.close_requested';
// The Abílio synchronizer stores the database ID in external_id and prefixes
// the title with ticket_uid. The exact fallback title is "Ticket #<ticket_uid>".
const abilioTitle = /^(?:(TKT-[A-Z0-9][A-Z0-9-]{0,59}): |Ticket #(TKT-[A-Z0-9][A-Z0-9-]{0,59})$)/;

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
    event = {
      event_type: closeRequested,
      event_id: `${closeRequested}:${candidate.commentId}`,
      ticket_reference: reference[1] ?? reference[2],
      plane_issue_id: issue.id,
      ...(candidate.confirmedVersion ? { confirmed_version: candidate.confirmedVersion } : {}),
    };
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
