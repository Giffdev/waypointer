# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Map-page Share control: a lightweight "Share map" popover on `/map` shows
  sharing status, enables sharing, and copies/opens the public link, and
  deep-links to `/settings#sharing-title` for full management
  (disable/republish). (#44)

### Fixed
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
