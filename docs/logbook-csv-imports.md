# Digital logbook CSV imports

Waypointer supports three import capabilities:

1. **Automatic adapters:** ForeFlight Logbook and myFlightradar24 Flight Diary.
2. **Evidence-backed mapping presets:** MyFlightbook and CrewLounge PILOTLOG.
3. **Generic mapped CSV:** any conventional CSV with a header row. Waypointer
   maps the required date, origin, and destination columns automatically when
   the header match is unambiguous; otherwise the user maps them once.

The explicit mapping preview appears only when required columns or formats
cannot be inferred safely. A mapping exists only for the current import unless
a future, explicitly consented feature is added; it is not saved globally.

Mapped imports use the same owner-scoped airport resolution, staged correction,
duplicate review, commit, provenance, file-size limits, idempotency, and raw-row
scrubbing as automatic imports. Resolved new rows are committed immediately,
exact duplicates are skipped, and a fully resolved upload returns to the map.
Partial imports show only unresolved rows and state how many rows were already
imported. Presets and inferred mappings never bypass server-side validation.

An upload is only redirected away when nothing is left to decide. If any row is
unresolved, an ambiguous duplicate, or carrying an unresolved route token, it
stays outstanding, and the count is published read-only at
`GET /api/import/attention` for badge surfaces to consume. No surface consumes
it yet; it ships ahead of the UI so the numbers have one definition when they
do.

## Route columns become waypoints, never landings

The **ForeFlight adapter only** reads the `Route` header. Route tokens become
ordered *waypoints*: they are persisted as `flight_stops.stop_kind = 'waypoint'`
and exposed on a flight as the presentation-only `routePath`. They never count
as a landing, never change `airportSequence`, and never affect unique-airport,
route, or landing statistics, and they are excluded from the public share
contract. Only an explicit endpoint/landing column, or a deliberate user
action, creates a landing.

Generic and mapped CSV imports are deliberately **not** routed through this
classifier. Their multi-airport columns are explicit airport-sequence fields
and continue to produce landings exactly as before; reclassifying them would
change the meaning of stops already committed, and therefore statistics and
shares, with no migration and no preview. Extending waypoint classification to
another provider is a separate, deliberate migration.

Token acceptance is deliberately narrow:

- airway, procedure, and nav-fix shapes are rejected before resolution;
- a token must name its airport through an ICAO, FAA-LID, GPS, or ident alias.
  The whole alias-type set for the winning airport is considered, not just the
  highest-priority one, so `BFI` (IATA *and* FAA-LID for Boeing Field) is
  accepted while an IATA-only match such as `OED` — the Medford VOR — is not.
  A match that reports no namespaces at all is refused, not assumed;
- endpoints and adjacent repeats are deduped, non-adjacent repeats are kept,
  and the path is capped at 32 nodes.

Anything not accepted stays in the preserved raw route text and produces a row
warning, including a rejected IATA/navaid collision. It never invalidates the
row and never places an airport marker.

ForeFlight's landing-count columns (`AllLandings`, `DayLandingsFullStop`,
`NightLandingsFullStop`) are not read. They report how many landings a leg had,
never where, so they cannot place a stop without guessing — and they cannot
honestly drive a warning either, because a lesson flown in the pattern
legitimately logs ten landings against a single `From`/`To` pair.

## Re-importing after an importer fix

Batch identity includes the importer pipeline version, so re-uploading the same
file after a pipeline fix restages it under the new version instead of
returning the old result. Already-committed flights are still recognised — the
row's `sourceRowKey`, or an older fingerprint version, adopts the existing
flight rather than creating a second one. While the private original is still
retained, `POST /api/import/batches/{batchId}/reprocess` performs the same
restage without a re-upload; it copies the stored file so the original batch
keeps its own, and repeat calls return the batch the first call created. That
idempotency is scoped to the source batch *and* the importer version, so a
later importer fix produces a new result rather than handing back the previous
one, and a result that has since expired does not leave the batch permanently
un-reprocessable. Once the retention window has expired the file can simply be
uploaded again.

## Presets

### MyFlightbook CSV

The preset recognizes the exact published core names `Date`, `Tail Number`,
`Model`, `Total Flight Time`, `From`, and `To`. MyFlightbook documents `Date`,
`Tail Number`, and `Total Flight Time` as required and explicitly documents
`From` plus `To` as an alternative to `Route`.

Evidence:
[MyFlightbook public import field description](https://github.com/ericberman/MyFlightbookWeb/blob/master/MyFlightbook.Web/App_GlobalResources/Content.en/ImportTableDescription.txt)
(retrieved 2026-08-13).

Exports containing MyFlightbook's documented `Route` field can map it as an
ordered airport sequence. Route-only MyFlightbook files are detected when the
published core fields are present, and mapping no longer requires a `From`/`To`
pair that a Route-only export never has.

Real MyFlightbook exports are UTF-8-with-BOM, quote-all, CRLF, and use a
locale-dependent list separator (comma in en-US, semicolon in many other
locales). A shared decoder (`src/lib/import/csv-decode.ts`) used by every
upload path (client preview, synchronous upload, durable worker) accepts
UTF-8 (with or without BOM), UTF-16 (BOM-only), and — only when there is no
UTF-8 BOM and strict UTF-8 decoding fails — a Windows-1252 fallback, which
covers the common case of Excel re-saving a MyFlightbook export and
corrupting its encoding. Binary signatures (Office/ZIP, OLE, PDF, images) are
rejected before any text decoding is attempted. Comma-as-decimal-separator
locales (e.g. `1,5` meaning 1.5 hours) are not handled; duration parsing
still requires `.` decimals. Delimiter detection (comma vs. semicolon) is
quote-aware and scoped to the first CSV record.

### CrewLounge PILOTLOG compatible CSV

The preset recognizes CrewLounge's published names `PILOTLOG_DATE`, `AF_DEP`,
`AF_ARR`, `TIME_TOTAL`, `AC_MODEL`, and `AC_REG`, with optional suggestions for
`TIME_DEP`, `FLIGHTNUMBER`, and `OPERATOR`.

Evidence:
[CrewLounge PILOTLOG import wizard header reference](https://support.crewlounge.aero/support/solutions/articles/24000034487-import-flight-records-from-another-logbook-or-my-excel-sheet)
(retrieved 2026-08-13).

Limitation: PILOTLOG accepts many date/time conventions. Files that do not
match the preset's documented convention require explicit mapping rather than
guessing ambiguous dates or durations.

## Generic mapping rather than brittle presets

Waypointer does not ship fixed presets for these sources because the public
documentation either describes an interactive mapper or points to a
downloadable/account-specific template rather than publishing one stable
export header:

- **Garmin Pilot / flyGarmin:** Garmin directs users to its current CSV
  template on the logbook import page.
  [Garmin support](https://support.garmin.com/en-US/?faq=SvuO7yT2Xo1g2RU4St75i5)
- **Logbook Pro:** its documented Import Wizard accepts comma- or tab-delimited
  files and lets users assign source columns to destination fields.
  [NC Software documentation](https://docs.nc-software.com/display/LPDOCS/Import+Wizard)
- **Safelog:** its template can vary with the fields enabled in an individual
  account, so a universal header would be unsafe to infer.
  [Safelog helpdesk](https://www.dauntless-soft.com/helpdesk/Knowledgebase/Article/View/172/46/importing-from-a-csv-tsv-or-text-file)
- **LogTen Pro:** no stable, current public export sample was found during this
  implementation. Its CSV can still use explicit generic mapping, but Flight
  Map does not claim an automatic adapter or preset.

These formats are accepted only when the uploaded file is a valid CSV and the
required mapping is either inferred unambiguously or supplied explicitly.
Waypointer does not implement proprietary database, backup, PDF, XLS/XLSX, or
cloud-account formats.

## Generic mapping limits

- Maximum upload size remains 10 MB unless the deployment lowers it.
- Accepted CSV content types are centralized in
  `src/lib/import/csv-mime.ts` (`text/csv`, `text/plain`,
  `application/vnd.ms-excel`, `application/octet-stream`) and shared by the
  client preview gate, the synchronous upload route, and the durable
  presigned-upload flow so the three allowlists cannot drift; the file-picker
  `accept` attribute advertises the same set (plus the `.csv` extension) so
  mobile document pickers that report non-`text/csv` MIME types (iOS Safari's
  `application/vnd.ms-excel`, some Android providers) are not greyed out.
- The first non-empty record must be a unique header row, with at most 128
  columns.
- Date formats are explicit: ISO `YYYY-MM-DD`, `YYYYMMDD`, month/day/year, or
  day/month/year.
- Airport values must be IATA, ICAO, FAA/local identifiers. A mapped `Route`,
  `Stops`, or `Airport Sequence` column accepts 2+ ordered identifiers separated
  by whitespace, `>`, `->`, `→`, comma, semicolon, or `|`. Adjacent duplicate
  stops and route/origin/destination endpoint conflicts are rejected.
- ForeFlight `From`/`To`, CrewLounge `AF_DEP`/`AF_ARR`, and
  myFlightradar24 `From`/`To` remain two-airport imports. Waypointer does not
  reinterpret ForeFlight navigation-route text as landed stops.
- Duration supports decimal hours, `H:MM`, or minutes. Distance supports miles
  or nautical miles.
- Notes, comments, passenger names, crew names, and unmapped fields are never
  copied into the canonical proposal. Raw rows exist only during review and
  are scrubbed atomically on commit.
