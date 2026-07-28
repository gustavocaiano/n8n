# Plan: GitLab ↔ Plane Bridge (n8n)

Make the self-hosted Plane issue tracker (plane.nforensic.site) behave like
GitLab/GitHub's native issue tracker, driven by GitLab (gitlab.pdmfc.com) commit
and merge-request events. A bare mention `DEV-15` posts a comment and advances
the issue; `closes DEV-15` moves it through review to done; MR lifecycle events
sync state; reverts reopen.

**Status:** Planning complete, not implemented.
**Owner workspace:** `gcaiano` (UUID `06ee19a6-de38-47bf-90bd-bd6d3d350384`), workspace slug TBD (confirm at build time).
**Stack:** GitLab self-hosted → n8n (webhook-trigger, publicly reachable, community nodes OK) → Plane self-hosted.

---

## Resolved decisions (from user Q&A)

| Question | Decision |
|---|---|
| Project scope | **DEV now**, designed to extend to ADM (and others) without rework |
| Network reachability | n8n is **publicly reachable** → webhook-primary architecture |
| Community nodes | **OK** — use `2mOlaf/n8n-nodes-planeso` + HTTP Request fallback |
| Mention semantics | **Mention = comment + In Progress** (bare mention in a commit on Todo/Backlog advances to In Progress) |
| MR-open | advances Todo/Backlog → In Progress |
| MR-closed-without-merge | reverts → Todo (guarded) |
| MR-merged | → Done |
| Revert/reopen | Done → In Progress |

## Council direction (chosen from alpha + gamma review)

Two councillors (alpha: state-machine; gamma: improvements) delivered substantive
analysis. Beta (n8n workflow structure) failed twice with session errors — its
structural concerns were folded in from the earlier librarian research instead.

**Adopted design shifts driven by the council:**

1. **Event reducer, not direct webhook-to-PATCH.** The bridge parses every
   event (webhook or backstop) into normalized semantic actions, then reduces
   per-issue before touching Plane. This avoids state flapping when a single
   push contains `refs` then `closes` then `reopens` of the same issue.
   *(alpha A.1)*

2. **Protected states.** `Done` is never downgraded except on explicit
   `reopens`/confirmed revert. `Cancelled` is human-owned — the bridge never
   touches it. `In Review` is never downgraded to `In Progress` by a later bare
   mention. *(alpha A.1 guards)*

3. **`closes` on a feature branch with no open MR → comment + In Progress only,
   NOT In Review.** "In Review" requires a confirmed open MR containing the
   commit. *(alpha C.1)* — this sharpens the original "closes in open MR → In
   Review" rule: the bridge must verify MR membership before promoting to
   Review.

4. **Deployment-success → Done (gamma §C, adopted as a Phase 3 improvement).**
   "Merged ≠ deployed." MR-merged alone moves to **In Review** (or a custom
   "Merged" state); only a successful production deployment moves to **Done**.
   This fixes a correctness bug in the naive design. Requires the GitLab
   **Deployment** webhook + `GET /commits/:sha/merge_requests` to trace back to
   the issue. See Phase 3 — A14.

5. **`external_id` on EVERY Plane write is a hard design rule**, not a
   nice-to-have. Comments support it natively (409 on dup). Links/relations/work
   logs that don't support it must dedupe client-side. *(gamma runner-up)*

6. **Sentinel tagging on bridge writes.** Every comment the bridge creates
   embeds `<!-- n8n-bridge: src=<source>, action=<verb> -->` so the (future)
   back-direction Plane→GitLab poll can detect echoes and avoid loops. *(gamma A12)*

7. **Conservative downgrades.** MR-closed-without-merge → Todo only if the issue
   is not Done, no other open MR references it, and the closed MR was the reason
   it advanced. *(alpha A.1 rule 6)*

8. **Backstop does state transitions, but only for strong current facts** (MR
   currently merged to default → Done; open MR currently contains closing commit
   → In Review). Unsafe for backstop: MR-closed-without-merge downgrades,
   force-push downgrades, bare-mention advances past In Progress. *(alpha B)*

---

## State machine (DEV project)

Confirmed Plane states (UUIDs):
- `Backlog` `e3bde020-...` (default, group=backlog)
- `Todo` `6af7ed32-...` (group=unstarted)
- `In Progress` `16099284-...` (group=started)
- `In Review` `a24250ec-...` (group=started)
- `Done` `56c26d40-...` (group=completed)
- `Cancelled` `c69e0a4f-...` (group=cancelled) — **human-owned, never touched by bridge**

### Transition table

| Trigger | Condition | From → To | Also |
|---|---|---|---|
| Bare mention `DEV-15` in commit | commit on any branch | Todo/Backlog → In Progress | comment "mentioned in <commit-url>" |
| `closes/fixes/resolves DEV-15` in commit | commit in **open MR** targeting default | Todo/Backlog/In Progress → In Review | comment |
| `closes/fixes/resolves DEV-15` in commit | commit **merged to default** (or MR merged) | any non-Cancelled → Done | comment + link MR |
| `closes/fixes/resolves DEV-15` on feature branch | **no open MR** contains the commit | Todo/Backlog → In Progress (NOT In Review) | comment |
| `reopens DEV-15` | any branch | Done → In Progress | comment |
| MR opened referencing `DEV-15` | action=open | Todo/Backlog → In Progress | comment |
| MR closed without merge | action=close, guarded | In Progress/In Review → Todo (only if no other open MR refs it) | comment |
| MR merged referencing `DEV-15` | action=merge | → Done | comment + link |
| Deployment to prod success (Phase 3) | env=production, status=success | In Review → Done | comment "deployed to prod <link>" |
| Pipeline failed (Phase 3) | status=failed | In Review → In Progress | comment "pipeline #N failed <link>" |

**Precedence within one event (multiple commits to same issue):** reduce in
chronological order; later semantic intent wins, subject to the protected-state
guards. Explicit reopen > merge-to-default > close-in-open-MR > MR-open > bare
mention > MR-closed-unmerged. *(alpha A.1 ladder)*

**Graceful degradation for ADM (no In Review state):** per-project state map
with fallback. ADM's "In Review" target collapses to "In Progress". *(alpha D.8,
gamma A-multi-project)*

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ WORKFLOW 1 — real-time (GitLab Trigger: Push + Merge Request)     │
│                                                                   │
│ GitLab Trigger ──► route on X-Gitlab-Event                        │
│   ├── Push Hook ──► Code: normalize commits[] → semantic actions  │
│   └── MR Hook ────► route on object_attributes.action             │
│         ├── open/update ──► HTTP GET /mrs/:iid/commits (if needed)│
│         ├── merge ─────────► treat commits as merged-to-default   │
│         └── close ─────────► MR-closed-without-merge path         │
│                                                                   │
│   ──► Code: REDUCER — group by issue, apply precedence + guards   │
│   ──► for each issue:                                             │
│         1. Plane: GET work item by identifier (DEV-15)            │
│         2. Plane: POST comment (external_id=<sha|mr-iid-action>)  │
│         3. Plane: PATCH state (if transition allowed by guards)   │
│         4. Plane: POST link (MRs only; dedupe client-side)        │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ WORKFLOW 2 — backstop (Schedule Trigger, every 15–30 min)         │
│                                                                   │
│ Schedule Trigger ──► HTTP GET /repository/commits?since=<lastSha> │
│   ──► Code: dedup via staticData.lastSha (ring of last N SHAs)    │
│   ──► SAME reducer + Plane calls as Workflow 1                    │
│   (external_id dedup makes webhook+backstop overlap safe for      │
│    comments; backstop state transitions limited to "strong current│
│    facts" only — see Council direction #8)                        │
└──────────────────────────────────────────────────────────────────┘
```

### Components

| Function | n8n node | Notes |
|---|---|---|
| Receive GitLab events | **GitLab Trigger** (native) | Auto-registers webhook on activation; verifies `X-Gitlab-Token`. Subscribe to Push + Merge Request (+ Deployment, Pipeline in Phase 3) |
| Route by event type | **Switch/IF** on `X-Gitlab-Event` header | `Push Hook` vs `Merge Request Hook` |
| Fetch all MR commits | **HTTP Request** → `GET /projects/:id/merge_requests/:iid/commits` | MR webhook only has `last_commit` |
| Regex + normalize + reduce | **Code node** (JS) | The brain — extracts `DEV-NN`, applies precedence/guards, emits per-issue actions |
| Resolve identifier | **Plane node** (Get by Identifier) or HTTP Request | `DEV-15` → work-item UUID + project UUID |
| Post comment | **Plane node** (Create Comment) | `comment_html` + `external_id` + `external_source="gitlab"` |
| Change state | **Plane node** (Update Work Item) | `state=<uuid>`; guarded by reducer |
| Add MR link | **Plane node** (Create Link) | MRs only; GET existing links first to dedupe (no external_id) |
| Auth Plane | **Header Auth** credential (`X-Api-Key`) | Community node uses its own credential type (API key + Base URL + workspace slug) |
| Auth GitLab API | **Header Auth** credential (`PRIVATE-TOKEN`) | For HTTP Request calls to GitLab REST |
| Backstop schedule | **Schedule Trigger** | 15–30 min interval |
| Backstop dedup | **Code node** + `$getWorkflowStaticData('global')` | Ring of last N commit SHAs (N≈50); Plane external_id is the real safety net |

### Multi-project extensibility

A config object in the reducer Code node maps prefix → project:
```js
const PROJECTS = {
  DEV: { uuid: 'b5842796-...', slug: '<confirm>', states: { backlog:'e3bde020-...', todo:'6af7ed32-...', inProgress:'16099284-...', inReview:'a24250ec-...', done:'56c26d40-...' } },
  ADM: { uuid: '902e990c-...', slug: '<confirm>', states: { ..., inReview: null /* fallback to inProgress */ } },
};
```
Adding ADM = one entry. *(gamma A multi-project, alpha D.8)*

---

## Phases

### Phase 1 — Core bridge (MVP)  [sequential foundation]
**Write-scope:** `files/gitlab-plane-bridge/workflow-1-realtime.json`, `files/gitlab-plane-bridge/workflow-2-backstop.json`, `files/gitlab-plane-bridge/README.md`

Delivers the resolved state machine for the DEV project:
- Workflow 1: GitLab Trigger (Push + MR) → route → reducer → Plane comment + state + MR-link
- Workflow 2: Schedule backstop → same reducer → Plane
- Regex: `(?<![A-Z0-9])([A-Z][A-Z0-9]+-\d+)(?![A-Z0-9-])` (case-sensitive; reject mixed-case)
- Closing keywords: `closes|fixes|resolves` (plural-imperative canonical forms only)
- Reopen keyword: `reopens`
- `external_id` on every comment; sentinel HTML comment in every bridge write
- Guards: protected Done/Cancelled, MR-membership check before In Review, MR-closed-without-merge guard
- Plane auth (Header Auth `X-Api-Key`), GitLab API auth (`PRIVATE-TOKEN`)
- README with setup: Plane API key, GitLab token, webhook activation steps, state-UUID config

**Validatable when:** pushing a commit with `refs DEV-15` to a feature branch posts a Plane comment and moves a Todo issue to In Progress; opening an MR with `closes DEV-15` in the description moves it to In Review; merging moves to Done; `reopens DEV-15` reverts Done→In Progress; duplicate push does not double-comment (409 handled).

### Phase 2 — Robustness & edge cases  [after Phase 1]
**Write-scope:** `files/gitlab-plane-bridge/workflow-1-realtime.json` (extend), `files/gitlab-plane-bridge/reducer.js` (extracted shared logic)

- Extract reducer into a shared Code-node module imported by both workflows (DRY)
- 20-commit cap handling: when `total_commits_count > len(commits)`, HTTP GET missing commits with `since=` filter (don't defer to backstop — gamma B5, alpha B)
- Force-push: skip comment for already-processed SHA (external_id 409), do NOT blindly reapply state
- MR `action=update` re-scan description (people add `closes` after open — gamma B10)
- Skip MR drafts (`draft`/`work_in_progress` flag — gamma D.6)
- Stale-issue nudge: daily Schedule scan of `staticData` last-activity map, comment after N days (gamma A8)
- Backstop ring-buffer dedup (last ~50 SHAs) instead of single pointer (alpha B)
- Per-issue processing serialization (avoid concurrent webhook races — alpha A.2)

**Validatable when:** a 25-commit push processes all 25 (via API fetch); an MR edited to add `closes DEV-15` after open correctly advances state; a draft MR does not move the issue; force-push of an old SHA does not duplicate the comment.

### Phase 3 — Improvements (parallelizable subset)  [after Phase 2]
Each item is an independent lane with its own write-scope; can be delegated in parallel.

| # | Improvement | Trigger | Write-scope | Verdict |
|---|---|---|---|---|
| A14 | **Deployment-success → Done** (replaces MR-merged→Done) | Deployment webhook `status=success, env=prod` | `files/gitlab-plane-bridge/workflow-3-deploy.json` | Easy-Medium — **highest value** (gamma §C) |
| A6 | Pipeline-failed → In Progress + comment | Pipeline webhook `status=failed` | `files/gitlab-plane-bridge/workflow-3-pipeline.json` | Easy-Medium |
| A1 | Branch-naming auto-association (`feature/DEV-15-...`) | Push, `before==000…` (new branch) | extend workflow-1 | Easy |
| A10 | Work log from MR review duration | MR `action=merge` | extend workflow-1 | Easy |
| A4/A9 | Commit-footer relations (`Blocks: DEV-22`) | Push, parse trailers | extend workflow-1 reducer | Medium — confirm Plane relations POST + custom type |
| A8 | Stale-issue detection | Schedule daily | `files/gitlab-plane-bridge/workflow-3-stale.json` | Medium |
| A11 | Epic progress rollup | on Done transition | extend workflow-1 | Medium — confirm parent-filter |
| A3 | Cycle/sprint auto-assign on MR-open | MR `action=open` | extend workflow-1 | Easy-Medium |
| A2 | Auto-assign commit author | Push/MR | extend workflow-1 | Medium — **confirm Plane members endpoint** |
| A7 | Release notes → Plane page | Release webhook | `files/gitlab-plane-bridge/workflow-3-release.json` | Medium — confirm create-page endpoint |
| A13 | Tag → Plane milestone | Tag webhook + REST | `files/gitlab-plane-bridge/workflow-3-tag.json` | Medium — confirm create-milestone |
| A12 | Plane→GitLab back-channel (polled) | Schedule poll Plane | `files/gitlab-plane-bridge/workflow-3-back.json` | Medium — loop-prevention via sentinel |
| A5 | Block merge until issue in correct state | GitLab CI → n8n webhook | `files/gitlab-plane-bridge/workflow-3-gate.json` + CI config | Hard — CI integration path |

### Explicitly rejected (gamma §B)
- True real-time bidirectional sync (loop machine)
- Auto-creating Plane issues from GitLab issues (two sources of truth)
- Relying on GitLab native `closes` for external trackers (impossible — the bridge exists because of this)
- Parsing `closes` from MR titles (free-text, unreliable)
- Mirroring commit diffs into Plane comments (link, don't paste)
- Auto-provisioning Plane users from GitLab (security/lifecycle nightmare)
- Reacting to emoji/feature-flag webhooks (noise)

---

## Execution Order

```
Phase 1 (foundation) ── sequential, single lane ──► validates core state machine
   │
   ▼
Phase 2 (robustness) ── sequential, extends Phase 1 files ──► validates edge cases
   │
   ▼
Phase 3 (improvements) ── parallelizable ──► each lane owns a distinct file
   ├── A14 deploy→Done        (workflow-3-deploy.json)      ★ recommended first
   ├── A6  pipeline-failed    (workflow-3-pipeline.json)       can run in parallel
   ├── A1  branch-naming      (extends workflow-1)             can run in parallel
   ├── A10 work-log           (extends workflow-1)             can run in parallel
   ├── A4  footer-relations   (extends reducer.js)             can run in parallel
   ├── A8  stale-detection    (workflow-3-stale.json)          can run in parallel
   ├── A11 epic-rollup        (extends workflow-1)             can run in parallel
   ├── A3  cycle-auto-assign  (extends workflow-1)             can run in parallel
   ├── A2  auto-assign-author (extends workflow-1)             gated on members endpoint
   ├── A7  release-notes      (workflow-3-release.json)        gated on create-page endpoint
   ├── A13 tag→milestone      (workflow-3-tag.json)            gated on create-milestone endpoint
   ├── A12 back-channel       (workflow-3-back.json)           needs sentinel from Phase 1
   └── A5  merge-gate         (workflow-3-gate.json + CI)      hardest, last
```

**Why these boundaries:**
- Phase 1 must come first: the reducer + guards + Plane integration are the foundation every later phase extends. Parallelizing here would duplicate the core logic.
- Phase 2 extends Phase 1's files and hardens correctness; must follow Phase 1 because it modifies the reducer.
- Phase 3 lanes are file-disjoint (each owns a `workflow-3-*.json` or extends workflow-1 at distinct call-sites), so they can run in parallel after Phase 2. A14 (deploy→Done) is recommended first because it changes the semantics of "Done" and should land before users build habits around the Phase 1 behavior.

**UI/UX flag:** None of these phases involve user-facing UI — all are n8n workflow JSON + Plane API calls. No `@designer` routing needed.

---

## Deferred questions / to confirm at build time

Recorded so they're not lost (gamma "endpoints to confirm"):

1. **Workspace slug** for Plane API paths (`/api/v1/workspaces/{slug}/...`) — confirm in Plane settings.
2. **Plane members endpoint** (`GET /workspaces/{slug}/members/`) — needed for A2 auto-assign-author.
3. **Plane create-page endpoint** — needed for A7 release-notes.
4. **Plane create-milestone endpoint** — needed for A13 tag→milestone.
5. **Plane relations POST** + whether custom `relation_type` strings are accepted — needed for A4/A9.
6. **Plane work-log `external_id` support** — determines A10 dedup strategy.
7. **Plane outgoing webhooks** — would enable real-time A12 back-channel instead of polling.
8. **GitLab `POST /merge_requests/:iid/notes`** — needed for A12 back-channel.
9. **GitLab create/update MR approval rules** — needed for A5 bot-approver path (CI path is preferred regardless).
10. **GitLab squash-merge mode** per project — determines whether `closes` belongs in MR description or commit message (gamma D.1).

---

## Key references

- GitLab webhook events & payloads: https://docs.gitlab.com/user/project/integrations/webhook_events/
- GitLab commits API: https://docs.gitlab.com/api/commits/
- GitLab merge requests API: https://docs.gitlab.com/api/merge_requests/
- n8n GitLab Trigger: https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.gitlabtrigger
- n8n HTTP Request + Header Auth: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/
- n8n staticData (dedup): https://docs.n8n.io/docs/build/code-in-n8n/cookbook/built-in-methods-and-variables-examples/getworkflowstaticdata
- Plane API intro: https://developers.plane.so/api-reference/introduction
- Plane get work item by identifier: https://developers.plane.so/api-reference/issue/get-issue-sequence-id
- Plane create comment (external_id dedup → 409): https://github.com/makeplane/plane/blob/c62930eb/apps/api/plane/api/views/issue.py
- Community Plane node: https://github.com/2mOlaf/n8n-nodes-planeso
- Closest template (GitLab MR → Jira key parse): https://n8n.io/workflows/7924-automate-code-reviews-for-gitlab-mrs-with-gemini-ai-and-jira-context

## Council record

- **Alpha** (state-machine edge cases): reconciled — adopted reducer pattern, protected-state guards, MR-membership check for In Review, conservative downgrade rules, backstop strong-facts-only state transitions.
- **Gamma** (improvements & feasibility): reconciled — adopted deployment→Done as the semantic fix to "Done", external_id as hard rule, sentinel tagging, 15 feasible improvements catalogued in Phase 3, 7 ideas explicitly rejected.
- **Beta** (n8n workflow structure): failed twice with session errors (ses_0562e82f8ffe1E5mONlRMGrklD, ses_0562e0788ffeLRnqvUnxB1TLGc). Structural concerns (event routing, dedup key design, 20-commit cap handling, multi-project config) were folded in from the earlier librarian research (lib-2) and alpha's review. Not retried a third time per council protocol.
