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
  canonical path, timestamps, and the flight count the live shared map
  currently covers (`sharedFlightCount`; `publishedFlightCount` is a
  deprecated duplicate kept for mid-deploy browsers).
- `POST /api/account/sharing` takes no body. It enables sharing for the
  owner's map. Calling it while sharing is already enabled is idempotent.
- `DELETE /api/account/sharing` disables public access.

The Share action is the complete opt-in control. There are no per-flight
sharing controls and no product flight-count ceiling. Changing the username
disables sharing until the owner explicitly enables it again.

Two owner surfaces call this same API: the full management panel on
`/settings` (enable/disable, link, copy), and a lightweight discoverability
popover on `/map` (status, enable, copy/open link) that deep-links to
`/settings#sharing-title` for disable. Neither surface adds a distinct
endpoint or contract, and neither has a republish action: there is nothing to
republish.

## Public read boundary

The public page reads the projection with a bodyless request:

```text
GET /api/shared/{username}
```

A shared map is a **live view of the owner's current eligible map**, not a
stored publication. Each request does two things, in this order:

1. `public_share_owner_by_handle(text)` resolves the username to an owner id,
   and answers at all only for an enabled, unrevoked share on a live account.
   It is a `SECURITY DEFINER` PostgreSQL function with a fixed
   `pg_catalog, public` search path and no `PUBLIC` execute grant; production
   migration provisioning grants execution only to the runtime database role.
2. The projection is derived inside a read-only, owner-scoped transaction
   (`app.current_user_id` set to the resolved owner, so every row-level
   security policy filters to that owner) from three bounded queries: the
   owner's flights, their flight stops, and the airports those rows reference.

The order is the security boundary: an unknown, reserved, disabled, or revoked
handle fails at step 1 and never reaches a row. Because step 2 reads current
rows, a flight imported, edited, enriched with route waypoints, or deleted a
moment ago is reflected on the next request — no republish, and the share URL
never changes.

`map_shares.projection` still exists and is still written when sharing is
enabled, but only so a rolled-back build has something to serve. It is never
read by this path and is not a fallback: a failure to derive the live map is a
`503`, never a stale map presented as current.

The endpoint defaults to the frozen schema-v2 projection for backward
compatibility. Callers that need per-leg route direction must request
`?contract=3`; callers that need route-waypoint path geometry must request
`?contract=4`, which is what the bundled shared-map page uses. All three
variants return the same public-safe whole-map projection:

- aggregate flight and route counts;
- routes carry `id`, `kind`, `flightCount`, both canonical airports, and (v3
  and v4) `forwardFlightCount`/`reverseFlightCount` plus a route-level
  `directionMode`;
- each airport's preferred public identifier (IATA, local, ICAO, then source
  identifier — with unscheduled small airports preferring their local/FAA code,
  so Bandon State reads as `S05` rather than `BDY`), name, city, country,
  facility type, and reference coordinates;
- the minimum per-flight facts needed for viewer-local filtering: calendar
  date, commercial/private kind, passenger/pilot role, normalized aircraft
  labels, registration/tail number when present, and route references — v2
  exposes a flat `routeIds` array per flight, v3 and v4 expose ordered
  `routeLegs: { routeId, direction }` entries, and v4 alone may carry an
  ordered presentation-only `routePath`.

The default view includes all shared flights. Role, date-range, aircraft,
and registration filters run only in the viewer and never mutate owner data;
statistics are recomputed from the filtered projection. The projection has no
product flight-count ceiling. Rendering and initial framing use bounded,
linear-time aggregation without truncating the shared dataset.

The response does not contain flight IDs, airport database IDs, duration,
exact times, notes, source/provenance data, import fields, email, session or
authentication data, or internal account identifiers. Airport display codes
are labels rather than identities, and are read from the live airport catalog
on every request: an identifier correction shipped by an airport catalog
release (`npm run db:airport-release`) appears on the next read with no owner
action. Coordinate-based identities keep distinct airports with the same code
separate.

An owner who deletes every eligible flight while sharing is enabled serves an
empty map, not an error: a live view of an empty logbook is empty. Enabling
sharing on an empty map is still refused (`409 sharing-map-empty`).

Responses use
`Cache-Control: no-store, max-age=0, s-maxage=0, must-revalidate`, which is
what keeps the view live as well as revocable — a cached copy would be exactly
the frozen view this contract removed. Unknown, disabled, reserved,
UUID-shaped, and malformed usernames return the same generic `404 not-found`.
The viewer revalidates on focus, visibility restoration, `pageshow`, and a
30-second interval, so an open page picks up both new flights and a disabled
share.
