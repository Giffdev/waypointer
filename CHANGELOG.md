# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Route waypoints (persistence and data contract; no UI in this change): a
  ForeFlight `Route` column is now parsed into an ordered path of *waypoints*
  alongside the flight's landings and persisted as
  `flight_stops.stop_kind = 'waypoint'`. A flight exposes them through the new
  presentation-only `routePath`; nothing renders them yet. Waypoints are never
  treated as landings — `airportSequence`, unique-airport counts, landing
  counts, dedupe identity, and the public share contract all stay
  landings-only, so adding waypoints to an existing logbook cannot move a
  single statistic. Token acceptance is deliberately narrow: airway,
  procedure, and nav-fix shapes are rejected, and a token must name the
  airport through an ICAO/FAA-LID/GPS/ident alias (an IATA-only match is not
  enough). Unresolved and rejected tokens stay in the preserved raw route text
  and raise a row warning instead of invalidating the row. Generic/mapped CSV
  imports are unchanged: their multi-airport columns remain explicit landings.
- `GET /api/import/attention`: a read-only pending-import count endpoint for
  future badge surfaces to consume. No surface reads it yet.
- `POST /api/import/batches/{batchId}/reprocess`: explicitly restage a batch
  under the current importer version while its private original is still
  retained. The original object is copied, not moved, so the source batch
  keeps its own file; repeat calls return the batch the first call created.
  Expired uploads can simply be uploaded again.
- Map-page Share control: a lightweight "Share map" popover on `/map` shows
  sharing status, enables sharing, and copies/opens the public link, and
  deep-links to `/settings#sharing-title` for full management
  (disable/republish). (#44)

### Fixed
- Repeated legs with a blank departure time no longer collapse into one
  flight. Two same-day legs over the same route with no `TimeOut` produced an
  identical fingerprint, the unique index on `(user_id, fingerprint)` enforced
  the collapse physically, and the extra flights disappeared with no
  user-visible notice. Row fingerprint v3 appends a stable `sourceRowKey` when
  — and only when — the departure time is blank, so distinct source rows stay
  distinct while a timed flight logged in two providers still collapses.
- Import identity survives a re-export that inserts rows or adds columns. The
  previous source row key was an ordinal (`adapterVersion:rowNumber`), so
  adding one unrelated row at the top of a logbook export made every row below
  it look new. The key is now derived from a fixed projection of the row's
  identity fields — date, times, endpoints, flight number, registration,
  aircraft — plus an occurrence counter within the file, so an added column or
  an edited remark no longer changes which flight a row is.
- Re-importing after a pipeline fix now actually reprocesses. Batch reuse was
  keyed on the file hash alone, so the same bytes staged by an older importer
  were returned forever and a deployed fix could never reach the data it
  fixed. Batch identity now includes the importer version. Successful
  same-version reuse is unchanged, and flights committed under an older
  fingerprint version are *adopted* rather than duplicated.
- Corrections no longer leave the canonical route stale. Correcting an airport
  patched only the derived `origin`/`destination`/`airportMatches` projection
  and left `routeNodes` untouched, so the row committed its original airport,
  stopped matching its own fingerprint, and re-imports of the same file created
  duplicates. The same bug in post-catalog-refresh reconciliation meant a row
  that became resolvable never became committable.
- Commit invariant violations are typed and map to `409`/`422` instead of a
  generic `503`. Silently dropping unresolved airports from a committing route
  is replaced by an assertive committable-route invariant, so a dropped middle
  stop can no longer commit as a shorter flight.
- The import format detector no longer stops after 256 physical lines, and no
  longer discards everything it read when a file turns out to be malformed. A
  ForeFlight export with a large Aircraft Table — or any quoted field
  containing newlines — pushed the `Flights Table` marker out of the scan
  window and the file was rejected as unrecognised; a single stray quote
  anywhere did the same, because the reader threw and detection fell back to
  zero records. The scan is now record-aware, bounded, and lenient: it keeps
  everything read before a fault and reports "we stopped reading" rather than
  "this format is unsupported". The import path still parses strictly, so a
  malformed file fails loudly instead of importing short.
- Import invariant errors no longer log a bare error name. Unexpected failures
  now log a correlation id and the stack frames — never the message, which
  routinely quotes an airport, a registration, or a whole CSV cell.
- Multi-stop import recovery: re-importing a logbook that contains a
  multi-stop day no longer fails the whole batch. Duplicate assessment loaded
  the airport catalog from a flight's origin and destination only, so any
  stored flight with an intermediate stop (for example `S05 → KRBG → S05`)
  threw while candidates were being built, the batch was marked
  `processing-failed`, and nothing was committed — which is why a missing
  Roseburg leg stayed missing. Stops are now read before the catalog query and
  every stop airport is loaded, matching the flight list. A stored flight whose
  airport metadata still cannot be rendered no longer breaks the import: it
  falls back to exact-fingerprint duplicate matching, so no route is invented
  and no duplicate flight can be created.
- Retrying an identical failed upload: a file that failed to process kept
  owning its content hash, so re-uploading the same bytes returned the failed
  batch instead of staging a new one and the user could never recover without
  editing the file. Failed and cancelled batches are no longer reusable — they
  are scrubbed, expired and their private upload is deleted — while successful
  and committed imports are still deduplicated exactly as before. If deleting
  the superseded upload fails, the batch stays in the retention sweep and the
  deletion is retried rather than being silently orphaned.
- Airport display codes: unscheduled small airports now prefer their local/FAA
  identifier over a stale IATA code, so Bandon State (`KS05`) displays and
  canonicalizes as `S05` instead of `BDY`, while every alias (`BDY`, `S05`,
  `KS05`) stays resolvable on import and search. The rule is decided once when
  the airport catalog is built, gated on the OurAirports facility type, an
  explicit `scheduled_service = false`, and a local code that is genuinely a
  different identifier from both the IATA code and the source ident — so
  scheduled, medium, large, heliport, seaplane and closed facilities keep their
  published IATA codes, as do fields whose ident *is* their IATA code. Against
  the pinned OurAirports snapshot this demotes 648 small airports and no medium
  or large airport; a rule gated on `scheduled_service` alone would also demote
  large airports such as Phnom Penh (`PNH`), Odesa (`ODS`), Ulaanbaatar
  (`ULN`), İstanbul Atatürk (`ISL`) and Western Sydney (`WSI`), all of which
  are marked `scheduled_service = "no"` upstream. Import canonicalization and
  the public map selector share one policy module, and already-published maps
  are relabelled at read time — no republish and no snapshot rewrite. Merging
  this change does not by itself alter any displayed code in production: the
  new labels appear only after an approved airport catalog release re-seeds
  `airports.iata`, and the read-time relabel fails open to the stored published
  labels if the catalog lookup is unavailable.
- Import duplicate detection: same-day flights on the same tail are no longer
  flagged as duplicates when they fly different routes. Route agreement is now
  a hard gate rather than one signal among several, so a multi-leg day (for
  example `S05 → KRBG → …`) commits every leg. Genuine same-route re-imports
  are still detected, reversed routes and differing leg counts are explicitly
  not duplicates, and routes with fewer than two resolved stops never match.
- Release workflow restored to owner-only: the production release-approval
  workflow's distinct-second-approver check (introduced in error) is
  replaced with a check that both the requester and the independent
  approval resolve to the single repository-owner identity, matching
  Waypointer's solo-maintainer model. (#37)
- Mobile CSV import: `application/vnd.ms-excel` and blank-content-type CSV
  uploads (as reported by iOS Safari and some Android file pickers) are now
  accepted end-to-end — the client preview gate, synchronous upload route,
  and durable presigned-upload flow now share one MIME allowlist instead of
  three independently drifting ones — and the Android/Chrome document
  picker's `accept` attribute now advertises every trusted CSV MIME type
  instead of only the `.csv` extension, so valid files are no longer greyed
  out. (#39, #41)
- MyFlightbook CSV import: added a shared, hardened byte-decoder supporting
  UTF-8-with-BOM, BOM-only UTF-16, and a Windows-1252 fallback (the common
  result of Excel re-saving a MyFlightbook export), plus quote-aware
  comma/semicolon delimiter auto-detection and MyFlightbook's `Route`-only
  column export, which was previously broken. Also fixed a MIME-allowlist
  drift in the durable import worker. (#45)
- Shared-map airport legend now sources its "flown airport" swatch color
  from the same constant used by the map's own marker paint so the two can
  never silently drift apart; the shared-map canvas and legend now render
  before the filters panel in DOM/reading order for correct keyboard and
  screen-reader flow. (#40)
- Terrain-data-credits control now renders outside the map region and lays
  out in normal document flow below the map on mobile instead of overlaying
  it (previously could be clipped or hidden on small screens), while
  staying associated with the map via `aria-describedby` on every
  viewport. (#43)
- Mobile primary navigation no longer wraps onto two lines. (#42)
- Map-page Share popover no longer overflows narrow viewports; the URL
  field and Copy link button are contained within the popup. (#46)

## [0.1.0] - 2026-09-01

Initial tagged release of Waypointer (flight-map), covering all work merged to
`main` to date.

### Added
- Flight import from ForeFlight and MyFlightRadar24, with durable/background
  import processing and airport-catalog resolution.
- Firebase-backed authentication with sign-in/sign-out flows.
- Public/shared map viewing with viewer filters and public-route safeguards.
- Vercel production release tooling: release candidate preparation, health
  checks, rollback verification, and a two-stage production deploy workflow
  requiring a separate approval step before deployment. (Fixed in
  `[Unreleased]` (#37): as originally shipped, this required a distinct
  approver identity different from the requester, which is impossible for
  Waypointer's single-maintainer/single-collaborator repository; the
  approval check now requires the repository-owner identity instead.)

### Fixed
- Shared-map 3D/flat view toggle: flat mode now fully removes DEM terrain
  source and terrain attribution credits; 3D mode shows compact, exact
  11-provider joerd credits without stray Mapzen Terrarium branding.
- Direction indicators on shared maps now use geometry-based icons instead of
  unsupported Unicode glyphs, with map-safe text for selected labels.
- Shaded-relief terrain now stays reliably ordered below route lines across
  every 3D entry path.
- Terrain teardown failures now fail safe (attribution is retained rather than
  silently lost), and direction-icon registration failures now fail visibly
  instead of degrading silently. (#35)
