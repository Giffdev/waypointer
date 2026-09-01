# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-01

Initial tagged release of Waypointer (flight-map), covering all work merged to
`main` to date.

### Added
- Flight import from ForeFlight and MyFlightRadar24, with durable/background
  import processing and airport-catalog resolution.
- Firebase-backed authentication with sign-in/sign-out flows.
- Public/shared map viewing with viewer filters and public-route safeguards.
- Vercel production release tooling: release candidate preparation, health
  checks, rollback verification, and independently-approved two-person
  production deploy workflow.

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
