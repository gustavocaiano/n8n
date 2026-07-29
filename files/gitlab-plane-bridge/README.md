# GitLab ↔ Plane Bridge (n8n)

Makes the self-hosted Plane issue tracker (`plane.nforensic.site`) behave like
GitLab/GitHub's native issue tracker. Mentioning `DEV-15` in a commit posts a
Plane comment and advances the issue state. `closes DEV-15` moves it through
review to done. MR lifecycle events sync state. `reopens DEV-15` reverts done.

## Architecture

Two n8n workflows:

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| Real-time | `workflow-1-realtime.json` | GitLab webhook (Push + Merge Request) | Event-driven: processes commits and MR events as they happen |
| Backstop | `workflow-2-backstop.json` | Schedule (every 15 min) | Safety net: polls GitLab commits API for anything the webhook missed (>20-commit pushes, webhook delivery failures, >3-branch pushes) |

Both workflows share the same reducer logic and Plane API calls. The Plane
comment endpoint's `external_id` field provides idempotency — re-processing
the same commit returns 409 (no duplicate), so the webhook and backstop can
overlap safely.

## Prerequisites

1. **n8n instance**, publicly reachable from `gitlab.pdmfc.com` (so GitLab can deliver webhooks).
2. **Plane API key** — generate in Plane → Settings → API.
3. **GitLab access token** (personal/group/project, `api` scope) — for REST API calls from the backstop and MR-commits fetch.
4. **GitLab OAuth2/API credential** for the GitLab Trigger node (n8n's own credential type — see [n8n GitLab Trigger docs](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.gitlabtrigger)).

## Setup

### 1. Create n8n credentials

Create three credentials in n8n (Settings → Credentials):

| Name | Type | Value |
|---|---|---|
| `Plane API Key` | Header Auth | Header name: `X-Api-Key`, Header value: `<your plane api token>` |
| `GitLab API Token` | Header Auth | Header name: `PRIVATE-TOKEN`, Header value: `<your gitlab token>` |
| GitLab Trigger credential | GitLab OAuth2 API | Per n8n docs — used by the GitLab Trigger node |

### 2. Replace placeholders in the workflow JSON

Before importing, find-and-replace these placeholders in both workflow files:

| Placeholder | Replace with | Where |
|---|---|---|
| `REPLACE_WORKSPACE_SLUG` | Your Plane workspace slug (find in Plane URL: `plane.nforensic.site/<slug>/...`) | All Plane API URLs |
| `REPLACE_WITH_PLANE_AUTH_ID` | The n8n credential ID for "Plane API Key" | All Plane HTTP Request nodes |
| `REPLACE_WITH_GITLAB_AUTH_ID` | The n8n credential ID for "GitLab API Token" | GitLab HTTP Request nodes |
| `REPLACE_GITLAB_PROJECT_ID` | Your GitLab project ID (numeric, from project settings) | Backstop workflow only |

**Note on credential IDs:** In n8n, credential IDs are visible in the credential's URL when you open it for editing. Alternatively, after importing the workflow, open each HTTP Request node and select the credential from the dropdown — n8n will wire the ID automatically.

### 3. Verify Plane state UUIDs

The reducer Code node embeds the Plane state UUIDs for the DEV project:

| State | UUID |
|---|---|
| Backlog | `e3bde020-6ce7-4b87-b994-2ebb28c14d84` |
| Todo | `6af7ed32-6610-44e3-be3f-f405b16d2d35` |
| In Progress | `16099284-4b49-4ed3-af2a-d99e21d0e154` |
| In Review | `a24250ec-212a-49ee-ad59-6d31e8b181ae` |
| Done | `56c26d40-418d-4d71-8f49-ecf0ba0837ad` |
| Cancelled | `c69e0a4f-6fa8-4aa6-85c8-26a8162db905` (human-owned — bridge never touches) |

These were confirmed from your Plane instance on 2026-07-28. If states were changed since, update the `PROJECTS` object in the Reducer and Apply Guards Code nodes.

### 4. Import and activate

1. In n8n, import `workflow-1-realtime.json`.
2. Open the workflow, verify credentials are selected on all HTTP Request nodes.
3. **Activate** the workflow. Activation auto-registers the GitLab webhook.
4. Verify in GitLab: project → Settings → Webhooks — a webhook to your n8n URL should exist with Push + Merge Request events checked.
5. Import `workflow-2-backstop.json`, set the GitLab project ID, activate.

## State machine

| Trigger | Condition | From → To | Also |
|---|---|---|---|
| Bare mention `DEV-15` in commit | any branch | Todo/Backlog → **In Progress** | comment "mentioned in \<commit-url\>" |
| `closes/fixes/resolves DEV-15` in commit | commit in **open MR** targeting default | Todo/Backlog/In Progress → **In Review** | comment |
| `closes/fixes/resolves DEV-15` in commit | commit **merged to default** (or MR merged) | any non-Cancelled → **Done** | comment + MR link |
| `closes/fixes/resolves DEV-15` on feature branch | **no open MR** contains the commit | Todo/Backlog → **In Progress** (NOT In Review) | comment |
| `reopens DEV-15` | any branch | Done → **In Progress** | comment |
| MR opened referencing `DEV-15` | action=open | Todo/Backlog → **In Progress** | comment |
| MR closed without merge | action=close, guarded | In Progress/In Review → **Todo** (only if no other open MR refs it) | comment |
| MR merged referencing `DEV-15` | action=merge | → **Done** | comment + link |

### Guards (always applied)

- **Cancelled** is human-owned — the bridge never touches it.
- **Done** is never downgraded except on explicit `reopens`.
- **In Review** is never downgraded to In Progress by a bare mention.
- **Backstop** does not apply MR-closed-without-merge downgrades (only strong current facts: merged→Done, close-in-open-MR→In Review).

### Keyword conventions

| Keyword | Action |
|---|---|
| `closes`, `fixes`, `resolves` | Close (→ In Review in open MR, → Done on merge) |
| `reopens` | Reopen (Done → In Progress) |
| Bare `DEV-15` (no keyword) | Mention (comment + In Progress from Todo/Backlog) |

Issue key regex (case-sensitive): `DEV-15`, `ADM-3` — must be uppercase prefix, hyphen, number. Mixed-case like `dev-15` is intentionally rejected.

## Testing

1. Create a Plane issue `DEV-1` in **Todo** state.
2. Push a commit with message `refs DEV-1` to a feature branch → expect a Plane comment + state → **In Progress**.
3. Open an MR with description `closes DEV-1` → expect state → **In Review**.
4. Merge the MR → expect state → **Done** + a link to the MR attached.
5. Push a commit `reopens DEV-1` → expect Done → **In Progress**.
6. Re-push the same commit → expect **no duplicate comment** (409 handled via `external_id`).

## Known limitations (MVP — Phase 1)

- **20-commit push cap**: GitLab's push webhook includes only the 20 newest commits. Phase 2 adds API fallback for larger pushes.
- **Force-push**: already-processed commit SHAs are skipped for comments (409), but state is not re-evaluated. Phase 2.
- **MR description edits**: `action=update` re-scans the description, but idempotency on repeated edits is basic. Phase 2.
- **Draft MRs**: not yet skipped. Phase 2.
- **Stale-issue detection**: not implemented. Phase 3.
- **Single repo in backstop**: the backstop polls one GitLab project (configurable). Multi-repo support is a config extension.

See the full roadmap in [`docs/plans/gitlab-plane-bridge.md`](../../docs/plans/gitlab-plane-bridge.md).

## How it works

```
GitLab Trigger (Push + MR events)
  → Switch on event type
  → Normalize (extract DEV-NN via regex, classify action)
  → Reducer (group by issue, apply precedence + guards)
  → Plane: Get Work Item by identifier (DEV-15 → UUID)
  → Apply Guards (re-check using current Plane state)
  → Plane: Create Comment (external_id dedup → 409 on duplicate)
  → Plane: Update State (if guards allow)
  → Plane: Create Link (MRs only, client-side dedup)
```

Every comment embeds a sentinel `<!-- n8n-bridge: src=..., action=... -->` for future loop-prevention in the planned Plane→GitLab back-channel (Phase 3).
