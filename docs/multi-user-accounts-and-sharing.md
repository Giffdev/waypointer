# Multi-user accounts and sharing

**Status:** Proposed product and architecture specification; pending product, security/privacy, and operational sign-off  
**Planning constraint:** This document authorizes no application-code, infrastructure, database, authentication-provider, or hosting changes. Implementation begins only after Devin Sinha explicitly approves a phase.  
**Document owner:** Scotty, Backend Engineer  
**Integrated reconciliation revision:** Uhura, Quality Engineer  
**Product owner:** Devin Sinha  
**Last updated:** 2026-08-11

## Decision legend and sign-off gates

- **Settled** means an existing product directive or accepted architecture constraint.
- **Proposed** means the recommended implementation baseline, not yet approved for build.
- **Open** means a decision with alternatives that must be resolved at the named gate.

| Review | Required before | Status |
| --- | --- | --- |
| Product scope and privacy behavior | Any implementation | Pending Devin Sinha |
| Threat model and privacy review | Identity/schema implementation | Pending; reviewer unassigned |
| UX review of registration, share-link preview/control, deletion, and recovery | Shared-link preview | Pending; reviewer unassigned |
| Operational review of email, storage, queue, backups, erasure, and rollback | Production data migration | Pending; reviewer unassigned |

## Executive summary

Waypointer currently reads ignored, machine-local ForeFlight and myFlightradar24 artifacts into one implicit local workspace. Authentication, browser uploads, remote persistence, and sharing are intentionally non-functional. The next major feature will turn that prototype into a secure multi-user product: each person creates an account with a unique username, owns an isolated set of flights and imports, and may deliberately enable one privacy-reduced map URL that can be disabled or rotated.

The core safety rule is that an immutable internal user ID—not a username, email address, route parameter, share token, or client-supplied owner field—is the authorization boundary. Every request, job, storage key, query, export, and deletion operation must derive its actor and scope on the server. Accounts and maps remain private by default. Sharing is a separately revocable capability over a sanitized projection; it never grants access to raw imports, provenance payloads, corrections, notes, registrations, exact timestamps, or other private fields unless a later, explicit requirement is approved.

## Current system and settled constraints

**Settled current stack**

- Next.js 16 App Router, TypeScript, React 19, Tailwind CSS, and project CSS tokens.
- MapLibre GL JS 6 for globe and regional cartography.
- Vitest for current domain tests; Playwright is planned for authenticated journeys.
- PostgreSQL + PostGIS, Drizzle ORM, Auth.js, S3-compatible object storage, and a background worker are planned but not deployed.
- The server currently reads `data\private\local-flights.json` (ForeFlight artifact schema v4) and `data\private\fr24-flights.json` (myFlightradar24 artifact schema v3). Both use the synthetic reconciliation owner `local-preview`.

**Settled directives**

- No implementation occurs as part of this planning task.
- Accounts, flights, imports, and sharing are private by default.
- No third-party flight-service credentials are requested or retained.
- Private flight rows must not leak through maps, aggregates, metadata, logs, caches, errors, or timing-sensitive lookup behavior.
- Eventual GitHub hosting must be created under **`giffdev` only**, never `devsin_microsoft`, and only after explicit confirmation. No remote, Vercel project, or production database is created now.

## Goals

1. Support secure registration, verification, sign-in, recovery, and account deletion for multiple people.
2. Give every account an immutable identity and a unique, user-facing username.
3. Isolate each user's flights, imports, corrections, aggregates, exports, and worker jobs.
4. Support password credentials first and planned Google authentication/account linking without unsafe automatic identity merging.
5. Let users explicitly enable one sanitized share link, keep it stable while enabled, rotate it when needed, and disable it with immediate revocation.
6. Support username renames, export, and deletion without leaving dangling access.
7. Migrate eligible local artifacts into exactly one explicitly selected account without cross-user assumptions or loss of provenance.
8. Make authorization failures, import execution, sharing access, and erasure observable without logging private flight data.

## Non-goals

- Implementing any part of this specification now.
- Any social graph, friend/follow request, follower/following list, contact upload, audience list, feed, comment, like, messaging, group, invitation, or friend-only sharing feature.
- Public profiles, public username map URLs, directory/search discovery, or search-engine indexing in the initial share-link release.
- Letting another user view data through account membership or edit another user's flights.
- Sharing raw uploads, rejected rows, source payloads, correction history, notes, tail/registration numbers, seat data, or third-party credentials.
- Automatic identity linking solely because two providers assert the same email address.
- Cross-user flight deduplication, shared canonical flight ownership, or household accounts.
- Live aircraft tracking or credential-based scraping/synchronization.
- Native mobile applications, enterprise SSO, administrator impersonation, or organization tenancy in the first multi-user release.
- Treating usernames as permanent database keys or authorization claims.

## Personas

| Persona | Need | Primary risk |
| --- | --- | --- |
| Account owner | Import, reconcile, correct, and optionally share a combined flight history | Cross-account access or sensitive itinerary details being exposed |
| Link viewer | View a map intentionally shared through its URL | Seeing more detail than the owner intended or retaining access after disable/rotation |
| Operator | Diagnose failures and abuse without reading flight rows | Sensitive data entering logs, dashboards, support tools, or backups |

## User stories

- As a new user, I can register with a unique username, verified email, and password.
- As a returning user, I can sign in without revealing whether a submitted username or email exists.
- As a Google user, I can deliberately create or link a Google sign-in after proving control of the existing account.
- As an account owner, I can rename my username under predictable rules without changing ownership IDs.
- As an account owner, I can import flights and know that no other account can query, modify, export, or deduplicate against them.
- As an account owner, I can preview exactly what a shared map will expose before enabling sharing.
- As an account owner, I can explicitly enable or disable one unlisted share URL.
- As an account owner, I can keep the URL stable while sharing is enabled or rotate it to invalidate the previous URL.
- As an account owner, I can exclude individual flights from every shared view.
- As a viewer, I can use a valid enabled link without gaining access to private API fields.
- As an account owner, I can export my data and permanently delete my account.
- As an existing local user, I can migrate supported local artifacts into one selected account through a dry-run and review flow.

## Functional requirements

### Account lifecycle

**Proposed**

1. **Register:** collect username, email, password, terms/privacy acknowledgement, and abuse signals. Do not create an active authenticated session until verification requirements are satisfied.
2. **Verify:** send a single-use, short-lived email token stored only as a digest. Reissuing invalidates older tokens. Responses remain enumeration-resistant.
3. **Activate:** create the default private profile and sharing policy transactionally with account activation.
4. **Sign in:** accept verified email or username plus password. Return one generic failure for unknown identity, wrong password, disabled account, or unverified account; offer recovery through a separate generic flow.
5. **Recover:** issue a single-use password-reset token, revoke existing sessions after reset, and notify the verified address.
6. **Link identity:** while recently authenticated, let the user link Google or another credential. If a provider email matches an existing account, require proof of both identities rather than silently merging.
7. **Change sensitive data:** require recent authentication for password, primary email, provider unlinking, export, and deletion.
8. **Suspend:** an operator may disable sign-in and sharing for abuse/security response without deleting evidence required by policy. Suspension actions require audited reason codes.
9. **Delete:** immediately disable normal sign-in, revoke every session and share link, cancel processing jobs, and mark the account `deletion_pending`; then enter the proposed cancellation grace period before asynchronous purge. Grace-period cancellation uses a generic, out-of-band recovery flow that sends a single-use link only to the verified email address. It does not create a limited or partially authenticated session. Successful cancellation keeps sharing disabled, keeps old sessions revoked, and requires fresh credential recovery/sign-in.

An account must always retain at least one usable authentication method. Unlinking the last provider is rejected until a password or another verified provider is added.

### Identity model

**Proposed**

- `users.id` is an opaque immutable UUID generated server-side.
- `users.primary_email_normalized` is unique for active accounts and is never placed in public URLs.
- `user_profiles.username_normalized` is a case-insensitive unique user-facing handle. The original presentation case is not preserved in the initial ASCII-only design.
- Authentication identities live in `auth_accounts`; a user may have password credentials and multiple explicitly linked OAuth identities.
- Provider subject ID plus provider name is unique. Provider email is an attribute, not an ownership key.
- All user-owned rows reference `users.id`. No foreign key points to username.
- The initial share URL does not expose the username. Private APIs may return a stable, non-secret user ID but must not accept it as authority. A future public username URL requires a separate product/privacy decision.

### Username rules and renames

**Proposed initial rules**

- Canonical form is lowercase ASCII.
- Length is 3–30 characters.
- Allowed characters are `a-z`, `0-9`, single hyphens, and single underscores.
- A username begins and ends with an alphanumeric character and cannot contain consecutive separators.
- Reject reserved application routes, confusing system/support terms, brand impersonation, profanity required by moderation policy, and visually dangerous names.
- Uniqueness is enforced by a database constraint on normalized username, not by a prior availability check.
- Registration and rename return a conflict-safe validation response; login and recovery remain enumeration-resistant.
- A user may rename at most once every 30 days.
- The prior username is reserved from reuse for at least 90 days and stored in `username_history`.
- Old usernames are not valid login aliases.
- A rename never changes `user_id`, share tokens, imports, or flight ownership.
- Because the initial share URL is token-based, username renames do not change it. Redirect behavior is relevant only if a separately approved public username URL is introduced later.

**Open:** final rename cooldown, reservation duration, and moderation list require product/privacy approval.

### Credential and authentication strategy

**Settled direction:** Auth.js is the planned authentication framework; credentials use Argon2id; Google authentication is planned; there is no home-grown session protocol.

**Proposed controls**

- Passwords allow password-manager paste, Unicode, and long passphrases; minimum 12 characters and maximum 128 characters after safe input handling.
- Screen new passwords against a breached-password service using a privacy-preserving lookup. Do not impose composition rules or periodic rotation.
- Store only Argon2id hashes with parameters calibrated and versioned for the production runtime. Rehash after successful login when parameters change.
- Apply progressive throttling by account signal and network signal. Avoid permanent lockouts that attackers can trigger.
- Verify OAuth `state`, PKCE where supported, issuer, audience, nonce, callback host, and provider subject.
- Never auto-link Google by email alone. Linking requires a recent authenticated session or proof of the existing password/provider.
- OAuth access/refresh tokens, if any are needed beyond sign-in, are encrypted at rest and never sent to the browser or logs. Google sign-in alone should request only minimum identity scopes.
- Multi-factor authentication and passkeys are future enhancements, not launch requirements, but the schema must not preclude multiple authenticators.

### Session management

**Proposed**

- Use Auth.js database-backed sessions so account suspension, password reset, provider unlinking, and deletion can revoke sessions centrally.
- Session tokens are high-entropy, stored server-side in non-reversible form where adapter support permits, and sent only in `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` host cookies in production.
- Rotate session identifiers after sign-in, sensitive reauthentication, privilege-relevant account changes, and at a bounded interval.
- Proposed inactivity timeout: 14 days. Proposed absolute lifetime: 30 days. “Remember me” is deferred.
- Record session creation, last use, coarse device label, and revocation time; do not store detailed browsing history.
- Account settings list active sessions and support “sign out this session” and “sign out all other sessions.”
- State-changing cookie-authenticated requests require same-origin enforcement and framework-supported CSRF protection.
- Caches containing authenticated data are private/no-store unless a reviewed user-scoped cache key is proven safe.

### Per-user ownership and authorization

**Settled**

- Every user-owned table carries `user_id`.
- Repository/service methods require an authenticated actor scope.
- PostgreSQL row-level security is defense in depth.

**Proposed invariants**

1. The server derives the actor from the validated session; request bodies cannot select `user_id`.
2. Resource lookup uses `(resource_id, user_id)` together for owner-only operations. “Fetch, then check” is not the default pattern.
3. Shared access uses a separate read model and access predicate; it never reuses owner serialization.
4. Database RLS policies deny by default. Application roles cannot bypass RLS during normal web requests.
5. Workers use narrowly scoped service credentials, reload the batch by ID, verify its persisted owner, and constrain every write by that owner.
6. Object keys are namespaced as `users/{user_id}/imports/{batch_id}/...`; signed URLs are short-lived and operation-specific.
7. Cache, queue, search, metric, and idempotency keys include user scope.
8. Authorization failures return generic not-found/forbidden behavior without confirming another user's resource exists.
9. Shared reference tables such as airports are global and read-only to users. User-specific aliases/corrections remain user-owned.
10. Support tooling has no default raw-data browse path. Any exceptional access requires explicit policy, least privilege, audit, and user-facing terms.

## Storage and database model

**Proposed logical model**

| Table/group | Key fields and constraints |
| --- | --- |
| `users` | immutable ID, normalized primary email, status, verification/deletion timestamps |
| `auth_accounts` | user ID, provider, provider subject, encrypted token material only when required; unique provider+subject |
| `password_credentials` | user ID, versioned Argon2id hash, changed timestamp |
| `sessions` | user ID, token digest/reference, expiry, last use, revoked timestamp |
| `verification_tokens` | purpose, identity reference, digest, expiry, consumed timestamp |
| `user_profiles` | user ID, unique normalized username, display name, discoverability settings |
| `username_history` | user ID, old username, reserved-through timestamp |
| `sharing_policies` | user ID, enabled flag, field/precision options, version, confirmed timestamp |
| `share_links` | owner user ID, token digest, generation, created/rotated/disabled timestamps, last-used metadata; at most one active link per user |
| `share_projection_entries` | share generation, owner user ID, flight ID, approved redacted snapshot/version, approval timestamp; explicit membership only |
| `flights` | owner user ID, private canonical fields and optimistic version; source-row visibility never grants shared access |
| `import_batches` / `import_rows` | owner user ID, object key, hashes, adapter versions, states, counts |
| `flight_sources` / `flight_overrides` / `duplicate_candidates` | owner user ID in addition to parent IDs for explicit scoping and RLS |
| `export_jobs` / `deletion_jobs` | owner user ID, state, expiry, attempts, error category |
| `audit_events` | actor/subject IDs where allowed, action, result, request/job correlation ID; no raw flight payload |

Foreign keys and unique indexes include ownership where practical so a child row cannot accidentally attach to a parent owned by another user. Schema migrations use expand/backfill/validate/contract sequencing and are reversible until destructive cleanup is explicitly approved.

Original imports are private objects with content-type/size enforcement, malware scanning where retained, encryption at rest, and lifecycle deletion. Raw rows remain in restricted persistence only as long as needed for review, provenance, and documented retention; they are never copied into analytics telemetry.

## Sharing model

### Private default and explicit control

**Proposed**

- Every account starts with sharing disabled. The owner workspace remains `/map`.
- Account settings expose one clear **Enable share link** / **Disable share link** control and a separate **Rotate link** action.
- Enabling sharing requires a server-generated preview and explicit confirmation of included flight count/date span, airports/regions, private-aviation inclusion, excluded flights, and field redactions.
- Disabling sharing immediately invalidates the active URL. Re-enabling later creates a new token; it never silently restores a disabled URL.
- Account suspension or deletion disables the link immediately.
- Visibility is not a flight-kind label. “Private aviation” and “private visibility” must never be conflated.

### Stable versus regeneratable token

**Proposed decision**

- Each user has at most one active share link.
- The token stays stable while sharing remains enabled so a deliberately shared bookmark keeps working.
- The owner may rotate the link at any time. Rotation atomically creates a new token generation and revokes the previous generation.
- Disabling the link revokes the token. Re-enabling generates a different token.
- Tokens contain at least 128 bits of cryptographic entropy. Store only a digest; display/copy the plaintext token only in the authenticated creation or rotation response. Later settings views show status and a non-secret fingerprint, not the unrecoverable token.
- The link grants only `view-shared-map` for one owner. Query parameters may filter already-authorized data but cannot widen its capability.
- Revocation/rotation is authoritative in the database and invalidates shared caches. Old tokens return ordinary unavailable/not-found behavior with no owner metadata.
- Link expiry is deferred; the simple initial model uses owner-controlled disable/rotation rather than multiple links, labels, recipients, or invitations.

### Shared-data projection and safe redaction

**Proposed default shared projection**

- The authenticated owner view continues to show the owner's exact canonical airports and full owner-authorized detail. The tokenized shared view is a separate server-side projection and never reuses the owner serializer.
- The launch-default shared projection uses region/country labels or coarse coordinates, coarse route geometry, and privacy-safe aggregates derived only from explicitly approved flights. Exact airports are off by default and require a separate per-share setting, warning, preview, and confirmation; the simple URL remains `/s/{opaque-token}` because the policy is stored server-side.
- Enabling or updating a share creates explicit projection membership. Flights do not inherit sharing eligibility from account state, source markings, import batches, or a broad visibility flag.
- Newly imported or newly added flights are excluded from an enabled share until the owner previews and explicitly adds them.
- If an included flight is edited in a field that affects shared output or a derived aggregate—including origin, destination, or displayed date precision—it is removed from the active projection and marked pending review. It re-enters only after a new preview and explicit confirmation. Edits solely to fields that the shared allowlist can never serialize do not change projection membership.
- An excluded or pending-review row is removed before route geometry, airport sets, counts, filters, date ranges, busiest-route calculations, and completeness metadata are computed.
- No raw import row, object key, provenance ID, source row number, correction history, notes, seat, registration/tail number, account email, provider identity, exact departure time, or session metadata.
- Per-flight lists and exact dates are off by default. If later enabled, the default date precision is month/year rather than exact date.
- Shared responses expose neither hidden-row counts nor “data incomplete because N flights are private” metadata.
- Server-side access filtering occurs before aggregation and serialization.
- Shared pages use `noindex`, restrictive caching, and a referrer policy that prevents the capability token from reaching third-party analytics, map-provider URLs, error reports, or referrer headers.

### Optional public username URL

**Explicitly separate and deferred**

- `/u/{username}/map` is not part of the initial share-link feature.
- A username URL would be discoverable identity rather than a secret capability and would require a separate enable control, sharing preview, indexing decision, rename/redirect policy, abuse review, and product/privacy sign-off.
- Enabling a token URL must never implicitly create or expose a public username profile.
- No social graph, audience list, friend-only access, invitations, followers, contacts, or feed is implied by either URL model.

## URL and navigation design

**Proposed**

- Owner workspace: `/map`, `/flights`, `/import`, `/settings/account`, `/settings/sharing`, `/settings/sessions`.
- Enabled share map: `/s/{opaque-token}`.
- Deferred optional public map, only after separate approval: `/u/{normalized-username}/map`.
- Authentication: `/login`, `/register`, `/verify`, `/recover`, and provider callback routes owned by Auth.js.
- Existing map filter query parameters may be supported on shared maps only after allowlisting and normalization. They select a subset of already-authorized data and never widen access.
- User IDs, email addresses, import IDs, flight IDs, object keys, and provider subjects do not appear in public map URLs.
- Share-link pages are `noindex` and are never canonicalized into a username page. If public username maps are later approved, their canonical and rename behavior is specified separately.

## Imports, ownership, deduplication, and correction semantics

### Background import ownership

**Proposed**

1. The authenticated server creates `import_batch` with its derived `user_id`.
2. The upload URL permits one bounded object write beneath that user's batch prefix.
3. Queue payloads carry an opaque batch ID and correlation ID. They do not carry trusted owner claims or raw file contents.
4. The worker loads the batch, derives persisted ownership, checks state/idempotency, reads only the recorded object, and writes rows constrained by `user_id`.
5. Progress/status APIs query `(batch_id, actor_user_id)`.
6. Retry, cancellation, and dead-letter handling remain scoped to the batch owner. A retry cannot transfer ownership.
7. Worker telemetry contains adapter/version, counts, durations, and error categories—not filenames, airport pairs, notes, registrations, or row payloads.

### Per-user deduplication

**Settled direction:** deterministic matching is scoped within one user and ambiguous matches require review.

**Proposed details**

- Every fingerprint, source stable ID, file hash, duplicate-candidate query, and idempotency key is namespaced by `user_id`.
- Identical flights imported by two people create independent canonical records.
- Reimporting the same source for one user is an idempotent no-op or attaches new provenance according to the approved reconciliation rule.
- Pilot and passenger records for the same movement remain role-distinct unless the user explicitly merges them under an approved rule.
- Exact matches may be auto-suppressed only when the rule/version is deterministic and reversible. Fuzzy matches are suggestions.
- Rule version and explanation are persisted so later algorithm changes do not silently rewrite history.

### Corrections

**Proposed**

- A correction updates only that user's canonical flight in a transaction and appends an immutable override record containing field, prior value, corrected value, actor, reason category, and time.
- Source rows and provenance remain immutable.
- Future imports may suggest a saved user-specific alias/correction but never overwrite a manual correction without review.
- Global airport-reference corrections follow a separately reviewed reference-data process; ordinary users cannot mutate shared airport rows.
- Shared maps render the current canonical value but never expose the override trail.
- Optimistic concurrency/version checks prevent one browser session from silently overwriting another edit.

## Migration from current local artifacts

**Proposed migration order**

1. Prefer reimporting the original user-held ForeFlight or official myFlightradar24 export through the production adapter, because the local map-safe artifacts intentionally omit raw fields.
2. If original exports are unavailable, offer an explicit artifact migration tool for supported schemas only: ForeFlight v4 and myFlightradar24 v3 at the time of this document.
3. Require the operator/user to authenticate and select exactly one destination account. Never assign local artifacts to the first account, a username guess, or a machine identity.
4. Run a dry-run that validates schema versions, hashes, row counts, airport references, duplicate candidates, omitted-field limitations, and destination ownership.
5. Show the migration summary and require explicit confirmation before committing.
6. Create a migration batch and provenance records that identify the artifact version and original source hash without uploading unnecessary local private fields.
7. Reconcile within the selected account only. Existing account flights participate; other users never do.
8. Verify committed counts and exportability before offering to archive or delete local artifacts. Local files are never deleted automatically.

The multi-user runtime must stop treating repository-global `data\private\*.json` paths or `local-preview` as an active production identity. Development fixtures may remain synthetic and must be visibly separated from real accounts.

## API boundaries

**Proposed principles**

- Server Components, route handlers, and server actions call service methods with an explicit actor/access context.
- No browser connects directly to PostgreSQL, object storage, or the queue.
- Owner DTOs, shared-map DTOs, and operational DTOs are separate types and serializers.
- Mutations validate content type, size, schema, origin/CSRF, authorization, and optimistic version. Import/share mutations also accept idempotency keys.
- APIs return stable error categories and correlation IDs, not stack traces or ownership-sensitive detail.
- CORS is same-origin only initially.

**Proposed capability groups**

| Boundary | Capabilities |
| --- | --- |
| `/api/account/*` | profile, username rename, email/password/provider changes, sessions, export, deletion |
| `/api/imports/*` | create upload, finalize, status, review, commit, cancel; owner-only |
| `/api/flights/*` | list/read/create/correct/delete; owner-only |
| `/api/sharing/*` | preview, enable, status, disable, rotate |
| `/api/shared/links/{token}/map` | enabled capability-link projection only |

Username availability, login, and recovery need distinct enumeration policies; they must not share a permissive generic user-search endpoint.

## Export and deletion

### Export

**Proposed**

- Require recent authentication and create an asynchronous owner-scoped export job.
- Export canonical flights, source/provenance metadata safe for the owner, corrections, import summaries, profile, sharing settings/history, and machine-readable schema/version documentation.
- Exclude password hashes, session tokens, OAuth secrets, share-token plaintext, internal abuse signals, and other users' private profile fields.
- Write an encrypted-at-rest private object with a short-lived, one-use or tightly bounded download URL; delete it automatically after the stated expiry.
- Audit request, completion, download, expiry, and failure without logging exported content.

### Deletion

**Proposed**

- Require recent authentication plus an out-of-band confirmation.
- Immediately disable normal login, revoke sessions and every sharing surface, cancel uploads/jobs, hide the account, and persist a deletion tombstone.
- Allow a proposed 7-day cancellation grace period without any limited-sign-in mode. A generic recovery endpoint may send a single-use cancellation link to the already verified email address without revealing whether an account exists.
- Successful cancellation restores the account to a private, sharing-disabled state; old sessions and share URLs remain revoked, and the owner completes credential recovery or fresh sign-in before access.
- After grace, purge user-owned relational rows and objects asynchronously in dependency order; retain only non-identifying operational evidence required by law/security policy. Active-store purge completes no later than 30 days from the original deletion request, including the grace period.
- Backups age out under the documented provider retention window. A disaster-recovery restore must replay deletion tombstones before serving traffic.
- Username reuse follows the reservation policy and must not expose the deleted user's prior identity.
- Publish deletion status to the user without claiming erasure before all active stores and scheduled object deletions confirm completion.

**Open:** the proposed 7-day duration, backup retention maximum, and legal/audit retention require product/privacy/operations approval. The no-login grace lifecycle and out-of-band cancellation mechanism are the coherent baseline.

## Abuse prevention and rate limiting

**Proposed**

- Apply layered limits by IP/network, account, normalized target, share token, device cookie where lawful, and endpoint class.
- Protect registration, verification resend, login, recovery, username availability, shared maps, upload creation, parsing, export, and deletion.
- Use generic responses and comparable processing for account lookup flows.
- Introduce proof-of-work/CAPTCHA only after risk thresholds rather than for every user; the vendor requires privacy review.
- Enforce upload byte, row, decompression, parser-time, concurrent-job, retry, and account storage quotas.
- Bound shared-map request cost, filter cardinality, and cache variation. A valid share token does not waive resource limits.
- Add abuse controls for token guessing/scraping and username cycling.
- Maintain emergency kill switches for new registration, credentials login, Google login, imports, and share-link access.
- Document appeal/support handling before automated suspension is enabled.

## Observability and audit

**Proposed**

- Generate a request correlation ID at the edge and preserve it through services, queue jobs, and storage operations.
- Measure registration funnel, verification delivery, login success/failure category, session revocation, provider linking, import states/durations, duplicate-review outcomes, share-link enable/disable/rotation, link access/revocation, authorization denials, export/deletion state, queue depth, and erasure lag.
- Alert on cross-owner query anomalies, RLS denials from expected code paths, spikes in token failures, import-object scope failures, deletion SLA breaches, and shared-endpoint abuse.
- Audit sensitive actions with actor, subject/resource class, action, result, coarse network/device security data where allowed, and correlation ID.
- Never log passwords, tokens, cookies, email content, raw filenames, file hashes exposed to clients, flight rows, airport pairs, dates/times, notes, registrations, or share-link plaintext.
- Validate redaction with automated tests and periodic sampled schema review. Production support dashboards use aggregates, not raw event payloads.

## Security and privacy requirements

- Complete a threat model covering account takeover, OAuth confusion/linking, CSRF, session fixation, IDOR, RLS bypass, worker confused-deputy behavior, share-token leakage, username enumeration/impersonation, malicious uploads, cache poisoning, and deletion gaps.
- Use TLS, encryption at rest, secret rotation, least-privilege service identities, dependency scanning, migration review, and environment separation.
- Set a Content Security Policy and prevent share tokens from reaching third-party scripts. Public analytics must be token-blind.
- Shared-map rendering must tolerate unavailable external tiles without returning private flight data to a provider.
- Backups, previews, logs, test fixtures, and support exports receive the same ownership/privacy review as primary tables.
- Privacy notices must explain link possession, forwarding risk, disable/rotation, redaction, retention, export, and deletion before launch.

## Testing strategy

### Unit and property tests

- Username normalization, reserved names, and rename cooldown/reservation.
- Password/session/token expiry and single-use behavior.
- Visibility predicates and redaction serializers for every field.
- Explicit share-projection membership, new-flight exclusion, edit invalidation, and reapproval.
- Owner exact-airport rendering versus shared coarse-location default and exact-airport opt-in.
- Token generation/digest verification and revocation.
- Per-user fingerprint/idempotency construction.
- Share-link enable/disable/rotation state transitions.
- Export inclusion/exclusion and deletion dependency ordering.

### Database and service integration tests

- Unique identity/provider/username constraints under races.
- RLS denies cross-user reads and writes for every user-owned table.
- Child records cannot attach to another owner's parent.
- Owner, enabled-link, disabled-link, rotated-link, suspended, and deleted access matrices.
- Worker retries remain idempotent and owner-scoped.
- Revocation invalidates caches and outstanding signed URLs as designed.
- Concurrent correction conflict behavior.
- Expand/backfill/rollback migrations against representative data volumes.

### End-to-end tests

Use at least Alice, Bob, and Mallory:

1. Alice and Bob register independently and import overlapping flights without cross-user deduplication.
2. Bob cannot access Alice's flight, batch, export, or object by guessing IDs.
3. Alice previews and enables her share link; only the approved shared projection appears.
4. A newly imported flight remains absent, and editing an included origin/destination removes that flight and its derived data until Alice explicitly reapproves it.
5. Alice's owner view shows exact airports; the shared URL starts coarse, and exact airports appear only after the separate setting, warning, preview, and confirmation.
6. The URL remains stable while enabled, rotation invalidates the old URL, and disable removes access immediately.
7. Mallory with a disabled or rotated token receives no map or owner metadata.
8. Password reset and provider unlink revoke the intended sessions.
9. Username rename preserves ownership and leaves the token link unchanged.
10. Export is downloadable only by Alice and expires.
11. Deletion immediately disables login and sharing; cancellation during grace uses only the out-of-band link, restores private state, and does not revive old sessions or URLs.
12. A supported local artifact dry-run and commit targets only Alice.

### Security, reliability, and performance tests

- Automated IDOR corpus that substitutes another user's IDs at every boundary.
- CSRF, OAuth state/nonce, session fixation, open redirect, cache-key isolation, and token-referrer tests.
- Malicious/oversized/decompression-bomb CSV cases and worker timeout/retry cases.
- Rate-limit and enumeration-response tests.
- Shared-map load tests and import concurrency tests with privacy-safe synthetic data.
- Restore drill proving backups do not resurrect revoked sharing or deleted accounts into active service.

No test fixture may contain Devin Sinha's or any other person's private flight rows.

## Phased milestones

### Phase 0 — specification and safety gates

- Approve this scope, resolve phase-1 open decisions, complete threat model/privacy review, define service providers and retention, and write migration/rollback runbooks.
- **No implementation or hosting occurs in this phase.**

### Phase 1 — private multi-user foundation

- PostgreSQL/PostGIS and Drizzle schema, Auth.js credentials flow, verified email, database sessions, private profiles, RLS, owner-scoped flights/imports, worker ownership, and audit baseline.
- Sharing remains hard-disabled and all existing prototype screens remain explicit about unavailable remote behavior until backed by services.

### Phase 2 — lifecycle and portability

- Recovery, active-session management, Google sign-in/linking, export, deletion, quotas, operational dashboards, and local-artifact migration.
- Production launch remains private-only.

### Phase 3 — share link

- One stable-while-enabled capability link, preview/confirmation, privacy controls, disable/rotation, cache isolation, safe redaction, and abuse controls.
- No public username profile, audience management, invitations, or social features.

### Phase 4 — hardening and scale

- Passkeys/MFA evaluation, load tuning, retention verification, restore drills, and only then broader source integrations.
- Evaluate an optional public username map as a separate product proposal; it is not implied by or required for the share-link feature.

## Rollout and rollback

**Proposed rollout**

- Use backward-compatible database changes and per-capability feature flags.
- Seed only synthetic test users, then internal accounts, then a small controlled test cohort.
- Keep registration, Google auth, imports, and share links independently gated.
- Migrate local artifacts only through explicit per-account jobs after private isolation tests pass.
- Require privacy/security sign-off and a clean cross-user authorization test report before expanding each cohort.

**Rollback rules**

- Disable the affected capability first; preserve owner access where safe.
- Roll back application code only while the database remains backward-compatible. Destructive schema contraction waits until the rollback window closes.
- Never restore a disabled/rotated share link, suspension, or deleted account merely because code rolled back.
- Pause workers before incompatible schema rollback; drain or quarantine jobs by version.
- If shared projection or cache isolation is suspect, disable every non-owner sharing endpoint and purge shared caches.
- If identity linking is suspect, disable new linking while retaining existing login methods; do not split/merge accounts automatically.
- Record rollback reason, affected cohort, data repair, and verification in an incident/audit trail.

## Acceptance criteria

### Specification acceptance

- Product owner approves goals, non-goals, phases, privacy defaults, and the explicit no-implementation-now constraint.
- Security/privacy approves the identity boundary, provider-linking rule, share-token lifecycle, sharing projection, retention, export, and deletion model.
- Operations approves email/auth/storage/queue providers, service limits, backup expiry, erasure verification, rollout, and rollback.
- Every open decision required for Phase 1 has an owner and resolution before implementation starts.
- Eventual repository/hosting setup remains gated to authenticated **`giffdev`** ownership.

### Feature acceptance before any multi-user production release

- Two authenticated users cannot read, infer, mutate, export, delete, deduplicate against, or enqueue work for each other's data through application, direct API, worker, cache, object, or database paths.
- Every user-owned database table has tested ownership constraints and deny-by-default RLS.
- Username uniqueness is race-safe; renames preserve immutable identity and honor the reservation policy.
- Credentials, Google linking, recovery, session rotation/revocation, and sensitive reauthentication pass security tests.
- Imports and retries are owner-scoped and idempotent; deduplication never crosses users.
- Corrections preserve immutable source provenance and cannot be overwritten silently.
- Private is the default. Enabling sharing requires an accurate preview and explicit confirmation.
- A valid enabled link receives only the explicitly approved shared projection; new flights are excluded and projected-field edits remove affected flights until reapproval.
- Authenticated owner views may show exact airports; shared views launch with coarse location and require a separate explicit exact-airport setting and preview.
- Link disable/rotation, suspension, and deletion remove access immediately.
- Export is complete, private, time-bounded, and excludes credentials/secrets.
- Deletion revokes access immediately and meets the approved active-store and backup-erasure commitments.
- Logs, telemetry, alerts, fixtures, and support surfaces contain no raw private flight rows or share-token plaintext.
- Rollback can disable sharing/import/auth capabilities without reactivating revoked access or corrupting ownership.

## Open decisions

| Decision | Recommended baseline | Owner/gate |
| --- | --- | --- |
| Transactional email provider and sender/domain | Select a provider with verified-domain, suppression, webhook, privacy, and regional support | Product + operations before Phase 1 |
| Auth.js session adapter/token-at-rest behavior | Database sessions; confirm adapter can store only token digests or document compensating controls | Backend + security before Phase 1 |
| Managed PostgreSQL/PostGIS, object store, and queue | Prefer managed, region-aligned services with RLS, PITR, lifecycle, and least-privilege identities | Backend + operations before Phase 1 |
| Username cooldown/reservation durations | 30-day cooldown and 90-day reservation | Product + privacy before Phase 1 |
| Account deletion grace and backup expiry | 7-day grace with normal login disabled and out-of-band cancellation; shortest operationally safe documented backup window | Product + privacy + operations before Phase 2 |
| Shared location/date/detail controls | Coarse location and aggregate/routes by default; exact airports, per-flight lists, and exact dates off | Product + UX + privacy before Phase 3 |
| Share-token lifecycle | One stable link while enabled; rotation or disable invalidates it; re-enable creates a new token | Product + privacy before Phase 3 |
| Optional link expiry | Defer initially; owner-controlled disable/rotation keeps the control simple | Product + privacy before Phase 3 |
| Optional public username map | Separate future feature with a separate enable control; never implied by token sharing | Product + privacy after Phase 3 |
| Age eligibility, terms, moderation, and appeals | Define before open registration or any discoverable public profile | Product/legal before public rollout |
| Production URL/domain | Decide before OAuth callback, email, canonical URL, and CSP configuration | Product + operations before Phase 1 |
