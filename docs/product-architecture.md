# Waypointer — product and architecture plan

## Product intent and observed references

Waypointer is a multi-user, private-by-default home for a person's combined general-aviation and commercial flight history. It should make a life in the air legible through an explorable globe, trustworthy records, and user-controlled corrections.

The current sharing contract is in [`map-sharing-api.md`](map-sharing-api.md). Waypointer implements isolated accounts with usernames, Auth.js sign-in, and one explicitly enabled public travel map at `/{username}`. The URL is intentionally enumerable and has no token, GUID, fragment, or legacy compatibility route. Email is never exposed as a fallback. The authenticated owner view remains private; the Share action publishes a field-allowlisted server-side snapshot containing every eligible flight at that moment, canonical public airport metadata, and only the flight facts required for viewer-local filters. New imports wait for an owner-initiated complete-map update, and any published flight or route-stop mutation conservatively disables the whole share until the owner shares again. Account deletion disables normal login and sharing immediately. Social graphs and friend-only audiences remain explicit non-goals.

Publicly observed on 2026-08-07 (no authentication or private data accessed):

- **Arelplane public profile:** a Cesium 3D map, profile highlights, lifetime stats, recent updates, airport/region/aircraft summaries, and a public description reporting flights, airports, and hours. Its public markup also signals import-review and inline-edit workflows.
- **myFlightradar24 public profile:** a route map with airport points, colored paths, update recency, account entry points, and a separate flights URL. Public route/airport metadata powers the map.

Inferred requirements, kept separate from observations: users will value filters, public sharing controls, lifetime summaries, provenance badges, and correction history. These are hypotheses to validate, not copied product behavior.

## MVP boundary

**In:** account registration/login (Google and username/password), private user workspace, generic CSV and ForeFlight CSV import, staged preview, airport matching, deterministic duplicate suggestions, row-level acceptance, origin/destination correction, provenance, a global globe that transitions to precise regional cartography, flight list, basic filters and aggregates, account export/delete.

**Not in first release:** scraping or credential-based syncing from third parties; live aircraft tracking; social graph; mobile apps; collaborative logs; pilot credential storage; automatic Arelplane/myFR24 ingestion without an authorized export/API; public profiles by default. Arelplane-style and myFR24 exporters become adapters only after sample exports and terms/API review.

Unauthenticated preview pages may use representative data. Authenticated owner
routes, browser imports, and sharing use persisted owner-scoped PostgreSQL data.

## Chosen stack

- **Next.js 16 App Router + TypeScript + React 19:** one maintainable full-stack web application, server components by default, mature deployment path.
- **MapLibre GL JS 6 (BSD-3-Clause):** production-oriented WebGL cartography with globe projection at global scales and its automatic Mercator transition near zoom 12 for precise regional work. GPU-native vector/raster layers and accessible app controls require no paid-provider token. Great-circle routes and OurAirports-derived airport facilities are application-owned GeoJSON layers. Native layers remain preferred; deck.gl `ArcLayer` is only a fallback if measured route-rendering limitations justify its additional runtime.
- **Tailwind CSS plus project CSS tokens:** quick responsive implementation while retaining a distinct visual system.
- **PostgreSQL + PostGIS:** relational integrity, geospatial airport/region lookup, row-level ownership queries, and database-enforced sharing/mutation serialization.
- **Drizzle ORM:** explicit SQL-friendly schemas and migrations.
- **Auth.js:** Google OAuth plus Credentials provider. Passwords are hashed with Argon2id and sessions use secure, HTTP-only cookies. No home-grown session protocol.
- **S3-compatible object storage + background worker (planned):** private, short-retention original uploads; queued parsing and reconciliation outside request timeouts.
- **Vitest:** foundational pure-domain tests; Playwright will cover import/auth journeys once those routes exist.

## Domain/data model

- `users`, `accounts`, `sessions`: identity and authentication. Username is unique but not an authorization boundary.
- `user_profiles`: display preferences and independently controlled `profile_visibility`.
- `map_shares`, `map_share_flights`: one opt-in public username URL, redacted projection, and server-derived whole-map snapshot membership; source flights never inherit share access.
- `airports`: canonical ICAO/IATA/local identifiers, coordinates, country, first-level region, aliases, dataset/version.
- `flights`: user-owned canonical record; date/time precision, origin/destination airport IDs, kind, aircraft/registration, flight number, duration/distance, notes, visibility, timestamps. `fingerprint_version` and `source_row_key` carry import identity so an adopted flight can be recognised across fingerprint versions.
- `flight_stops`: the ordered path of one flight. `stop_kind` is `landing` or `waypoint` and `source_field` is `endpoint`, `route`, or `manual`. **Only `landing` stops feed statistics, dedupe identity, and the public share contract**; waypoints are presentation-only. Rows that predate this split migrate as `landing`/`endpoint`.
- `import_batches`: user, adapter/version, status, original object key, file hash, `importer_version`, counts, timestamps, expiry. File-hash reuse is scoped by importer version so a deployed pipeline fix can reach bytes that were already staged.
- `import_rows`: minimal source snapshot, parsed fields, validation state, match confidence, proposed flight.
- `flight_sources`: many-to-one provenance from canonical flight to batch/row, source type, external stable ID, source timestamps.
- `flight_overrides`: field, original value, corrected value, actor, reason, timestamp. Canonical values update transactionally, but source truth remains immutable.
- `duplicate_candidates`: candidate pair, rule/version, score, explanation, resolution. Do not silently merge low-confidence matches.

All user-owned tables carry `user_id`; repository/service queries require it. Production PostgreSQL should also use row-level security as defense in depth.

## Route and client-data boundaries

- `/` is a framework-native temporary redirect to `/map`.
- `/map` and `/flights` share normalized `type`, `period`, `year`, and `month` URL parameters. The URL is the source of truth so direct links and browser history reproduce the same view.
- `/import` is independent of map filters.
- Server components construct least-data route contracts: Map receives cartographic features and aggregates, Flights receives sanitized history fields, and Import receives only artifact presence and a normalized count. Raw rows, provenance payloads, source timestamps, and full history are not serialized to routes that do not require them.

## Import and reconciliation

1. Browser requests a scoped upload URL; object is private and size/type limited.
2. Create `import_batch` stamped with the current importer version; worker identifies the explicit adapter and parses into a versioned intermediate schema.
3. Normalize dates/time zones, airport identifiers, whitespace/case, aircraft registrations, and flight numbers. Preserve raw values, the raw route text, and adapter version.
4. Resolve airports by canonical identifiers and aliases. Ambiguous or unknown locations enter review; never guess silently.
5. Build deterministic fingerprints within one user: date/time precision + ordered **landing** airports + flight number/registration + kind. Source stable IDs and file hashes are stronger signals. Fuzzy matches produce candidates, not automatic deletion.
6. Present new, duplicate, ambiguous, and invalid rows. User decisions are idempotent.
7. Commit accepted rows and provenance in one transaction. Re-imports attach provenance or remain no-ops.
8. Corrections select a canonical airport and append an override audit entry. Future imports may propose the saved alias, but cannot overwrite the user's correction without review.

### Route waypoints are not landings

A `Route` column answers "which airports were on the flight plan", never "where did the pilot land". Two questions, two mechanisms, never conflated:

- **Is this token an airport?** The classifier (`src/lib/import/route-normalization.ts`) tokenizes the raw route, rejects airway/procedure/nav-fix shapes, resolves the remainder through airport aliases, and applies a namespace guard so a token qualifies only when it names the winning airport through an ICAO / FAA-LID / GPS / ident alias. The guard reads the airport's *whole* alias-type set for that code, not the priority winner, so `BFI` (IATA and FAA-LID) qualifies while an IATA-only match such as `OED` (Medford VOR) does not. Every resolver reports that set on every resolved match, and the guard fails closed when the set is empty: "the resolver did not say" is not evidence that a token is an airport. A qualifying token becomes `stop_kind = 'waypoint'`.
- **Did the pilot land there?** Only an explicit source endpoint/landing field, or a deliberate user action, produces `stop_kind = 'landing'`. ForeFlight's landing-count columns are not read at all: they report how many landings a leg had, never where, so they can neither place a stop nor honestly raise a warning (a pattern lesson legitimately logs ten landings against one `From`/`To` pair).

**Scope.** Only the ForeFlight adapter calls the classifier today. Generic/mapped CSV imports keep explicit airport-sequence columns as landings; reclassifying them would change the meaning of already-committed stops with no migration, so extending waypoint classification to another provider is a deliberate migration rather than a new call site.

Unresolved or rejected tokens — including IATA/navaid collisions — survive in the preserved raw route text and raise a row warning; they never invalidate the row and never create an airport marker. The ordered path is deduped at the endpoints and across adjacent repeats, keeps non-adjacent repeats, and is capped at 32 nodes. A token dropped because it restates the leg's own `From`/`To` is recorded as `endpoint-duplicate`, which is a different fact from `adjacent-duplicate`: naming your own endpoints is how routes are written, not a malformed repeat.

Because identity and statistics read landings only, adding, removing, or re-resolving waypoints across thousands of flights can never manufacture or collapse a flight. The private authenticated map draws them: `buildMapPageContract` sends `routePathFlights` — only the flights that actually carry a waypoint — and `FlightGlobe` renders them from two dedicated sources (`flight-map-route-paths`, `flight-map-route-waypoints`) into dedicated layers (`OVERFLOWN_LAYER_IDS`), dashed and hollow, beneath the flown routes. A flight with no `routePath` is absent from that payload and renders exactly the landing-only aggregate it always did. The route and airport sources are untouched, so route strength, mapped-airport counts, and the airport marker's "you have been here" meaning cannot move. **The public share snapshot stays landings-only and renders no waypoints**: `SharedMapView` passes no `routePathFlights`, and the share projection never carried them.

### Import identity and version-aware reprocessing

- `sourceRowKey` hashes a fixed projection of the row's identity fields (date, times, endpoints, flight number, registration, and the source's own verbatim aircraft cell) plus a 1-based occurrence counter within the file. It replaces an ordinal, so neither inserting an unrelated row above a leg nor adding a column nor editing a remark changes that leg's identity. The aircraft term is read from the flight row (ForeFlight's `AircraftID`), never from the display name resolved out of that export's Aircraft Table — projecting the resolved name made an edited type code rewrite the identity of every flight flown in that aircraft.
- Row fingerprint v3 appends `sourceRowKey` **only when the departure time is blank** — exactly the collision class where several same-day legs over the same route previously produced one digest and the unique index silently kept one flight. Timed rows keep a content-only digest, so the same flight logged in two providers still collapses.
- Flights committed under v1/v2 are adopted, not duplicated: dedupe tries the current digest, then `sourceRowKey`, then a superseded fingerprint version. Migration 0018 backfills `flights.fingerprint_version` to 2 for flights with more than two committed stops, matching what the pre-v3 function actually produced.
- `flights.fingerprint_version` always names the algorithm that produced the digest stored beside it. Accepted-duplicate digests are versioned in a reserved range above row-fingerprint versions, so one integer column stays honest for both families and a deliberate second copy can never be read as a superseded row digest.
- A deliberately accepted duplicate (`accept_new`) is a second flight for one source row, so it omits `sourceRowKey` rather than contending for it.
- Batch uniqueness is `(user_id, file_sha256, importer_version)`, and the importer version is stamped when the upload row is created, not when its hash is learned. Re-uploading the same bytes after an importer bump restages them automatically; `POST /api/import/batches/{id}/reprocess` does the same explicitly while the private original is retained, copying the stored object so both batches own their own file. Reprocess idempotency is keyed on the source batch, the importer version, and a recovery generation, so a later importer creates a new result and an expired earlier result does not permanently block one.
- `GET /api/import/attention` is the single definition of the pending-import count, read by the `/map` import-review banner. It performs no cleanup: the retention sweep runs on write paths and its scheduled job, never on a counter read, and a failed read renders nothing rather than degrading the map.
- Commit invariant violations are typed and map to `409`/`422`, never `503`. Conditions that are our own defect stay untyped and surface as `500` with a correlation id.

The included `flightFingerprint` is only the first deterministic seam; production matching needs time-precision semantics and rule versioning.

## Privacy and security

- Private by default; sharing is opt-in and field-aware. Private flights must never appear in public aggregates or metadata.
- Authenticated owner contracts and public shared contracts are separate allowlists. The public DTO (schema v3, with a legacy v2 shape retained at `GET /api/shared/{username}` for callers that omit `?contract=3`) includes canonical airport identifiers, names, cities, countries, facilities, and public reference coordinates plus date, kind, role, aircraft, registration, and per-leg route direction/references for viewer-local filtering. It excludes internal airport/flight/account/session IDs, exact times, notes, source/provenance, and import data. Pre-v2 coarse snapshots require owner republishing and are never converted back into synthetic regions.
- Each Share or Update action covers the complete eligible owner map with no product flight-count ceiling. Owner-scoped stop/airport queries and database-side snapshot membership replacement avoid parameter-list growth; PostgreSQL, function memory/time, and response-size resources fail explicitly rather than producing a partial share. Enabled snapshots do not auto-include newly added/imported flights. Owner-flight and route-stop mutations share canonical UUID-keyed PostgreSQL transaction locks with publication, so an overlapping mutation commits before the complete projection is derived. Any mutation touching a selected flight membership disables the whole share until an explicit Share/Update action, including owner-only field edits; membership rows are retained until that complete-map publish replaces them.
- Account deletion disables normal login, sessions, jobs, and sharing immediately. A proposed grace period uses a verified-email, single-use cancellation flow; cancellation does not revive old sessions or share URLs.
- Never request or retain third-party credentials. Imports use user-provided exports or authorized OAuth/API integrations.
- Hash passwords with Argon2id; OAuth tokens encrypted at rest; secrets server-only; CSRF protection, rate limiting, breached-password screening, secure cookie settings, and email verification/reset.
- Validate files by content and size, parse in an isolated worker, block formulas when re-exporting CSV, malware-scan retained originals, and delete originals after a short configurable window.
- Encrypt storage and transport; redact logs; no raw import rows in telemetry. Maintain access/audit events and tested export/deletion workflows.
- Airport data is shared reference data; flight records, original uploads, import rows, overrides, and derived user aggregates are user-private.

## Deployment and ownership

The repository is created and hosted under **GitHub persona `giffdev` only**
— never `devsin_microsoft` — and is now public. Public visibility means the
source, issue tracker, and Actions run history are readable by anyone;
`DATABASE_URL`, `AUTH_SECRET`, provider credentials, and other runtime
secrets remain Vercel/Railway environment configuration and are never
committed. GitHub secret scanning (with push protection) and Dependabot
security updates are enabled on the repository; `main` requires the `test`
and `validate` status checks before merge. Waypointer has exactly one
collaborator (the repository owner); the production release-approval
workflow in `DEPLOYMENT.md` enforces that both the release requester and the
independent approval resolve to that same owner identity rather than
requiring a second, distinct approver.

Recommended initial production path: Vercel (Next.js) + managed Postgres/PostGIS + private S3-compatible storage + managed queue/worker. Use separate preview and production environments, migrations in CI, encrypted environment variables, backups, region selection, PII-scrubbed monitoring, and cost/retention limits. The architecture remains portable to a container host if worker or geospatial load grows.

Patterns retained from the user's existing local projects are documented in `DEPLOYMENT.md`: explicit Vercel preview/production commands, committed environment placeholders, locked CI installs, and a manual production gate. Their Firebase architecture is intentionally not reused because Waypointer needs relational provenance, deduplication, and geospatial querying.

## Phased backlog

1. **Foundation:** schema/migrations, versioned OurAirports reference ingestion, Auth.js, ownership policies, CI, threat model.
2. **Trustworthy import:** generic CSV contract, ForeFlight adapter, worker, review states, deterministic dedupe, corrections/provenance, fixtures and integration tests.
3. **Map experience:** country/state boundaries, filters, aggregates, accessible 2D/table fallback, performance budgets.
4. **Portability/privacy:** export, deletion, retention jobs, public-share controls, abuse/rate controls, audit review.
5. **Source expansion:** obtain representative Arelplane/myFR24 exports, review terms/APIs, add versioned adapters; only then consider authorized sync.
6. **Polish:** saved views, trips, richer stats, onboarding, observability and load testing.

## Immediate acceptance criteria

- A user can only query their own batches/flights.
- Re-importing the same file is idempotent.
- No ambiguous airport is committed without a user choice.
- Every accepted flight shows provenance, and every correction preserves the source value.
- Upload/auth UI never implies completion until backed by production services.

## Current map performance boundary

MapLibre owns tile, route, airport, and label rendering outside React's render loop. The app submits one route collection and one airport collection, uses native layers rather than one React component per feature, and only synchronizes zoom after interaction ends. All local routes and airports remain represented; zoom-dependent map labels limit visual collisions while the airport selector remains the complete accessible index.

Regional inspection supports overzooming to level 18. MapLibre renders a globe at global scales and transitions toward Mercator around zoom 12; the close view must therefore be described as regional cartography, not literal spherical rendering. Selecting an airport moves to close regional detail and isolates connected routes; an accessible frequency-sorted route selector can fit and highlight one connection at a time. Reciprocal paths receive stable screen-space separation, collision-managed route labels appear at regional zoom, and routes have enlarged invisible hit targets plus a selected-route halo and aggregate-frequency popup. This preserves the complete artifact while reducing the Washington-area bundle without exposing raw flight rows.

The full local artifact has been exercised with trusted drag and wheel input in a common laptop-sized browser viewport. This is pragmatic interaction validation, not a hardware-neutral benchmark. Low-end devices, high-DPI mobile devices, and substantially larger future artifacts do not yet have a formal frame-time budget and require profiling before production launch.

## Cartography providers and graceful fallback

The mockup defaults to OpenFreeMap's Liberty style and its OpenStreetMap/OpenMapTiles-derived vector data, with attribution displayed in-map. It supplies vector place, water, road, POI, landcover, and aeroway context plus Natural Earth shaded relief. OpenFreeMap is keyless and commercially usable with attribution, but offers no SLA and may change or discontinue service. The application therefore retains a neutral local style fallback and a configurable public style URL.

OpenFreeMap's default aerodrome labels emphasize IATA facilities, so Waypointer renders a custom OurAirports overlay for the user's resolved commercial, GA, and small-airstrip endpoints with facility-specific minimum label zooms. OurAirports CSV data is public domain, refreshed nightly, and supplied without an accuracy warranty. The current explicit heuristic is: scheduled large/medium airports are `commercial`; small airports without an IATA code are `airstrip`; all others are `general-aviation`. Runway length/surface are not yet ingested and must be added from the versioned OurAirports runways feed before using runway-based styling. Shipping the entire nightly CSV to browsers is out of scope; broader contextual airport coverage should use preprocessed tiles or bounded server queries.

An optional AWS Open Data Registry Terrarium raster-dem source (elevation-tiles-prod) adds hillshade only while the 3D globe view is active; the flat-map view omits the terrain source entirely, so no terrain attribution is owed there. Its component datasets have source- and region-specific attribution obligations, so a compact, persistent in-map control (collapsed by default, always present alongside the globe while terrain is active) reproduces the full required upstream-provider attribution text verbatim from Tilezen's joerd project (not merely a summary link to it) and links out to the canonical source, rather than presenting a blanket license claim or permanent branded text. The control renders as a DOM sibling of the map region (not a descendant), associated with it via `aria-describedby` so exactly one instance of it ever exists in the accessibility tree; on narrow/mobile viewports it lays out below the map in normal document flow instead of absolutely overlaying it, using the same DOM position and only a different CSS `position` per breakpoint. MapLibre's 3D terrain mesh is deliberately disabled on the main globe because globe/terrain interoperability is not reliable enough for this acceptance path; shaded raster/hillshade preserves relief without flattening the global view. The hillshade is inserted at a stable position — immediately below the bottom-most flight route layer when the route layers already exist, and otherwise below the basemap's first symbol layer — because the relief is opaque enough at regional zooms to wash the routes out if it lands above them. Resolving that position from "the first symbol layer in the current style" is not stable: after a flat → 3D pivot the application's own route-direction symbol layers already exist and sort first, which would silently raise the hillshade above the route lines. A given view mode therefore has identical layer order whether it was loaded directly or reached by pivoting. If elevation fails, the basemap and private route/airport layers continue to work. If the main style cannot be fetched, the neutral local globe still renders those application layers and reports the degraded state.

On-map one-way/bidirectional route direction cues are rendered as small pre-baked raster icons registered via `map.addImage` (see `src/lib/map-icons.ts`), not as Unicode text glyphs (`➤`/`↔`) through the vector-tile glyph/font pipeline. Self-hosted glyph sources are not guaranteed to cover the Arrows/Dingbats Unicode blocks those characters live in, and an uncovered glyph silently falls back to an unrelated substitute rather than failing loudly. The icon geometry is generated with pure analytic math (point-in-triangle rasterization, no canvas/DOM dependency), so it renders identically regardless of glyph coverage and is fully unit-testable in Node/jsdom. The one-way icon is a single rightward-pointing arrowhead auto-oriented along each route's true travel direction by MapLibre's `icon-rotation-alignment: "map"`; the bidirectional icon is deliberately point-symmetric (180°-rotation-invariant) since a "both" route's line geometry may be drawn in either direction. The legend's own Unicode glyphs are unaffected by this change. The same glyph-coverage rule applies to every MapLibre `text-field`: map labels read only arrow-free properties (the selected-route label uses `mapSafeRouteLabel`, which pairs airport codes with a plain ASCII separator), while the arrow-bearing `routeLabel`/`routeTitle`/`directionDetail` strings stay on DOM surfaces — popups, legend and statistics titles — that render with real web fonts. Direction on the map canvas is therefore communicated solely by the raster icons: no standalone `directionCue` feature property remains, and no MapLibre `text-field` layer reads an arrow-bearing property — route features expose `directionMode` for the icon expressions instead. DOM-facing `routeLabel`/`routeTitle`/`directionDetail` feature properties intentionally retain the `➤`/`↔` direction cues so popups, the legend, and statistics titles keep an accessible textual cue alongside the icons.

Airport marker and legend swatch colors share one constant
(`AIRPORT_MARKER_COLORS` in `src/lib/map-style.ts`) so the legend can never
silently drift from the actual on-map `circle-color`/`circle-stroke-color`
paint expression; add any new marker-state color there, not inline in a
component. On the shared/public map, the map canvas and its legend render
before the filters panel in DOM/reading order so keyboard and
screen-reader navigation reaches the map first; this is a one-time
structural position, not a per-breakpoint visual reorder.

`NEXT_PUBLIC_MAP_STYLE_URL` may select another public, CORS-enabled MapLibre style. It is browser-visible and must never carry a secret or paid-provider token. CesiumJS remains a fallback only if photorealistic 3D or 3D Tiles becomes more important than vector-cartography styling; common hosted Cesium imagery/terrain requires tokens and explicit approval. Provider/legal review remains a release gate; this document does not claim Arelplane parity.
