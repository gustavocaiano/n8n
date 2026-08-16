# Plane DEV Daily Briefing (n8n)

Posts each developer a personal **Top-3 plan for the day**, in European
Portuguese (pt-PT), to a shared Telegram group. It reads open work items from
the **DEV** project on the self-hosted Plane instance
(`plane.nforensic.site`), groups them per recipient and per Plane module, and
asks OpenAI to produce a focused Top-3 prioritization for each recipient who has
issues. The workflow is **read-only** — it never writes back to Plane (no
comments, no state changes, no creations).

The workflow ships **inactive by default**. Import it, configure the env vars,
wire the Telegram credential, test manually, and only then activate the
schedule.

## Purpose

Give every developer on the DEV project a single, short, AI-summarized briefing
at the start of each weekday: the three things they should focus on today, drawn
from their open Plane issues across all modules (modules represent the real
sub-projects the team works on). Recipients with zero open issues skip the AI
call but still receive a concise "sem tarefas abertas" Telegram message. The
briefing lands in one Telegram group, one message per developer, @-mentioning
that developer so they notice it.

## Node-level flow

```
Schedule (weekdays 08:30 Europe/Lisbon)
  → Init & Validate Config
       parse $env.PLANE_DAILY_BRIEFING_RECIPIENTS (JSON array) and
       $env.PLANE_PROJECT_DEV (JSON); assert required env vars are present and
       non-empty; assert each recipient has {planeUserId, displayName,
       telegramUsername}. Throw (fail-fast) on any missing/malformed config.
  → Plane: List DEV Work Items
       GET /api/v1/workspaces/{WORKSPACE_SLUG}/projects/{PLANE_PROJECT_DEV.uuid}/work-items/
       header X-Api-Key: $env.PLANE_API_KEY, per_page=1000. Fail-fast on error.
  → Plane: List DEV Modules
       GET .../projects/{PLANE_PROJECT_DEV.uuid}/modules-lite/
       same auth, per_page=1000. Fail-fast on error.
  → Prepare Module Requests → Plane: List Module Work Items
       for each module, GET .../modules/{module_id}/module-issues/ so every
       issue can be mapped reliably to its real-world project/module.
  → Plane Page Cap Guards
       if work-items, modules, or one module-membership response reaches the
       configured page cap or response metadata proves another page exists,
       throw rather than build an inaccurate briefing.
  → Filter & Group
       drop done + cancelled states (keep backlog / todo / inProgress / inReview
       from PLANE_PROJECT_DEV.states); drop work items whose assignee is not in
       the recipients allowlist (by planeUserId); group the rest by planeUserId
       → module → issue list. Emit ONE item for every allowlisted recipient.
       Recipients with zero open issues bypass OpenAI and receive an empty-day
       Telegram message.
  → Build Prompt
       assemble a pt-PT prompt: the recipient's open issues grouped by module,
       asking OpenAI for a Top-3 prioritized plan for the day.
  → OpenAI: Top-3 Plan
       Responses API with strict JSON Schema output;
       model = $env.PLANE_DAILY_BRIEFING_OPENAI_MODEL;
       Authorization: Bearer $env.OPENAI_API_KEY.
       On API error / empty / malformed response → deterministic pt-PT fallback
       (a simple in-progress-first list built from the recipient's issues). The
       run does NOT fail here.
  → Format Telegram Message
       pt-PT text: @mention the recipient's telegramUsername + the Top-3 plan
       (or the deterministic fallback).
  → Telegram: Send to Group
       Telegram node; chat id = $env.PLANE_DAILY_BRIEFING_TELEGRAM_CHAT_ID.
       A Telegram send failure fails the run.
```

Exactly **one OpenAI call per recipient with issues**; zero calls for recipients
with zero issues. Exactly **one Telegram message per allowlisted recipient**.

## Configuration

Auth is supplied through `$env` (Plane + OpenAI) and one n8n **Telegram account
credential** (the bot token). There are no per-node credential dropdowns for
Plane/OpenAI — their keys come from the environment. The Telegram nodes use an
n8n credential (see [Import & activation](#import--activation)).

| Variable | Value | Required | Example |
|---|---|---|---|
| `WORKSPACE_SLUG` | Plane workspace slug (from Plane URL: `plane.nforensic.site/<slug>/...`) — *existing* | yes | `pdmfc` |
| `PLANE_PROJECT_DEV` | JSON string: DEV project UUID + 6 state UUIDs — *existing*. The briefing's open-state filter uses the state UUIDs. | yes | `{"uuid":"b5842796-...","states":{...}}` |
| `PLANE_API_KEY` | Plane API key — sent as `X-Api-Key` by every Plane HTTP node | yes | `plane_xxxxxxxx` |
| `OPENAI_API_KEY` | OpenAI API key — sent as `Bearer` by the OpenAI node | yes | `sk-xxxxxxxx` |
| `PLANE_DAILY_BRIEFING_OPENAI_MODEL` | OpenAI model for the briefing; workflow fallback is `gpt-5-mini` | no | `gpt-5-mini` |
| `PLANE_DAILY_BRIEFING_TELEGRAM_CHAT_ID` | Telegram **group** chat id — negative for groups (see [Telegram setup](#telegram-setup)) | yes | `-1001234567890` |
| `PLANE_DAILY_BRIEFING_RECIPIENTS` | JSON array of recipients (see [Recipient mapping](#recipient-mapping)) | yes | `[{"planeUserId":"...","displayName":"...","telegramUsername":"..."}]` |
| *Telegram account credential* | n8n credential holding the bot token (not an env var) | yes | — |

Add these to your n8n server's environment (the `config/.env` file + the
`config/docker-compose.yml` `environment:` block, then restart n8n). The
`config/.env.example` file already contains a clearly separated **Plane DEV
Daily Briefing** section with safe placeholders/defaults.

> **Important:** n8n only reads environment variables at startup — restart n8n
> after changing them.

### Telegram setup

The briefing posts to a Telegram **group**; each recipient's plan is a separate
message in that group, @-mentioning the recipient.

1. **Create a bot** via [@BotFather](https://t.me/BotFather) (`/newbot`) and keep
   the bot token. This token goes into the n8n **Telegram account** credential,
   **not** into an env var.
2. **Create a Telegram group** (or reuse an existing one), add the bot to it,
   and promote the bot to **admin** so it can post messages. Also add every
   recipient to the group (they must be members to be @-mentioned reliably).
3. **Obtain the group's chat id — it is negative for groups.** After adding the
   bot, send any message into the group, then query the Telegram API:
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
   ```
   In the response, find the `chat` object for your group; its `id` is a large
   **negative** number (supergroups look like `-1001234567890`). Put that value
   in `PLANE_DAILY_BRIEFING_TELEGRAM_CHAT_ID`. Do not use your private user chat
   id (that is positive and points to a 1:1 chat, not the group).
4. **@username requirement.** Each recipient must have a public Telegram
   **@username** set in their Telegram account (Settings → Username). The
   `telegramUsername` field in `PLANE_DAILY_BRIEFING_RECIPIENTS` is exactly that
   username (without the leading `@`). The workflow prepends `@` to build the
   mention. A recipient with no @username cannot be mentioned and should not be
   listed (Telegram will still deliver the message to the group, but the mention
   won't resolve).

### Import & activation

The workflow is **inactive by default** — it ships disabled, so the schedule
does not fire until you explicitly activate it after testing.

1. Import `workflow.json` into n8n. Leave it **inactive** (do not toggle it on
   yet).
2. Fill in the env vars in `config/.env` (copy from `config/.env.example`) and
   restart n8n so `$env` resolves.
3. In n8n, open the **Telegram** credential settings and create/select the
   existing **Telegram account** credential that holds the bot token.
4. **Reselect the Telegram account credential** in every Telegram node after
   import. n8n credential IDs are instance-specific and do not survive a raw
   JSON import, so a freshly imported Telegram node may point at a missing
   credential. Open the node, clear the credential dropdown, and reselect the
   existing Telegram account credential you created in step 3. (Plane and
   OpenAI nodes need no reselection — they read keys from `$env`.)
5. Run the workflow **manually** once (Execute workflow) and confirm the
   expected Telegram messages appear in the group.
6. Only after the manual run succeeds, **activate** the workflow so the
   weekdays-08:30-Europe/Lisbon schedule takes effect.

## Recipient mapping

`PLANE_DAILY_BRIEFING_RECIPIENTS` is a JSON array — one object per developer.
Each object must have exactly three keys (unknown keys fail validation):

| Key | Meaning |
|---|---|
| `planeUserId` | The recipient's Plane user UUID — matched against each work item's assignee. Work items whose assignee is **not** in this list are dropped (allowlist filter). |
| `displayName` | Human-friendly name used in the pt-PT message greeting. |
| `telegramUsername` | The recipient's public Telegram @username **without** the leading `@`. Used to @-mention them in the group. |

**Example (placeholders only — no real personal IDs or secrets):**

```json
[
  {
    "planeUserId": "<plane-user-uuid>",
    "displayName": "<Display Name>",
    "telegramUsername": "<telegram-username>"
  },
  {
    "planeUserId": "<plane-user-uuid>",
    "displayName": "<Display Name>",
    "telegramUsername": "<telegram-username>"
  }
]
```

The value above is valid JSON: copy it, replace each `<...>` placeholder with
the real values, and keep it as a single line in `config/.env` (matching the
existing raw-JSON style of `PLANE_PROJECT_DEV`). The `Init & Validate Config`
node parses it with `JSON.parse` and throws (fail-fast) if it is missing, not an
array, or any object is missing one of the three keys.

## Behavior, prioritization & modules

- **Schedule.** Weekdays (Mon–Fri) at 08:30 **Europe/Lisbon**. The timezone is
  set in the workflow settings, so Lisbon DST (WET ↔ WEST) is handled
  automatically — it stays 08:30 local time year-round.
- **Read-only.** The workflow only sends `GET` requests to Plane. It never
  creates, updates, comments, or changes state on any Plane work item. Contrast
  with the GitLab↔Plane bridge, which writes comments and state.
- **Open-state filter.** Only work items in open states are kept: `backlog`,
  `todo`, `inProgress`, `inReview` (derived from `PLANE_PROJECT_DEV.states`).
  `done` and `cancelled` are excluded. (If Plane states change, update
  `PLANE_PROJECT_DEV` — no workflow JSON edit needed.)
- **Allowlist filter.** Only work items assigned to a `planeUserId` listed in
  `PLANE_DAILY_BRIEFING_RECIPIENTS` are kept. Everything else is dropped — the
  briefing never mentions non-allowlisted users or their issues.
- **Modules = real projects.** Each Plane module represents a real sub-project.
  The workflow reads each module's membership endpoint, then groups every
  recipient's issues by module before going to OpenAI. Issues with no module
  association are shown as `Sem módulo`.
- **Top-3 prioritization (pt-PT).** For each recipient with ≥1 open issue, one
  OpenAI Responses API call produces a Top-3 plan for the day in pt-PT,
  weighing priority, deadlines, state, module, labels, and current work. The
  output is a short, actionable plan — not a full issue dump.
- **Zero issues → no AI cost.** A recipient with zero open issues bypasses
  OpenAI and receives a short Telegram message confirming there are no open
  assigned DEV issues.
- **One message per developer.** Each recipient's plan is a separate Telegram
  message posted to the group, @-mentioning that recipient. Other recipients'
  issues are never included in a given recipient's message.

### Plane page cap and fail-fast continuation guard

The current self-hosted deployment supports requests with `per_page=1000`, but
Plane limits vary by version and a server may clamp that value. The workflow
does **not** paginate beyond the first page. Its normalization nodes fail fast
when `next_page_results`, totals, page counts, or a next-page URL prove that
more data exists, or when a bare response reaches 1000 records. A `next_cursor`
by itself is deliberately ignored because Plane can include one on the final
page. Add cursor pagination before activation if the guard fires — the workflow
will not silently continue with incomplete data.

## Privacy and cost

- **Privacy.** For each recipient with issues, that recipient's issue titles,
  identifiers, states, priorities, dates, labels, module names, and Plane links
  are sent to OpenAI, along with their `displayName`. No other recipient's data
  is included in a given prompt. `PLANE_API_KEY` and `OPENAI_API_KEY` live only
  in the server environment (`$env`) and are never sent to Telegram. The
  Telegram message is posted to a group the bot is a member of; only the
  recipient's own issues appear in their message.
- **Group visibility.** These briefings are personalized, not private: every
  member of the shared Telegram group can read every developer's message.
- **Execution history.** n8n may retain fetched work-item data in execution
  history. Configure an appropriate retention policy and restrict workflow and
  execution access. Use a dedicated, read-only Plane token with the narrowest
  available workspace permissions. Because this deployment allows `$env` in
  Code nodes, only trusted editors should be able to modify or run workflows.
- **API load.** Module-membership requests are sent one at a time with a short
  interval to reduce the chance of hitting Plane rate limits.
- **Cost.** Exactly **one OpenAI Responses API call per recipient with issues,
  per run** — zero calls for recipients with zero issues. With `M` recipients
  holding open issues and ~22 weekdays/month, that is roughly `22 × M`
  OpenAI calls/month. Using the default `gpt-5-mini` model keeps per-call cost
  small; the prompt is bounded by the recipient's own open-issue count (and
  capped indirectly by the 1000-item Plane page guard).

## Failure behavior

| Failure | Behavior |
|---|---|
| **Missing / malformed config** (`WORKSPACE_SLUG`, `PLANE_PROJECT_DEV`, `PLANE_API_KEY`, `OPENAI_API_KEY`, `PLANE_DAILY_BRIEFING_TELEGRAM_CHAT_ID`, or `PLANE_DAILY_BRIEFING_RECIPIENTS` missing/empty/malformed JSON) | **Fail-fast** at `Init & Validate Config`. The run stops before any Plane or OpenAI call. No partial messages are sent. The model variable is optional and falls back to `gpt-5-mini`. |
| **Plane fetch error** (auth, network, non-cap HTTP error) | **Fail-fast.** No briefings are produced; the run stops. |
| **Plane page cap hit** (response metadata proves another page exists, or a bare response reaches the configured 1000-record cap) | **Fail-fast** in the corresponding normalization node — refuse to continue with a possibly-truncated dataset. |
| **OpenAI runtime failure** (HTTP, network, timeout, incomplete, empty, or malformed response) | **Deterministic pt-PT fallback.** The workflow uses the same local priority/deadline/state scoring applied before the AI call and proceeds to Telegram. The run does **not** fail. |
| **Telegram send failure** (bad chat id, bot not in group, bot not admin, Telegram API error) | **Fails the run.** A Telegram failure is not silently skipped — it surfaces as a failed execution so the operator notices. |

**No Plane writes.** Under all paths — success, OpenAI fallback, or failure —
the workflow only reads from Plane. There is no code path that creates, updates,
comments, or changes state on a Plane work item.

## Manual tests

Run the workflow manually (Execute workflow) for each scenario. Keep the
workflow **inactive** during testing so the schedule does not interfere.

1. **>3 issues across modules.** Give a recipient >3 open issues spread across
   ≥2 modules → expect one Telegram message @-mentioning them, in pt-PT, with
   exactly a Top-3 plan (the AI picks 3), and each picked item tagged with its
   module.
2. **Zero issues.** Give a recipient zero open issues (all closed/cancelled or
   none assigned) → expect **no** OpenAI call and one concise Telegram message
   saying there are no open DEV issues assigned to them.
3. **Completed/cancelled exclusion.** Assign a recipient one `done` and one
   `cancelled` issue (and nothing else open) → expect the zero-issues Telegram
   message, confirming done + cancelled are filtered out.
4. **Non-allowlisted exclusion.** Assign open issues to a Plane user whose
   `planeUserId` is **not** in `PLANE_DAILY_BRIEFING_RECIPIENTS` → expect no
   message for them and none of their issues appearing in anyone else's
   message.
5. **Malformed OpenAI fallback.** Set `PLANE_DAILY_BRIEFING_OPENAI_MODEL` to an
   invalid model id (so the OpenAI call errors at runtime) → expect each
   recipient-with-issues to still receive a Telegram message containing the
   deterministic pt-PT fallback list (local priority/deadline/state order), and the run to
   **not** fail.
6. **Missing config.** Empty one required env var (e.g. clear
   `PLANE_DAILY_BRIEFING_TELEGRAM_CHAT_ID` or break the recipients JSON) and
   run → expect **fail-fast** at `Init & Validate Config`: no Plane fetch, no
   OpenAI call, no Telegram message. Restore the value afterwards.
7. **Schedule / timezone.** Confirm the Schedule trigger is set to
   **Europe/Lisbon** and the cron fires Mon–Fri at 08:30 (and **not** on
   weekends). To test safely: temporarily change the trigger to fire 1–2
   minutes ahead of the current time, activate, confirm it fires, then revert
   to the 08:30 weekday cron and deactivate. Lisbon DST transitions should not
   shift the local fire time (it stays 08:30 Lisbon).

## Notes

- **Inactive by default.** The workflow is imported disabled; do not activate it
  until env vars are set, the Telegram credential is reselected, and the manual
  tests pass.
- **No Plane writes.** The briefing is a read-only consumer of Plane; the
  GitLab↔Plane bridge is the component that writes to Plane.
- **Existing env vars reused.** `WORKSPACE_SLUG` and `PLANE_PROJECT_DEV` are
  shared with the GitLab↔Plane bridge; the five `PLANE_DAILY_BRIEFING_*` /
  `PLANE_API_KEY` / `OPENAI_API_KEY` additions are documented in
  `config/.env.example` and passed through in `config/docker-compose.yml`.
