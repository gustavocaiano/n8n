// MR comment references — note-event routing, human-note filtering, paginated
// MR notes fetch, and lifecycle scanning of ALL human MR notes.
// Runs the ACTUAL jsCode stored in workflow-1-realtime.json via helpers
// (node:test + node:vm, dependency-free). Barrier regressions live in the
// barrier-*.test.mjs files; this file covers the MR-comment feature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCandidate, jsCodeOf, runCodeNode, nodeRef, decision, SMOKE_CFG, MR_COMMENT_NODES,
} from './helpers.mjs';

const wf = loadCandidate();
const ENV = { WORKSPACE_SLUG: 'smokews', PLANE_PROJECT_DEV: JSON.stringify(SMOKE_CFG) };

const filterNotes = jsCodeOf(wf, 'Filter MR Notes');
const normalizeNote = jsCodeOf(wf, 'Normalize MR Note');
const lifecycle = jsCodeOf(wf, 'Normalize MR (with commits)');
const reducer = jsCodeOf(wf, 'Reducer');
const guards = jsCodeOf(wf, 'Apply Guards');
const linkback = jsCodeOf(wf, 'Prepare GitLab Linkback');

test('MR linkback skips unchanged descriptions to prevent webhook feedback loops', () => {
  const item = { issueKey: 'DEV-224', workItemUrl: 'https://plane.example/DEV-224/', mrIid: 234, gitlabProjectId: '2601', commitShas: [] };
  for (const mrDescription of ['Summary without issue references', 'closes [DEV-224](https://plane.example/DEV-224/)']) {
    assert.equal(runCodeNode(linkback, { items: [{ json: { ...item, mrDescription } }] }).length, 0);
  }
});

test('MR Note? boolean operands are valid under strict n8n type validation', () => {
  const filter = wf.nodes.find(node => node.name === 'MR Note?');
  const conditions = filter.parameters.conditions.conditions;
  for (const condition of conditions.filter(value => value.operator.type === 'boolean')) {
    assert.equal(typeof condition.rightValue, 'boolean', 'n8n validates both operands, even for unary is-true checks');
  }
});

// --- payload builders --------------------------------------------------------

/** GitLab note-event webhook payload (note on a merge request). */
function notePayload({ note = '', noteable_type = 'MergeRequest', system = false, action = 'create', mrState = 'opened', target_branch = 'feature/x', projectDefault = 'master', title = 'MR title' } = {}) {
  return {
    object_kind: 'note',
    object_attributes: { note, noteable_type, system, action, url: 'https://gitlab.example.com/g/Repo/-/merge_requests/9#note_1' },
    merge_request: {
      iid: 9, state: mrState, target_branch, title, description: '',
      url: 'https://gitlab.example.com/g/Repo/-/merge_requests/9',
    },
    project: { id: 42, default_branch: projectDefault },
    user: { email: '', username: 'alice', name: 'Alice' },
  };
}

/** GitLab merge-request-event webhook payload. */
function mrPayload({ action = 'open', description = '', target_branch = 'feature/x', projectDefault = 'master', title = 'MR title' } = {}) {
  return {
    object_kind: 'merge_request',
    object_attributes: {
      iid: 9, action, target_branch, source_branch: 'feature/x', description, title,
      url: 'https://gitlab.example.com/g/Repo/-/merge_requests/9', merge_commit_sha: 'abc123',
    },
    project: { id: 42, default_branch: projectDefault },
    user: { email: '', username: 'alice', name: 'Alice' },
  };
}

/** Run "Normalize MR Note" against a single note webhook payload. */
function noteRun(payload) {
  return runCodeNode(normalizeNote, { items: [{ json: payload }], env: ENV });
}

/** Run "Normalize MR (with commits)" for a lifecycle action with notes+commits.
 * Models the SEQUENTIAL graph: the normalizer's $input receives only filtered
 * note messages; commits arrive via $('Get MR Commits').all(). */
function lifecycleRun(action, { description = '', commits = [], notes = [], target_branch = 'feature/x', projectDefault = 'master' } = {}) {
  const payload = mrPayload({ action, description, target_branch, projectDefault });
  const items = notes.map((body) => ({ json: { message: body } }));
  return runCodeNode(lifecycle, {
    items,
    env: ENV,
    nodeRefs: {
      'MR Action?': nodeRef([{ json: payload }]),
      'Get MR Commits': nodeRef(commits.map((c) => ({ json: c }))),
    },
  });
}

/** Run "Filter MR Notes" against paginated note items (object or array pages). */
function filterRun(pages) {
  return runCodeNode(filterNotes, { items: pages.map((j) => ({ json: j })) });
}

/** Reduce note-derived refs (reducer output items) into per-issue decisions. */
function reduce(items) {
  return runCodeNode(reducer, { items: items.map((j) => ({ json: j })) , env: ENV });
}

const mrItem = (action, issueKey = 'DEV-240', overrides = {}) => ({
  issueKey, action, source: 'mr', mrIid: 9,
  mrUrl: 'https://gitlab.example.com/g/Repo/-/merge_requests/9',
  mrTitle: 'MR title', mrDescription: '', gitlabProjectId: '42',
  planeProjectUuid: SMOKE_CFG.uuid, actorEmail: '', actorUsername: 'alice', actorName: 'Alice',
  ...overrides,
});

function guard(state, decisionJson) {
  const item = { json: { id: 'wi-1', project: 'p1', state, assignees: [], __originalDecision: decisionJson } };
  return runCodeNode(guards, { items: [item], env: ENV })[0].json;
}

// --- 1. Filter MR Notes ------------------------------------------------------

test('filter notes: system notes dropped, human notes reshaped to { message }', () => {
  const out = filterRun([
    { body: 'changed description', system: true },
    { body: 'closes DEV-240', system: false },
    { body: 'plain comment', system: undefined },
  ]);
  assert.deepEqual(out.map((i) => i.json), [{ message: 'closes DEV-240' }, { message: 'plain comment' }]);
});

test('filter notes: tolerates whole-page array items from the HTTP node', () => {
  const out = filterRun([
    [{ body: 'a', system: true }, { body: 'b', system: false }],
    [{ body: 'c', system: false }],
  ]);
  assert.deepEqual(out.map((i) => i.json), [{ message: 'b' }, { message: 'c' }]);
});

test('filter notes: safe failure on malformed page (no silent partial scan)', () => {
  assert.throws(
    () => filterRun([{ body: 'ok' }, { id: 1 }]),
    /note at index 1 has no body/,
  );
  assert.throws(
    () => filterRun([null]),
    /unexpected non-object note at index 0/,
  );
});

test('no human notes: system-only pages and the known empty placeholder degrade to ONE empty sentinel message', () => {
  assert.deepEqual(filterRun([{ body: 'changed description', system: true }]).map((i) => i.json), [{ message: '' }]);
  assert.deepEqual(filterRun([{}]).map((i) => i.json), [{ message: '' }], "alwaysOutputData placeholder {} tolerated");
  assert.deepEqual(filterRun([{ body: 'x', system: true }, {}]).map((i) => i.json), [{ message: '' }]);
  assert.deepEqual(filterRun([]).map((i) => i.json), [{ message: '' }], 'empty input still yields the sentinel');
  // a note object WITH fields but no body remains a true malformed failure
  assert.throws(() => filterRun([{ id: 5 }]), /has no body/);
});

// --- 2. Normalize MR Note: event filters -------------------------------------

test('note filters: only MR notes, never system notes, never non-create/update', () => {
  assert.deepEqual(noteRun(notePayload({ noteable_type: 'Issue' })), [], 'issue comments ignored');
  assert.deepEqual(noteRun(notePayload({ noteable_type: 'Commit' })), [], 'commit comments ignored');
  assert.deepEqual(noteRun(notePayload({ system: true, note: 'closes DEV-240' })), [], 'system notes ignored');
  assert.deepEqual(noteRun(notePayload({ action: 'destroy', note: 'closes DEV-240' })), [], 'non-create/update ignored');
  assert.equal(noteRun(notePayload({ action: 'update', note: 'closes DEV-240' })).length, 1, 'update accepted');
  assert.equal(noteRun(notePayload({ action: 'create', note: 'closes DEV-240' })).length, 1, 'create accepted');
  assert.equal(noteRun(notePayload({ action: undefined, note: 'closes DEV-240' })).length, 1, 'legacy payloads without action treated as create');
});

// --- 3. Normalize MR Note: markdown plain/linked refs + dedup ----------------

test('note refs: plain and markdown-linked close refs both map to close-in-mr on an open MR', () => {
  assert.deepEqual(noteRun(notePayload({ note: 'closes DEV-240' })).map((i) => i.json.action), ['close-in-mr']);
  assert.deepEqual(noteRun(notePayload({ note: 'fixes [DEV-240](https://plane.example/browse/DEV-240/)' })).map((i) => i.json.action), ['close-in-mr']);
  assert.deepEqual(noteRun(notePayload({ note: 'resolves DEV-240' })).map((i) => i.json.action), ['close-in-mr']);
});

test('note refs: reopen plain and linked map to reopen', () => {
  assert.deepEqual(noteRun(notePayload({ note: 'reopens DEV-240' })).map((i) => i.json.action), ['reopen']);
  assert.deepEqual(noteRun(notePayload({ note: 'reopens [DEV-240](https://plane.example/browse/DEV-240/)' })).map((i) => i.json.action), ['reopen']);
});

test('note refs: bare mention is NOT a closure — maps to mr-open (In Progress)', () => {
  const out = noteRun(notePayload({ note: 'looking at DEV-240 next' }));
  assert.deepEqual(out.map((i) => i.json.action), ['mr-open']);
});

test('note refs: bare linked mention maps to mr-open', () => {
  const out = noteRun(notePayload({ note: 'tracking in [DEV-240](https://plane.example/browse/DEV-240/)' }));
  assert.deepEqual(out.map((i) => i.json.action), ['mr-open']);
});

test('note refs: mixed-case keys rejected', () => {
  assert.deepEqual(noteRun(notePayload({ note: 'closes dev-240' })), []);
});

test('note refs: repeats dedup — same key twice in one note yields one ref; close beats bare', () => {
  const out = noteRun(notePayload({ note: 'closes DEV-240 and again closes DEV-240' }));
  assert.equal(out.length, 1);
  const mixed = noteRun(notePayload({ note: 'DEV-240 closes DEV-240' }));
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].json.action, 'close-in-mr');
});

test('note refs: MR title is NEVER parsed', () => {
  const out = noteRun(notePayload({ note: 'no refs here', title: 'fix DEV-999 closes DEV-998' }));
  assert.deepEqual(out, []);
});

// --- 4. Normalize MR Note: state/target awareness ----------------------------

test('note lifecycle: closing comment on an OPEN MR -> close-in-mr (In Review)', () => {
  const out = noteRun(notePayload({ note: 'closes DEV-240', mrState: 'opened' }));
  assert.equal(out[0].json.action, 'close-in-mr');
  assert.equal(out[0].json.mrIid, 9);
  assert.equal(out[0].json.source, 'mr');
});

test('note lifecycle: close ref on a MERGED MR -> merged for validated targets (default + dev), close-in-mr otherwise', () => {
  const def = noteRun(notePayload({ note: 'closes DEV-240', mrState: 'merged', target_branch: 'master', projectDefault: 'master' }));
  assert.equal(def[0].json.action, 'merged');
  const dev = noteRun(notePayload({ note: 'closes DEV-240', mrState: 'merged', target_branch: 'dev', projectDefault: 'master' }));
  assert.equal(dev[0].json.action, 'merged', 'dev is a validated branch of record');
  const other = noteRun(notePayload({ note: 'closes DEV-240', mrState: 'merged', target_branch: 'feature/x', projectDefault: 'master' }));
  assert.equal(other[0].json.action, 'close-in-mr');
});

test('note lifecycle: bare mention on a MERGED MR -> mention (never a false closure)', () => {
  const out = noteRun(notePayload({ note: 'DEV-240', mrState: 'merged', target_branch: 'master', projectDefault: 'master' }));
  assert.equal(out[0].json.action, 'mention');
});

test('note lifecycle: close ref on a CLOSED (unmerged) MR -> mr-closed reset path', () => {
  const out = noteRun(notePayload({ note: 'closes DEV-240', mrState: 'closed' }));
  assert.equal(out[0].json.action, 'mr-closed');
});

test('note lifecycle: unknown/missing MR state treated like opened (close-in-mr)', () => {
  const out = noteRun(notePayload({ note: 'closes DEV-240', mrState: '' }));
  assert.equal(out[0].json.action, 'close-in-mr');
});

test('note payloads: project resolved from object_attributes.project_id when payload project is absent', () => {
  const p = notePayload({ note: 'closes DEV-240' });
  delete p.project; // docs: the MR entity in note payloads carries no project_id
  p.object_attributes.project_id = 42;
  const out = noteRun(p);
  assert.equal(out[0].json.gitlabProjectId, '42', 'falls back to the note object_attributes.project_id');
  assert.equal(out[0].json.mrIid, 9, 'merge_request.iid used (never noteable_id)');
});

test('note edits: re-scanning an edited comment (action=update) is idempotent for the same action', () => {
  const created = noteRun(notePayload({ note: 'closes DEV-240', action: 'create' }));
  const edited = noteRun(notePayload({ note: 'closes DEV-240', action: 'update' }));
  assert.deepEqual(edited.map((i) => i.json.action), created.map((i) => i.json.action));
  assert.equal(
    reduce(edited.map((i) => i.json))[0].json.externalId,
    reduce(created.map((i) => i.json))[0].json.externalId,
    'same action label -> same external_id -> Plane 409, no duplicate on edit',
  );
});

test('note edits: an edit that flips close -> reopens emits a distinct guarded reopen decision', () => {
  const before = reduce(noteRun(notePayload({ note: 'closes DEV-240', action: 'create' })).map((i) => i.json));
  const after = reduce(noteRun(notePayload({ note: 'reopens DEV-240', action: 'update' })).map((i) => i.json));
  assert.equal(after[0].json.desiredStateName, 'reopen');
  assert.notEqual(after[0].json.externalId, before[0].json.externalId, 'new action label -> new external_id');
  assert.equal(after[0].json.targetStateUuid, SMOKE_CFG.states.inProgress);
});

// --- 5. Lifecycle events scan ALL human MR notes (comment-only refs) ---------

test('lifecycle merge: a close ref ONLY in an MR comment still closes (-> merged/Done on default)', () => {
  const out = lifecycleRun('merge', {
    target_branch: 'master', projectDefault: 'master',
    commits: [{ id: 'sha1', message: 'no refs here', title: 'no refs' }],
    notes: ['looks good, closes DEV-240'],
  });
  assert.deepEqual(out.map((i) => i.json.action), ['merged']);
  assert.equal(out[0].json.issueKey, 'DEV-240');
});

test('lifecycle merge: comment-only close ref into dev target also counts as merged', () => {
  const out = lifecycleRun('merge', { target_branch: 'dev', projectDefault: 'master', notes: ['closes DEV-240'] });
  assert.deepEqual(out.map((i) => i.json.action), ['merged']);
});

test('lifecycle merge: comment-only close ref into a non-validated target stays close-in-mr', () => {
  const out = lifecycleRun('merge', { target_branch: 'feature/x', projectDefault: 'master', notes: ['closes DEV-240'] });
  assert.deepEqual(out.map((i) => i.json.action), ['close-in-mr']);
});

test('lifecycle close: a reference ONLY in an MR comment resets via mr-closed', () => {
  const out = lifecycleRun('close', { notes: ['closes DEV-240'] });
  assert.deepEqual(out.map((i) => i.json.action), ['mr-closed']);
  assert.deepEqual(out.map((i) => i.json.issueKey), ['DEV-240']);
});

test('lifecycle open: comment-only bare mention maps to mr-open (In Progress)', () => {
  const out = lifecycleRun('open', { notes: ['ping DEV-240'] });
  assert.deepEqual(out.map((i) => i.json.action), ['mr-open']);
});

test('lifecycle: description + commits + notes scanned together, deduped per key+action', () => {
  const out = lifecycleRun('merge', {
    target_branch: 'master', projectDefault: 'master',
    description: 'closes DEV-240',
    commits: [{ id: 'sha1', message: 'closes DEV-240', title: 'closes DEV-240' }],
    notes: ['closes DEV-240'],
  });
  assert.equal(out.length, 1, 'same key+action across description/commits/notes collapses');
  assert.deepEqual(out.map((i) => i.json.action), ['merged']);
});

test('lifecycle: MR title is never parsed (no false closure from title)', () => {
  const out = lifecycleRun('merge', { target_branch: 'master', projectDefault: 'master', title: 'fix DEV-999 closes DEV-998', notes: [''], description: '' });
  // title carries refs but is never parsed; sentinel note + empty description -> no refs at all
  assert.deepEqual(out, []);
});

test('lifecycle: missing Get MR Commits context throws (no silent commit skip)', () => {
  assert.throws(
    () => runCodeNode(lifecycle, {
      items: [{ json: { message: '' } }],
      env: ENV,
      nodeRefs: { 'MR Action?': nodeRef([{ json: mrPayload({ action: 'open' }) }]) },
    }),
    /no run data provided for node 'Get MR Commits'/,
  );
});

test('precedence: closes in description/commits + reopens in a comment -> BOTH refs emitted, reopen wins in reducer', () => {
  const out = lifecycleRun('merge', {
    target_branch: 'master', projectDefault: 'master',
    description: 'closes DEV-240',
    commits: [{ id: 'sha1', message: 'closes DEV-240', title: 'closes DEV-240' }],
    notes: ['reopens DEV-240'],
  });
  assert.deepEqual(out.map((i) => i.json.action).sort(), ['merged', 'reopen'], 'note refs must reach the normalizer');
  const reduced = reduce(out.map((i) => i.json));
  assert.equal(reduced.length, 1);
  assert.equal(reduced[0].json.desiredStateName, 'reopen');
  assert.equal(reduced[0].json.targetStateUuid, SMOKE_CFG.states.inProgress);
});

test('precedence: closes in a comment + reopens in description/commits -> reopen still wins (ladder is source-agnostic)', () => {
  const out = lifecycleRun('merge', {
    target_branch: 'master', projectDefault: 'master',
    description: 'reopens DEV-240',
    commits: [{ id: 'sha1', message: 'reopens DEV-240', title: 'x' }],
    notes: ['closes DEV-240'],
  });
  assert.deepEqual(out.map((i) => i.json.action).sort(), ['merged', 'reopen']);
  const reduced = reduce(out.map((i) => i.json));
  assert.equal(reduced[0].json.desiredStateName, 'reopen');
});

test('no human notes: normalizer still runs on the sentinel and scans description/commits only', () => {
  const fromDescription = lifecycleRun('open', { description: 'closes DEV-240', notes: [''] });
  assert.deepEqual(fromDescription.map((i) => i.json.action), ['close-in-mr'], 'sentinel message matches nothing');
  const noRefs = lifecycleRun('open', { description: '', commits: [], notes: [''] });
  assert.deepEqual(noRefs, [], 'sentinel-only run emits no refs, no false actions');
});

// --- 6. Reducer: targets/labels/externalId for note-driven actions -----------

test('reducer: note-driven action targets match the state machine', () => {
  const cases = [
    ['close-in-mr', SMOKE_CFG.states.inReview, 'close'],
    ['merged', SMOKE_CFG.states.done, 'merged'],
    ['mr-open', SMOKE_CFG.states.inProgress, 'mr-open'],
    ['mention', SMOKE_CFG.states.inProgress, 'mention'],
    ['reopen', SMOKE_CFG.states.inProgress, 'reopen'],
    ['mr-closed', SMOKE_CFG.states.todo, 'mr-closed'],
  ];
  for (const [action, target, label] of cases) {
    const out = reduce([mrItem(action)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].json.targetStateUuid, target, `action ${action}`);
    assert.equal(out[0].json.desiredStateName, label, `action ${action}`);
    assert.equal(out[0].json.externalId, `gitlab-mr-9-${label}-DEV-240`, `action ${action}`);
  }
});

test('reducer: repeated note events dedup to the SAME externalId (Plane 409 idempotency)', () => {
  const a = reduce([mrItem('close-in-mr')])[0].json.externalId;
  const b = reduce([mrItem('close-in-mr')])[0].json.externalId;
  assert.equal(a, b);
  // a later comment-only reopen of the same MR gets a distinct id (state change allowed)
  assert.notEqual(a, reduce([mrItem('reopen')])[0].json.externalId);
});

test('reducer: comment-only ref keeps MR linkback context (url + description)', () => {
  const out = reduce([mrItem('close-in-mr', 'DEV-240', { mrDescription: 'closes DEV-240' })]);
  assert.ok(out[0].json.mrUrl.includes('/merge_requests/9'));
  assert.equal(out[0].json.mrDescription, 'closes DEV-240');
  assert.ok(out[0].json.commentHtml.includes('n8n-bridge'), 'sentinel preserved');
});

// --- 7. Guards applied to note-driven decisions ------------------------------

test('guards: closing comment on issue already In Review -> no change (already in target)', () => {
  const d = reduce([mrItem('close-in-mr')])[0].json;
  const g = guard(SMOKE_CFG.states.inReview, d);
  assert.equal(g.shouldChangeState, false);
  assert.match(g.guardReason, /already in target state/);
});

test('guards: bare-mention comment never downgrades In Review, never closes', () => {
  const d = reduce([mrItem('mr-open')])[0].json;
  const g = guard(SMOKE_CFG.states.inReview, d);
  assert.equal(g.shouldChangeState, false);
  assert.match(g.guardReason, /In Review not downgraded by mention/);
});

test('guards: comment on an already-merged MR cannot re-apply Done protection violation', () => {
  const d = reduce([mrItem('merged')])[0].json;
  const g = guard(SMOKE_CFG.states.done, d);
  assert.equal(g.shouldChangeState, false);
  assert.match(g.guardReason, /Done cannot be downgraded except by reopen/);
});

test('guards: mr-closed reset only downgrades active review states', () => {
  const d = reduce([mrItem('mr-closed')])[0].json;
  assert.equal(guard(SMOKE_CFG.states.inProgress, d).shouldChangeState, true);
  assert.equal(guard(SMOKE_CFG.states.inReview, d).shouldChangeState, true);
  const same = guard(SMOKE_CFG.states.todo, d);
  assert.equal(same.shouldChangeState, false);
  assert.match(same.guardReason, /already in target state/, 'todo issue already reset — guard short-circuits');
});

// --- 8. Paginated notes fetch: graph config (no silent cap) ------------------

test('graph: Get MR Notes uses the notes API with env auth and per_page=100', () => {
  const n = wf.nodes.find((x) => x.name === 'Get MR Notes');
  assert.ok(n, 'Get MR Notes present');
  assert.equal(n.type, 'n8n-nodes-base.httpRequest');
  assert.equal(n.typeVersion, 4.2);
  assert.equal(
    n.parameters.url,
    "=https://gitlab.pdmfc.com/api/v4/projects/{{ $('MR Action?').first().json.project.id }}/merge_requests/{{ $('MR Action?').first().json.object_attributes.iid }}/notes",
    'URL anchored on the MR webhook payload (input items here are commits)',
  );
  assert.deepEqual(n.parameters.headerParameters, {
    parameters: [{ name: 'PRIVATE-TOKEN', value: '={{ $env.GITLAB_API_TOKEN }}' }],
  });
  assert.deepEqual(n.parameters.queryParameters, { parameters: [{ name: 'per_page', value: '100' }] });
});

test('graph: Get MR Notes pagination pages via $pageCount and ends on a short page — NO silent cap', () => {
  const n = wf.nodes.find((x) => x.name === 'Get MR Notes');
  const pg = n.parameters.options.pagination.pagination;
  assert.equal(pg.paginationMode, 'updateAParameterInEachRequest');
  assert.deepEqual(pg.parameters.parameters, [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }]);
  assert.equal(pg.paginationCompleteWhen, 'other');
  assert.equal(pg.completeExpression, '={{ !Array.isArray($response.body) || $response.body.length < 100 }}');
  assert.equal(pg.limitPagesFetched, false, 'no page cap: stopping is determined by the short-page rule only');
  assert.ok(!('maxRequests' in pg), 'no maxRequests cap (a cap would silently truncate the scan)');
});

test('graph: sequential single-path notes chain — ONE normalizer inbound, notes fetched exactly once', () => {
  const conns = wf.connections;
  const outs = (src) => (conns[src]?.main?.[0] || []).map((c) => c.node);
  assert.deepEqual(outs('MR Action?'), ['Get MR Commits'], 'MR Action? TRUE feeds ONLY Get MR Commits (no fan-out)');
  assert.deepEqual(outs('Get MR Commits'), ['Get MR Notes']);
  assert.deepEqual(outs('Get MR Notes'), ['Filter MR Notes']);
  assert.deepEqual(outs('Filter MR Notes'), ['Normalize MR (with commits)']);
  let inbound = 0;
  for (const c of Object.values(conns)) {
    for (const arr of c.main) for (const t of arr || []) if (t.node === 'Normalize MR (with commits)') inbound++;
  }
  assert.equal(inbound, 1, 'normalizer must have exactly ONE inbound connection (single reducer path)');
  const gmc = wf.nodes.find((n) => n.name === 'Get MR Commits');
  assert.equal(gmc.alwaysOutputData, true, 'zero-commit MRs still reach the normalizer');
  const gmn = wf.nodes.find((n) => n.name === 'Get MR Notes');
  assert.equal(gmn.executeOnce, true, 'notes fetch runs ONCE despite N commit items flowing through');
  assert.equal(gmn.alwaysOutputData, true, 'empty notes response still reaches the filter');
  assert.ok(
    gmn.parameters.url.includes("$('MR Action?').first()"),
    'notes URL anchored on the webhook payload, never on $json (which is a commit item)',
  );
  assert.ok(!gmn.parameters.url.includes('$json'), 'no $json in notes URL');
});

test('graph: note-event routing wired through the EXISTING webhook path', () => {
  const route = wf.nodes.find((x) => x.name === 'Route Event');
  const noteRule = route.parameters.rules.values.find((v) => v.outputKey === 'note');
  assert.ok(noteRule, 'Route Event has a note rule');
  assert.equal(noteRule.conditions.conditions[0].rightValue, 'note');
  const iff = wf.nodes.find((x) => x.name === 'MR Note?');
  assert.equal(iff.type, 'n8n-nodes-base.if');
  const conds = iff.parameters.conditions;
  assert.equal(conds.combinator, 'and');
  assert.equal(conds.conditions.length, 3);
  assert.ok(conds.conditions[0].leftValue.includes('noteable_type'), 'noteable_type filter present');
  assert.ok(conds.conditions[2].leftValue.includes('system'), 'system-note filter present');
  // no MR title parsing anywhere in the note/lifecycle normalizers
  assert.ok(!normalizeNote.includes('attrs.title') && !normalizeNote.match(/refs\(.*title/), 'note normalizer never parses title');
  // no staticData/persistence used to remember refs
  for (const name of MR_COMMENT_NODES) {
    const n = wf.nodes.find((x) => x.name === name);
    assert.ok(!JSON.stringify(n.parameters).includes('staticData'), `${name} must not persist refs`);
  }
});
