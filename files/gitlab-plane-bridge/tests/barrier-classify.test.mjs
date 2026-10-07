// Classify Lookup Batch — retry policy, delay policy, barrier semantics.
// Runs the ACTUAL jsCode stored in the candidate workflow via helpers.runCodeNode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCandidate, jsCodeOf, runCodeNode, nodeRef, missingNodeRef, brokenPreparedNodeRef,
  decision, httpResp,
} from './helpers.mjs';

const wf = loadCandidate();
const classify = jsCodeOf(wf, 'Classify Lookup Batch');

function preparedBatch(keys, attempt = 1) {
  return keys.map((k) => ({ json: { issueKey: k, attempt, batchSize: keys.length, originalDecision: decision(k) } }));
}

function classifyRun(preparedKeys, responses, { attempt = 1, nodeRefs = {}, fixedNow = null } = {}) {
  const prepared = preparedBatch(preparedKeys, attempt);
  return runCodeNode(classify, {
    items: responses,
    nodeRefs: { 'Prepare Lookup Attempt': nodeRef(prepared), ...nodeRefs },
    fixedNow,
  });
}

const OK = (key, overrides = {}) => httpResp(200, { body: { id: 'wi-' + key, project: 'p1', state: 'st-todo', assignees: [] }, ...overrides });

test('mixed ordering: 429 first, others 200 -> single retry summary, nothing released', () => {
  const out = classifyRun(['SMK-1', 'SMK-2', 'SMK-3'], [httpResp(429), OK('SMK-2'), OK('SMK-3')]);
  assert.equal(out.length, 1, 'exactly ONE summary item — the two 200s must not be released');
  const s = out[0].json;
  assert.equal(s.ready, false);
  assert.equal(s.__planeLookupRetry, true);
  assert.equal(s.attempt, 2);
  assert.equal(s.batchSize, 3);
  assert.deepEqual(s.issueKeys, ['SMK-1', 'SMK-2', 'SMK-3']);
  assert.equal(s.decisions.length, 3);
  assert.deepEqual(s.decisions[0], decision('SMK-1'), 'ORIGINAL decision carried unchanged');
});

test('mixed ordering: 429 second (not first) -> same summary behavior', () => {
  const out = classifyRun(['SMK-1', 'SMK-2', 'SMK-3'], [OK('SMK-1'), httpResp(429), OK('SMK-3')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.ready, false);
  assert.equal(out[0].json.attempt, 2);
  assert.equal(out[0].json.decisions.length, 3);
});

test('attempt budget: 3 attempts TOTAL -> exactly 2 waits, 3rd 429 throws', () => {
  // attempt 1 -> summary attempt 2
  const r1 = classifyRun(['SMK-1'], [httpResp(429)], { attempt: 1 });
  assert.equal(r1[0].json.attempt, 2);
  // attempt 2 -> summary attempt 3
  const r2 = classifyRun(['SMK-1'], [httpResp(429)], { attempt: 2 });
  assert.equal(r2[0].json.attempt, 3);
  // attempt 3 -> throw, no release, no further wait
  assert.throws(
    () => classifyRun(['SMK-1'], [httpResp(429)], { attempt: 3 }),
    (e) => /after 3 attempts \(HTTP 429\)/.test(e.message),
  );
});

test('permanent statuses 401/403/404/500 throw immediately: no wait, no release', () => {
  for (const status of [401, 403, 404, 500]) {
    assert.throws(
      () => classifyRun(['SMK-1', 'SMK-2'], [OK('SMK-1'), httpResp(status, { body: { message: 'nope' } })]),
      (e) => e.message.includes(`HTTP ${status}`) && e.message.includes('permanent failure'),
      `status ${status} must throw`,
    );
  }
});

test('mixed success + permanent failure -> no release at all', () => {
  assert.throws(
    () => classifyRun(['SMK-1', 'SMK-2', 'SMK-3'], [OK('SMK-1'), httpResp(500), OK('SMK-3')]),
    /HTTP 500/,
  );
});

test('429-only policy: 5xx never retried, 429 never fatal before budget', () => {
  // 503 is permanent (not 429) even though it is a "retryable-looking" 5xx
  assert.throws(() => classifyRun(['SMK-1'], [httpResp(503)]), /HTTP 503/);
  // 429 at attempt 1/2 must NOT throw
  assert.equal(classifyRun(['SMK-1'], [httpResp(429)], { attempt: 1 })[0].json.ready, false);
  assert.equal(classifyRun(['SMK-1'], [httpResp(429)], { attempt: 2 })[0].json.ready, false);
});

test('Retry-After parsing: seconds FLOOR 600, long wait honored, malformed/missing/zero -> 600', () => {
  const delay = (headers, fixedNow = null) =>
    classifyRun(['SMK-1'], [httpResp(429, { headers })], { fixedNow })[0].json.retryDelaySeconds;
  assert.equal(delay({ 'retry-after': '30' }), 600, 'short server wait floored to 600');
  assert.equal(delay({ 'Retry-After': '30' }), 600, 'header lookup is case-insensitive');
  assert.equal(delay({ 'retry-after': '1200' }), 1200, 'long server wait HONORED (600 is floor, never a cap)');
  assert.equal(delay({ 'retry-after': '601' }), 601);
  assert.equal(delay({ 'retry-after': '600' }), 600);
  assert.equal(delay({ 'retry-after': '0' }), 600, 'non-positive falls back to 600');
  assert.equal(delay({ 'retry-after': '-5' }), 600);
  assert.equal(delay({ 'retry-after': 'soon-ish' }), 600, 'malformed falls back to 600');
  assert.equal(delay({}), 600, 'missing header falls back to 600');
  assert.equal(delay({ 'x-other': '1' }), 600);
});

test('Retry-After HTTP-date: future date honored with FLOOR 600, past date -> 600', () => {
  const NOW = 1_700_000_000_000;
  const future = new Date(NOW + 120_000).toUTCString();
  const longFuture = new Date(NOW + 1_200_000).toUTCString();
  const past = new Date(NOW - 120_000).toUTCString();
  assert.equal(classifyRun(['SMK-1'], [httpResp(429, { headers: { 'retry-after': future } })], { fixedNow: NOW })[0].json.retryDelaySeconds, 600, 'short future date floored to 600');
  assert.equal(classifyRun(['SMK-1'], [httpResp(429, { headers: { 'retry-after': longFuture } })], { fixedNow: NOW })[0].json.retryDelaySeconds, 1200, 'long future HTTP-date honored (floor, never capped)');
  assert.equal(classifyRun(['SMK-1'], [httpResp(429, { headers: { 'retry-after': past } })], { fixedNow: NOW })[0].json.retryDelaySeconds, 600);
});

test('delay = max(600, max valid Retry-After) across all 429s in the batch', () => {
  const out = classifyRun(
    ['SMK-1', 'SMK-2', 'SMK-3'],
    [httpResp(429, { headers: { 'retry-after': '10' } }), httpResp(429, { headers: { 'retry-after': '45' } }), httpResp(429)],
  );
  // every value floors to 600; third 429 has no Retry-After (malformed -> 600).
  assert.equal(out[0].json.retryDelaySeconds, 600);

  const out2 = classifyRun(
    ['SMK-1', 'SMK-2'],
    [httpResp(429, { headers: { 'retry-after': '900' } }), httpResp(429, { headers: { 'retry-after': '1200' } })],
  );
  assert.equal(out2[0].json.retryDelaySeconds, 1200, 'max LONG wait across the batch honored (floor 600)');

  const out3 = classifyRun(
    ['SMK-1', 'SMK-2'],
    [httpResp(429, { headers: { 'retry-after': '30' } }), httpResp(429, { headers: { 'retry-after': '900' } })],
  );
  assert.equal(out3[0].json.retryDelaySeconds, 900, 'long wait dominates short (floored) wait');
});

test('all success -> whole batch released ONCE with fresh work items and original decisions', () => {
  const out = classifyRun(['SMK-1', 'SMK-2'], [OK('SMK-1'), OK('SMK-2')], { attempt: 2 });
  assert.equal(out.length, 2, 'one item per response, released together');
  assert.ok(out.every((i) => i.json.ready === true));
  assert.ok(out.every((i) => i.json.attempt === 2));
  assert.ok(out.every((i) => i.json.batchSize === 2));
  assert.deepEqual(out.map((i) => i.json.issueKey), ['SMK-1', 'SMK-2']);
  assert.deepEqual(out[0].json.workItem, { id: 'wi-SMK-1', project: 'p1', state: 'st-todo', assignees: [] });
  assert.deepEqual(out[0].json.originalDecision, decision('SMK-1'));
  assert.deepEqual(out.map((i) => i.pairedItem), [{ item: 0 }, { item: 1 }]);
});

test('context recovery: missing paired prepared request throws (NO numeric fallback)', () => {
  assert.throws(
    () => runCodeNode(classify, {
      items: [OK('SMK-1')],
      nodeRefs: { 'Prepare Lookup Attempt': missingNodeRef() },
    }),
    /no paired Prepare Lookup Attempt item.*context missing or ambiguous/,
  );
});

test('context recovery: paired prepared item missing originalDecision throws', () => {
  assert.throws(
    () => runCodeNode(classify, {
      items: [OK('SMK-1')],
      nodeRefs: { 'Prepare Lookup Attempt': brokenPreparedNodeRef() },
    }),
    /missing issueKey\/originalDecision/,
  );
});

test('no hidden fallback to Reducer: classifier must not reference $(\'Reducer\')', () => {
  assert.ok(!classify.includes("$('Reducer')"), 'classifier must recover via Prepare Lookup Attempt only');
});

test('context assertions: response count / batchSize / attempt / unique keys enforced', () => {
  // fewer responses than batchSize
  const prepared = [
    { json: { issueKey: 'SMK-1', attempt: 1, batchSize: 2, originalDecision: decision('SMK-1') } },
    { json: { issueKey: 'SMK-2', attempt: 1, batchSize: 2, originalDecision: decision('SMK-2') } },
  ];
  assert.throws(
    () => runCodeNode(classify, { items: [OK('SMK-1')], nodeRefs: { 'Prepare Lookup Attempt': nodeRef(prepared) } }),
    /expected 2 responses, got 1/,
  );
  // attempt mismatch across batch
  const mixedAttempt = [
    { json: { issueKey: 'SMK-1', attempt: 1, batchSize: 2, originalDecision: decision('SMK-1') } },
    { json: { issueKey: 'SMK-2', attempt: 2, batchSize: 2, originalDecision: decision('SMK-2') } },
  ];
  assert.throws(
    () => runCodeNode(classify, { items: [OK('SMK-1'), OK('SMK-2')], nodeRefs: { 'Prepare Lookup Attempt': nodeRef(mixedAttempt) } }),
    /attempt mismatch across batch/,
  );
  // duplicate issue keys across prepared items
  const dup = [
    { json: { issueKey: 'SMK-1', attempt: 1, batchSize: 2, originalDecision: decision('SMK-1') } },
    { json: { issueKey: 'SMK-1', attempt: 1, batchSize: 2, originalDecision: decision('SMK-1') } },
  ];
  assert.throws(
    () => runCodeNode(classify, { items: [OK('SMK-1'), OK('SMK-1')], nodeRefs: { 'Prepare Lookup Attempt': nodeRef(dup) } }),
    /duplicate issueKey in batch/,
  );
});

test('error hygiene: thrown messages never leak body keys or auth headers', () => {
  const dirty = httpResp(500, {
    body: { XApiKey: 'sk-secret-value', internalField: 'sensitive' },
    headers: { 'x-api-key': 'plane-secret-key', server: 'plane' },
  });
  try {
    classifyRun(['SMK-1'], [dirty]);
    assert.fail('expected throw');
  } catch (e) {
    const msg = e.message;
    assert.ok(msg.includes('HTTP 500'));
    assert.ok(!/secret/i.test(msg), 'no secret material in error: ' + msg);
    assert.ok(!msg.includes('XApiKey') && !msg.includes('internalField'), 'no body keys in error: ' + msg);
    assert.ok(!msg.includes('server') || !msg.includes('plane-secret'), 'no header values in error: ' + msg);
  }
  // 429-exhausted error must also stay clean
  try {
    classifyRun(['SMK-1'], [httpResp(429, { headers: { 'retry-after': '5' } })], { attempt: 3 });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(!/secret/i.test(e.message));
  }
});
