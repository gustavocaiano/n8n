// Prepare Lookup Attempt + Unwrap Lookup Batch: batch/attempt/context handling.
// Runs the ACTUAL jsCode stored in the candidate workflow via helpers.runCodeNode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCandidate, jsCodeOf, runCodeNode, decision, SMOKE_CFG } from './helpers.mjs';

const wf = loadCandidate();
const prepare = jsCodeOf(wf, 'Prepare Lookup Attempt');
const unwrap = jsCodeOf(wf, 'Unwrap Lookup Batch');

test('Prepare: first round wraps Reducer decisions with attempt 1 + batchSize', () => {
  const d1 = decision('SMK-1');
  const d2 = decision('SMK-2');
  const out = runCodeNode(prepare, { items: [{ json: d1 }, { json: d2 }] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].json, { issueKey: 'SMK-1', attempt: 1, batchSize: 2, originalDecision: d1 });
  assert.deepEqual(out[1].json, { issueKey: 'SMK-2', attempt: 1, batchSize: 2, originalDecision: d2 });
});

test('Prepare: retry round rebuilds the SAME batch from carried ORIGINAL decisions', () => {
  const d1 = decision('SMK-1');
  const d2 = decision('SMK-2');
  const summary = { json: { ready: false, __planeLookupRetry: true, attempt: 2, retryDelaySeconds: 600, batchSize: 2, issueKeys: ['SMK-1', 'SMK-2'], decisions: [d1, d2] } };
  const out = runCodeNode(prepare, { items: [summary] });
  assert.equal(out.length, 2);
  assert.ok(out.every((i) => i.json.attempt === 2), 'attempt counter comes from the summary item JSON');
  assert.deepEqual(out[0].json.originalDecision, d1, 'original decision preserved exactly');
  assert.deepEqual(out[1].json.originalDecision, d2);
  assert.equal(out[0].json.batchSize, 2);
});

test('Prepare: attempt 3 summary still allowed, attempt 4 rejected', () => {
  const summary = (attempt) => ({ json: { __planeLookupRetry: true, attempt, batchSize: 1, decisions: [decision('SMK-1')] } });
  assert.equal(runCodeNode(prepare, { items: [summary(3)] })[0].json.attempt, 3);
  assert.throws(() => runCodeNode(prepare, { items: [summary(4)] }), /invalid retry attempt 4/);
  assert.throws(() => runCodeNode(prepare, { items: [summary(1)] }), /invalid retry attempt 1/);
});

test('Prepare: malformed summary rejected (no decisions / batchSize mismatch / multi-item)', () => {
  assert.throws(() => runCodeNode(prepare, { items: [{ json: { __planeLookupRetry: true, attempt: 2 } }] }), /retry summary has no decisions/);
  assert.throws(
    () => runCodeNode(prepare, { items: [{ json: { __planeLookupRetry: true, attempt: 2, batchSize: 3, decisions: [decision('SMK-1')] } }] }),
    /batchSize 3 != decisions.length 1/,
  );
  assert.throws(
    () => runCodeNode(prepare, {
      items: [
        { json: { __planeLookupRetry: true, attempt: 2, decisions: [decision('SMK-1')] } },
        { json: { __planeLookupRetry: true, attempt: 2, decisions: [decision('SMK-1')] } },
      ],
    }),
    /retry summary must be a single item/,
  );
});

test('Prepare: validation failures — empty, missing key/fields, duplicate issueKey', () => {
  assert.throws(() => runCodeNode(prepare, { items: [] }), /no input items/);
  assert.throws(() => runCodeNode(prepare, { items: [{ json: {} }] }), /decision missing issueKey/);
  assert.throws(
    () => runCodeNode(prepare, { items: [{ json: decision('SMK-1', { commentHtml: undefined }) }] }),
    /malformed decision for SMK-1/,
  );
  assert.throws(
    () => runCodeNode(prepare, { items: [{ json: decision('SMK-1') }, { json: decision('SMK-1') }] }),
    /duplicate issueKey SMK-1 in batch/,
  );
});

test('counter travels in item JSON, never staticData', () => {
  for (const code of [prepare, jsCodeOf(wf, 'Classify Lookup Batch'), unwrap]) {
    assert.ok(!code.includes('$getWorkflowStaticData'), 'barrier code must not use staticData');
  }
});

const okReadyItem = (key, attempt, body = { id: 'wi-' + key, project: 'p1', state: 'st-todo', assignees: [] }) => ({
  json: { ready: true, attempt, batchSize: 3, issueKey: key, statusCode: 200, workItem: body, originalDecision: decision(key) },
  pairedItem: { item: 0 },
});

test('Unwrap: expands fresh work items with EXACT original decision embedded', () => {
  const body = { id: 'wi-SMK-1-r2', project: 'p1', state: 'st-todo', assignees: [] };
  const items = [okReadyItem('SMK-1', 2, body), okReadyItem('SMK-2', 2), okReadyItem('SMK-3', 2)];
  items.forEach((i, idx) => { i.pairedItem.item = idx; });
  const out = runCodeNode(unwrap, { items });
  assert.equal(out.length, 3);
  const first = out[0].json;
  assert.equal(first.id, 'wi-SMK-1-r2', 'fresh FINAL-round work item fields at top level');
  assert.equal(first.project, 'p1');
  assert.equal(first.state, 'st-todo');
  assert.deepEqual(first.__originalDecision, decision('SMK-1'), 'exact original decision embedded');
  assert.deepEqual(out.map((i) => i.pairedItem), [{ item: 0 }, { item: 1 }, { item: 2 }]);
});

test('Unwrap: refuses partial/subset releases and inconsistent context', () => {
  // ready flag missing
  assert.throws(() => runCodeNode(unwrap, { items: [{ json: { batchSize: 1, attempt: 2, issueKey: 'SMK-1', workItem: { id: 'x', project: 'p', state: 's' }, originalDecision: decision('SMK-1') } }] }), /without a successful classification/);
  // length mismatch vs batchSize (subset!)
  assert.throws(() => runCodeNode(unwrap, { items: [okReadyItem('SMK-1', 2)] }), /expected 3 items, got 1/);
  // duplicate keys
  const dup = [okReadyItem('SMK-1', 2), okReadyItem('SMK-1', 2), okReadyItem('SMK-2', 2)];
  assert.throws(() => runCodeNode(unwrap, { items: dup }), /duplicate issueKey in released batch/);
  // attempt mismatch
  const mixed = [okReadyItem('SMK-1', 2), okReadyItem('SMK-2', 3), okReadyItem('SMK-3', 2)];
  assert.throws(() => runCodeNode(unwrap, { items: mixed }), /attempt\/batchSize mismatch/);
});

test('Unwrap: decision/workitem validation — key mismatch, missing fields', () => {
  const badDecision = okReadyItem('SMK-1', 2);
  badDecision.json.originalDecision = decision('SMK-9');
  assert.throws(() => runCodeNode(unwrap, { items: [badDecision, okReadyItem('SMK-2', 2), okReadyItem('SMK-3', 2)] }), /decision missing or issueKey mismatch for SMK-1/);

  const noId = okReadyItem('SMK-1', 2, { project: 'p1', state: 'st-todo' });
  assert.throws(() => runCodeNode(unwrap, { items: [noId, okReadyItem('SMK-2', 2), okReadyItem('SMK-3', 2)] }), /missing id\/project\/state/);

  const badDecisionFields = okReadyItem('SMK-1', 2);
  badDecisionFields.json.originalDecision = decision('SMK-1', { externalId: undefined });
  assert.throws(() => runCodeNode(unwrap, { items: [badDecisionFields, okReadyItem('SMK-2', 2), okReadyItem('SMK-3', 2)] }), /malformed decision for SMK-1/);
});

test('candidate uses the real state map env in Apply Guards (production parity)', () => {
  const guards = jsCodeOf(wf, 'Apply Guards');
  assert.ok(guards.includes('JSON.parse($env.PLANE_PROJECT_DEV)'), 'production Apply Guards must read $env.PLANE_PROJECT_DEV');
  assert.ok(!guards.includes("$('Reducer').all()"), 'guards must consume the embedded decision, not the Reducer pairing');
});
