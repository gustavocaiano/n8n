# Vortex Announcements Publisher (n8n)

Lets an authorized Abilio operator publish **one fleet-wide operational
notice**. An n8n webhook workflow authenticates and validates the request,
and a small publisher sidecar atomically replaces a static JSON feed file.
Vortex NUCs fetch that file every 30 seconds over HTTPS; their browsers show
a modal once per user/browser. Publishing and cancellation run in n8n;
periodic reads never touch n8n.

```
Abilio ── POST /webhook/vortex-announcements/publish ──▶ n8n workflow
         (X-Vortex-Publish-Token, Idempotency-Key)         │ auth + validation,
                                                           │ canonical serialization
                                                           ▼
                                             vortex-publisher sidecar
                                             (idempotency, single-writer lock,
                                              tmp + fsync + rename)
                                                           │
                                                           ▼
                                             vortex_feed volume: public/latest.json
                                                           │
Nginx Proxy Manager ── /vortex ──▶ vortex-feed (nginx) ──▶ serves latest.json
Vortex scheduler ── HTTPS GET every 30s (optional Basic auth) ──▶ latest.json
```

## Components

| Piece | File | Purpose |
|---|---|---|
| n8n workflow | `workflow.json` (this dir) | Webhook auth, strict payload validation, canonical feed serialization, response mapping |
| Publisher sidecar | `plane/vortex-announcements/publisher/server.mjs` + `entrypoint.sh` | Owns the feed volume. Idempotency journal, serialized writes, atomic replacement, crash recovery |
| Feed server | `plane/vortex-announcements/nginx/templates/vortex-announcements.conf.template` | nginx vhost serving exactly `/vortex/latest.json` |
| Reader auth map | `plane/vortex-announcements/nginx/entrypoint/25-vortex-readers.sh` | Generates the Basic-auth reader map from `VORTEX_FEED_READERS` |
| Compose wiring | `plane/compose.yml` | `vortex-publisher` + `vortex-feed` services, `vortex_feed` volume, n8n env vars |
| Env vars | `plane/.env.example` | Authoritative variable list |

## Prerequisites

1. The `plane/` compose stack running (n8n + sidecars behind Nginx Proxy Manager).
2. **Two distinct secrets** — generate with `openssl rand -hex 32`:
   - `VORTEX_PUBLISH_TOKEN` — Abilio presents it to the webhook (`X-Vortex-Publish-Token`).
   - `VORTEX_SIDECAR_TOKEN` — n8n presents it to the sidecar (`X-Publisher-Token`). **Must differ** from the publish token.
3. **Reader credentials** (optional HTTP Basic auth, one per NUC):
   `VORTEX_FEED_READERS` is a whitespace-separated list of `user:password` pairs,
   e.g. `VORTEX_FEED_READERS="nuc1:s3cret nuc2:other"`. Leave empty for an
   intentionally public feed (never publish confidential content then).
   Passwords must not contain whitespace. The login prompt realm is
   `VORTEX_FEED_AUTH_REALM` (default `Vortex announcements`).
   Credentials are matched **case-sensitively** (nginx map string entries
   match ignoring case, so the generator emits anchored, case-sensitive
   regex entries per reader); the `Basic` scheme keyword itself is
   case-insensitive, per RFC 7617.

## Setup

### 1. Environment variables

Set in `plane/.env` (see `plane/.env.example`):

```dotenv
VORTEX_PUBLISH_TOKEN=<openssl rand -hex 32>
VORTEX_SIDECAR_TOKEN=<openssl rand -hex 32, different>
VORTEX_FEED_READERS=nuc1:s3cret nuc2:other   # or empty for a public feed
VORTEX_FEED_AUTH_REALM=Vortex announcements
```

> **Host drift warning:** the repo's `plane/compose.yml` is the base version —
> the live host compose file has drifted from it (bridge env lines were added
> directly on the host). When deploying, apply the repo's compose changes to
> the host file too: the two `VORTEX_*` lines in `n8n-plane`'s `environment:`
> block, the `vortex-publisher` and `vortex-feed` services, and the
> `vortex_feed` volume. `plane/.env.example` is the authoritative variable list.

### 2. Start the services

```bash
cd plane/
docker compose up -d
```

This **recreates `n8n-plane`** (brief webhook downtime; n8n data persists in
the `n8n_data` volume) and starts `vortex-publisher` (internal network only —
no published ports) and `vortex-feed` (nginx). The feed URL never 404s: the
publisher seeds `public/latest.json` with `{"notification":null}` on first
boot, and the feed vhost additionally answers a missing file (e.g. a fresh,
not-yet-seeded volume) from memory with the same empty-feed document — auth
still enforced.

### 3. Nginx Proxy Manager

On the `nodemation.nforensic.site` proxy host, add a **custom location**:
`/vortex` → `http://vortex-feed:80`, with **no path suffix** — the public path
`/vortex/latest.json` must reach the container unchanged. NPM forwards the
original `Host` header, which matches no `server_name`; the feed vhost is
deliberately `default_server` on port 80 so it still answers.

### 4. The workflow

The workflow already exists on the instance (`Vortex Announcements Publisher`,
created 2026-09-13, currently **inactive**) — just activate it in the n8n UI.
For a fresh instance, import `workflow.json` and activate. There are **no
n8n credentials to wire**: all auth flows through `$env` expressions, per
repo convention.

> **`$env` dependency:** the workflow reads `VORTEX_PUBLISH_TOKEN` and
> `VORTEX_SIDECAR_TOKEN` via `$env`. n8n's `N8N_BLOCK_ENV_ACCESS_IN_NODE`
> must NOT be set on this instance — it would empty `$env` and every request
> would fail closed with 500 `server_misconfigured`.

Production webhook URL:

```
POST https://nodemation.nforensic.site/webhook/vortex-announcements/publish
```

### 5. Verification (post-deploy)

```bash
# Sidecar health
docker compose exec vortex-publisher wget -qO- http://localhost:8085/healthz

# Feed: unauthenticated (when VORTEX_FEED_READERS is set) → 401 + WWW-Authenticate
curl -i https://nodemation.nforensic.site/vortex/latest.json

# Feed: with reader credentials → 200 {"notification":null}
curl -i -u nuc1:s3cret https://nodemation.nforensic.site/vortex/latest.json

# Feed: wrong-case password → 401 (credentials are case-sensitive)
curl -i -u nuc1:S3CRET https://nodemation.nforensic.site/vortex/latest.json

# Publish (valid)
curl -i -X POST https://nodemation.nforensic.site/webhook/vortex-announcements/publish \
  -H 'Content-Type: application/json' \
  -H "X-Vortex-Publish-Token: $VORTEX_PUBLISH_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"notification":{"id":"test-1","title":"Test","body":"Hello","expires_at":"2026-10-01T11:00:00Z"}}'
# → 200 {"status":"published","notification_id":"test-1"} and the feed now returns it

# Replay the same key + body → same 200 (idempotent, no renumber)
# Same key, different body → 409 idempotency_conflict
# Publish with a bogus token → 401; malformed body → 422 with an errors array

# Cancel
curl -i -X POST https://nodemation.nforensic.site/webhook/vortex-announcements/publish \
  -H 'Content-Type: application/json' \
  -H "X-Vortex-Publish-Token: $VORTEX_PUBLISH_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"notification":null}'
# → 200 {"status":"cleared","notification_id":null}
```

## Publishing API (for Abilio)

`POST /webhook/vortex-announcements/publish` with headers
`X-Vortex-Publish-Token` (the publish token) and `Idempotency-Key` (a UUID —
HTTP retries must reuse the original key), `Content-Type: application/json`.

Body — exactly one top-level key, `notification`:

| Field | Rules |
|---|---|
| `id` | Required. `^[a-zA-Z0-9_-]+$`, max 100 chars. New ID for every new announcement or content edit; retries reuse the original ID. |
| `title` | Required, 1–160 chars, must contain a non-whitespace character. |
| `body` | Required, 1–4000 chars, must contain a non-whitespace character. Plain text; newlines preserved. Vortex renders text, never HTML. |
| `starts_at` | Optional or `null` = immediately eligible. Else `YYYY-MM-DDTHH:mm:ssZ` or with numeric offset. No fractional seconds; must be a real calendar date (e.g. `2099-02-31` is rejected). |
| `expires_at` | Required, same format and strictness. Strictly after `starts_at`, and in the future **for new operations** — replays of a recorded key return their recorded 200 even after expiry. |
| — | No other fields. Publisher metadata belongs in headers, not the feed. |

Cancellation: `{"notification":null}`. Abilio collects Europe/Lisbon local
time and converts to UTC before sending.

Responses:

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"status":"published","notification_id":"…"}` / `{"status":"cleared","notification_id":null}` | The **file** was published — not that devices received it |
| 401 | `{"status":"error","code":"unauthorized"}` | Bad/missing publish token |
| 409 | `…idempotency_conflict` / `…superseded` | Same key with a different payload / stale retry whose outcome was superseded |
| 413 | `…payload_too_large` | Transport cap (64 KiB at the sidecar) — unreachable through n8n, which enforces the 32 KiB feed cap first |
| 422 | `…invalid_idempotency_key` \| `…invalid_json` \| `…invalid_payload` (field details in `errors[]`) \| `…invalid_date_range` \| `…already_expired` \| `…payload_too_large` (> 32 KiB serialized feed) \| `…non_canonical_payload` | Validation failure |
| 503 | `…publish_busy` | Sidecar write lock unavailable, publish queue full, or request waited too long for the publish slot |
| 500 | `…server_misconfigured` \| `…publish_failed` | Missing env vars (fail closed) / unexpected publisher state |

## How it works

```
Vortex Publish Webhook (POST, responseNode)
  → Validate Request   (fail-closed: $env token check → 500 server_misconfigured;
                        constant-time X-Vortex-Publish-Token compare; UUID
                        Idempotency-Key; strict field validation — nonblank
                        title/body, real-calendar timestamps; canonical
                        serialization — exact key order, ≤32 KiB. Expiry is
                        NOT checked here: the sidecar owns that rule, applied
                        to new operations only)
  → Publishable?       (authorized?)
       TRUE:  Call Publisher (POST http://vortex-publisher:8085/publish, raw
              canonical body, neverError + fullResponse, 20s timeout)
              → Map Response → Respond
       FALSE: Respond (mapped error status + JSON body)
```

Design invariants:

- **Fail closed.** Missing `VORTEX_PUBLISH_TOKEN` → every request gets
  500 `server_misconfigured`; nothing is written. The sidecar refuses to start
  writes without `VORTEX_SIDECAR_TOKEN`, and crashes loudly (fail-closed) on a
  corrupt state journal rather than silently resetting.
- **Atomic replacement.** The sidecar writes a temp file on the same
  filesystem, fsyncs, renames over `latest.json`, fsyncs the directory, then
  reads back and verifies the sha256 before acknowledging. Readers never see
  a partial file. Commit point: once the rename lands, the new file is live —
  a failure *after* it (read-back, journal write) returns 500 even though the
  new content may already be served. Retrying with the same Idempotency-Key
  is always safe: the journal resolves the outcome (recorded 200, or the
  crash-recovery path completes it).
- **Single writer, single process.** All publications serialize through a
  mkdir-based lock (crash-safe: locks staler than 60 s are broken). The lock
  is not ownership-safe across processes, which is fine by construction: the
  entrypoint execs exactly one node process and an in-process queue serializes
  requests, so cross-process contention only occurs across a crash-restart
  boundary. The queue is bounded (100) and shares a single 15 s deadline for
  queue wait + lock wait — overflow or over-deadline → 503 `publish_busy`,
  comfortably inside n8n's 20 s HTTP timeout.
- **Idempotency journal.** `state.json` records every operation. Replaying a
  completed key returns the recorded response without renumbering — journal
  resolution runs *before* expiry validation, so a lost response retried
  after the notification expired still replays its recorded 200. A key reused
  with a different payload → 409 `idempotency_conflict`. An older *uncertain*
  retry arriving after a newer publication is marked `superseded` → 409 —
  a stale retry can never overwrite a newer acknowledged message. The journal
  is append-only and **unbounded**: evicting old entries would let a retry of
  a long-gone key resurrect as a new op and clobber a newer publication.
  Entries are ~200 bytes on a dedicated volume.
- **Conditional requests off.** ETags are disabled (nginx's default ETag is
  derived from mtime + size, so two same-length publications within one
  second could alias) and `if_modified_since off` blocks Last-Modified-based
  304s — every GET returns the full body with
  `Cache-Control: private, no-cache`. The `WWW-Authenticate` challenge header
  is emitted only on 401 responses, never on successes or in public mode.
- **Privacy.** Request bodies are never logged; the sidecar logs only status,
  key prefix, and mode. The workflow disables execution-data retention for
  success, error, and manual runs (`saveDataSuccessExecution`/
  `saveDataErrorExecution: none`, `saveManualExecutions: false`), so
  notification content and tokens are not persisted with executions.
  Caveat: node error output during an interactive editor run can still show
  request context on screen (including the HTTP node's error context, which
  n8n does not redact); nothing is stored.
- **Independent availability.** nginx serves the volume directly — the feed
  survives n8n *and* sidecar downtime. Static reads never create n8n
  executions.

## Verification evidence

- Sidecar integration suite: **49/49** — auth, strict validation (whitespace-only
  title/body, impossible calendar dates, malformed UTF-8 → 422
  `non_canonical_payload`, 2000-emoji unicode bodies), atomic replace,
  idempotent replay **after expiry** (recorded 200, no renumber, feed
  untouched), 409 conflict/superseded, crash recovery
  (journaled-but-unfinalized op re-run), stale-lock breaking, journal
  non-eviction (old key replays as recorded 200 after 60 subsequent
  publications), state persistence across restart, no bodies in logs.
- nginx render suite: **26/26** — 401/200/wrong-password in auth mode,
  case-mutated credentials (uppercase/lowercase base64 variants and
  single-char mutations → 401, while a lowercase `basic` scheme → 200), no
  `WWW-Authenticate` on 200, If-Modified-Since ignored → 200 full body,
  unmatched-Host (NPM case) → 200, fresh-volume 404 fallback (auth still
  enforced) and restore, public mode (no challenge header), `server_tokens
  off`, generated reader map contains anchored regex (not plain string)
  entries.
- Workflow jsCode unit harness: **42/42** against the exact shipped code
  (extracted and eval'ed identically to how the SDK compiles it) — including
  expired-notification pass-through and 11 strict-date/blank-field cases.
- Live pinned test on the instance (post-update): webhook → validation →
  fail-closed 500 `server_misconfigured` verified end-to-end, and the manual
  execution was correctly **not** persisted afterwards (retention disabled).
- `docker compose -f plane/compose.yml config --quiet` passes; `node --check`
  on the sidecar passes.

## Known limitations (V1)

- **One slot, fleet-wide.** A replacement immediately supersedes the previous
  notice; there is no per-device targeting, delivery reporting, or read
  acknowledgement. If the new notice starts in the future, the feed is empty
  until then — the previous notice does not reappear.
- Offline Vortexes retain a cancelled notice until their next successful
  fetch or its original expiry (inherent to a cached pull design).
- Browser dismissal storage is per Vortex origin + user, is clearable, and is
  not an audit record.
- Expiry is enforced by each Vortex on every local read (`starts_at <= now <
  expires_at`); no n8n cleanup job exists or is needed.

See the full design record in
[`docs/plans/vortex-announcements.md`](../../docs/plans/vortex-announcements.md).
Vortex-side configuration (`ANNOUNCEMENTS_URL` / `_USERNAME` / `_PASSWORD` in
each NUC's `/opt/vortex/.env`) is documented there.
