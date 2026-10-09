# GitLab ↔ Plane Bridge (n8n)

Makes the self-hosted Plane issue tracker (`plane.nforensic.site`) behave like
GitLab/GitHub's native issue tracker. Mentioning `DEV-15` in a commit posts a
Plane comment and advances the issue state. `closes DEV-15` moves it through
review to done. MR lifecycle events sync state. `reopens DEV-15` reverts done.
The same keywords also work in **human MR comments** (`closes DEV-240` posted
as a merge request note closes the issue exactly like a description reference).

## Architecture

Two n8n workflows:

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| Real-time | `workflow-1-realtime.json` | GitLab webhook (Push + Merge Request + Merge Request comments) | Event-driven: processes commits, MR events and MR comments as they happen |
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

1. In **each** GitLab repo: Settings → Webhooks → add URL `{YOUR_N8N_URL}/webhook/gitlab-plane-bridge`, set the **Secret Token** to the same value you put in the `WEBHOOK_SECRET` env var, and check **Push events** + **Merge request events** + **Note events** (comments). MR comment refs are processed through the same webhook path and secret as push/MR events — no extra webhook or credential is needed.
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
| `closes DEV-15` in a **human MR comment** | MR open (state `opened`) | Todo/Backlog/In Progress → **In Review** | comment (close-in-mr) |
| `closes DEV-15` in a human MR comment | MR already **merged**, target = default or `dev` | any non-Cancelled → **Done** | comment (merged) |
| `closes DEV-15` in a human MR comment | MR already merged, target ≠ default/`dev` | → **In Review** (close-in-mr) | comment |
| `closes DEV-15` in a human MR comment | MR already closed **without merge** | In Progress/In Review → **Todo** (guarded) | comment (mr-closed) |
| Bare `DEV-15` in a human MR comment | MR open | Todo/Backlog → **In Progress** (mr-open, never a closure) | comment |
| `reopens DEV-15` in a human MR comment | any MR state | Done → **In Progress** | comment |
| MR approval / approved / unapproval / unapproved | any approval action | **no-op** (no state change, no comment) | — |

> **Title-only references are intentionally ignored.** Only the MR description body, commit messages, and human MR comments are scanned for issue refs — the MR `title` field is not parsed.
>
> **Merge and close fetch all MR commits and all MR comments** via the GitLab API (`GET /projects/:id/merge_requests/:iid/commits` and `GET /projects/:id/merge_requests/:iid/notes`), so `closes DEV-xx` in any commit or any human comment — not just the description — is recognized. Open/update/reopen also fetch both. A reference that exists ONLY in a comment therefore still closes on merge (→ Done) and still resets on close-without-merge (→ Todo, guarded).

## MR comments (note events, workflow-1)

GitLab delivers comments as `object_kind: "note"` webhooks. The workflow routes
them through the existing webhook path (`GitLab Webhook → Verify Secret →
Route Event`), then a dedicated `MR Note?` IF applies three filters:

1. **MR notes only** — `object_attributes.noteable_type` must be `MergeRequest`. Comments on issues, commits, and snippets are ignored.
2. **Human notes only** — `object_attributes.system !== true`. System notes (state changes, approvals, assignment notes) are never user intent; this also prevents the bridge from reacting to its own/system-generated description diffs.
3. **Create/update actions only** — non-create/update actions are ignored. A payload without an `action` field (older GitLab versions) is treated as a create.

The note body is parsed with the **same keyword semantics** as everywhere else
(`closes|fixes|resolves`, `reopens`, bare mention; markdown-link-aware; mixed
case rejected; no MR title parsing), and the mapping depends on the MR's
**current state** carried in the webhook payload:

| MR state at comment time | `closes/fixes/resolves` | bare mention | `reopens` |
|---|---|---|---|
| `opened` | close-in-mr → **In Review** | mr-open → **In Progress** | reopen → **In Progress** |
| `merged` | target = default or `dev` → **Done** (merged); otherwise → **In Review** | mention → **In Progress** | reopen → **In Progress** |
| `closed` (unmerged) | mr-closed → **Todo** (guarded) | mention → **In Progress** | reopen → **In Progress** |

Existing guards always apply: Cancelled untouched, Done not downgraded (except
explicit `reopens`), In Review not downgraded by a bare mention.

### All human MR notes are scanned on every MR lifecycle event

For `open`, `update`, `reopen`, `merge`, and `close`, the workflow additionally
fetches **every** human MR comment via the paginated notes API
(`GET /projects/:id/merge_requests/:iid/notes`, `per_page=100`) and scans the
note bodies alongside the MR description and all MR commits in a single
normalizer run:

- **Strictly sequential graph, no fan-out merges.** The chain is
  `MR Action? (TRUE) → Get MR Commits → Get MR Notes → Filter MR Notes →
  Normalize MR (with commits)`. Ordinary n8n nodes do NOT merge multiple
  incoming branches into one execution, so the notes fetch is wired in series
  behind the commits fetch. This guarantees a notes API failure (or a
  malformed notes page) always stops the run **before** the Reducer — no
  comment, state change, or linkback can ever run on a truncated scan.
- **Exactly one notes fetch per event.** `Get MR Commits` emits one item per
  commit, so `Get MR Notes` is set to **Execute Once** and anchored on
  `$('MR Action?').first()` (never `$json`, which is a commit item flowing
  through the chain). `alwaysOutputData` on both HTTP nodes keeps the branch
  alive for zero-commit MRs and empty notes responses.
- The HTTP Request node paginates with `page={{ $pageCount + 1 }}` and stops
  only when a page returns **fewer than 100 notes** (GitLab's last-page rule).
  There is **no page cap**: a page cap would silently truncate the scan, so
  instead any unexpected page shape or API error **fails the run loudly**
  (safe failure) in `Filter MR Notes` before any Plane side effect runs.
- `Filter MR Notes` drops `system: true` notes and reshapes the rest into
  message items that the existing `Normalize MR (with commits)` node scans
  exactly like commit messages. The normalizer reads commits from
  `$('Get MR Commits')` node data and note messages from its input, and scans
  the description exactly once. When an MR has **no human comments**
  (system-only notes, an empty notes page, or the `alwaysOutputData`
  placeholder), `Filter MR Notes` emits a single empty sentinel message — the
  normalizer still runs and simply matches nothing on the comment side. A note
  object that has fields but no body remains a hard failure.
- No workflow `staticData` is used to remember seen references — every scan
  re-reads the current MR state from the GitLab API, so a comment-only
  reference is picked up at merge/close time even if the comment arrived days
  earlier.
- **Edited comments are handled safely.** Note `update` events are re-scanned
  like creates: the same body/action re-emits the same decision `external_id`
  (`gitlab-mr-<iid>-<action>-<issue>` → Plane 409, no duplicate), and an edit
  that introduces a genuinely new action (e.g. `closes` → `reopens`) flows
  through the normal guards. An edit only ever changes state in the guarded
  direction — it can never force Done or downgrade protected states.
- **Identity resolution follows the GitLab docs.** The MR is identified by
  `merge_request.iid` (never `noteable_id`), and the project comes from the
  payload `project.id` with a fallback to the note's own
  `object_attributes.project_id` (the MR entity inside note payloads carries
  no `project_id`).
- The bridge **never edits MR comments** (it only posts commit comments and
  edits MR descriptions, both idempotent), so processing notes cannot create a
  feedback loop. Repeated identical comments dedupe via the Plane comment
  `external_id` (`gitlab-mr-<iid>-<action>-<issue>` → 409 on duplicate).

### Guards (always applied)

- **Cancelled** is human-owned — the bridge never touches it.
- **Done** is never downgraded except on explicit `reopens`.
- **In Review** is never downgraded to In Progress by a bare mention.
- **Approval actions are no-ops.** MR webhook actions `approval`, `approved`, `unapproval`, and `unapproved` are routed to the FALSE branch of `MR Action?` and `Normalize MR (direct)` returns `[]` for them — no state change, no comment.
- **Backstop** only applies strong current facts from commit polling: bare mention → In Progress, `reopens` → In Progress. It does not emit `merged` or `close-in-mr` actions (those require MR lifecycle events, which only the real-time webhook receives). Comments still post for protected states; only the state change is suppressed.

### Plane read-retry barrier (real-time workflow)

`Get Work Item` reads are wrapped in a **whole-read-batch barrier** so a Plane
rate-limit (HTTP 429) never releases a partial set of issue updates. The
attempt counter travels in item JSON (never workflow staticData), so it
survives the Wait round-trip.

```
Reducer
  → Prepare Lookup Attempt   (fresh decisions, attempt 1 — or rebuild the exact
                              same batch from the retry summary, attempt 2/3)
  → Get Work Item            (same URL + env auth; fullResponse + neverError;
                              native retry off; transport errors still stop the run)
  → Classify Lookup Batch    (recovers each response's prepared request via
                              itemMatching — no numeric fallback)
  → Lookup Batch Ready?      (IF)
       TRUE  → Unwrap Lookup Batch → Apply Guards (once, whole batch, fresh
               FINAL-round work items + embedded original decision)
       FALSE → Wait for Plane Retry → Prepare Lookup Attempt (re-runs the
               ENTIRE GET batch)
```

- **429-only policy.** Any other HTTP status (401/403/404/500/5xx) or a
  transport error is permanent: the run throws before any downstream item is
  released. 429 is the only retryable status.
- **3 attempts TOTAL** (initial + +10 min + +20 min). The 3rd consecutive 429
  throws — nothing downstream has run by then.
- **Delay = max(600 s, max valid `Retry-After`)** across all 429s of the batch,
  seconds or HTTP-date — 600 s is the **minimum (floor), never a cap**: long
  server-provided waits are honored; malformed/missing/non-positive falls back
  to 600 s.
- **Single release.** Downstream side effects (comments, state changes,
  linkbacks, assignment) run exactly once, only after EVERY read in the batch
  has succeeded, using only the final round's work items. Changed Plane state
  between rounds is re-checked by the guards as usual.
- The backstop workflow is unaffected (its own 15-min poll + cursor overlap
  remains the safety net).

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

The `MR Action?` IF node routes five MR webhook actions through the TRUE path — a strict sequential chain `Get MR Commits → Get MR Notes → Filter MR Notes → Normalize MR (with commits)` — where all MR commits AND all human MR comments are fetched and scanned alongside the MR description in ONE normalizer run:

| MR action | Routed? | Issue ref handling |
|---|---|---|
| `open` | TRUE → Get MR Commits → Get MR Notes | `closes` (description, commits, or comments) → close-in-mr (In Review); `reopens` → reopen; bare → mr-open (In Progress) |
| `update` | TRUE → Get MR Commits → Get MR Notes | same as open |
| `reopen` | TRUE → Get MR Commits → Get MR Notes | same as open |
| `merge` | TRUE → Get MR Commits → Get MR Notes | `closes` → merged (Done if target = default branch or `dev`, else close-in-mr); `reopens` → reopen; bare → mention |
| `close` | TRUE → Get MR Commits → Get MR Notes | every discovered issue ref (description, commits, or comments) → mr-closed (→ Todo, guarded) |
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

### Offline barrier tests (node:test, dependency-free)

`node --test files/gitlab-plane-bridge/tests/*.test.mjs` runs tests that execute
the ACTUAL `jsCode` stored in `workflow-1-realtime.json` inside a vm sandbox
(emulating `$input` / `$env` / `$('Node').itemMatching()`), plus structural
graph checks (34 live nodes + IDs preserved, barrier wiring, side-effect
branches, backstop untouched). Covered: 429→200 mixed ordering in both
positions, 3-attempt budget (exactly 2 waits, then throw), permanent
401/403/404/500 with no wait and no release, Retry-After seconds/HTTP-date/
malformed/missing/floor-600 (long server waits honored)/max-across-batch, single whole-batch release,
fresh FINAL-round work items driving the guards (Done/Cancelled protection),
original-decision mapping with no numeric fallback, context-missing throws,
and error messages that never leak body keys or auth headers.

`tests/mr-comments.test.mjs` additionally covers the MR-comment feature end to
end against the real node code: system-note/human-note filtering and safe
failure on malformed pages (with the empty placeholder tolerated and a
no-human-notes sentinel), note-event filters (MR only, create/update only),
markdown plain/linked refs, state-aware comment mapping (opened/merged/closed ×
validated targets), comment-only references closing on merge and resetting on
close-without-merge, bare-mention no-false-closure, precedence of conflicting
refs across sources (closes in description/commits vs reopens in comments and
vice versa — reopen wins in the reducer), repeat dedup (in-note and across
events via external_id), the sequential single-path graph config (one
normalizer inbound, Execute Once notes fetch, no silent page cap), and guards
(In Review / Done / mr-closed rules) applied to comment-driven decisions.

### Real-time (workflow-1)

1. Create a Plane issue `DEV-1` in **Todo** state.
2. Push a commit with message `refs DEV-1` to a feature branch → expect a Plane comment + state → **In Progress**.
3. Open an MR with description `closes DEV-1` → expect state → **In Review** (MR description + all MR commits are scanned).
4. Push a commit `closes DEV-1` to the same MR branch → MR `update` webhook fires → expect state stays **In Review** (close-in-mr, idempotent via `external_id`).
5. Merge the MR to the default branch → expect state → **Done** + the MR description edited to link back to the Plane issue.
6. Push a commit `reopens DEV-1` → expect Done → **In Progress**.
7. Re-push the same commit → expect **no duplicate comment** (409 handled via `external_id`).
8. Open an MR with title `DEV-2 fix` but no issue ref in the description, commits, or comments → expect **no state change** (title-only references are intentionally ignored).
9. Approve / unapprove an MR → expect **no state change, no comment** (approval actions are no-ops).
10. After linkback has mutated the description to `closes [DEV-1](url)`, trigger an MR `update` → expect `closes [DEV-1](url)` to still be recognized as a close ref (markdown-link-aware).
11. On an **open** MR targeting the default branch, post a human comment `closes DEV-1` → expect a Plane comment + state → **In Review** (comment-only reference).
12. Create an MR whose description/comments contain NO refs, push no closing commits, but post a comment `closes DEV-2`, then **merge** the MR to the default branch → expect **Done** (the merge event scans all human MR notes).
13. Post a comment `closes DEV-2`, then **close** the MR without merging → expect the issue reset **Todo** if it was In Progress/In Review (guarded).
14. Post a bare comment `DEV-2` (no keyword) on an open MR whose issue is In Review → expect **no state change** (bare mentions never close and never downgrade In Review), only the "MR" linkback comment.
15. Post the SAME comment `closes DEV-2` twice on the same open MR → expect **no duplicate** Plane comment (external_id 409) and no state flapping.
16. Comment on an **issue** (not an MR), or observe a system note (e.g. "changed title") → expect **no state change, no comment** (only human MR comments are processed).
17. Comment `closes DEV-2` on an MR that is **already merged** into the default branch → expect **Done** (if not already Done); on an issue already Done → expect no state change (Done protected).

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
GitLab Webhook (Push + MR + Note events)
  → Verify Secret (X-Gitlab-Token)
  → Switch on event type (push / merge_request / note)
  → Push: Normalize Push (extract DEV-NN from commit messages)
  → MR: MR Action? (open/update/reopen/merge/close → TRUE; approval/etc → FALSE)
        TRUE (strict sequence — one normalizer run, notes failure stops
              the run BEFORE the Reducer):
          Get MR Commits → Get MR Notes (Execute Once; URL anchored on the
                          webhook payload; paginated notes API, no cap)
            → Filter MR Notes (system notes dropped; no human notes → one
              empty sentinel message; malformed page → safe failure)
            → Normalize MR (with commits) — scans description ONCE + commits
              (from Get MR Commits) + ALL human comments (from input)
        FALSE: Normalize MR (direct) — returns [] for non-merge/close actions
  → Note: MR Note? (MergeRequest + human + create/update only → TRUE)
        TRUE:  Normalize MR Note — scans the comment body; mapping by MR state
               (opened → close-in-mr/mr-open, merged → merged/mention,
                closed → mr-closed/mention)
        FALSE: dropped (issue/commit comments, system notes, other actions)
  → Reducer (group by issue, apply precedence + guards)
  → Plane lookup retry barrier:
       Prepare Lookup Attempt → Plane: Get Work Item by identifier (DEV-15 → UUID,
         fullResponse + neverError) → Classify Lookup Batch → Lookup Batch Ready?
         all success → Unwrap Lookup Batch
         any 429 (attempt < 3) → Wait for Plane Retry
                                  (max(600 s, max Retry-After); long waits honored)
                                  → re-run the entire GET batch
         permanent failure / 3rd 429 → throw (no downstream release)
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
