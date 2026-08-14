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
| Backstop | `workflow-2-backstop.json` | Schedule (every 15 min) | Safety net: polls the GitLab commits API in a bounded time window for anything the webhook missed (>20-commit pushes, webhook delivery failures, >3-branch pushes). Paginates up to 20 pages × 100 commits per project per poll. |

Both workflows share the same reducer logic and Plane API calls. The Plane
comment endpoint's `external_id` field provides idempotency — re-processing
the same commit returns 409 (no duplicate), so the webhook and backstop can
overlap safely.

## Prerequisites

1. **n8n instance**, publicly reachable from `gitlab.pdmfc.com` (so GitLab can deliver webhooks).
2. **Plane API key** — generate in Plane → Settings → API. Supplied to the workflows via the `PLANE_API_KEY` env var.
3. **GitLab access token** (personal/group/project, `api` scope) — for REST API calls from the backstop and MR-commits fetch. Supplied via the `GITLAB_API_TOKEN` env var.
4. **A webhook secret** — any string you choose. Set it in every GitLab repo's webhook config (Secret Token field) and as the `WEBHOOK_SECRET` env var. The workflow validates the `X-Gitlab-Token` header against it.

## Setup

### 1. Set environment variables in your n8n server

The workflows read **all** config — slugs, UUIDs, project IDs, and API
credentials — from environment variables (`$env`). Every HTTP Request node sends
its auth header through an expression:

- GitLab nodes send `PRIVATE-TOKEN: {{ $env.GITLAB_API_TOKEN }}`
- Plane nodes send `X-Api-Key: {{ $env.PLANE_API_KEY }}`

There are **no n8n credentials to create and no per-node credential dropdowns
to wire**. Add these to your n8n server's environment (docker-compose
`environment:` block, `.env` file, or systemd `Environment=`):

| Variable | Value | Used by | Example |
|---|---|---|---|
| `WORKSPACE_SLUG` | Your Plane workspace slug (find in Plane URL: `plane.nforensic.site/<slug>/...`) | Both | `pdmfc` |
| `PLANE_API_KEY` | Plane API key — sent as `X-Api-Key` by every Plane HTTP node | Both | `plane_xxxxxxxx` |
| `GITLAB_API_TOKEN` | GitLab access token (`api` scope) — sent as `PRIVATE-TOKEN` by every GitLab HTTP node | Both | `glpat-xxxxxxxxxxxx` |
| `WEBHOOK_SECRET` | A secret string — set the same value in every GitLab repo's webhook config as the Secret Token field | WF1 only | `mySecret123` |
| `PLANE_PROJECT_DEV` | JSON string with the DEV project UUID + 6 state UUIDs (see below) | Both | `{"uuid":"b5842796-...","states":{...}}` |
| `GITLAB_GROUP_ID` | Numeric GitLab group ID — the backstop auto-discovers all repos under this group (including subgroups) | WF2 only | `3175` |

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
      - PLANE_API_KEY=plane_xxxxxxxx
      - GITLAB_API_TOKEN=glpat-xxxxxxxxxxxx
      - WEBHOOK_SECRET=mySecret123
      - 'PLANE_PROJECT_DEV={"uuid":"b5842796-7af7-474c-bf17-012977399c16","states":{"backlog":"e3bde020-6ce7-4b87-b994-2ebb28c14d84","todo":"6af7ed32-6610-44e3-be3f-f405b16d2d35","inProgress":"16099284-4b49-4ed3-af2a-d99e21d0e154","inReview":"a24250ec-212a-49ee-ad59-6d31e8b181ae","done":"56c26d40-418d-4d71-8f49-ecf0ba0837ad","cancelled":"c69e0a4f-6fa8-4aa6-85c8-26a8162db905"}}'
      - GITLAB_GROUP_ID=3175
```

> **Important:** n8n must be restarted after changing environment variables for them to take effect.

### 2. Import workflows and activate

Because auth is supplied entirely through `$env` headers, there are no
credential dropdowns to wire after import.

1. Import `workflow-1-realtime.json` into n8n and **activate** it. Note the webhook URL: `{YOUR_N8N_URL}/webhook/gitlab-plane-bridge`.
2. Import `workflow-2-backstop.json` and **activate** it.

### 3. Register the webhook in each GitLab repo

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
| `closes DEV-15` in MR description **or any MR commit** | action=open/update/reopen | Todo/Backlog/In Progress → **In Review** | comment (fetches all MR commits) |
| Bare `DEV-15` in MR description or commits | action=open/update/reopen | Todo/Backlog → **In Progress** | comment (mr-open) |
| `reopens DEV-15` in MR description or commits | action=open/update/reopen | Done → **In Progress** | comment |
| `closes DEV-15` in MR description or commits | action=merge, **target = default branch** | any non-Cancelled → **Done** | comment + MR link (fetches all MR commits) |
| `closes DEV-15` in MR description or commits | action=merge, target ≠ default | → **In Review** (close-in-mr, not Done) | comment |
| Bare `DEV-15` in MR description or commits | action=merge | Todo/Backlog → **In Progress** (mention) | comment |
| MR closed without merge | action=close, guarded | In Progress/In Review → **Todo** (only if no other open MR refs it) | comment (every discovered issue ref → mr-closed) |
| MR approval / approved / unapproval / unapproved | any approval action | **no-op** (no state change, no comment) | — |

> **Title-only references are intentionally ignored.** Only the MR description body and commit messages are scanned for issue refs — the MR `title` field is not parsed.
>
> **Merge and close fetch all MR commits** via the GitLab API (`GET /projects/:id/merge_requests/:iid/commits`), so `closes DEV-xx` in any commit — not just the description — is recognized. Open/update/reopen also fetch all commits.

### Guards (always applied)

- **Cancelled** is human-owned — the bridge never touches it.
- **Done** is never downgraded except on explicit `reopens`.
- **In Review** is never downgraded to In Progress by a bare mention.
- **Approval actions are no-ops.** MR webhook actions `approval`, `approved`, `unapproval`, and `unapproved` are routed to the FALSE branch of `MR Action?` and `Normalize MR (direct)` returns `[]` for them — no state change, no comment.
- **Backstop** only applies strong current facts from commit polling: bare mention → In Progress, `reopens` → In Progress. It does not emit `merged` or `close-in-mr` actions (those require MR lifecycle events, which only the real-time webhook receives). Comments still post for protected states; only the state change is suppressed.

### Keyword conventions

| Keyword | Action |
|---|---|
| `closes`, `fixes`, `resolves` | Close (→ In Review in open MR, → Done on merge to default) |
| `reopens` | Reopen (Done → In Progress) |
| Bare `DEV-15` (no keyword) | Mention (comment + In Progress from Todo/Backlog) |

Issue key regex (case-sensitive): `DEV-15`, `ADM-3` — must be uppercase prefix, hyphen, number. Mixed-case like `dev-15` is intentionally rejected.

**Markdown-link-aware parsing.** After the GitLab linkback node edits an MR description to replace `DEV-15` with `[DEV-15](https://plane.nforensic.site/...)`, subsequent `update` webhooks deliver the linked form. The regexes recognize both:
- `closes DEV-15` and `closes [DEV-15](url)` → close action
- `reopens DEV-15` and `reopens [DEV-15](url)` → reopen action
- `[DEV-15](url)` (bare linked) → mention

**MR description linkback is idempotent.** If the description already contains `[DEV-15](`, the linkback node skips that issue entirely — repeated MR `update` webhooks never nest a second link. Plain issue keys inside a URL path (e.g. `/browse/DEV-15/`) are not rewritten; only bare keys preceded by a non-alphanumeric, non-bracket, non-slash character are linked.

## MR lifecycle routing (workflow-1)

The `MR Action?` IF node routes five MR webhook actions through the TRUE path (Get MR Commits → Normalize MR (with commits)), where all MR commits are fetched and scanned alongside the MR description:

| MR action | Routed? | Issue ref handling |
|---|---|---|
| `open` | TRUE → Get MR Commits | `closes` → close-in-mr (In Review); `reopens` → reopen; bare → mr-open (In Progress) |
| `update` | TRUE → Get MR Commits | same as open |
| `reopen` | TRUE → Get MR Commits | same as open |
| `merge` | TRUE → Get MR Commits | `closes` → merged (Done if target = default branch, else close-in-mr); `reopens` → reopen; bare → mention |
| `close` | TRUE → Get MR Commits | every discovered issue ref → mr-closed (→ Todo, guarded) |
| `approval` / `approved` / `unapproval` / `unapproved` | FALSE → Normalize MR (direct) | **no-op** — returns `[]`, no state change, no comment |

All other MR actions also go FALSE and produce no output.

## Backstop poll details (workflow-2)

The backstop is a **bounded-window** poller, not an open-ended "since" scan.

- **Fixed scan window per run.** `Backstop Init` captures `scanUntil = new Date().toISOString()` once at the start of each poll. Every project is then queried with `since=<cursor>` **and** `until=<scanUntil>`, so a poll only ever examines a closed time interval — it cannot drift backwards or grow unbounded.
- **First-run cursor bootstrap (no historical replay).** The cursor lives in workflow global static data (`lastPollTime`). On the first run after the repair — when `lastPollTime` is empty — the cursor is bootstrapped to `scanUntil` and the poll scans an empty window (`since == until`). This intentionally avoids replaying every historical commit the first time the repaired workflow runs. Every subsequent run scans `[lastPollTime, scanUntil)`.
- **Cursor advances only on success.** `Process Commits` sets `lastPollTime = scanUntil` after normalizing. n8n persists workflow static data only on a **successful** production execution, so if any node throws, the cursor is not advanced and the next poll retries the same window.
- **Pagination.** `List Commits` uses the HTTP Request node's built-in pagination (`Update a Parameter in Each Request`): the `page` query parameter is set to `={{ $pageCount + 1 }}` on each request, pagination stops when the response array is empty, and a hard cap of 20 pages (20 × 100 = up to 2000 commits per project per poll) prevents runaway loops. `per_page` stays at 100.
- **One decision per commit, not per issue.** The reducer emits one decision per `(commit, issue)` pair instead of collapsing a whole poll into one output per issue, so no commit's comment is lost.
- **Deterministic overlap with the realtime webhook.** Each decision's `external_id` is exactly `gitlab-commit-<commitSha>-<issueKey>`. Because the realtime workflow uses the same id for the same commit, a duplicate comment POST returns **409** and is treated as an idempotent success — the webhook and backstop can process the same commit without duplicating comments.
- **Fail-fast idempotency.** All `continueOnFail` flags were removed from GitLab list requests, `Get Work Item`, and `Update State`, so a real failure stops execution and prevents the cursor from advancing. `Create Comment` is configured to return the full HTTP response and never error on its own; a dedicated `Validate Comment Result` node follows it and **throws** on any status other than 2xx or 409. This lets the expected 409 (duplicate) pass through while an unexpected 4xx/5xx fails the run.

## Testing

### Real-time (workflow-1)

1. Create a Plane issue `DEV-1` in **Todo** state.
2. Push a commit with message `refs DEV-1` to a feature branch → expect a Plane comment + state → **In Progress**.
3. Open an MR with description `closes DEV-1` → expect state → **In Review** (MR description + all MR commits are scanned).
4. Push a commit `closes DEV-1` to the same MR branch → MR `update` webhook fires → expect state stays **In Review** (close-in-mr, idempotent via `external_id`).
5. Merge the MR to the default branch → expect state → **Done** + the MR description edited to link back to the Plane issue.
6. Push a commit `reopens DEV-1` → expect Done → **In Progress**.
7. Re-push the same commit → expect **no duplicate comment** (409 handled via `external_id`).
8. Open an MR with title `DEV-2 fix` but no issue ref in the description or commits → expect **no state change** (title-only references are intentionally ignored).
9. Approve / unapprove an MR → expect **no state change, no comment** (approval actions are no-ops).
10. After linkback has mutated the description to `closes [DEV-1](url)`, trigger an MR `update` → expect `closes [DEV-1](url)` to still be recognized as a close ref (markdown-link-aware).

### Backstop (workflow-2)

1. **First run after import/repair:** expect **no** historical comments. The cursor bootstraps to the current time and the first poll scans an empty window — no old commits are replayed.
2. After the first run, push a commit `refs DEV-2` to any repo in the group and wait ≤15 min → expect a Plane comment + state → **In Progress**, with the commit linked.
3. Trigger the realtime webhook for the same commit (or just wait for the next backstop poll) → expect **no duplicate comment** (409 accepted as idempotent).
4. Push a commit `reopens DEV-2` while `DEV-2` is Done → expect Done → **In Progress**.
5. If Plane returns an unexpected status on comment creation, the workflow **stops** (Validate Comment Result throws) and `lastPollTime` is **not** advanced — the next poll retries the same window.

## Known limitations (MVP — Phase 1)

- **20-commit push cap (webhook only):** GitLab's push webhook includes only the 20 newest commits. The backstop closes this gap for commits that landed in its scan window via pagination (up to 2000 commits/project/poll). Commits that are both older than the webhook cap *and* outside the current backstop window can still be missed until the next poll catches their window.
- **Force-push**: already-processed commit SHAs are skipped for comments (409), but state is not re-evaluated. Phase 2.
- **MR description edits**: `action=update` re-scans the description, but idempotency on repeated edits is basic. Phase 2.
- **Draft MRs**: not yet skipped. Phase 2.
- **Stale-issue detection**: not implemented. Phase 3.

See the full roadmap in [`docs/plans/gitlab-plane-bridge.md`](../../docs/plans/gitlab-plane-bridge.md).

## How it works

### Real-time (workflow-1)

```
GitLab Webhook (Push + MR events)
  → Verify Secret (X-Gitlab-Token)
  → Switch on event type (push / merge_request)
  → Push: Normalize Push (extract DEV-NN from commit messages)
  → MR: MR Action? (open/update/reopen/merge/close → TRUE; approval/etc → FALSE)
       TRUE:  Get MR Commits → Normalize MR (with commits) — scans description + all commits
       FALSE: Normalize MR (direct) — returns [] for non-merge/close actions
  → Reducer (group by issue, apply precedence + guards)
  → Plane: Get Work Item by identifier (DEV-15 → UUID)
  → Apply Guards (re-check using current Plane state; throw on malformed data)
  → Plane: Create Comment (full response + neverError, external_id dedup → 409 on duplicate)
       → Validate Comment Result (accept 2xx/409, else throw)
  → Plane: Update State (if guards allow)
  → Prepare GitLab Linkback → GitLab: Post Commit Comment / Edit MR Description
    (links the GitLab side back to the Plane work item)
```

### Backstop (workflow-2)

```
Schedule (every 15 min)
  → Backstop Init (capture scanUntil; read/seed lastPollTime cursor)
  → GitLab: List Group Projects (auto-discovers all repos incl. subgroups)
  → Split Projects (one item per project: projectId, since, scanUntil)
  → GitLab: List Commits (since/until window, paginated 20×100)
  → Process Commits (flatten pages, parse DEV-NN + reopens, advance cursor)
  → Reducer (one decision per commit+issue)
  → Plane: Get Work Item
  → Apply Guards (re-check current Plane state; throw on malformed data)
  → Plane: Create Comment (full response + neverError)
       → Validate Comment Result (accept 2xx/409, else throw)
  → Plane: Update State (if guards allow)
```

Every comment embeds a sentinel `<!-- n8n-bridge: src=..., action=... -->` for future loop-prevention in the planned Plane→GitLab back-channel (Phase 3).
