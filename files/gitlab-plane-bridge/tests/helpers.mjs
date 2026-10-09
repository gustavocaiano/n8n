// Shared harness for the plane-lookup-retry barrier tests.
// Dependency-free: node:test + node:vm + node:fs. Every logic test runs the
// ACTUAL jsCode stored in files/gitlab-plane-bridge/workflow-1-realtime.json
// inside a vm sandbox that emulates the n8n Code-node runtime
// ($input / $env / $('Node') / itemMatching).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const testsDir = path.dirname(fileURLToPath(import.meta.url));
export const candidatePath = path.join(testsDir, '..', 'workflow-1-realtime.json');
export const backstopPath = path.join(testsDir, '..', 'workflow-2-backstop.json');
export const opsArtifactPath = path.join(testsDir, '..', '..', '.slim', 'debug', 'plane-lookup-retry', 'mcp-update-operations.json');

export function loadCandidate() {
  return JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
}

export function loadBackstop() {
  return JSON.parse(fs.readFileSync(backstopPath, 'utf8'));
}

export function nodeOf(wf, name) {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node not found: ${name}`);
  return n;
}

export function jsCodeOf(wf, name) {
  const n = nodeOf(wf, name);
  if (n.type !== 'n8n-nodes-base.code') throw new Error(`${name} is not a code node`);
  return n.parameters.jsCode;
}

/** Emulate a named-node reference as returned by $('NodeName') in a Code node. */
export function nodeRef(items) {
  return {
    all: () => items,
    first: () => items[0],
    itemMatching: (i) => {
      if (!Number.isInteger(i) || i < 0 || i >= items.length) {
        throw new Error(`Paired item data is unavailable for index '${i}'`);
      }
      return items[i];
    },
  };
}

/** A node reference whose context is entirely missing (worst case). */
export function missingNodeRef() {
  return {
    all: () => { throw new Error('Paired item data is unavailable'); },
    first: () => { throw new Error('Paired item data is unavailable'); },
    itemMatching: () => { throw new Error('Paired item data is unavailable'); },
  };
}

/** A node reference that resolves but returns an incomplete prepared item. */
export function brokenPreparedNodeRef() {
  return nodeRef([{ json: { issueKey: 'SMK-1' } }]); // no originalDecision
}

/**
 * Run the ACTUAL stored jsCode in a vm sandbox emulating the Code node.
 * fixedNow: optional epoch-ms; when set, Date inside the sandbox is a shim
 * frozen at that instant (Date.parse still delegates to the real parser).
 */
export function runCodeNode(jsCode, { items = [], env = {}, nodeRefs = {}, fixedNow = null } = {}) {
  const sandbox = {
    $input: { all: () => items, first: () => items[0] },
    $env: env,
    $: (name) => {
      if (!(name in nodeRefs)) throw new Error(`no run data provided for node '${name}'`);
      return nodeRefs[name];
    },
    console: { log: () => {}, error: () => {} },
  };
  if (fixedNow !== null) {
    sandbox.Date = { now: () => fixedNow, parse: (s) => Date.parse(s) };
  }
  const ctx = vm.createContext(sandbox);
  // n8n compiles the Code node body as a function body (top-level return OK).
  const result = new vm.Script('function __codeNodeMain(){\n' + jsCode + '\n}\n__codeNodeMain();', {
    filename: 'stored-jsCode.js',
  }).runInContext(ctx);
  // JSON-normalize: objects created inside the vm realm have foreign
  // prototypes that break deepStrictEqual; the Code node serializes item
  // JSON across realms the same way.
  return result === undefined ? result : JSON.parse(JSON.stringify(result));
}

export const SMOKE_CFG = {
  uuid: 'smoke-proj-uuid',
  states: {
    backlog: 'st-backlog',
    todo: 'st-todo',
    inProgress: 'st-inprog',
    inReview: 'st-review',
    done: 'st-done',
    cancelled: 'st-cancelled',
  },
};

export function decision(issueKey, overrides = {}) {
  return {
    issueKey,
    desiredStateName: 'mention',
    targetStateUuid: 'st-inprog',
    shouldChangeState: true,
    guardReason: '',
    commentHtml: '<!-- n8n-bridge: test -->',
    externalId: 'ext-' + issueKey,
    externalSource: 'gitlab',
    mrUrl: '',
    mrTitle: '',
    gitlabProjectId: '42',
    commitShas: [],
    mrIid: '',
    mrDescription: '',
    planeProjectUuid: SMOKE_CFG.uuid,
    actorEmail: '',
    actorUsername: '',
    actorName: '',
    authorEmails: [],
    authorNames: [],
    ...overrides,
  };
}

/** HTTP node fullResponse+neverError output shape: { statusCode, headers, body }. */
export function httpResp(statusCode, { body = {}, headers = {} } = {}) {
  return { json: { statusCode, statusMessage: 'x', headers, body } };
}

export const NEW_BARRIER_NODES = [
  'Prepare Lookup Attempt',
  'Classify Lookup Batch',
  'Lookup Batch Ready?',
  'Unwrap Lookup Batch',
  'Wait for Plane Retry',
];

export const LIVE_ONLY_NODES = [
  'Existing Comments',
  'Filter Duplicate Comments',
  'Unassigned?',
  'Get Members',
  'Resolve Assignee',
  'Assign Issue',
];

/** The 25 node names of the authoritative live baseline (pre-candidate). */
export const BASELINE_25_NODES = [
  'GitLab Webhook', 'Route Event', 'MR Action?', 'Get MR Commits', 'Get Work Item',
  'Create Comment', 'Should Change State?', 'Update State', 'Is Commit?',
  'Post Commit Comment', 'Edit MR Description', 'Verify Secret', 'Normalize Push',
  'Normalize MR (with commits)', 'Normalize MR (direct)', 'Reducer', 'Apply Guards',
  'Prepare GitLab Linkback', 'Validate Comment Result', ...LIVE_ONLY_NODES,
];

/** MR-comment support nodes (note-event routing + paginated MR notes fetch). */
export const MR_COMMENT_NODES = [
  'MR Note?', 'Get MR Notes', 'Filter MR Notes', 'Normalize MR Note',
];

/** Node IDs that must be preserved from the live workflow (sample of critical ones). */
export const PRESERVED_IDS = {
  'GitLab Webhook': 'f9a9faa8-7e84-45e5-90c5-683215ada8c5',
  'Verify Secret': '6cf7de18-b3ae-4923-8e7f-ef514bbee624',
  'Route Event': 'fff7232b-2ac6-49d1-b8b7-996106a2b7eb',
  'MR Action?': 'fb3b8be1-e306-4360-b9f3-303f2b019825',
  'Get MR Commits': '283c9f65-aa73-49a3-97cd-96eb71fde318',
  'Normalize Push': 'da655d4e-38b6-4ae2-930d-639a8695598c',
  'Normalize MR (with commits)': 'a8146573-0075-40f7-956b-e4ec19d8a0fa',
  'Normalize MR (direct)': '0baf48a9-5e2b-4bc2-8114-67a079e5befe',
  'Reducer': '27b16332-e5b9-4c08-9f12-e55048f0bde3',
  'Get Work Item': '2f8b05f5-3749-4cf0-9df3-c60a87373536',
  'Apply Guards': '8180f618-a02d-4f8e-88f9-10f68ba195c4',
  'Prepare GitLab Linkback': '25d35f13-a95c-4996-9ead-ec70f6b98f3b',
  'Existing Comments': '779cc0cd-26a6-4aff-8eaf-4546c84a02ee',
  'Filter Duplicate Comments': '99ac84bb-b796-44df-a5a1-7c3ea5912d16',
  'Create Comment': '1fdf95d3-3d6e-4e71-ac08-445e87630b86',
  'Validate Comment Result': 'b3d2e8f1-4a6c-4917-be38-8f5a9c2d7e10',
  'Should Change State?': 'f40b8ea8-5573-4174-9e0b-385dc236006f',
  'Update State': '03ded0dc-4eba-4717-b232-d0808b1d0ae8',
  'Is Commit?': '54a59673-cd75-4dcd-9d51-efbd5bdc151a',
  'Post Commit Comment': '8d571f35-5869-441f-b6b2-3c300a1b8daf',
  'Edit MR Description': '2a94ea65-c57f-4f97-b33e-07118bfa19a2',
  'Unassigned?': '06cecd53-555d-4126-a603-7428c827558f',
  'Get Members': '79abbd70-4c1c-4a79-88bb-93e95353bf09',
  'Resolve Assignee': 'f5a42d7e-863b-4a59-b5eb-25a4c758c1c7',
  'Assign Issue': '68d9a5fc-54ed-4d42-b6d9-ce95ae502a59',
  // MR-comment support nodes (fresh IDs assigned when they were added)
  'MR Note?': '294ac709-d02e-4c69-a509-bddc06029815',
  'Get MR Notes': '9040d610-e971-4eb8-ad0e-8f4639ffab43',
  'Filter MR Notes': 'eb5770bc-6c63-42de-9d64-374bfecd6839',
  'Normalize MR Note': 'aaa2b155-3e25-468b-907b-f538ce25c476',
};
