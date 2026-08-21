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

Production uses the normal deployment path for the linked Vercel project:

```powershell
vercel deploy --prod --yes --archive=tgz
```

Run it from a clean reviewed commit after validation. The Vercel Production
environment must contain one persistent
`FLIGHT_MAP_RELEASE_WRITES_PAUSED=false` value before the deployment starts.
Do not add a deployment-scoped override; the fresh runtime must inherit the
persistent Production value.

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

Production deployment does not auto-migrate. Before deploying application
code that requires `0017_public_share_handles.sql`, configure both variables
in the release shell and run:

```powershell
npm run db:migrate
```

The safe migration runner uses `MIGRATION_DATABASE_URL` for DDL and derives
the runtime role name from `DATABASE_URL`. After applying `0017`, it revokes
runtime execution of the obsolete
legacy projection functions and grants only
`public_map_projection_by_handle(text)`. The handle function remains
revoked from `PUBLIC`; the runtime role must not own the function or receive
schema-creation rights. Verify the exact migration ledger boundary is `0017`
and retain the migration receipt before starting the Vercel deployment.

A future dedicated import worker can use an explicitly bounded pool near
`DB_POOL_MAX=5`. The internal `background_jobs` table deliberately has no user
RLS because claims span owners; worker code must use its explicit `user_id` and
re-check account state. This schema work does not deploy or start a worker.
When deployed, set `WORKER_EXECUTION_MODE` explicitly: `disabled` is safe-off,
`on-demand` drains the queue and exits for an external scheduler, and
`continuous` is the required hosted Railway mode. Continuous mode applies
bounded exponential idle backoff from `JOB_POLL_INTERVAL_MS` (minimum and
default 30000) to `JOB_POLL_MAX_INTERVAL_MS` (default 900000). The production
configuration checker requires those exact values. Both the checker and runtime
require
`FLIGHT_MAP_RELEASE_WRITES_PAUSED=false`; run
`npm run check:durable-import-worker` against the complete target environment.

`/live` reports process liveness, mode, and whether processing is enabled.
Authenticated `/health` reports processing readiness and returns 503 while
disabled, after a loop failure, when polling progress is stale, or when scanner
or queue checks fail. Health probes share a five-second deadline and do not
start overlapping dependency checks.

## Production deployment and recovery

Configure the normal Production runtime in Vercel, including:

- `AUTH_URL=https://<production-host>`
- `AUTH_SECRET=<independent strong random value>`
- `DATABASE_URL=<least-privilege Neon runtime role>`
- `DB_POOL_MAX=1`
- `FLIGHT_MAP_RELEASE_WRITES_PAUSED=false`
- `FLIGHT_MAP_MVP_SYNC_IMPORTS=true`
- `IMPORT_STORAGE_BACKEND=sync-mvp`
- `IMPORT_MAX_BYTES=1048576`
- all required `NEXT_PUBLIC_FIREBASE_*` values

Do not place `MIGRATION_DATABASE_URL` in Vercel runtime variables. Firebase
must authorize the Production hostname and
`https://<production-host>/__/auth/handler`.

The release order is:

1. Pause or otherwise fence application writes according to the release
   procedure.
2. Run `npm run db:migrate` from the approved release environment with the DDL
   and runtime URLs above.
3. Verify migration boundary `0017` and the runtime handle-function grant.
4. Deploy the reviewed application artifact.
5. Complete the public-auth and handle-sharing acceptance checks before
   removing the release fence.

The current production recovery is intentionally simple: persist exactly
`FLIGHT_MAP_RELEASE_WRITES_PAUSED=false` for the Vercel Production environment,
then create a fresh normal Production deployment from the reviewed branch:

```powershell
vercel deploy --prod --yes --archive=tgz
```

Do not use `npm run deploy:production` for this recovery; that script is the
existing airport control-plane deployment and sets a deployment-scoped
`FLIGHT_MAP_RELEASE_WRITES_PAUSED=true` value. After Vercel reports the
deployment Ready, complete one clean-browser Google sign-in and confirm `/map`
loads with a database-backed application session.
