# Public map sharing API

Waypointer publishes one intentionally public, enumerable URL per enabled
account:

```text
/{username}
```

There is no GUID, token, secret, fragment, query parameter, or legacy public
route. The account username is visible in the URL. Email is never used as a
fallback or exposed by map sharing.

## Owner lifecycle

Owner routes require an authenticated session, and writes require same-origin
requests:

- `GET /api/account/sharing` returns the enabled state, public username,
  canonical path, timestamps, and published flight count.
- `POST /api/account/sharing` takes no body. It publishes the owner's entire
  current map and enables sharing. Calling it while sharing is enabled
  atomically republishes the current map.
- `DELETE /api/account/sharing` disables public access.

The Share action is the complete opt-in control. There are no per-flight
sharing controls and no product flight-count ceiling. Re-enabling republishes
the entire current map at the same username URL. Changing the username
disables sharing until the owner explicitly enables it again.

Two owner surfaces call this same API: the full management panel on
`/settings` (enable/disable, link, copy), and a lightweight discoverability
popover on `/map` (status, enable, copy/open link) that deep-links to
`/settings#sharing-title` for disable/republish. Neither surface adds a
distinct endpoint or contract.

## Public read boundary

The public page reads the projection with a bodyless request:

```text
GET /api/shared/{username}
```

`public_map_projection_by_handle(text)` is a `SECURITY DEFINER` PostgreSQL
function with a fixed `pg_catalog, public` search path and no `PUBLIC` execute
grant. Production migration provisioning grants execution only to the runtime
database role.

The endpoint defaults to the frozen schema-v2 projection for backward
compatibility. Callers that need per-leg route direction (geometry-based
direction icons, reciprocal-route labeling) must request
`GET /api/shared/{username}?contract=3`; the bundled shared-map page always
uses `?contract=3`. Both variants return the same public-safe whole-map
projection:

- aggregate flight and route counts;
- routes carry `id`, `kind`, `flightCount`, both canonical airports, and (v3
  only) `forwardFlightCount`/`reverseFlightCount` plus a route-level
  `directionMode`;
- each airport's preferred public identifier (IATA, local, ICAO, then source
  identifier — with unscheduled small airports preferring their local/FAA code,
  so Bandon State publishes as `S05` rather than `BDY`), name, city, country,
  facility type, and reference coordinates;
- the minimum per-flight facts needed for viewer-local filtering: calendar
  date, commercial/private kind, passenger/pilot role, normalized aircraft
  labels, registration/tail number when present, and route references — v2
  exposes a flat `routeIds` array per flight, v3 exposes ordered
  `routeLegs: { routeId, direction }` entries so multi-stop direction (e.g.
  a reciprocal leg on the same route) can be rendered per leg instead of only
  per route.

The default view includes all published flights. Role, date-range, aircraft,
and registration filters run only in the viewer and never mutate owner data;
statistics are recomputed from the filtered projection. The projection has no
product flight-count ceiling. Rendering and initial framing use bounded,
linear-time aggregation without truncating the published dataset.

The response does not contain flight IDs, airport database IDs, duration,
exact times, notes, source/provenance data, import fields, email, session or
authentication data, or internal account identifiers. Airport display codes
are labels rather than identities; coordinate-based identities keep distinct
airports with the same code separate.

Because display codes are labels, the public read re-derives them from the
live airport catalog instead of trusting the frozen snapshot. An airport is
relabelled only when exactly one catalog airport carries the published code as
an identifier alias at the published coordinates; unknown, moved, or ambiguous
airports keep whatever label was published. The refresh is cosmetic and fails
open: if the catalog lookup errors, the map is still served with its stored
published labels rather than returning `503 shared-map-unavailable`.
Already-published maps therefore pick up identifier corrections on the next
read — no republish, no snapshot rewrite, and no change to the stored schema
version, so the v2 rollback view stays valid. Corrections land only once an
airport catalog release (`npm run db:airport-release`) rewrites the affected
`airports.iata` values; until then the catalog still carries the old code and
every map keeps its current label.

Pre-v2 snapshots are not reconstructed into synthetic `R<number>` regions.
They return `409 republish-required` until the owner uses the authenticated
Share/Republish action.

Responses use
`Cache-Control: no-store, max-age=0, s-maxage=0, must-revalidate`. Unknown,
disabled, reserved, UUID-shaped, and malformed usernames return the same
generic `404 not-found`. The viewer revalidates on focus, visibility
restoration, and `pageshow` so disabling sharing clears an open public map.
