# Multi-user accounts and URL sharing: security and privacy plan

**Status:** Historical design plan; not the current map-sharing API contract
**Release note:** The current shipped contract is [`map-sharing-api.md`](map-sharing-api.md): an owner-controlled, intentionally public `/{username}` map with no token, fragment, GUID, or legacy route. Capability-link and non-indexing requirements below are retained as design history.
**Integrated reconciliation revision:** Uhura, Quality Engineer, 2026-08-11

## 1. Scope and safety objective

Flight history is sensitive location data. Even without notes or passenger details, it can reveal likely home airports, routines, employer/customer routes, aircraft ownership or access, and future or recurring absences. A person's map, flight list, aggregates, provenance, imports, and inferred patterns are therefore private unless that person knowingly shares a bounded view.

This plan covers first-party accounts, Google sign-in, private-by-default maps, an owner-controlled unlisted share URL, recovery, portability, and incident containment. It does not authorize public profiles, live tracking, social networking, third-party credential collection, or minor accounts.

### Explicit non-goals

Friend graphs, friend/follow requests, followers, invitations, contact discovery, username/profile search, activity feeds, recommendations, direct messaging, blocking/reporting workflows for social contact, and named-recipient access are not part of the planned feature. A readable, non-indexed owner alias may locate an already-issued map capability, but the alias alone discloses no projection and is not a directory or authorization credential. Adding discoverability or any of the excluded features requires a new product and privacy review; this plan must not be used as approval for them.

### Data classes

| Class | Examples | Handling |
|---|---|---|
| Restricted travel data | Flights, exact airports/times, notes, tail numbers, routes, inferred home airport, imports, provenance | Owner-only except for the explicit redacted share projection; encrypted; excluded from logs, search, and analytics |
| Restricted identity/security | Password hashes, OAuth tokens, sessions, recovery/share tokens, email | Server-only; least privilege; tokens encrypted or one-way hashed as applicable |
| Private account profile | Username, display name, avatar, email | Private; not exposed by the unlisted share URL unless a field is separately approved |
| Shared reference data | Canonical airport records and public geographic boundaries | May be cached globally, but never joined to a user's history without authorization |

## 2. Threat model

### Assets and trust boundaries

Assets include accounts, sessions, share configuration and tokens, travel records and aggregates, raw import objects, provenance, exports, audit events, and cryptographic secrets. Trust boundaries exist between the browser, Next.js server, Auth.js/OIDC provider, database/RLS layer, private object storage, import worker, email provider, caches/CDN, and operational support tools.

The browser, uploaded files, URL parameters/share tokens, OAuth responses, and all user-supplied profile fields are untrusted. A logged-in user is not trusted to identify the owner of a requested record.

### Principal misuse and failure cases

1. An attacker scans or guesses share URLs to identify a person's routes, home airport, or periods away.
2. An attacker changes a flight, user, batch, export, or share ID to read another user's data (IDOR/cross-tenant access).
3. A viewer retains access through a browser, CDN, server, image, metadata, or aggregate cache after the owner disables or rotates the URL.
4. A bearer link is guessed, leaked through logs/referrers/analytics, indexed, or forwarded beyond its intended audience.
5. A compromised owner account enables or rotates sharing and exfiltrates history through a legitimate-looking URL.
6. Account or share enumeration occurs through registration, login, reset, share endpoints, predictable identifiers, or timing differences.
7. OAuth account confusion or unsafe email auto-linking gives an attacker control of an existing account.
8. Credential stuffing, reset abuse, session theft, CSRF, or failure to revoke old devices leads to account takeover.
9. A CSV/import supplies formulas, malicious content, misleading identity/provenance, oversized input, or values that escape into logs or exports.
10. Tail numbers, exact timestamps, notes, source filenames, or provenance reveal more than the visible map suggests.
11. A user accidentally enables a URL for all history, future trips, newly imported flights, or a derived aggregate that still identifies private records.
12. A minor publishes routine location data through a forwarded URL without an age-appropriate safety and consent model.
13. Deleted data survives in shares, search, queues, object storage, analytics, caches, or operational copies.
14. An insider or breached service account queries travel data without a business need, with insufficient evidence for investigation.

## 3. Mandatory requirements

Requirements marked **BLOCKER** apply before the associated capability may ship.

### Identity, password, and Google authentication

- **BLOCKER:** Use Auth.js or another reviewed library; do not create a custom session or OAuth protocol.
- **BLOCKER:** Passwords use Argon2id with parameters benchmarked for the production environment and stored only as hashes. Accept long passphrases (at least 12 characters; allow at least 64), reject commonly breached passwords, and do not impose composition rules that weaken passphrases.
- **BLOCKER:** Verify email ownership before password recovery or enabling sharing. Login, registration, and reset responses must be generic and timing-normalized enough to resist enumeration.
- **BLOCKER:** Google sign-in uses OIDC authorization code flow with exact redirect URI validation and library-provided state, nonce, and PKCE protections. Require a verified provider email.
- **BLOCKER:** Never auto-link a Google identity to a password account solely because email strings match. Link only from an authenticated session with recent reauthentication, or through a reviewed recovery flow that proves control of both identities.
- **BLOCKER:** OAuth refresh/access tokens are encrypted at rest, excluded from logs, and requested with the minimum scopes. Waypointer must not request third-party flight-service credentials.
- Later hardening: optional WebAuthn/passkeys and step-up MFA for export, account linking, and deletion.

### Authorization and tenant/user isolation

- **BLOCKER:** Every user-owned row has an immutable owner ID. Authorization is deny-by-default and permits only the owner or the server-side projection for a currently enabled share token.
- **BLOCKER:** Repository/service methods derive the acting user from the server session. They must not trust a client-supplied `user_id`, username, email, or visibility flag.
- **BLOCKER:** Production PostgreSQL row-level security enforces ownership/share policy as defense in depth. Application tests must also prove isolation with at least two users.
- **BLOCKER:** Flights, aggregates, search indexes, import batches/rows, corrections, provenance, object keys, exports, background jobs, and cache keys are owner-scoped. Global or username-keyed caches of personalized data are prohibited.
- **BLOCKER:** Storage uses private buckets and opaque owner-scoped keys. Signed upload/download URLs are short-lived, content/size constrained, and cannot overwrite another object.
- **BLOCKER:** Batch and aggregate endpoints perform authorization before existence checks and return indistinguishable not-found responses for inaccessible resources.

### Private-by-default maps and visibility

- **BLOCKER:** New accounts, profiles, flights, imports, maps, statistics, and saved views are private. Source rows never inherit shared access from account state, import state, source markings, or a broad visibility flag.
- **BLOCKER:** No private flight may contribute to a shared count, route line, airport marker, date range, update timestamp, activity feed, metadata tag, preview image, search result, or error message.
- **BLOCKER:** Sharing is an explicit Share action for an unlisted URL, with a server-derived complete-map snapshot that has no product flight-count ceiling, a field/precision summary, and forwarding and recognizable-route warnings. Callers cannot select or exclude flight IDs. Resource failures must reject the operation without truncating or replacing the last enabled snapshot.
- **BLOCKER:** Future flights/itineraries are not shareable in the initial release. An enabled URL reads only the published snapshot: newly imported or newly added flights remain outside that snapshot until an owner-initiated Update action atomically includes the complete current set. Owner-flight mutations and Share/Update use the same database lock, so an overlapping mutation commits before publication is derived. Any update or delete of a selected flight, or any insert, update, or delete of a route stop attached to a selected flight, conservatively disables the whole share. The membership rows remain as the last published record until a successful complete-map republish atomically replaces them and re-enables sharing.
- Default shared views omit notes, provenance, source IDs/filenames, correction history, flight numbers, seats, passenger data, exact times, and aircraft registration/tail numbers.

### Unlisted share URL lifecycle

- **BLOCKER:** Sharing is off by default. Enabling it creates a separate, explicitly redacted server-side shared-map projection with server-derived complete-snapshot membership, redacted values/precision, and a projection version; it must not change the visibility of source flight rows.
- **BLOCKER:** The only supported public capability is `/{handle}#key={capabilityKey}`. The handle is user-chosen, visible, and not identity-verified. The 256-bit HMAC-derived fragment key is mandatory authorization; only its digest is stored in `map_shares`, and it is sent from the browser in the body of `POST /api/shared/{handle}`, never in an HTTP URL. Internal UUID public IDs are non-public implementation identities; `/shared/{uuid}` and UUID projection access are unsupported.
- **BLOCKER:** The Share action is explicit consent to publish the complete coarse map. Before it is available, the UI discloses that the user-chosen, unverified username is visible and forwarded with the link. Generated OAuth/Firebase or migration usernames must be edited first and email is never exposed as a fallback. Disablement and renaming immediately make the current route unavailable; re-enable and rename publication rotate the key so every prior handle/key combination remains invalid even after handle reuse.
- **BLOCKER:** Disablement, rotation, account disablement, security recovery, or deletion must fail closed at the authorization source immediately. Every share request revalidates current token state; possession of a formerly valid URL is not sufficient.
- **BLOCKER:** The implemented shared JSON and error responses use the exact `Cache-Control: no-store, max-age=0, s-maxage=0, must-revalidate` header. Share HTML, tiles, images, and metadata must provide equivalent platform/CDN bypass before launch. No personalized share response may enter a shared or stale-while-revalidate cache.
- **BLOCKER:** Revocation tests must prove old URLs fail from a fresh browser and after prior access, and that CDN, reverse-proxy, server-render, route-data, service-worker, image/preview, and browser-back paths do not reveal revoked content. Incident controls must support immediate cache purge as defense in depth.
- **BLOCKER:** Shared API responses set `Referrer-Policy: no-referrer`, and the shared page removes the fragment before loading the map. Third-party requests therefore cannot receive the key through an HTTP URL or referrer. Token-bearing query strings are prohibited.
- **BLOCKER:** Share pages set `X-Robots-Tag: noindex, nofollow, noarchive` and matching HTML robot directives, are omitted from sitemaps/feeds/previews, and do not generate Open Graph images containing travel data. `robots.txt` is supplementary, not an access control.
- **BLOCKER:** Tokens are removed from application, proxy, CDN, tracing, error, analytics, support, and audit logs. Monitoring may record only a non-reversible share ID and coarse outcome.
- **BLOCKER:** Unknown, disabled, rotated, malformed, and legacy UUID identifiers return the same generic not-found behavior. Link expiry is deferred. Endpoints, response size, redirects, and timing must not reveal whether an account or old share exists.
- **BLOCKER:** The UI warns that anyone with the URL can forward or copy its contents. There is no claim of recipient identity, confidentiality after viewing, or screenshot/download prevention.
- Later hardening: owner-selected expiration, multiple independently revocable URLs, access-count anomaly alerts, or optional viewer verification. These are not required for the simple initial URL.

### Sensitive fields and precision

- **BLOCKER:** Field-level policy is enforced server-side, not by hiding client UI. API contracts for shared views must be allowlists separate from owner contracts.
- **BLOCKER:** Aircraft registration/tail number, free-text notes, provenance, external IDs, uploaded filenames, correction/audit data, seat/passenger fields, and authentication identity are never shared by default.
- **BLOCKER:** Exact departure/arrival timestamps are omitted from the share URL. The default displayed precision is month/year; any future date-level option requires a separate explicit toggle and warning. Exact times are out of scope for the initial URL.
- **BLOCKER:** The authenticated owner view may show exact canonical airports. The implemented capability-protected shared view exposes only region/country labels or coarse coordinates and coarse route geometry. Exact-airport sharing controls are future and unimplemented; any later implementation requires a separate per-share setting, warning, preview, and explicit confirmation while preserving the same handle-plus-fragment authorization model.
- **BLOCKER:** Do not infer or label “home,” “work,” employer, routine, or absence periods in a shared view. A user must be warned when a selection contains repeated endpoints or a recognizable routine.
- **BLOCKER:** Downloads/exports from a shared view apply the same redaction and precision rules as the screen. Disabling download is not treated as prevention against a viewer copying data.
- Later hardening: automatic privacy-risk preview for repeated routes, rare aircraft, and recent travel; optional delay before completed flights appear in a share.

### Minor and vulnerable-user safety

- **BLOCKER:** Initial accounts and sharing are 18+ only, stated in eligibility/terms with a lightweight age attestation. Do not collect full birth dates solely for this gate.
- **BLOCKER:** If the product later serves minors, share URLs, public profiles, and exact locations/times remain disabled until a dedicated child-safety, consent, legal, and data-retention review passes.
- Do not market the service as real-time tracking or infer that a person is currently away from home.

### Import provenance and untrusted content

- **BLOCKER:** Original imports, raw rows, adapter/source metadata, filenames, source timestamps, and correction history are owner-only and never included in share URL payloads.
- **BLOCKER:** Every imported flight starts private regardless of source markings. Provenance demonstrates source lineage, not the identity or trustworthiness of the uploader.
- **BLOCKER:** Enforce content-based format validation, size/row limits, isolated parsing, malware scanning for retained originals, formula neutralization on CSV export, bounded decompression, and short configurable original-file retention.
- **BLOCKER:** Import workers and logs must not emit raw rows, notes, tokens, filenames, or full routes. Jobs must verify ownership again before commit or result delivery.
- Authorized APIs may be added only after scope, token storage, revocation, terms, and data-deletion review. Scraping or storing third-party passwords is prohibited.

### Recovery, sessions, and devices

- **BLOCKER:** Recovery tokens are random, one-time, short-lived (30 minutes or less), hashed at rest, invalidated after use/resend, and never logged. Recovery messages do not contain travel details.
- **BLOCKER:** A password reset or security recovery invalidates all existing sessions and active share URLs. Notify the verified email of password, OAuth-link, recovery, and share-state changes without revealing private history.
- **BLOCKER:** Session cookies are `Secure`, `HttpOnly`, appropriately `SameSite`, narrowly scoped, rotated after authentication/privilege changes, and protected against CSRF. Session IDs are unguessable and stored hashed where supported.
- **BLOCKER:** Users can view active sessions/devices with coarse location/time, revoke one or all, and are prompted for recent reauthentication before changing email/password, linking identities, exporting, deleting, or enabling/rotating sharing.
- Later hardening: risk-based reauthentication and impossible-travel/session anomaly detection, without creating invasive location telemetry.

### Export, deletion, and retention

- **BLOCKER:** Owner exports require recent reauthentication, are generated in an owner-scoped job, delivered through a private short-lived URL (24 hours or less), and never sent as an email attachment. Export access is audited.
- **BLOCKER:** Account deletion immediately disables normal login, sessions, the active share URL, and processing jobs and records a deletion tombstone. During the proposed grace period there is no limited or partially authenticated session: cancellation uses a generic out-of-band flow that sends a single-use link only to the verified email address. Cancellation restores a private, sharing-disabled account, leaves old sessions/URLs revoked, and requires fresh credential recovery/sign-in. If not cancelled, primary data, raw objects, search entries, and derived aggregates are purged within a documented period no longer than 30 days from the original request.
- **BLOCKER:** Backup deletion follows a documented bounded schedule; restored backups must replay deletion tombstones before serving traffic. Legal/security exceptions must be narrow, documented, and inaccessible to normal product paths.
- **BLOCKER:** Users can delete individual flights/imports and understand whether canonical flights with multiple provenance sources remain. Deleted records must not persist in aggregates or share caches.
- Export and deletion behavior, retention windows, and support contact must be disclosed before collecting production data.

### Audit, operations, and breach containment

- **BLOCKER:** Append-only security audit events cover login/recovery, identity linking, session revocation, share enable/disable/rotation/access, export, deletion, administrative access, and authorization denials.
- **BLOCKER:** Audit records use actor/target opaque IDs, action, outcome, request correlation, and coarse time/network metadata. They exclude passwords, tokens, URLs containing tokens, raw routes, exact airports/times, tail numbers, notes, imports, and export contents.
- **BLOCKER:** Administrative access is least-privileged, strongly authenticated, time-bound where possible, and audited with a stated support reason. Support staff must not impersonate users or browse maps by default.
- **BLOCKER:** Encrypt transport and managed storage, separate production/preview data and credentials, rotate secrets, restrict database/object-store roles, scrub monitoring, and prohibit production travel data in preview/test.
- **BLOCKER:** Maintain a tested incident runbook able to disable all sharing, revoke sessions and tokens, rotate keys, invalidate URLs/caches, suspend imports/exports, identify affected owners from audit evidence, and notify as legally required.
- Later hardening: automated data-access anomaly alerts, periodic access reviews, tabletop exercises, and cryptographic key separation per sensitive subsystem.

### Rate limiting and enumeration resistance

- **BLOCKER:** Layer per-IP, per-account, per-device/session, per-token, and global limits on registration, login, recovery, share URL access, export, and import. Limits must cap repeated misses without making valid tokens distinguishable.
- **BLOCKER:** Use generic status/body behavior for unknown versus existing accounts and inaccessible versus absent resources. Avoid response-size, redirect, avatar, and timing side channels.
- **BLOCKER:** Security limits fail closed for sensitive writes and degrade safely for reads. Alert on credential stuffing, share-token scanning, abnormal share access, and cross-owner authorization failures.
- Do not use CAPTCHA as the sole control. Any third-party challenge service requires a separate privacy review.

## 4. Rollout phases and acceptance gates

No phase inherits approval from an earlier phase. Failed isolation, unintended disclosure, or token leakage is a **RED** release blocker.

### Phase 0 — schema and security foundation

**Allowed:** migrations, test fixtures, threat-model validation; no production personal data.

**Gate:**
- Data inventory, retention schedule, owner/share-projection model, and separate owner/shared response schemas reviewed.
- RLS policies and service authorization design cover every user-owned and derived table.
- Secrets, environment separation, audit schema, incident disable switches, and deletion propagation are designed.
- Automated checks prevent raw imports and travel fields from entering logs/telemetry.

### Phase 1 — accounts and owner-only workspace

**Allowed:** password/Google login and private maps; no share URL.

**Gate:**
- Authentication, safe account linking, recovery, secure sessions/device revocation, CSRF, and auth rate-limit tests pass.
- Two-user negative tests cover every read/write/API/job/storage path; RLS tests prove cross-user access fails.
- New/imported records and all aggregates are private; CDN/server caching cannot cross users.
- Export/deletion, retention jobs, audit events, breached-password screening, and incident session revocation are exercised in a production-like environment.
- Independent security review finds no high-severity auth, IDOR, injection, upload, or secret-handling issue.

### Phase 2 — opt-in unlisted share URL

**Allowed:** one owner-controlled, bounded, redacted share URL; no public profile, directory, social feature, or named-recipient access.

**Gate:**
- At least 128-bit token entropy, one-way token storage, explicit enablement, disablement, rotation, and current-state inventory are verified.
- Token does not appear in application/proxy/CDN/analytics/error logs, referrers, screenshots generated by the service, or third-party requests.
- `no-store`, no-referrer, no-index/noarchive, sitemap exclusion, and third-party-resource isolation are tested.
- Disablement and rotation invalidate authorization immediately; old URLs and every identified cache/render path fail after revocation.
- Consent states that omitting direct account identifiers or a display name does not anonymize repeated coarse endpoints and routes, which may still reveal a home region, routines, employer, or identity. It also states that revocation cannot recall content already opened, copied, forwarded, or screenshotted.
- Token scanning/rate controls and safe not-found responses pass adversarial tests.
- Owner sharing controls and server-side redaction prove tail numbers, notes, provenance, source details, and exact timestamps are omitted.
- Forwarding-risk warning, owner-versus-shared location behavior, coarse location/date defaults, automatic complete-snapshot membership, new-flight snapshot isolation, and conservative whole-share disable/republication after selected flight or route-stop mutations are verified.

**Current evidence status:** PostgreSQL and API tests prove authorization-source
disablement/rotation and fresh API reads returning not found. Component tests
also prove that an already-loaded viewer revalidates on focus, visibility
restoration, and browser-history `pageshow`, clears the projection after generic
revoked/unavailable responses, and hides stale content without falsely claiming
revocation after a network failure. Evidence for every CDN, service-worker,
image/preview, and server-render cache path remains an open launch gate.
Authorization revocation and viewer revalidation must not be described as
recalling content that a recipient already opened, copied, forwarded, or
screenshotted.

### Phase 3 — broader visibility or youth support

Public profiles, searchable pages, social features, multiple audience types, live/recent tracking, third-party sync, or users under 18 require a new threat model, applicable legal/child-safety review, and explicit approval. They are not approved by this document.

## 5. Launch blockers versus later hardening

### Mandatory launch blockers

1. Deny-by-default authorization plus tested owner isolation/RLS for every row, job, object, aggregate, cache, and export.
2. Library-based secure authentication, verified identity, safe OAuth linking, recovery, CSRF protection, session/device revocation, and abuse limits.
3. Private-by-default records and a separate allowlisted share payload with sensitive-field and precision redaction.
4. Explicit owner Share/Update actions, accurate pre-action disclosures, immediate disable/re-enable rotation, cache-safe revocation, no implicit sharing of future/new flights, and conservative whole-share disablement after any selected flight or route-stop mutation.
5. Working export/deletion/retention, privacy-safe audit logs, incident containment controls, and production/preview separation.
6. Before enabling the URL, all Phase 2 token, leakage, indexing, caching, and enumeration gates.
7. Adult-only initial eligibility; no public profile, live tracking, or third-party credential collection.

### Later hardening (not substitutes for blockers)

- Passkeys/MFA and risk-based step-up.
- Automated privacy-risk warnings and anomaly detection.
- Optional expiry, multiple independently revocable URLs, link PINs, access anomaly alerts, and delayed recent-flight sharing.
- Periodic access reviews, penetration testing at larger scale, and recurring incident exercises.
- Any recommendation system, public profile, minor support, or authorized third-party sync only after a new review.

## 6. Required verification evidence

Release owners should attach:

- authorization/RLS matrix and automated test results;
- cache, object-store, worker, export, and deletion isolation tests;
- auth/OIDC/account-linking and recovery test results;
- share enable/disable/rotation, cache revocation, enumeration, referrer, indexing, and token-leakage tests;
- redacted examples of owner versus share URL API contracts;
- projection-membership tests proving every eligible flight is included automatically by Share/Update, overlapping mutations serialize before publication, later flights stay outside an enabled snapshot until update, any selected flight or route-stop mutation disables the whole share while retaining snapshot membership rows, and exact airports remain owner-only while future sharing controls are unimplemented;
- log/token leakage scan and retention-job evidence;
- incident exercise showing rapid share disablement, token/session revocation, and cache purge;
- an independent security review with all high-severity findings closed.

Approval must be reassessed when audiences, precision, import sources, identity providers, analytics, storage, or youth eligibility change.
