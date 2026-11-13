# Job Tracker secure Worker replacement

This package defines the secure `jd-proxy` implementation. Repository contents and local tests are **not evidence of live deployment or provider acceptance**; those are recorded separately. Both feature switches default to `false` in configuration and are enabled only during an authorized release.

## Security boundary

- Each feature request requires a Firebase ID token. `jose` verifies RS256 signatures with Google's pinned Secure Token X.509 endpoint, exact project issuer/audience, expiry, issued/authentication times, subject, and verified email. Attacker-supplied key URLs are rejected. The verified subject selects storage; caller-supplied `uid` fields are rejected.
- Every operation except owner disconnect checks current Firestore approval with the caller's ID token. The verified administrator email follows the deployed rules' administrator exception. Firestore failures deny access. Removed users can still disconnect their own grants.
- JWT signature verification does **not** check Firebase Auth account-disable/session-revocation state. A valid token can remain usable until expiry (normally one hour); removing app approval takes effect on the next check for non-administrators. This is not immediate Firebase session-revocation enforcement.
- OAuth uses 256-bit random state, S256 PKCE, an OIDC nonce, five-minute state expiry, and an atomic destructive consume in SQLite Durable Objects. The callback re-verifies the initiating Firebase token and approval. Its Google ID token must match the linked Google provider subject, OAuth client, nonce, verified email, and Gmail profile. Email alone is insufficient account-ownership evidence.
- Only new `grants-v2:` Durable Objects are usable. Legacy `GMAIL_TOKENS` remains in deployment metadata but is **never read, written, migrated, or deleted**. Every old connection must reconnect.
- Callback exchange claims a persisted lease before calling Google. Disconnect cancels the generation and unlinks locally but cannot claim remote revocation while the callback is unresolved. A cancelled callback retains newly returned credentials for revocation before reconnect is allowed. Refresh uses a separate durable lease and generation/version checks; expired access tokens are never reused after refresh failure.
- A late callback after manual recovery cannot reconnect or automatically revoke a newer authorization. It retains the late credential/uncertainty behind an owner-cleanup barrier and disables local access. Callback completion checks the lease deadline; manual recovery leaves cancellation evidence. Expiry is not treated as proof that an external exchange stopped.
- Disconnect retains pending credentials until Google revocation succeeds. Concurrent revocations are single-flight, and reconnect is blocked during cleanup. A crashed or ambiguous callback does not automatically clear its barrier. After a ninety-second grace period, the owner can remove Job Tracker access in Google Account permissions and explicitly confirm manual recovery. This returns **`revoked:false, confirmation:'owner'`**, not a claim of provider-verified revocation.
- Credentials reside only in Durable Object storage, relying on Cloudflare's encryption and access control, **not a separate application encryption key**. Restrict dashboard/DO data access. OAuth state contains the initiating Firebase token for five minutes of validity; cleanup normally removes it within fifteen additional minutes. Active grants expire after ninety days. Pending-revocation credentials and ambiguous callback barriers remain until explicit cleanup/recovery; they are not subject to a misleading universal ninety-day deletion claim.
- Exact browser origin/CORS checks supplement bearer authentication. Responses are `no-store`. Redirects contain only `gmail=connected` or `gmail=error`. The client rechecks authenticated status.
- Structured logs contain only known route, status, sanitized error code, optional allowlisted AI diagnostic reason, and duration. Observability remains enabled at full sampling; automatic invocation logs are disabled because OAuth callback URLs contain credentials. Never log full URLs, headers, request bodies, provider responses, or mail in Tail Workers/external sinks.

## Client contract

All POST requests use JSON and `Authorization: Bearer <Firebase ID token>`. Unknown request keys are rejected. Errors are `{error:{code,message}}` with 4xx/5xx status; the frontend maps codes to local messages.

| Endpoint | Body | Success |
| --- | --- | --- |
| `POST /extract` | Exactly one of `{url}` or `{text}` | `{job:{company,role,location,type,url,postedDate,salary}}`, all strings |
| `POST /gmail/auth` | `{consentToLink:true}` | `{authUrl}` |
| `GET /gmail/callback` | Google query parameters | Fixed app redirect, never a token |
| `POST /gmail/status` | `{}` | `{connected,reconnectRequired,revocationPending,manualRevocationRequired}` |
| `POST /gmail/scan` | `{companies:[{company,currentStage}],consentToAiProcessing:true}` | `{suggestions:[{company,suggestedStage,reason,emailFrom,emailSubject,interviewRounds:[{type,notes}]}]}` |
| `POST /gmail/disconnect` | `{}` | `{success:true,revoked:true}` |
| `POST /gmail/disconnect` | `{confirmManualRevocation:true}` after explicit owner confirmation | `{success:true,revoked:false,confirmation:'owner'}` |

`revocation_failed` means local disconnection succeeded but Google revocation is unconfirmed; retry is available after the thirty-second lease. `revocation_pending` means an unresolved callback or cleanup blocks reconnect. `request_in_progress` is a bounded operation lease. The manual recovery UI is available only when `manualRevocationRequired` becomes true. No legacy KV lookup distinguishes never-connected and old-linked users; both need the new flow.

Before **each** Gmail scan, the client asks for explicit permission to send recent email excerpts and the company list to Anthropic. The mandatory request flag cannot itself prove the UI checkbox was shown. Never auto-scan on sign-in, callback, or load. The Worker returns suggestions for human review and does not write job records.

## Bounds and performance

- Incoming JSON: 32 KiB streamed limit, five-second deadline, no compressed bodies.
- Extraction: explicit supported HTTPS ATS/company hosts in `src/features.mjs`, plus a constrained Workday hostname pattern. No arbitrary-domain fallback, credentials, nondefault ports, or fragments. Revalidate every redirect; maximum three redirects/four requests. Each page has a 256 KiB streamed cap, eight-second deadline and textual content type. Only 12,000 characters enter extraction. Unsupported/client-rendered sites use manual paste.
- Gmail: fixed fourteen-day job-subject query, read-only access, maximum ten messages in two batches of five. Each message has an eight-second deadline and 256 KiB cap. Prefer plain text, otherwise convert bounded HTML to text; retain up to 2,000 body characters plus bounded headers/snippet. Never fetch attachments, embedded images, external resources, or further pages.
- Other Google requests have five- or ten-second deadlines and bounded JSON. Anthropic has a twenty-second deadline, 64 KiB response cap, 64 KiB input-data cap and output caps of 800 extraction / 2,000 scan tokens. No automatic paid retries. Invalid/truncated model output fails visibly.
- Both AI operations use Anthropic's native `output_config.format` JSON-schema grammar, supported by the configured Sonnet 4.6 model, instead of relying only on a prompt requesting JSON. Schemas contain generic field definitions, not user/company/mail content. Every object is closed and all fields are required. Local validation still checks lengths, list sizes, valid dates and actual email evidence indexes. Only known enum labels are canonicalized for Anthropic's documented capitalization variation. Refusals, truncation, markdown fences and other malformed responses remain errors; there is no permissive repair or automatic paid retry. A cold schema can add compilation latency within the existing request deadline.
- `invalid_ai_response` may include a safe `diagnosticReason`, also recorded in the sanitized audit event: for example `json_syntax`, `content_shape`, `stop_refusal`, `stop_max_tokens`, `job_shape`, `job_type` or `job_date`. The value comes from a fixed allowlist, never from provider text. The first live synthetic attempt returned the generic error before these diagnostics existed; its exact cause remains unconfirmed until separate live acceptance testing.
- Extraction links come from the validated source URL, never model output. Gmail sender/subject come from fetched evidence selected by a validated email index. Strict output schemas reduce structural misuse; factual mistakes or prompt-injection effects still require human review.
- Strongly consistent budgets reserve before upstream work. Failed attempts count, and UTC minute/day boundaries can permit boundary bursts. The global coordinator is appropriate for a small private app, not unlimited scale. It does not establish a dollar guarantee; also set provider account spend limits and Cloudflare edge request protection.

| Action | User/min | User/day | Global/min | Global/day |
| --- | ---: | ---: | ---: | ---: |
| Extraction | 6 | 40 | 30 | 50 |
| Gmail scan | 1 | 6 | 5 | 10 |
| OAuth start | 3 | 10 | 20 | 200 |
| Status | 30 | 1,000 | 300 | 10,000 |
| Disconnect | 3 | 20 | 30 | 200 |

Callbacks reserve per-user/global quota only after consuming valid authenticated state; fabricated states cannot exhaust legitimate callback quotas. These are authenticated provider-work budgets, not complete denial-of-service protection. The status path does not fetch Google mail or refresh credentials.

## Local checks

Use Node 22 or newer, from this directory:

```powershell
npm ci --ignore-scripts
npm run check
npm test
$env:WRANGLER_LOG_PATH = Join-Path $PWD '.wrangler\build.log'
$env:WRANGLER_SEND_METRICS = 'false'
npm run build
```

The build uses `wrangler deploy --dry-run`; it bundles and validates configuration without deployment. Tests use generated RSA keys, synthetic grants/mail, mocked providers, and real local Miniflare/workerd SQLite Durable Objects. No test reads real mail/tokens or sends content to a live AI endpoint. Runtime tests require local loopback permission in restricted environments.

Validated on 2026-11-13: **60/60 Node-reported tests pass** (45 JWT/gateway/content cases, 14 real-runtime concurrency cases, and their parent test). Syntax checks and Wrangler dry-run also pass. Focused AI fixtures cover the synthetic Operations Manager posting, both native-schema requests, recognized enum capitalization, strict local limits, refusal/truncation and diagnostic privacy. Runtime cases cover one-use state, concurrent quotas, quota-cleanup races, callback/disconnect/refresh races, ambiguous/late callback recovery, and revocation retry. The quota-cleanup regression was independently checked against a temporary in-memory version of the old bug, where that test fails as expected. See `release-evidence.json` for the exact bundle/source hashes; this evidence does not certify production OAuth/provider configuration.

`dist/index.js` is the bundle. A complete deployment also needs the bindings, migration and variables in `wrangler.jsonc`; pasting source alone cannot provision a Durable Object namespace.

## Deployment and staged release

1. Review the bundle/configuration and obtain deployment authorization. Keep containment in place. Authenticated Wrangler access needs the scoped Worker deployment permission (`workers_scripts:write`, including the Durable Object migration). Retaining the existing KV binding does not require reading/writing KV contents or requesting broad KV data permissions. No credential belongs in this repository.
2. Preserve existing `ANTHROPIC_API_KEY`, `GMAIL_CLIENT_SECRET`, and `GMAIL_TOKENS`. Confirm the Google client's authorized redirect URI exactly equals `OAUTH_REDIRECT_URI`, Gmail API is enabled, and OIDC/Gmail scopes are allowed. Gmail read-only is a restricted Google scope; verification/test-user constraints apply. OAuth testing-mode refresh grants can expire after seven days.
3. Provision the SQLite `SecurityCoordinator` namespace/binding using the checked-in `secure-v2` migration. This legacy migration syntax remains supported; do not mix provisioning modes for the same class. Initially leave `ENABLE_EXTRACTION=false` and `ENABLE_GMAIL=false`.
4. Verify deployed binding/secret presence (never values), denial paths and sanitized logs. Release extraction independently with only `ENABLE_EXTRACTION=true`; it still needs the coordinator for quotas. Deploy the compatible frontend before enabling a feature, including manual-paste fallback and Gmail recovery UI.
5. Before enabling Gmail, revoke the old Job Tracker authorization in Google Account permissions, then reconnect through the new flow. Legacy KV credentials are untrusted and can outlive the old code. Inspection/deletion of historical credentials is a separate explicitly authorized operation; this package does neither. Never roll back to the vulnerable pre-containment Worker.
6. With deployment authorization, temporarily enable Gmail for owner acceptance: correct-account connect, other-account denial, status, refresh, disconnect and reconnect. Disable it again if any check fails. Replay and concurrency checks are covered locally; do not imply they were exercised against production. A real scan is a separate action requiring fresh AI consent. Mock tests cannot establish live OAuth configuration, consent policy, quota, secret correctness, or actual provider behavior.

Rollback means restoring the approved containment module or disabling both feature flags while preserving namespaces/migrations. This package changes neither Firestore rules nor job records.

## Primary references

- [Firebase ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Google server-side OAuth and revocation](https://developers.google.com/identity/protocols/oauth2/web-server), [backend ID-token verification/stable identity](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Gmail profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile), [message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Durable Object transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages), [native structured outputs and schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Sonnet 4.6](https://platform.claude.com/docs/en/models/sonnet-4-6/overview)
