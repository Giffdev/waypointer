# Deployment

Waypointer is linked to the `giffdevs-projects/flight-map` Vercel project. The hosted preview is available at
`https://flight-map-preview-giffdev.vercel.app`. Devin approved the MVP
Production release on 2026-08-13; Production must still pass the release
configuration check and migrations before promotion.
Vercel SSO protection is disabled so users can reach public registration.
Registration remains protected by email verification, rate limiting, and the
password policy.

## Adopted local conventions

The neighboring `arkham-horror-lcg-ca` and `unmatched-match-trac` projects use:

- Vercel for web hosting, with an explicit preview/production deploy step rather than assuming a GitHub push is live.
- all environment files and templates excluded from source control.
- locked npm installs plus test/build validation in GitHub Actions.
- a manually triggered production workflow only after Vercel project identifiers and a repository secret exist.

Waypointer adopts those operational conventions, but not their Firebase data architecture. PostgreSQL/PostGIS remains the better fit for relational flight provenance, reconciliation, and geospatial queries.

## Local and CI validation

Use Node 22 (`.nvmrc`) and the package lock:

```powershell
npm ci
npm run check
```

The prepared CI workflow runs the same command on pull requests and `main`. It is inert until a repository is created.

## Preview deployment

Only after the GitHub target is authenticated as **giffdev**:

1. Create the repository under `giffdev`; verify the remote URL before the first push.
2. Create or link a Vercel project in the intended giffdev-owned account/team.
3. Configure the documented Preview environment variables directly in the Vercel dashboard. Never copy values into source control.
4. Run `npm run check` and `npm run check:preview-config`.
5. Deploy an explicit preview from a clean committed tree:

   ```powershell
   npm run deploy:preview
   ```

6. Verify auth callback URLs, user isolation, upload retention, migrations, and account deletion before any production deployment.

### Public-auth acceptance matrix

Every row must pass against the exact deployment being approved. Public access
cannot be inferred from a successful authenticated or privileged request.

| Layer | Required evidence |
| --- | --- |
| Network edge | A direct unauthenticated request from outside Vercel returns Waypointer, not Vercel SSO/password protection. Do not use `vercel curl`, bypass headers, protection cookies, or a logged-in Vercel browser for this proof. |
| UI | A clean browser opens `/auth/register`; the DOM and rendered page contain no preview access-code field, invitation copy, or allowlist error. |
| API | A same-origin registration request for a new arbitrary deliverable email succeeds without `previewAccessCode` and can never return `preview-access-denied`. Rate limits, password policy, and generic duplicate-account behavior remain active. |
| Environment | `npm run check:preview-config` passes: current Preview variables exist, retired access-code/allowlist variables are absent, optional OAuth variables are complete pairs, and Vercel SSO/password protection is disabled. |
| End-to-end identity | From a clean browser and network, create an arbitrary-email account, receive and use the verification email, sign in with credentials, confirm the private session, request deletion, confirm session revocation, and remove the synthetic account. |

Privileged smoke inputs may diagnose a protected deployment, but they never
prove public access or public registration. This includes Vercel automation
bypasses, preview access secrets, allowlisted identities, direct database
verification, manually extracted verification tokens, and pre-existing session
cookies.

### Release evidence checklist

Before changing the stable Preview alias, record `pass`, `fail`, or `blocked`
for every item below and include the deployment URL or command output that
supports it. A release with any `fail`, `blocked`, or undeclared item is not
complete.

- [ ] Exact deployment is `Ready` and targets `Preview`.
- [ ] Network-edge row passes using an unprivileged external request.
- [ ] UI row passes in a clean browser.
- [ ] API row passes without retired or privileged inputs.
- [ ] `npm run check:preview-config` passes.
- [ ] Uhura-owned automated public-auth gates pass.
- [ ] End-to-end identity row passes with real verification delivery.
- [ ] Synthetic accounts and artifacts are removed.
- [ ] Remaining gates and unavailable providers are explicitly declared.
- [ ] Production was neither configured nor promoted.

Run the clean-browser identity row with an automatically readable QA catchall
mailbox:

```powershell
$env:PUBLIC_AUTH_SMOKE_BASE_URL = "https://flight-map-preview-giffdev.vercel.app"
$env:PUBLIC_AUTH_SMOKE_EMAIL_DOMAIN = "qa-catchall.example"
$env:PUBLIC_AUTH_SMOKE_INBOX_URL = "https://qa-inbox.example/latest"
$env:PUBLIC_AUTH_SMOKE_INBOX_TOKEN = "<secret>"
npm run smoke:public-auth
```

The inbox endpoint receives an `email` query parameter and returns
`{"verificationUrl":"https://.../auth/verify?..."}`. The smoke creates a new
arbitrary address, uses no Vercel bypass, retired preview secret, allowlisted
identity, pre-existing credentials, or stored browser state, and completes
registration, email verification, credentials login, Map access, and account
deletion. It fails on 401/403, off-origin redirects, Vercel challenge content,
retired gate fields/copy, or a registration API redirect to a retired gate.

`npm run check:public-auth` is offline-safe and runs in `npm run check`. It
fails when retired access-code/allowlist variables are configured locally or
referenced by product/deployment files. `npm run deploy:preview` additionally
runs `check:preview-config`, which audits the linked Vercel environment and
Vercel SSO/password settings before deployment.

Never use bare `vercel` or `vercel deploy` for this project. Production
candidates use `npm run deploy:production`, which verifies the clean private
Git commit, exact local Vercel project/team, write pause, reviewed source and
prebuilt artifact hashes, then runs `vercel deploy --prebuilt --prod
--skip-domain`. Vercel Git integration is not required.

For the hosted preview, credentials registration requires an HTTPS
`AUTH_URL`, `FLIGHT_MAP_HOSTED_PREVIEW=true`,
`IMPORT_STORAGE_BACKEND=sync-preview`, `IMPORT_MAX_BYTES` no greater than
1 MiB, `AUTH_EMAIL_FROM`, and `RESEND_API_KEY`. Registration is public and
every account must receive and use its one-time verification link. Original
CSVs are not retained in this mode. Synchronous preview storage remains a
temporary preview milestone and is rejected as the production release
topology.

The approved MVP Production topology intentionally uses the equivalent bounded
mode under production names: `FLIGHT_MAP_MVP_SYNC_IMPORTS=true`,
`IMPORT_STORAGE_BACKEND=sync-mvp`, and `IMPORT_MAX_BYTES=1048576`. Each owner is
limited to five upload attempts per hour. CSV content is parsed synchronously
and the original is not retained. This is temporary until private object
storage, malware scanning, and durable workers are deployed.

OAuth providers are optional and independently configured; missing provider
variables do not disable app-owned email/password authentication. Google
requires both `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`, with callback
`/api/auth/callback/google`. Microsoft Entra ID requires both
`AUTH_MICROSOFT_ENTRA_ID_ID` and `AUTH_MICROSOFT_ENTRA_ID_SECRET`, with callback
`/api/auth/callback/microsoft-entra-id`. Set
`AUTH_MICROSOFT_ENTRA_ID_ISSUER` to the tenant-specific v2.0 issuer URL when
sign-in must be limited to one organization. Configure Entra to return the
`email` claim plus a verified-email signal (`xms_edov` or a verified email
claim); Waypointer rejects profiles without that proof rather than trusting a
mutable username or unverified email.

### Firebase Auth parity

The dedicated Firebase project is associated through `.firebaserc`. Its web
application supplies the documented `NEXT_PUBLIC_FIREBASE_*` values. When all
required values are present, the browser uses Firebase for
verified email/password accounts and Google sign-in, then exchanges a recent
verified Firebase ID token for Waypointer's existing opaque PostgreSQL session.
Firebase tokens never replace application sessions, RLS ownership, account
disablement, or deletion checks.

In Firebase Authentication, enable **Email/Password** and **Google**, and add
the Vercel hostname as an authorized domain. Firebase manages the Google OAuth
client behind its provider switch, so no Google client ID or secret is copied
into Waypointer. The Firebase CLI can create projects and web applications but
does not expose a command to enable Authentication providers; that provider
switch is the remaining one-time console step.

For Vercel, also set `NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN` to the stable
public hostname. Next.js proxies `/__/auth/*` to the Firebase auth domain so
redirect state remains first-party and `getRedirectResult()` works in browsers
that partition third-party storage. Add
`https://<public-host>/__/auth/handler` to the Firebase-managed Google web
client's authorized redirect URIs and add `https://<public-host>` to its
authorized JavaScript origins. Record both derived values in
`config/firebase-oauth-hosts.json`; release configuration fails closed for any
canonical host absent from that manifest.

Use separate PostgreSQL roles where supported:

- `DATABASE_URL`: least-privilege runtime role, with `DB_POOL_MAX=1` for
  Vercel/serverless processes.
- `MIGRATION_DATABASE_URL`: CI/release-only DDL role used by Drizzle.

A future dedicated import worker can use an explicitly bounded pool near
`DB_POOL_MAX=5`. The internal `background_jobs` table deliberately has no user
RLS because claims span owners; worker code must use its explicit `user_id` and
re-check account state. This schema work does not deploy or start a worker.

## Immediate MVP Production setup

Before deployment, run migrations with a release-only
`MIGRATION_DATABASE_URL`; do not place that DDL credential in Vercel runtime
environment variables. Airport refresh and reconciliation remain prohibited
until an independent Pre-Ship approval explicitly authorizes the exact
candidate.

### Airport production release control plane

Deploy the independently reviewed release-control-plane candidate before
creating the production snapshot. It contains no user feature or database
migration. The control-plane deployment must own the canonical
`flight-map-one.vercel.app` Production alias while writes are paused. Configure
`FLIGHT_MAP_RELEASE_WRITES_PAUSED=true` as the only persistent release runtime
variable. Supply `FLIGHT_MAP_RELEASE_PHASE=control-plane`, the reviewed
candidate/source hashes, and
`FLIGHT_MAP_APPROVED_AIRPORT_CANDIDATE_SHA256=12a1816ff66d4eefaef954ad1ac126087fad44d72e8586ac233c6cc4fddf98d3`.
only as inputs to that reviewed build. Every runtime database connection
starts read-only. The authenticated,
same-origin `/api/health/release` endpoint returns 503 unless the live
connection confirms `default_transaction_read_only=on`.

No repository signing key is used. Deploy from a clean, externally reviewed
`Giffdev/waypointer` `main` commit using the authenticated Vercel CLI prebuilt
path. `.vercel/project.json` must identify project
`prj_1XEu7EWNl1Eekl3TKQ6FnKnGznv8` and team
`team_qymLK9gugmE5lSs2mxC5XqRY`; Vercel Git repository linkage is neither
required nor trusted. The candidate contains the complete repository and
deployment-source manifests. A separate content-addressed prebuilt manifest
records every exact `.vercel/output` upload path, byte length, SHA-1 upload
UID, and SHA-256 review digest.

Enable Vercel system environment variables and Secure Backend Access with OIDC.
The deployment attestation endpoint requests a Vercel-signed OIDC token whose
audience contains the operator's one-time challenge. The operator validates
Vercel's JWKS signature, issuer, audience, subject, team, project, and
Production environment. Runtime `VERCEL_DEPLOYMENT_ID`, project, and URL are
provider claims. Git repository/ref/commit provenance comes only from explicit
deployment-scoped `FLIGHT_MAP_GIT_*` values derived from the verified clean
checkout.

Prepare the exact artifact without deploying:

```powershell
$env:FLIGHT_MAP_APPROVED_COMMIT_SHA = "<reviewed-commit>"
$env:AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256 = "<reviewed-candidate-hash>"
$env:FLIGHT_MAP_DEPLOY_PREPARE_ONLY = "true"
npm run deploy:production
```

Every Vercel child process removes `MIGRATION_DATABASE_URL` and other database
credentials. Independently review the emitted candidate and prebuilt manifest.
Then deploy those exact existing bytes from the same clean checkout:

```powershell
Remove-Item Env:FLIGHT_MAP_DEPLOY_PREPARE_ONLY
$env:FLIGHT_MAP_USE_EXISTING_PREBUILT = "true"
$env:FLIGHT_MAP_APPROVED_PREBUILT_ARTIFACT_MANIFEST_SHA256 = "<reviewed-prebuilt-hash>"
npm run deploy:production
```

The wrapper creates a Production-targeted immutable deployment with
`--skip-domain`; it does not change `flight-map-one.vercel.app`. It writes a
maximum-30-minute provider expectation that binds the commit, source hashes,
prebuilt file tree, project/team, deployment ID, immutable URL, prior alias
owner, release claims, and write pause. Verify the immutable URL before
promotion, then promote through the fail-closed wrapper:

```powershell
$env:AIRPORT_RELEASE_PROVIDER_EXPECTATION_PATH = "data/private/release-approvals/vercel-provider-expectation-<hash>.json"
$env:AIRPORT_RELEASE_PROVIDER_EXPECTATION_SHA256 = "<file-hash>"
npm run verify:production-candidate
npm run promote:production
```

Control-plane verification uses the public, challenge-bound
`/api/health/deployment` endpoint. It returns only deployment runtime claims
and a short-lived Vercel OIDC identity for the caller's one-time audience; it
does not authenticate a user or access the database. Promotion repeats the
provider file-tree and OIDC attestation after assigning the alias, verifies
public registration and sign-in routes, and restores the prior alias if any
post-promotion check fails. Missing or extra prebuilt files, unexpected
provider `gitSource`, source substitution, provider API failure, redirects,
Preview, or alias drift fail closed. The authenticated
`/api/health/release` route and its ephemeral health session remain mandatory
for the separate database catalog release. The manual
`.github/workflows/vercel-deploy.yml` uses the same reviewed commit, candidate,
prebuilt-artifact hash, project/team, and `VERCEL_TOKEN` secret; it has no
automatic trigger. The only credentialed job targets the `vercel-production`
GitHub Environment and accepts a content-bound approval artifact only from a
successful `vercel-release-approval.yml` run on `main` by a different GitHub
actor than the release requester. The environment must permit deployments only
from `main`; required environment reviewers should also be enabled when the
repository plan supports them. The workflow requires the reviewed commit to
equal both workflows' dispatch commit and the current private-repository `main`
tip. Its `prepare` operation uploads `.vercel/output` for independent review. A
later `deploy` operation requires a second approval, that prepare run ID, and
the reviewed artifact hash, downloads those exact bytes, and never rebuilds
them.

After that exact Production deployment is Ready, create and independently
verify the provider snapshot. Store only non-secret snapshot/target metadata
and the structured restore procedure in a content-addressed JSON file under
`data/private/release-approvals/`.

Set its path/hash plus the provider-expectation path/hash in the operator
shell. `MIGRATION_DATABASE_URL` must be session-only in that same PowerShell
process; this command deliberately does not load `.env.local`:

```powershell
$env:AIRPORT_RELEASE_PROVIDER_EXPECTATION_PATH = "data/private/release-approvals/vercel-provider-expectation-<hash>.json"
$env:AIRPORT_RELEASE_PROVIDER_EXPECTATION_SHA256 = "<file-hash>"
.\scripts\invoke-airport-production-release.ps1 Prepare
```

Preparation makes uncached Vercel alias and deployment-by-ID/URL queries before
sending the health cookie, verifies the exact provider prebuilt-file UIDs and
challenge-bound Vercel OIDC identity, queries the alias again, rejects
redirects, Preview, alias drift, replacement, and project/team/source
mismatches, confirms the runtime pause, then verifies target name/OID, ledger,
and snapshot fingerprint. It emits redacted content-addressed preflight and
target/snapshot approval artifacts. The preflight is context only and never
authorizes a later privileged step. An independent reviewer must approve the
exact hashes. Then set the emitted approval/preflight values and run, from the
same shell:

```powershell
.\scripts\invoke-airport-production-release.ps1 Release
```

The reviewed OurAirports input is pinned by full SHA-256 and byte length in
`config/airport-catalog-release.json`. The release commands never download a
mutable dataset. The operator never exports Vercel's runtime `DATABASE_URL`;
the approved fingerprint/name/OID and live application attestation bind the
session-only `MIGRATION_DATABASE_URL` to the target.

Do not self-approve the URLs active in the release shell. Before the release,
an independent approver must create a content-addressed JSON approval under
`data/private/release-approvals/` that binds the reviewed candidate-manifest
SHA-256, target fingerprint, database name and OID, expiration, verified
snapshot identifier/hash, pre-change state fingerprint, exact restore-procedure
hash, and a fresh application-level write-pause attestation. The pause must
precede the snapshot; both expire after 30 minutes at most. The restore
procedure is structured data, not shell text: it must include the exact four
approved stop conditions, serializable transaction semantics, a live
Production-alias read-only control plane, a snapshot-ID-bound provider command, and
`npm run db:airport-rollback-verify`. Record the approval artifact SHA-256 out
of band. Configure:

```powershell
$env:AIRPORT_RELEASE_TARGET_APPROVAL_PATH = "data/private/release-approvals/<approval-hash>.json"
$env:AIRPORT_RELEASE_TARGET_APPROVAL_SHA256 = "<approval-hash>"
$env:AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH = "artifacts/release-evidence/airport-catalog/candidate-<candidate-hash>.json"
$env:AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256 = "<candidate-hash>"
$env:AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256 = "12a1816ff66d4eefaef954ad1ac126087fad44d72e8586ac233c6cc4fddf98d3"
$env:AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_PATH = "artifacts/release-evidence/airport-catalog/airport-production-preflight-<preflight-hash>.json"
$env:AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_SHA256 = "<preflight-hash>"
$env:AIRPORT_RELEASE_CONFIRMATION = "release-airport-catalog:<approval-hash>"
$env:AIRPORT_RELEASE_EVIDENCE_DIRECTORY = "artifacts/release-evidence/airport-catalog"

.\scripts\invoke-airport-production-release.ps1 Release
```

`db:airport-release` acquires an exclusive advisory transaction lock also used
as a shared barrier by application writes, verifies the exact migration
manifest and ledger prefix, applies pending migrations,
repairs 0009 code-derived identity provenance, refreshes seed rows and aliases,
reconciles unresolved imports, and runs database health checks in one
serializable transaction. Any migration, seed, reconciliation, audit, checksum,
or failure-injection error rolls back the entire database operation. The
content-addressed evidence file is written only after commit and is never
overwritten. It never trusts the cached preflight: uncached provider/alias,
prebuilt-tree, OIDC, and write-pause checks run before opening the database
client, immediately before the first transactional write, immediately before
commit, and immediately after commit. Alias drift rolls back when detected
before commit and blocks promotion/forces the approved restore path if detected
after commit. Evidence records request timestamps, provider IDs, alias mapping,
candidate/source hashes, OIDC token/identity hashes, challenge freshness, and health hashes, never raw tokens,
cookies, credentials, or URLs containing credentials.

The manifest includes every migration through 0015. A production boundary at
0008 therefore executes and verifies 0009–0015 atomically, including nautical
mile defaults, multi-stop backfill/RLS, map-mode defaults, and sharing
invalidation. Extra, missing, reordered, or modified migration files or ledger
rows are refused.

Run the database release twice using a fresh approval and snapshot for each
pass. Both catalog identity checksums must match. Do
not run `db:migrate` separately for this release: that would bypass the target,
ledger, snapshot, and atomicity gates. Standalone reconciliation remains a
recovery tool and requires the same approval:

```powershell
npm run db:reconcile-airports
```

After deploying the exact reviewed database-released build and promoting that
exact deployment to `flight-map-one.vercel.app`, obtain a
content-addressed provider expectation under
`data/private/release-approvals/`. Generate it from the same clean pinned Git
checkout after deployment. It binds the expected deployment ID/URL, exact
Vercel prebuilt-file UIDs, candidate manifest, target fingerprint, migration
manifest, catalog checksum, database evidence, and active write pause. Configure
the expectation and an ephemeral dedicated health-account session:

```powershell
$env:AIRPORT_RELEASE_PROVIDER_EXPECTATION_PATH = "data/private/release-approvals/vercel-provider-expectation-<hash>.json"
$env:AIRPORT_RELEASE_PROVIDER_EXPECTATION_SHA256 = "<file-hash>"
$env:AIRPORT_RELEASE_HEALTH_SESSION_COOKIE = "<ephemeral-cookie>"
.\scripts\invoke-airport-production-release.ps1 Health
```

Health must prove `/`, `/map`, `/flights`, `/api/flights`, and authenticated
airport search availability; exact `00A/K00A`, `W01/KW01`, `OMK/KOMK`, `S18`,
and `UIL/KUIL` resolution; reviewed counts/checksums/provenance; alias integrity;
zero orphan references; completed unresolved reconciliation; and unchanged
historical flight airport foreign keys; it also reruns reconciliation in a
read-only transaction and verifies the connected database name/OID. It queries
the provider and live alias immediately before database verification and again
after the full public/authenticated health sequence; redirects, alias drift,
replacement, Preview, provider source mismatch, OIDC failure, or runtime identity
mismatch fail closed. Destroy the health
session after use.

If an approved stop condition occurs after commit, do not improvise a rollback.
Set the exact trigger and content-addressed confirmation, execute the
independently approved provider restore command outside this repository, then
verify restoration without changing data:

```powershell
$env:AIRPORT_RELEASE_ROLLBACK_TRIGGER = "promotion-health-failed"
$env:AIRPORT_RELEASE_ROLLBACK_CONFIRMATION = "rollback-airport-catalog:<approval-hash>:<database-evidence-hash>"
.\scripts\invoke-airport-production-release.ps1 Rollback
```

Verification compares the restored ledger and relevant data fingerprints with
the pre-change state embedded in database-release evidence. A mismatch blocks
retry. A successful restore still requires a new approval, pause, and snapshot.

Then configure Production:

- `AUTH_URL=https://<production-host>`
- `AUTH_SECRET=<independent strong random value>`
- `DATABASE_URL=<least-privilege Neon runtime role>`
- `DB_POOL_MAX=1`
- `FLIGHT_MAP_RELEASE_PHASE=database-released`
- `FLIGHT_MAP_SOURCE_MANIFEST_SHA256=<full source-manifest digest>`
- `FLIGHT_MAP_DEPLOYMENT_SOURCE_MANIFEST_SHA256=<reviewed deployment-source manifest digest>`
- `FLIGHT_MAP_CANDIDATE_MANIFEST_SHA256=<reviewed candidate digest>`
- `FLIGHT_MAP_APPROVED_AIRPORT_CANDIDATE_SHA256=12a1816ff66d4eefaef954ad1ac126087fad44d72e8586ac233c6cc4fddf98d3`
- `FLIGHT_MAP_MIGRATION_MANIFEST_SHA256=<reviewed migration manifest digest>`
- `FLIGHT_MAP_CATALOG_CHECKSUM=<committed catalog identity checksum>`
- `FLIGHT_MAP_DATABASE_EVIDENCE_SHA256=<database release evidence digest>`
- `FLIGHT_MAP_RELEASE_WRITES_PAUSED=true`
- `DELETION_TOMBSTONE_SECRET=<independent strong random value>`
- Optional account deletion capability: set both
  `AUTH_EMAIL_FROM=<verified sender>` and `RESEND_API_KEY=<configured secret>`,
  or omit both. When omitted, deletion controls are hidden and the API rejects
  before revoking sessions, cancelling jobs, or changing account state.
- `FLIGHT_MAP_MVP_SYNC_IMPORTS=true`
- `IMPORT_STORAGE_BACKEND=sync-mvp`
- `IMPORT_MAX_BYTES=1048576`
- `IMPORT_RETENTION_DAYS=7`
- All five `NEXT_PUBLIC_FIREBASE_*` values, with
  `NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN=<production-host>`

The Firebase-managed Google web client must include
`https://<production-host>` as an authorized JavaScript origin and
`https://<production-host>/__/auth/handler` as an authorized redirect URI.
Firebase Authentication must also list the Production hostname as an
authorized domain.

Do not set `FLIGHT_MAP_HOSTED_PREVIEW`, `FLIGHT_MAP_DEV_PREVIEW`,
`AUTH_DEV_EXPOSE_VERIFICATION_LINK`, or either retired `AUTH_PREVIEW_*`
variable in Production.

Run:

```powershell
npm run check
npm run check:production-config
npm run deploy:production
```

`deploy:production` creates an immutable Production candidate with
`--skip-domain`; it does not promote the public alias. Run
`verify:production-candidate`, then `promote:production` only after independent
approval of the exact commit, candidate, and prebuilt manifest. The manual
`workflow_dispatch` flow in `.github/workflows/vercel-deploy.yml` provides the
same separate prepare and deploy operations. Each operation requires a separate
content-bound manual approval workflow run by an actor other than the release
requester before its token-bearing step. The credentialed job also targets the
`vercel-production` environment, and the token remains process-only. The build
writes only the fixed non-secret project/team linkage; it never runs
`vercel pull` or downloads Production environment values.
