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
published core fields are present.

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
