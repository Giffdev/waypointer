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
  current map and enables sharing.
- `DELETE /api/account/sharing` disables public access.

The Share action is the complete opt-in control. There are no per-flight
sharing controls and no product flight-count ceiling. Re-enabling republishes
the entire current map at the same username URL. Changing the username
disables sharing until the owner explicitly enables it again.

## Public read boundary

The public page reads the projection with a bodyless request:

```text
GET /api/shared/{username}
```

`public_map_projection_by_handle(text)` is a `SECURITY DEFINER` PostgreSQL
function with a fixed `pg_catalog, public` search path and no `PUBLIC` execute
grant. Production migration provisioning grants execution only to the runtime
database role.

The response contains aggregate flight and route counts plus coarse routes:
route ID, flight kind, aggregate count, country, and coordinates rounded to
one decimal degree. It does not contain per-flight records, dates, duration,
exact airports, aircraft, registration, source, provenance, raw import fields,
email, or internal account identifiers.

Responses use
`Cache-Control: no-store, max-age=0, s-maxage=0, must-revalidate`. Unknown,
disabled, reserved, UUID-shaped, and malformed usernames return the same
generic `404 not-found`. The viewer revalidates on focus, visibility
restoration, and `pageshow` so disabling sharing clears an open public map.
