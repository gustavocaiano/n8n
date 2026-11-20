import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const readJson = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const workflows = {
  abilio: readJson('../../../workflows/hermes-abilio.workflow.json'),
  plane: readJson('../../../workflows/hermes-plane.workflow.json'),
};
const fixture = readJson('../fixtures/acceptance.json');
const env = {
  HERMES_BRIDGE_ABILIO_WEBHOOK_SECRET: 'fixture-abilio',
  HERMES_BRIDGE_PLANE_WEBHOOK_SECRET: 'fixture-plane',
  HERMES_BRIDGE_OUTBOUND_SECRET: 'fixture-hermes',
  HERMES_BRIDGE_OUTBOUND_URL: 'http://hermes.example.invalid:8644/webhooks/ticket-workflow',
  HERMES_BRIDGE_PLANE_URL: 'https://plane.example.invalid/',
  HERMES_BRIDGE_PLANE_WORKSPACE: fixture.plane.workspace,
  HERMES_BRIDGE_PLANE_PROJECT_ID: fixture.plane.issue.project,
  HERMES_BRIDGE_PLANE_OPERATOR_IDS: `${randomUUID()}, ${fixture.plane.comment.actor}`,
  HERMES_BRIDGE_PLANE_API_KEY: 'fixture-read-token',
};
const verify = 'Verify and filter';
const sign = 'Sign Hermes delivery';
const ignored = { status: 200, result: 'ignored' };
const ignoredState = (reason) => ({ ...ignored, reason });
const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const hmac = (key, bytes) => createHmac('sha256', key).update(bytes).digest('hex');
const node = (source, name) => workflows[source].nodes.find((entry) => entry.name === name);

async function run(source, name, item, options = {}) {
  const execute = new AsyncFunction('$input', '$env', '$', 'require', node(source, name).parameters.jsCode);
  const helpers = {
    getBinaryDataBuffer(index, key) {
      assert.equal(index, 0);
      assert.equal(key, 'data');
      assert.ok(!options.mustStayOnDisk, 'the runner must not load a body over the limit');
      return options.raw;
    },
  };
  const lookup = (previous) => {
    assert.equal(previous, verify);
    return { first: () => ({ json: options.candidate }) };
  };
  const [output] = await execute.call({ helpers }, { first: () => item }, { ...env, ...options.env }, lookup, require);
  return output.json;
}

function receive(source, event = fixture[source].event, options = {}) {
  const raw = options.raw ?? Buffer.from(JSON.stringify(event, null, 2) + '\n');
  const isAbilio = source === 'abilio';
  const headerName = isAbilio ? 'x-abilio-ticket-signature' : 'x-plane-signature';
  const secret = isAbilio ? env.HERMES_BRIDGE_ABILIO_WEBHOOK_SECRET : env.HERMES_BRIDGE_PLANE_WEBHOOK_SECRET;
  const headers = {
    [headerName]: hmac(secret, options.signedBytes ?? raw),
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': 'caller-chosen-id',
    ...options.headers,
  };
  const binary = { data: { bytes: raw.length, ...options.binaryMetadata } };
  return run(source, verify, { json: { headers, body: event }, binary }, { ...options, raw });
}

function readComment(candidate, body = fixture.plane.comment, statusCode = 200) {
  return run('plane', 'Confirm human comment', { json: { statusCode, body } }, { candidate });
}

function readIssue(candidate, body = fixture.plane.issue, statusCode = 200) {
  return run('plane', sign, { json: { statusCode, body } }, { candidate });
}

function receiveState(event = fixture.planeState.event, options = {}) {
  return receive('plane', event, {
    ...options,
    env: { HERMES_BRIDGE_PLANE_CLOSING_STATE_IDS: fixture.planeState.state.id, ...options.env },
  });
}

function verifyDelivery(delivery, expected) {
  assert.equal(delivery.url, env.HERMES_BRIDGE_OUTBOUND_URL);
  assert.deepEqual(JSON.parse(delivery.body), expected);
  assert.equal(delivery.requestId, expected.event_id);
  assert.match(delivery.timestamp, /^[0-9]+$/);
  assert.ok(Math.abs(Number(delivery.timestamp) - Math.floor(Date.now() / 1000)) <= 2);
  assert.equal(delivery.signature, hmac(env.HERMES_BRIDGE_OUTBOUND_SECRET, delivery.timestamp + '.' + delivery.body));
}

test('Abílio forwards only the signed, structured event fields', async () => {
  const accepted = await receive('abilio', { ...fixture.abilio.event, private_text: 'omit this' });
  assert.deepEqual(accepted.event, fixture.abilio.event);
  verifyDelivery(await run('abilio', sign, { json: accepted }), fixture.abilio.event);
  for (const override of [
    { event_type: 'abilio.ticket.updated' },
    { event_id: 'caller-defined' },
    { ticket_reference: 'TKT-1;something' },
  ]) {
    assert.deepEqual(await receive('abilio', { ...fixture.abilio.event, ...override }), {
      status: 422, result: 'invalid_event',
    });
  }
});

for (const source of ['abilio', 'plane']) {
  test(`${source} verifies the raw bytes before parsing and uses a separate secret`, async () => {
    const signedBytes = Buffer.from(JSON.stringify(fixture[source].event));
    const invalidSignature = { status: 401, result: 'invalid_signature' };
    assert.deepEqual(await receive(source, undefined, { signedBytes }), invalidSignature);
    const malformed = Buffer.from('{invalid JSON');
    assert.deepEqual(await receive(source, undefined, { signedBytes, raw: malformed }), invalidSignature);
    assert.deepEqual(await receive(source, undefined, { raw: malformed }), { status: 400, result: 'invalid_json' });
    const altered = Buffer.concat([signedBytes.subarray(0, -1), Buffer.from([0xff, 125])]);
    assert.deepEqual(await receive(source, undefined, { raw: altered }), { status: 400, result: 'invalid_json' });

    const otherSecret = source === 'abilio' ? env.HERMES_BRIDGE_PLANE_WEBHOOK_SECRET : env.HERMES_BRIDGE_ABILIO_WEBHOOK_SECRET;
    const header = source === 'abilio' ? 'x-abilio-ticket-signature' : 'x-plane-signature';
    assert.deepEqual(await receive(source, undefined, {
      raw: signedBytes,
      headers: { [header]: hmac(otherSecret, signedBytes) },
    }), invalidSignature);
  });
}

test('rejects oversized body metadata before reading from n8n binary storage', async () => {
  for (const source of ['abilio', 'plane']) {
    assert.deepEqual(await receive(source, undefined, {
      binaryMetadata: { bytes: 1024 * 1024 + 1 },
      mustStayOnDisk: true,
    }), { status: 413, result: 'body_too_large' });
  }
});

test('Plane resolves the canonical issue and preserves the same request ID across redeliveries', async () => {
  const event = fixture.plane.event;
  const candidate = await receive('plane', event);
  assert.equal(candidate.issueUrl,
    `https://plane.example.invalid/api/v1/workspaces/${fixture.plane.workspace}/projects/${fixture.plane.issue.project}/work-items/${event.entity_id}/`);
  assert.deepEqual(await readComment(candidate), { issueUrl: candidate.issueUrl });
  const delivery = await readIssue(candidate);
  verifyDelivery(delivery, fixture.plane.expected);

  const replay = await receive('plane', { ...event, delivery_id: randomUUID() });
  assert.equal((await readIssue(replay)).requestId, delivery.requestId);
  const sameComment = await receive('plane', { ...event, event_id: randomUUID() });
  assert.equal((await readIssue(sameComment)).requestId, delivery.requestId);

  const plain = structuredClone(event);
  plain.data.comment.comment_stripped = '@hermes fecha no Abílio';
  const noVersion = await receive('plane', plain);
  const { confirmed_version, ...expected } = fixture.plane.expected;
  verifyDelivery(await readIssue(noVersion, { ...fixture.plane.issue, name: `Ticket #${expected.ticket_reference}` }), expected);
});

test('Plane ignores legacy, comment updates, other projects, other actors and non-command comments', async () => {
  const event = fixture.plane.event;
  for (const override of [
    { version: undefined, event: 'issue_comment', action: 'created' },
    { event: 'workitem.comment.updated' },
    { entity_id: randomUUID() },
    { data: { ...event.data, project_id: randomUUID() } },
  ]) {
    assert.deepEqual(await receive('plane', { ...event, ...override }), ignored);
  }
  for (const override of [
    { actor_id: randomUUID() },
    { issue_id: randomUUID() },
    { edited_at: '2026-11-18T10:12:00Z' },
    { external_id: 'integration-message' },
    { external_source: 'gitlab' },
    { comment_stripped: '@hermes fecha no Abílio TKT-261118-FALSE' },
    { comment_stripped: '@hermes fecha no Abílio — disponível na v1.2.3 confirmar' },
    { comment_stripped: '@hermes fecha no Abílio — disponível na 12345' },
    { comment_stripped: '@hermes fecha no Abílio\n' },
  ]) {
    const data = { ...event.data, comment: { ...event.data.comment, ...override } };
    assert.deepEqual(await receive('plane', { ...event, data }), ignored);
  }
  assert.deepEqual(await receive('plane', event, { env: { HERMES_BRIDGE_PLANE_OPERATOR_IDS: '' } }), {
    status: 503, result: 'bridge_unconfigured',
  });
});

test('Plane rereads provenance and edit state before using the issue or delivering', async () => {
  const candidate = await receive('plane');
  for (const override of [
    { actor: randomUUID() }, { created_by: randomUUID() }, { issue: randomUUID() }, { project: randomUUID() },
    { external_source: 'gitlab' }, { external_id: 'abilio-reply' }, { edited_at: '2026-11-18T10:12:00Z' },
  ]) {
    assert.deepEqual(await readComment(candidate, { ...fixture.plane.comment, ...override }), ignored);
  }
  assert.deepEqual(await readComment(candidate, {}, 404), ignored);
  assert.deepEqual(await readComment(candidate, {}, 503), { status: 502, result: 'plane_unavailable' });
  const { edited_at, ...missingEditMarker } = fixture.plane.comment;
  assert.deepEqual(await readComment(candidate, missingEditMarker), { status: 502, result: 'plane_unavailable' });

  for (const override of [
    { external_source: null }, { external_source: 'gitlab' }, { project: randomUUID() }, { workspace: randomUUID() },
    { id: randomUUID() }, { name: 'Free text contains TKT-261118-AB12CD' },
  ]) {
    assert.deepEqual(await readIssue(candidate, { ...fixture.plane.issue, ...override }), ignored);
  }
  assert.deepEqual(await readIssue(candidate, {}, 404), ignored);
  assert.deepEqual(await readIssue(candidate, {}, 503), { status: 502, result: 'plane_unavailable' });
});

test('Plane state transitions require a configured destination, a signed change and an approved event actor', async () => {
  const { event, state } = fixture.planeState;
  assert.deepEqual(await receive('plane', event), ignoredState('state_transition_disabled'));
  assert.deepEqual(await receiveState(event, {
    env: { HERMES_BRIDGE_PLANE_CLOSING_STATE_IDS: `${state.id}, Done` },
  }), ignoredState('state_transition_unconfigured'));
  const done = randomUUID();
  for (const [override, reason] of [
    [{ version: 'v1' }, 'state_transition_not_proven'],
    [{ previous_attributes: { name: 'Before edit' } }, 'state_transition_not_proven'],
    [{ previous_attributes: { ...event.previous_attributes, state_id: state.id } }, 'state_transition_not_proven'],
    [{ previous_attributes: { state_id: event.previous_attributes.state_id } }, 'state_actor_not_proven'],
    [{ data: { ...event.data, updated_by_id: null, actor_id: fixture.plane.comment.actor } }, 'state_actor_not_proven'],
    [{ data: { ...event.data, completed_at: null } }, 'state_actor_not_proven'],
    [{ data: { ...event.data, updated_at: event.data.completed_at } }, 'state_actor_not_proven'],
    [{ data: { ...event.data, updated_at: undefined } }, 'state_actor_not_proven'],
    [{ data: { ...event.data, updated_by_id: randomUUID() } }, 'state_actor_not_allowed'],
    [{ data: { ...event.data, state_id: done } }, 'state_not_allowed'],
    [{ data: { ...event.data, external_source: 'gitlab' } }, 'state_issue_out_of_scope'],
    [{ data: { ...event.data, project_id: randomUUID() } }, 'state_issue_out_of_scope'],
    [{ data: { ...event.data, workspace_id: randomUUID() } }, 'state_issue_out_of_scope'],
    [{ entity_id: randomUUID() }, 'state_transition_not_proven'],
  ]) {
    assert.deepEqual(await receiveState({ ...event, ...override }), ignoredState(reason));
  }
  assert.deepEqual(await receiveState(event, { signedBytes: Buffer.from('changed after signing') }), {
    status: 401, result: 'invalid_signature',
  });
});

test('Plane checks the current v1 issue and sends a versionless event keyed by the v2 event ID', async () => {
  const { event, state, expected } = fixture.planeState;
  const issue = { ...fixture.plane.issue, state, completed_at: '2026-11-18T10:15:00.023427Z' };
  const candidate = await receiveState(event, {
    env: { HERMES_BRIDGE_PLANE_CLOSING_STATE_IDS: `${randomUUID()}, ${state.id}` },
  });
  assert.equal(candidate.issueUrl, `${(await receive('plane')).issueUrl}?expand=state`);
  assert.equal(candidate.commentId, undefined);
  verifyDelivery(await readIssue(candidate, issue), expected);
  const replay = await receiveState({ ...event, delivery_id: randomUUID() });
  verifyDelivery(await readIssue(replay, issue), expected);
  assert.deepEqual(await readIssue(replay, { ...issue, completed_at: '2026-11-18T10:15:00.023428Z' }),
    ignoredState('state_no_longer_eligible'));
  assert.deepEqual(await readIssue(replay, { ...issue, completed_at: undefined }),
    ignoredState('state_no_longer_eligible'));
  const newEventId = randomUUID();
  const newEvent = await receiveState({ ...event, event_id: newEventId });
  verifyDelivery(await readIssue(newEvent, issue), {
    ...expected, event_id: `plane.abilio.close_requested:state:${newEventId}`,
  });

  for (const changedState of [
    { ...state, id: event.previous_attributes.state_id },
    { ...state, name: 'Done' },
    { ...state, group: 'started' },
    state.id,
  ]) {
    assert.deepEqual(await readIssue(candidate, { ...issue, state: changedState }), ignoredState('state_no_longer_eligible'));
  }
  for (const override of [
    { id: randomUUID() }, { project: randomUUID() }, { workspace: randomUUID() },
    { external_source: 'gitlab' }, { name: 'Title without a ticket reference' },
  ]) {
    assert.deepEqual(await readIssue(candidate, { ...issue, ...override }), ignored);
  }
  assert.deepEqual(await readIssue(candidate, {
    id: issue.id, project_id: issue.project, state_id: state.id, name: issue.name,
  }), { status: 502, result: 'plane_unavailable' });
});

test('only state candidates bypass the Plane comment metadata read', () => {
  const { connections } = workflows.plane;
  assert.equal(connections['Eligible command?'].main[0][0].node, 'Comment command?');
  assert.deepEqual(connections['Comment command?'].main.map((output) => output.map(({ node }) => node)), [
    ['Read Plane comment metadata'], ['Read DEV issue'],
  ]);
});

test('exports keep both Webhooks inactive with binary POSTs and execution history off', () => {
  for (const [source, path] of [
    ['abilio', 'hermes/abilio-ticket-created'],
    ['plane', 'hermes/plane-comment-created'],
  ]) {
    const workflow = workflows[source];
    assert.equal(workflow.active, false);
    assert.deepEqual(workflow.settings, {
      executionOrder: 'v1',
      saveDataErrorExecution: 'none',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: false,
      saveExecutionProgress: false,
    });
    const webhook = node(source, 'Webhook');
    assert.equal(webhook.typeVersion, 1);
    assert.equal(webhook.parameters.path, path);
    assert.equal(webhook.parameters.httpMethod, 'POST');
    assert.equal(webhook.parameters.options.binaryData, true);
    const delivery = node(source, 'Deliver to Hermes');
    assert.equal(delivery.parameters.contentType, 'raw');
    assert.equal(delivery.parameters.body, '={{ $json.body }}');
    assert.equal(delivery.parameters.options.response.response.responseFormat, 'autodetect');
    assert.equal(delivery.parameters.options.redirect.redirect.followRedirects, false);
    assert.equal(delivery.retryOnFail, false);
    assert.equal(workflow.pinData, undefined);
    assert.equal(workflow.activeVersionId, undefined);
    assert.doesNotMatch(JSON.stringify(workflow), /fixture-|plane_wh_|plane_api_|api\.example\.invalid/);
    const authenticatedRequests = workflow.nodes.filter((entry) => entry.type === 'n8n-nodes-base.httpRequest');
    for (const request of authenticatedRequests) {
      assert.equal(request.credentials, undefined);
      assert.ok(request.parameters.headerParameters.parameters.every(({ value }) =>
        value === 'application/json' || value.startsWith('={{ ')));
    }
  }
});
