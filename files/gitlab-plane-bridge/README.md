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
4. **A webhook secret** — any string you choose. Set it in every GitLab repo's webhook config (Secret Token field) and as the `WEBHOOK_SECRET` env var. The workflow validates the `X-Gitlab-Token` header against it.

## Setup

### 1. Set environment variables in your n8n server

The workflows read all non-secret config from environment variables (`$env`) — no per-node find-and-replace needed for slugs, UUIDs, or project IDs. Add these to your n8n server's environment (docker-compose `environment:` block, `.env` file, or systemd `Environment=`):

| Variable | Value | Example |
|---|---|---|
| `WORKSPACE_SLUG` | Your Plane workspace slug (find in Plane URL: `plane.nforensic.site/<slug>/...`) | `pdmfc` |
| `WEBHOOK_SECRET` | A secret string you choose — set the same value in every GitLab repo's webhook config as the Secret Token field | `mySecret123` |
| `PLANE_PROJECT_DEV` | JSON string with the DEV project UUID + 6 state UUIDs (see below) | `{"uuid":"b5842796-...","states":{...}}` |
| `GITLAB_GROUP_ID` | Numeric GitLab group ID — the backstop auto-discovers all repos under this group (including subgroups). Only needed for WF2. | `3175` |

**`PLANE_PROJECT_DEV` value** (copy-paste — confirmed from your Plane instance on 2026-07-28):

```json
{"uuid":"b5842796-7af7-474c-bf17-012977399c16","states":{"backlog":"e3bde020-6ce7-4b87-b994-2ebb28c14d84","todo":"6af7ed32-6610-44e3-be3f-f405b16d2d35","inProgress":"16099284-4b49-4ed3-af2a-d99e21d0e154","inReview":"a24250ec-212a-49ee-ad59-6d31e8b181ae","done":"56c26d40-418d-4d71-8f49-ecf0ba0837ad","cancelled":"c69e0a4f-6fa8-4aa6-85c8-26a8162db905"}}
```

If Plane states were changed since, update the UUIDs in this env var — no workflow JSON edits needed.

**`GITLAB_GROUP_ID` value** — this is the numeric ID of your GitLab group (e.g. `/novaforensic`). The backstop auto-discovers all repos under this group, including subgroups — no need to list individual project IDs. Find it via GitLab → group Settings, or `GET /api/v4/groups?search=novaforensic`. New repos added to the group are picked up automatically on the next poll cycle.

**Docker-compose example:**

```yaml
services:
  n8n:
    environment:
      - WORKSPACE_SLUG=pdmfc
      - WEBHOOK_SECRET=mySecret123
      - 'PLANE_PROJECT_DEV={"uuid":"b5842796-7af7-474c-bf17-012977399c16","states":{"backlog":"e3bde020-6ce7-4b87-b994-2ebb28c14d84","todo":"6af7ed32-6610-44e3-be3f-f405b16d2d35","inProgress":"16099284-4b49-4ed3-af2a-d99e21d0e154","inReview":"a24250ec-212a-49ee-ad59-6d31e8b181ae","done":"56c26d40-418d-4d71-8f49-ecf0ba0837ad","cancelled":"c69e0a4f-6fa8-4aa6-85c8-26a8162db905"}}'
      - GITLAB_GROUP_ID=3175
```

> **Important:** n8n must be restarted after changing environment variables for them to take effect.

### 2. Create n8n credentials

Create two credentials in n8n (Settings → Credentials):

| Name | Type | Value |
|---|---|---|
| `Plane API Key` | Header Auth | Header name: `X-Api-Key`, Header value: `<your plane api token>` |
| `GitLab API Token` | Header Auth | Header name: `PRIVATE-TOKEN`, Header value: `<your gitlab token>` |

> **Credential IDs cannot be parameterized via env vars** — n8n binds credentials per-node via a static UI dropdown. This is the only manual per-node step remaining.

### 3. Import workflows and wire credentials

1. Import `workflow-1-realtime.json` into n8n.
2. Open each HTTP Request node and select the appropriate credential from the dropdown:
   - **Plane HTTP nodes** (5 in WF1: Get Work Item, Create Comment, Update State, Get Existing Links, Create Link) → select "Plane API Key"
   - **GitLab HTTP node** (1 in WF1: Get MR Commits) → select "GitLab API Token"
3. **Activate** the workflow. Note the webhook URL: `{YOUR_N8N_URL}/webhook/gitlab-plane-bridge`.
4. Import `workflow-2-backstop.json`.
5. Wire credentials on its HTTP nodes:
   - **Plane HTTP nodes** (3 in WF2: Get Work Item, Create Comment, Update State) → select "Plane API Key"
   - **GitLab HTTP nodes** (2 in WF2: List Group Projects, List Commits) → select "GitLab API Token"
6. Activate the backstop workflow.

**Total manual credential clicks: 11** (6 in WF1 + 5 in WF2). Everything else is handled by env vars.

### 4. Register the webhook in each GitLab repo

The real-time workflow uses a generic n8n Webhook trigger (not GitLab's auto-registering trigger), so you register the webhook manually in **each** GitLab repo:

1. In **each** GitLab repo: Settings → Webhooks → add URL `{YOUR_N8N_URL}/webhook/gitlab-plane-bridge`, set the **Secret Token** to the same value you put in the `WEBHOOK_SECRET` env var, and check **Push events** + **Merge request events**.
2. To add a new repo later: just add it to the `/novaforensic` GitLab group. The backstop auto-discovers it on the next poll cycle — no config change needed. For WF1, register its webhook (same URL + secret). All repos resolve issues to the same DEV project via the `DEV-NN` regex.

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
- **Backstop** only applies strong current facts from commit polling: bare mention → In Progress, `reopens` → In Progress. It does not emit `merged` or `close-in-mr` actions (those require MR lifecycle events, which only the real-time webhook receives).

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
