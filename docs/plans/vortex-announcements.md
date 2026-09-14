# Vortex announcement publishing automation

Status: **implemented 2026-09-13** — see [`files/vortex-announcements/README.md`](../../files/vortex-announcements/README.md) for the built system (workflow, publisher sidecar, feed server, compose wiring). The original design record follows, verbatim. Vortex's reader and modal are implemented in the Vortex repository. Abilio's publisher is planned in `~/www/abilio/docs/plans/vortex-broadcast-announcements.md`.

## Outcome and architecture

An authorized Abilio operator publishes one fleet-wide operational notice. n8n validates it and atomically replaces a static JSON file on a public HTTPS web server. Vortex servers fetch that file every 30 seconds; their browsers read the local cache every five seconds and show a small modal once per user/browser.

```text
Abilio -- authenticated POST --> n8n -- upload + atomic replace --> latest.json
Vortex scheduler -- HTTPS GET (optional Basic auth) -------------> latest.json
Vortex browser -- authenticated local Livewire poll ------------> local cache
```

n8n executes for publication/cancellation, never for the periodic reads. The static web server and storage must remain available independently of the n8n process. NetBird connectivity is not required.

Version 1 broadcasts to ALL Vortexes using the same feed. It does not select device recipients, report device delivery, or collect user acknowledgements. The browser stores only the last dismissed ID per Vortex origin and user. Browser storage can be cleared, so it is not an audit record.

## Exact feed contract

UTF-8 JSON, `Content-Type: application/json`, at most 32 KiB total. Use escaped plain text, never executable markup or HTML rendering.

```json
{
  "notification": {
    "id": "5eec7e6a-8705-4fe2-8c40-52e607360999",
    "title": "Manutenção programada",
    "body": "Guarde o seu trabalho antes das 11:30.\nObrigado.",
    "starts_at": "2026-10-01T09:00:00Z",
    "expires_at": "2026-10-01T11:00:00Z"
  }
}
```

- `id`: required nonempty string, max 100 characters, ASCII letters/digits/underscore/hyphen. Generate a UUID in Abilio. Every intentional new announcement or content edit gets a new ID; HTTP retries reuse the original ID.
- `title`: required nonblank string, max 160 characters.
- `body`: required nonblank string, max 4,000 characters. Newlines are preserved. Vortex renders text, not HTML.
- `starts_at`: optional or null for immediately eligible. Otherwise ISO 8601 with seconds and timezone (`YYYY-MM-DDTHH:mm:ssZ` or a numeric offset). Do not send fractional seconds or timezone-less dates.
- `expires_at`: required timestamp in the same format. Strictly after `starts_at` when supplied. Abilio/n8n must also reject an already expired new publication.
- Abilio collects Europe/Lisbon local date/time and converts it to UTC; Vortex uses absolute times. This includes daylight-saving changes.
- No other fields inside `notification`. Publisher metadata belongs in headers/publishing state, not the feed notification.
- Cancellation / initial empty file: `{"notification":null}`. Do not use the string `"none"`, `{}`, an empty notification object, or a 404.

There is exactly ONE slot. A replacement immediately supersedes the previous file. If its start is in the future, there will be no active notice until that time; the previous notice does not reappear. Make this explicit in Abilio. Preserving an older message until a future replacement begins is a separate future enhancement.

## Publishing endpoint

Proposed production webhook: `POST /webhook/vortex-announcements/publish`.

1. Require HTTPS and n8n Header Auth: `X-Vortex-Publish-Token`. Store the credential in n8n and Abilio's server configuration only.
2. Require `Idempotency-Key` (UUID) for every publish or cancellation operation. Persist its payload hash and result so transport retries return the prior result without overwriting a newer message. The notification UUID can also be the publication's idempotency key; cancellation needs its own UUID.
3. Authenticate before performing validation or writes. Bound request size at the reverse proxy and validate all lengths/types/timestamps in the workflow, including the final UTF-8 file size.
4. Generate the JSON file from validated fields using JSON serialization. Never interpolate message text into paths, shell commands, or template HTML.
5. Serialize publication operations against this one feed. Do not assume concurrent webhook executions finish in arrival order. Select and verify a workflow concurrency/locking mechanism available in the installed n8n edition; otherwise implement serialization in the storage publisher. A transient execution flag alone is insufficient.
6. Upload/write a uniquely named temporary file on the SAME filesystem as the final file. Use a configured fixed directory, never an Abilio-provided path.
7. Atomically replace `latest.json`. Verify the chosen SFTP server and rename operation support atomic replacement of an existing file. If they do not, use a small fixed server-side publishing helper; do not delete the live file before uploading its replacement.
8. Set web-server-readable permissions and verify the stored object before reporting publication success.
9. Record the idempotency result. If the server wrote the file but the workflow failed before recording success, recover by inspecting the current file/publication metadata before retrying. Prevent an older uncertain retry from overwriting a newer acknowledged publication. Keep cancellation's operation ID in private publisher state.
10. Respond only after publication completes (Respond to Webhook / last-node response), e.g. HTTP 200 `{"status":"published","notification_id":"..."}` or `{"status":"cleared","notification_id":null}`. This means the FILE was published, not that Vortexes or people received it.

An idempotency key with a different payload returns 409. Validation failures return 422, invalid credentials 401/403, and storage errors a non-2xx result. Limit execution retention and avoid logging credentials or message bodies unnecessarily. Persistent publication state can use an n8n Data Table if available, or an existing database; it is not used by readers.

## Storage and serving choices to resolve with actual access

Preferred: use the existing public web server with a persistent directory and restricted SFTP publishing account. n8n's FTP node supports SFTP uploads and rename operations. A shared mounted directory is another option for self-hosted n8n; container-local ephemeral storage is not suitable.

Determine the actual public hostname, persistent path, SFTP/volume access, atomic replacement support, workflow concurrency controls, and installed n8n version before building. Do not assume filesystem access or Execute Command nodes are available.

Serving requirements:

- HTTPS with a valid trusted certificate; Vortex refuses HTTP, credentials embedded in URLs, and redirects.
- Optional HTTP Basic authentication at the web server. Recommended: individual read-only credentials per NUC. Abilio's publishing credential must never be a reader credential.
- Vortex can intentionally read a public feed when BOTH reader credentials are blank. Do not publish confidential content to such a feed.
- Static reads should reach the web server directly. Do not proxy them through n8n or an authentication workflow.
- Support ETag / `If-None-Match` and 304 responses, with `Cache-Control: private, no-cache` for an authenticated feed. Revalidate every fetch; avoid CDN stale responses and negative caching that conceal updates.
- Verify ETags change on every content replacement, including two same-length publications within one second. Some static-server ETags depend only on file size and modification time. If reliable validators cannot be guaranteed, disable ETags so each GET returns the full small file.
- Correct `Content-Length`, JSON type, and persistent storage across service restarts.

## Expiry and cancellation

No expiry workflow or long-running Wait node is required. Vortex treats a notice as active only when `starts_at <= now < expires_at` (missing start means immediate). It enforces this on every local read, including after 304 responses and remote outages. The modal also closes at expiry using the server's clock as its reference.

Optional later cleanup may replace an expired file with `{"notification":null}`. It must compare the current notification ID under the same publication lock before clearing. Never let a timer for an older message delete a newer one. Physical cleanup is not the mechanism that enforces expiry.

Immediate cancellation is observed at the next successful fetch plus local browser poll. Offline Vortexes may retain a cancelled notice until their next successful fetch or its original expiry. This is inherent in a cached pull design.

## Vortex activation (already implemented consumer)

Set these in each NUC's `/opt/vortex/.env`:

```dotenv
ANNOUNCEMENTS_URL=https://YOUR-PUBLIC-HOST/vortex/latest.json
ANNOUNCEMENTS_USERNAME=YOUR-READ-ONLY-USERNAME
ANNOUNCEMENTS_PASSWORD=YOUR-READ-ONLY-PASSWORD
```

Empty URL disables the feature. Leave BOTH auth fields empty only for an intentionally public feed. Incomplete credentials prevent fetching. Values are read only on the server; they are not included in Livewire/browser payloads.

The production image now includes a supervisor `laravel-scheduler` process running `schedule:work`. It invokes `announcements:fetch` every 30 seconds. Deployment must include that image change; editing env vars on an old image alone does not add the scheduler. Existing NUC env files are preserved by updates: manually merge these values and restart `vortex.service`. The application uses a persistent file cache, shared by the scheduler and Octane workers, with a lock and a 30-second fetch throttle.

Local development: run `./vendor/bin/sail artisan schedule:work` alongside the app. A one-off fetch is `./vendor/bin/sail artisan announcements:fetch`. The command is intentionally quiet; inspect Laravel logs for fetch failures.

Transport uses a 2-second connection timeout and 5-second total timeout, no redirects, conditional ETag requests, and a 32 KiB accepted-body limit. Failures keep the last valid copy, whose expiry still applies. The first display normally arrives within approximately 35 seconds (30-second remote fetch plus 5-second visible-browser poll, excluding request latency). Background tabs may be throttled.

## Verification before publication

1. Unauthorized publishing and reading (when protected) fail without changing the file.
2. Valid publication produces the exact contract; request retries are idempotent.
3. Two concurrent publications leave a complete, deterministic final file. Same-key/different-body requests fail.
4. A response lost after a successful publication does not cause an old retry to replace a newer message.
5. Failed storage upload leaves the previous file usable; Abilio sees failure, not success.
6. Unchanged reads return 304; changed reads return the new JSON, including rapid same-length edits. No n8n execution is created by static reads.
7. Future messages wait; expiry works without an n8n cleanup job; cancellation clears on refresh.
8. Restart n8n and the web server: published content remains available.
9. On a test Vortex, verify title/body, one dismissal per user/browser, a new ID reopening, and no secret in browser requests.
10. Stop the feed temporarily: no app failure or expired modal; restore it and verify recovery.

## Official references

- n8n Webhook and authentication: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
- n8n SFTP upload/rename: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.ftp/
- Nginx Basic authentication: https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html
- Nginx static ETags: https://nginx.org/en/docs/http/ngx_http_core_module.html#etag
