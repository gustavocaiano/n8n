// Apply Guards semantics on the embedded decision + structural graph invariants
// (25 live nodes preserved, barrier wiring, backstop untouched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCandidate, loadBackstop, jsCodeOf, runCodeNode, decision, SMOKE_CFG,
  NEW_BARRIER_NODES, BASELINE_25_NODES, PRESERVED_IDS, candidatePath, opsArtifactPath,
} from './helpers.mjs';
import fs from 'node:fs';

const wf = loadCandidate();
const guardsCode = jsCodeOf(wf, 'Apply Guards');
const env = { ...SMOKE_CFG, WORKSPACE_SLUG: 'smokews', PLANE_PROJECT_DEV: JSON.stringify(SMOKE_CFG) };

function guardRun(state, overrides = {}, workItemOverrides = {}) {
  const d = decision('SMK-1', overrides);
  const item = { json: { id: 'wi-1', project: 'p1', state, assignees: [], ...workItemOverrides, __originalDecision: d } };
  return runCodeNode(guardsCode, { items: [item], env })[0].json;
}

test('guards: normal path — todo -> inProgress allowed, decision fields mapped', () => {
  const g = guardRun('st-todo');
  assert.equal(g.shouldChangeState, true);
  assert.equal(g.currentStateName, 'todo');
  assert.equal(g.targetStateName, 'inProgress');
  assert.equal(g.workItemId, 'wi-1');
  assert.equal(g.project, 'p1');
  assert.equal(g.currentState, 'st-todo');
  assert.ok(g.workItemUrl.includes('/smokews/browse/SMK-1/'));
  assert.deepEqual(g.authorEmails, []);
});

test('guards: Done is protected (mention blocked, reopen allowed)', () => {
  const blocked = guardRun('st-done', { desiredStateName: 'mention' });
  assert.equal(blocked.shouldChangeState, false);
  assert.match(blocked.guardReason, /Done cannot be downgraded except by reopen/);
  const reopened = guardRun('st-done', { desiredStateName: 'reopen', targetStateUuid: 'st-inprog' });
  assert.equal(reopened.shouldChangeState, true);
});

test('guards: Cancelled is human-owned, always blocked', () => {
  const g = guardRun('st-cancelled');
  assert.equal(g.shouldChangeState, false);
  assert.match(g.guardReason, /Cancelled is human-owned/);
});

test('guards: already in target state / inReview mention protection / mr-closed rule', () => {
  const same = guardRun('st-inprog', { targetStateUuid: 'st-inprog' });
  assert.equal(same.shouldChangeState, false);
  assert.match(same.guardReason, /already in target state/);

  const review = guardRun('st-review', { desiredStateName: 'mention' });
  assert.equal(review.shouldChangeState, false);
  assert.match(review.guardReason, /In Review not downgraded by mention/);

  const mrClosed = guardRun('st-backlog', { desiredStateName: 'mr-closed', targetStateUuid: 'st-todo' });
  assert.equal(mrClosed.shouldChangeState, false);
  assert.match(mrClosed.guardReason, /mr-closed only downgrades active review states/);
});

test('guards: missing embedded decision throws (no numeric fallback path)', () => {
  assert.throws(
    () => runCodeNode(guardsCode, { items: [{ json: { id: 'wi-1', project: 'p1', state: 'st-todo' } }], env }),
    /no embedded __originalDecision at 0/,
  );
  assert.throws(
    () => runCodeNode(guardsCode, { items: [{ json: { id: 'wi-1', project: 'p1', __originalDecision: decision('SMK-1') } }], env }),
    /malformed work item at 0/,
  );
});

test('guards: assignees passthrough from fresh work item', () => {
  const g = guardRun('st-todo', {}, { assignees: [{ id: 'u1' }] });
  assert.equal(g.assigneesCount, 1);
  assert.deepEqual(g.assignees, [{ id: 'u1' }]);
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

const conns = wf.connections;
const hasConn = (source, target, sourceIndex = 0) =>
  (conns[source]?.main?.[sourceIndex] || []).some((c) => c.node === target);

test('graph: all 25 live nodes preserved by name + 5 barrier nodes added (30 total)', () => {
  assert.equal(wf.nodes.length, 30);
  const names = wf.nodes.map((n) => n.name);
  for (const name of BASELINE_25_NODES) assert.ok(names.includes(name), `missing live node: ${name}`);
  for (const name of NEW_BARRIER_NODES) assert.ok(names.includes(name), `missing barrier node: ${name}`);
});

test('graph: critical node IDs preserved from live workflow', () => {
  for (const [name, id] of Object.entries(PRESERVED_IDS)) {
    assert.equal(wf.nodes.find((n) => n.name === name)?.id, id, `node id changed: ${name}`);
  }
});

test('graph: barrier wiring present, old direct wiring removed', () => {
  assert.ok(hasConn('Reducer', 'Prepare Lookup Attempt'));
  assert.ok(hasConn('Prepare Lookup Attempt', 'Get Work Item'));
  assert.ok(hasConn('Get Work Item', 'Classify Lookup Batch'));
  assert.ok(hasConn('Classify Lookup Batch', 'Lookup Batch Ready?'));
  assert.ok(hasConn('Lookup Batch Ready?', 'Unwrap Lookup Batch', 0), 'IF true -> Unwrap');
  assert.ok(hasConn('Lookup Batch Ready?', 'Wait for Plane Retry', 1), 'IF false -> Wait');
  assert.ok(hasConn('Unwrap Lookup Batch', 'Apply Guards'));
  assert.ok(hasConn('Wait for Plane Retry', 'Prepare Lookup Attempt'), 'loop back re-runs entire GET batch');
  // old direct wiring must be gone
  assert.ok(!hasConn('Reducer', 'Get Work Item'));
  assert.ok(!hasConn('Get Work Item', 'Apply Guards'));
});

test('graph: all live side-effect branches and live-only nodes untouched', () => {
  assert.ok(hasConn('Apply Guards', 'Should Change State?'));
  assert.ok(hasConn('Apply Guards', 'Prepare GitLab Linkback'));
  assert.ok(hasConn('Apply Guards', 'Existing Comments'));
  assert.ok(hasConn('Apply Guards', 'Unassigned?'));
  assert.ok(hasConn('Should Change State?', 'Update State'));
  assert.ok(hasConn('Existing Comments', 'Filter Duplicate Comments'));
  assert.ok(hasConn('Filter Duplicate Comments', 'Create Comment'));
  assert.ok(hasConn('Create Comment', 'Validate Comment Result'));
  assert.ok(hasConn('Unassigned?', 'Get Members'));
  assert.ok(hasConn('Get Members', 'Resolve Assignee'));
  assert.ok(hasConn('Resolve Assignee', 'Assign Issue'));
  assert.ok(hasConn('Prepare GitLab Linkback', 'Is Commit?'));
  assert.ok(hasConn('Is Commit?', 'Post Commit Comment', 0));
  assert.ok(hasConn('Is Commit?', 'Edit MR Description', 1));
  // upstream untouched
  assert.ok(hasConn('GitLab Webhook', 'Verify Secret'));
  assert.ok(hasConn('Verify Secret', 'Route Event'));
  assert.ok(hasConn('Route Event', 'Normalize Push'));
  assert.ok(hasConn('Route Event', 'MR Action?', 1));
  assert.ok(hasConn('MR Action?', 'Get MR Commits', 0));
  assert.ok(hasConn('MR Action?', 'Normalize MR (direct)', 1));
  assert.ok(hasConn('Normalize Push', 'Reducer'));
  assert.ok(hasConn('Normalize MR (with commits)', 'Reducer'));
  assert.ok(hasConn('Normalize MR (direct)', 'Reducer'));
});

test('graph: Get Work Item keeps same URL/env auth, gains fullResponse+neverError', () => {
  const gwi = wf.nodes.find((n) => n.name === 'Get Work Item');
  assert.equal(gwi.type, 'n8n-nodes-base.httpRequest');
  assert.equal(gwi.typeVersion, 4.2);
  assert.equal(
    gwi.parameters.url,
    '=https://plane.nforensic.site/api/v1/workspaces/{{ $env.WORKSPACE_SLUG }}/work-items/{{ $json.issueKey }}/',
    'same id URL must be preserved',
  );
  assert.deepEqual(gwi.parameters.headerParameters, {
    parameters: [{ name: 'X-Api-Key', value: '={{ $env.PLANE_API_KEY }}' }],
  }, 'env auth header unchanged');
  assert.deepEqual(gwi.parameters.options, {
    response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } },
  });
});

test('graph: IF routing condition + Wait node delay policy', () => {
  const iff = wf.nodes.find((n) => n.name === 'Lookup Batch Ready?');
  assert.equal(iff.type, 'n8n-nodes-base.if');
  assert.equal(iff.typeVersion, 2.2);
  const cond = iff.parameters.conditions;
  assert.equal(cond.combinator, 'and');
  assert.equal(cond.conditions.length, 1);
  assert.equal(cond.conditions[0].leftValue, '={{ $json.ready }}');
  assert.deepEqual(cond.conditions[0].operator, { type: 'boolean', operation: 'true' });
  assert.equal(cond.options.typeValidation, 'strict');

  const wait = wf.nodes.find((n) => n.name === 'Wait for Plane Retry');
  assert.equal(wait.type, 'n8n-nodes-base.wait');
  assert.equal(wait.typeVersion, 1.1);
  assert.equal(wait.parameters.resume, 'timeInterval');
  assert.equal(wait.parameters.unit, 'seconds');
  assert.equal(wait.parameters.amount, '={{ $json.retryDelaySeconds }}');
});

test('graph: no new retries or side-effect changes on other API nodes', () => {
  // every other HTTP node keeps plain options (no fullResponse introduced there)
  for (const name of ['Get MR Commits', 'Update State', 'Post Commit Comment', 'Edit MR Description', 'Get Members']) {
    const n = wf.nodes.find((x) => x.name === name);
    assert.ok(n, `${name} present`);
    const opt = JSON.stringify(n.parameters.options || {});
    if (name !== 'Get Members') assert.ok(!opt.includes('fullResponse'), `${name} options must stay unchanged: ${opt}`);
  }
  // barrier code nodes must not attempt HTTP (sandbox would fail anyway)
  for (const name of NEW_BARRIER_NODES) {
    const n = wf.nodes.find((x) => x.name === name);
    assert.ok(!JSON.stringify(n.parameters).match(/https?:\/\//) || n.name === 'Wait for Plane Retry', `${name} must not make HTTP calls`);
  }
});

test('graph: classifier references Prepare Lookup Attempt by exact node name', () => {
  const classify = jsCodeOf(wf, 'Classify Lookup Batch');
  assert.ok(classify.includes("$('Prepare Lookup Attempt').itemMatching(i)"));
});

test('MCP ops artifact (when present): atomic, references real nodes, sets retryOnFail off', () => {
  if (!fs.existsSync(opsArtifactPath)) return; // artifact is gitignored; portable check
  const ops = JSON.parse(fs.readFileSync(opsArtifactPath, 'utf8'));
  assert.equal(ops.artifactMeta.baselineVersionId, 'f9c04504-c603-4f12-a24d-48981d68a56e');
  const types = ops.operations.map((o) => o.type);
  assert.equal(types.filter((t) => t === 'addNode').length, 5);
  assert.ok(types.includes('setNodeSettings'));
  const settingsOp = ops.operations.find((o) => o.type === 'setNodeSettings');
  assert.equal(settingsOp.nodeName, 'Get Work Item');
  assert.equal(settingsOp.settings.retryOnFail, false);
  // old connections removed, new ones added
  const removed = ops.operations.filter((o) => o.type === 'removeConnection');
  assert.deepEqual(
    removed.map((o) => [o.source, o.target]).sort(),
    [['Get Work Item', 'Apply Guards'], ['Reducer', 'Get Work Item']].sort(),
  );
  const added = ops.operations.filter((o) => o.type === 'addConnection');
  assert.equal(added.length, 8);
  assert.ok(added.some((o) => o.source === 'Wait for Plane Retry' && o.target === 'Prepare Lookup Attempt'));
  assert.ok(added.some((o) => o.source === 'Lookup Batch Ready?' && o.target === 'Unwrap Lookup Batch' && o.sourceIndex === 0));
  assert.ok(added.some((o) => o.source === 'Lookup Batch Ready?' && o.target === 'Wait for Plane Retry' && o.sourceIndex === 1));
  // no removeNode / no node re-adds of existing nodes
  assert.ok(!types.includes('removeNode'));
  // exactly ONE organizational group op, byte-consistent with the repo snapshot
  const groupOps = ops.operations.filter((o) => o.type === 'setNodeGroups');
  assert.equal(groupOps.length, 1, 'exactly one setNodeGroups op (organizational only)');
  const persistedGroup = groupOps[0].nodeGroups[0];
  const snapshotGroups = wf.nodeGroups || [];
  assert.equal(snapshotGroups.length, 1, 'repo snapshot carries the published group');
  assert.deepEqual(persistedGroup, snapshotGroups[0], 'persisted group op must match repo snapshot nodeGroups exactly');
  assert.equal(
    ops.operations.length,
    ops.artifactMeta.operationsCount,
    'artifactMeta.operationsCount must match actual op count',
  );
});

test('backstop workflow file is untouched by the barrier change', () => {
  const b = loadBackstop();
  assert.equal(b.name, 'GitLab-Plane Bridge (Backstop)');
  const names = b.nodes.map((n) => n.name);
  assert.ok(names.includes('Every 15 min'), '15-min schedule backstop intact');
  for (const barrier of NEW_BARRIER_NODES) {
    assert.ok(!names.includes(barrier), `backstop must not contain barrier node: ${barrier}`);
    assert.ok(!JSON.stringify(b.connections).includes(barrier));
  }
  // backstop chain unchanged
  const c = b.connections;
  const has = (s, t) => (c[s]?.main?.[0] || []).some((x) => x.node === t);
  assert.ok(has('Every 15 min', 'Backstop Init'));
  assert.ok(has('Backstop Init', 'List Group Projects'));
  assert.ok(has('List Group Projects', 'Split Projects'));
  assert.ok(has('Split Projects', 'List Commits'));
  assert.ok(has('List Commits', 'Process Commits'));
  assert.ok(has('Process Commits', 'Reducer'));
  assert.ok(has('Reducer', 'Get Work Item'));
  assert.ok(has('Get Work Item', 'Apply Guards'));
  assert.ok(has('Apply Guards', 'Create Comment'));
  assert.ok(has('Apply Guards', 'Should Change State?'));
  assert.ok(has('Create Comment', 'Validate Comment Result'));
  // candidate realtime must not leak into backstop
  assert.ok(!JSON.stringify(b).includes('KxGMbmgawXOh4Dgk'));
});

test('candidate file itself is a valid standalone workflow JSON', () => {
  const raw = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  assert.equal(raw.nodes.length, wf.nodes.length);
  assert.equal(raw.settings.executionOrder, 'v1');
  // Publication-tolerant version metadata: the snapshot versionId tracks the
  // authoritative live version and legitimately changes on every publish
  // (f9c04504… baseline -> 5b46bbca… published). Pin its SHAPE and internal
  // consistency — never a specific published UUID hardcode.
  assert.equal(typeof raw.versionId, 'string');
  assert.match(
    raw.versionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'versionId must be a non-empty UUID-shaped value',
  );
  if (raw.activeVersionId !== undefined) {
    assert.equal(raw.activeVersionId, raw.versionId, 'activeVersionId must equal the snapshot versionId');
  }
  assert.equal(raw.id, 'gl-plane-rt-01', 'portable repo id unchanged');
  // unique node names + unique ids
  const names = raw.nodes.map((n) => n.name);
  assert.equal(new Set(names).size, names.length);
  const ids = raw.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  // connections only reference existing node names
  for (const [src, c] of Object.entries(raw.connections)) {
    assert.ok(names.includes(src), `connection source missing: ${src}`);
    for (const outs of c.main) for (const t of outs || []) assert.ok(names.includes(t.node), `connection target missing: ${t.node}`);
  }
});
