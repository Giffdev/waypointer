# Waypointer

A private, multi-user home for personal and commercial flight history. Waypointer turns existing flight logs into an interactive map, searchable history, and travel statistics.

## Run locally

For the complete account → upload → review → commit → Flights/Map flow:

```powershell
npm install
npm run dev:full
```

The command uses the local-only `.env.local` configuration, starts PostgreSQL
16/PostGIS with Docker Compose, runs Drizzle migrations, seeds the locally
verified OurAirports reference dataset, and starts the app. Open
`http://localhost:3000`, register, follow the development verification link,
sign in, and import a supported CSV. Uploaded originals remain under the
ignored `data\private\uploads` directory.

Host dependency: Docker Desktop with Docker Compose v2. The command reports
this explicitly when Docker is missing. Stop the database with:

```powershell
npm run db:local:down
```

The top-of-app status identifies `Full local workspace`, `Preview only`, or a
configured persisted deployment.

Validation:

```powershell
npm run check:full
npm run test:airport-release
```

`test:airport-release` provisions disposable PostgreSQL/PostGIS, migrates it,
runs two complete pinned catalog refreshes, verifies identical identity
checksums, writes JSON evidence under
`artifacts\release-evidence\airport-catalog`, and removes the database volume.

## Persisted multi-user development

Environment files and templates are intentionally excluded from source
control. Create `.env.local` locally (an existing local-only
`.env.local.example` may be copied) before using `npm run dev:full`.
The development verification link requires the explicit full-local flag,
loopback Auth and PostgreSQL URLs, local storage, a non-production process, and
its own opt-in flag. It cannot be enabled by the production runtime.

```powershell
npm run db:setup
npm run dev
```

Production rejects local storage and missing DB/auth/storage configuration.
Original uploads are private, limited to 10 MB by default, and retained for
seven days; staged row provenance remains in PostgreSQL.

Run the repository-level PostgreSQL import journey explicitly against the
migrated local PostGIS stack:

```powershell
npm run test:postgres
```

`npm run check:full` runs the normal checks, this PostgreSQL integration test,
and Playwright. Both commands provision the local database through Docker
Compose rather than silently skipping database coverage.

The public username projection function is `SECURITY DEFINER`, has a locked
`pg_catalog, public` search path, and is revoked from `PUBLIC`. Production
deployments do not auto-migrate. Before deploying the application, run the
reviewed migration path with both roles configured:

```powershell
$env:MIGRATION_DATABASE_URL = "<DDL-capable release role>"
$env:DATABASE_URL = "<least-privilege runtime role>"
npm run db:migrate
```

`MIGRATION_DATABASE_URL` applies migration `0017_public_share_handles.sql`.
`DATABASE_URL` is used only to identify the runtime role: the migration runner
revokes that role's access to the obsolete
legacy projection functions and grants
`EXECUTE` on `public_map_projection_by_handle(text)`. Do not grant the
runtime role function ownership or schema-creation rights. Confirm the
migration ledger boundary is `0017` before application deployment.

Production still requires provisioned PostgreSQL, `AUTH_SECRET`, and a real
`AUTH_URL`. Account deletion remains fail-closed and unavailable unless both
Resend variables are configured. The accepted synchronous MVP import mode does
not retain originals. Durable imports additionally require private
S3-compatible R2 storage and the Railway worker described below. The
app-owned email/password flow remains available independently. Google appears
only when `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` are both set. Microsoft
Entra ID appears only when `AUTH_MICROSOFT_ENTRA_ID_ID` and
`AUTH_MICROSOFT_ENTRA_ID_SECRET` are both set; use the optional tenant-specific
`AUTH_MICROSOFT_ENTRA_ID_ISSUER` to restrict organizational access. Register
the exact Auth.js callback URLs `/api/auth/callback/google` and
`/api/auth/callback/microsoft-entra-id`. Local placeholders and filesystem
storage are rejected outside the explicit loopback development path.

The canonical Production origin is `https://waypointer-app.vercel.app`.
Production `AUTH_URL`, `NEXTAUTH_URL`, the Firebase auth proxy domain, Google
OAuth JavaScript origin, and Google OAuth redirect URI must all agree with that
origin. `https://flight-map-one.vercel.app` remains a legacy entry point and
redirects to the canonical origin.

Runtime database connections use `DATABASE_URL` and a bounded pool. Production
defaults to one connection for serverless/Vercel processes; `DB_POOL_MAX`
overrides it explicitly (a future dedicated worker is expected to use about
five). Drizzle commands prefer the DDL-capable `MIGRATION_DATABASE_URL` and
fall back to `DATABASE_URL` locally. Private profiles and deletion requests use
owner RLS. The internal `background_jobs` queue intentionally does not, because
workers must claim jobs globally; every job still carries an immutable
`user_id`.

### Durable import worker

Keep `FLIGHT_MAP_DURABLE_IMPORTS` disabled until separate private Preview and
Production R2 buckets, origin-limited CORS, lifecycle rules, least-privilege
presigner/worker credentials, migration `0004_durable_import.sql`, and a
restricted pooled worker database role are provisioned. Railway must build
`Dockerfile.worker` through `railway.json`; the image runs Node 22, `clamd`,
and `freshclam`. The worker requires `WORKER_ID`, `WORKER_HEALTH_SECRET`, a
worker-sized `DB_POOL_MAX` (normally 5), R2 configuration, and the documented
ClamAV/job timing variables from `.env.example`. Set
`WORKER_EXECUTION_MODE=continuous` for the hosted Railway service. Production
defaults to `disabled`, which never opens database or storage clients and must
not be treated as processing-ready. `on-demand` drains until the queue is idle
and exits successfully, so use it only from an external scheduler rather than
for the always-on Railway service. Continuous mode uses bounded exponential
polling backoff from `JOB_POLL_INTERVAL_MS` (minimum 30000) up to
`JOB_POLL_MAX_INTERVAL_MS` (default 900000) so an empty queue does not keep
Neon awake. The production configuration check requires those exact values.

Set the complete worker environment, including `WORKER_EXECUTION_MODE`, before
deploying and run `npm run check:durable-import-worker` against those exact
values. The checker and worker runtime both require
`FLIGHT_MAP_RELEASE_WRITES_PAUSED=false` exactly. The check rejects disabled
mode as safe-off rather than deployment-ready. `/live` reports process
liveness, mode, and whether processing is enabled. Authenticated `/health`
reports processing readiness and returns 503 while disabled, after a loop
failure, when polling progress is stale, or when scanner or queue checks fail.
Health probes share a five-second deadline and do not overlap.
After the check passes, apply the migration and execute
`npm run smoke:durable-import` with a dedicated verified test account. The
hosted smoke requires both a clean CSV review/deduplication result and a
quarantined EICAR fixture before the feature flag may replace `sync-mvp`.

### Production recovery

The Gmail failure is caused by the deployed runtime inheriting
`FLIGHT_MAP_RELEASE_WRITES_PAUSED=true`, which blocks database-backed session
creation after successful Google OAuth. Keep exactly one persistent Production
value of `FLIGHT_MAP_RELEASE_WRITES_PAUSED=false`, then create a fresh normal
Production deployment:

```powershell
vercel deploy --prod --yes --archive=tgz
```

Do not use the airport control-plane `npm run deploy:production` script for
this recovery because it injects the paused value. Verify one clean-browser
Google sign-in reaches `/map` after the new deployment is Ready.

Before approving an auth deployment, run the production Google reauthentication
hard gate with an ignored Playwright storage-state file that contains the
approved test account's Waypointer and Google sessions:

```powershell
$env:FLIGHT_MAP_E2E_BASE_URL = "https://waypointer-app.vercel.app"
$env:FLIGHT_MAP_E2E_GOOGLE_REAUTH = "true"
$env:FLIGHT_MAP_E2E_GOOGLE_EMAIL = "<approved-test-account>"
$env:FLIGHT_MAP_E2E_GOOGLE_STORAGE_STATE = ".playwright-mcp/google-reauth.json"
npx playwright test e2e/auth.spec.ts --grep "production hard gate" --project=desktop-chrome
```

Capture the fixture with Playwright's `storageState({ indexedDB: true })`; the
gate rejects a fixture that does not contain a persisted Firebase identity.
It signs out cleanly, immediately signs back in through Google, and
requires `/map` within 15 seconds. Override
`FLIGHT_MAP_E2E_GOOGLE_REAUTH_MAX_MS` only for an explicitly approved threshold.
When explicitly enabled, the gate fails closed and names any missing required
variables. Values other than exactly `true` or `false`, including an empty
value, fail the run rather than silently skipping it. Clear the
session-persistent opt-in after the run so unrelated E2E commands are not
treated as production reauthentication attempts:

```powershell
Remove-Item Env:FLIGHT_MAP_E2E_GOOGLE_REAUTH
```

Run launch-schema checks with `npm run test:schema`. To also exercise clean and
upgrade migration paths, use a PostgreSQL role allowed to create temporary
databases and set `FLIGHT_MAP_RUN_POSTGRES_SCHEMA_TESTS=true`.

## Local ForeFlight preview import

Place a ForeFlight Logbook CSV at the repository root using the ignored
`logbook_*.csv` naming pattern, then run:

```powershell
npm run import:foreflight
```

The command downloads and caches the public OurAirports reference dataset
before reading the logbook, then writes an ignored map artifact to
`data\private\local-flights.json`, which the local mockup reads automatically.
It never uploads logbook contents.
Use `-- --offline` after the reference cache exists.

OurAirports publishes public-domain nightly CSVs without an accuracy warranty.

`npm run db:airport-release` is the production-safe catalog operation. It
uses only the reviewed file and SHA-256 pinned in
`config/airport-catalog-release.json`; it never downloads mutable release data.
Existing airport UUIDs are retained through verified source identity or an exact
logical match for explicitly marked 0009 code-derived identities. Crossed or
reassigned identifiers fail before writes. An exact manifest covers every
migration through 0017, including product migrations 0011–0017, and refuses
extra, missing, reordered, or modified migration files. The airport release
operation applies only its owned migration through 0015 and recognizes later
reviewed boundaries without replaying them. Pending owned migrations, the catalog,
aliases, unresolved-import reconciliation, and database health checks run in
one serializable transaction. Production requires a separately recorded,
content-addressed target/snapshot approval and candidate manifest. When Git
metadata is unavailable, the candidate includes a deterministic full relevant
source-tree manifest plus a content-addressed diff from the rejected baseline;
provenance failure blocks release. Active URLs cannot self-approve their own
fingerprint. The application write path participates in the release advisory
barrier, and production approval must prove an application-level write pause
before the fresh snapshot. Evidence is content-addressed, notice-redacted, and
never overwritten. `npm run db:setup` derives test-only safeguards for its
known loopback database. Run
`npm run db:audit-airports` to inspect cached coverage and representative
non-IATA resolution. The cache remains public-domain OurAirports data; Flight
Map preserves the dataset hash in `dataset_version` and does not treat the
catalog as an authoritative navigation source.

Correction search indexes official names, municipalities, catalog keywords,
and a bounded phonetic key for spelling variants. Phonetic results are search
suggestions only: imported identifiers are never silently resolved by name,
and the UI must show the official airport name and codes before correction.

## Local myFlightradar24 preview import

Place an official flight-diary CSV at the repository root using the ignored
`flightdiary_*.csv` naming pattern, then run:

```powershell
npm run import:fr24
```

The versioned adapter validates the official export header, resolves the
exported IATA/ICAO airport pair against the local OurAirports cache, and writes
an ignored map-safe artifact to `data\private\fr24-flights.json`. Registration,
seat, note, and other raw diary fields are not serialized. Use `-- --offline`
after the reference cache exists.
The preview uses its airport type, scheduled-service flag, and identifiers for
the custom commercial/GA/airstrip overlay. The current airstrip heuristic is a
small airport without an IATA code; runway-based refinement is not implemented.

## Migrate a local preview artifact

Versioned ForeFlight and myFlightradar24 JSON artifacts can be moved into one
existing account through the same staged review and commit services used by
browser imports. The destination user and source file are always explicit.
The default is a read-only dry run:

```powershell
npm run import:migrate-local -- --user-id <uuid> --source <artifact.json>
npm run import:migrate-local -- --user-id <uuid> --source <artifact.json> --apply
npm run import:migrate-local -- --user-id <uuid> --source <artifact.json> --commit
```

`--apply` stages rows for review without creating flights. `--commit` accepts
only commit-ready non-duplicates and explicitly skips duplicate, ambiguous, or
unresolved rows; it never auto-merges or alters an existing flight. Reruns are
idempotent for the destination user, artifact version, adapter, and source
hash. The command validates the exact supported schema version, never writes
or deletes the source artifact, and prints only status, safe counts, and issue
codes—never row contents, source paths, filenames, routes, or user identity.

See [`docs/product-architecture.md`](docs/product-architecture.md) for MVP boundaries, data/import design, security, and deployment planning.
See [`docs/logbook-csv-imports.md`](docs/logbook-csv-imports.md) for exact
automatic formats, evidence-backed mapping presets, generic CSV behavior, and
known limitations.
See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the normal giffdev/Vercel deployment path.

The explicit development preview still uses representative/local data. The
persisted path uses authenticated, per-user PostgreSQL records and private
storage. No remote repository has been initialized; eventual GitHub ownership
must be `giffdev`.
