# Read-only map sharing API

Owner routes require the normal authenticated session and same-origin writes:

- `GET /api/account/sharing` — returns enabled state, identity choice, selected
  flight count/IDs, and the capability path when enabled
- `POST /api/account/sharing/preview` with `{ flightIds, includeDisplayName }`
  — returns the exact coarse projection and a selection-bound `previewId`
- `POST /api/account/sharing` with
  `{ flightIds, includeDisplayName, previewId }` — publishes only that reviewed
  snapshot; stale previews are rejected
- `DELETE /api/account/sharing` — revokes public access immediately
- `POST /api/account/sharing/regenerate` — rotates the capability without
  changing the snapshotted selection

Selections are capped at 500 parent flights. New flights are never added
automatically. Editing or deleting a selected flight revokes the share.
Identity remains hidden unless separately opted in.

The owner UI renders `sharePath` as `/shared/[publicId]#key=[secret]`. The
shared page reads the fragment locally and loads:

- `POST /api/shared/[publicId]` with `{ key }` — unauthenticated, read-only
  `{ map: { owner, summary, routes, flights } }`

The public response contains only a display name, counts, flight kind, aggregate
route counts, countries, and coordinates rounded to one decimal degree. It
includes one opaque parent entry per selected flight with its ordered coarse
legs, but no dates, duration, departure time, aircraft, registration, source,
provenance, or raw import fields. `summary.flightCount` counts parents while
`routes` aggregates all projected legs. It contains no raw user, flight,
airport, import, authentication, or source identifiers.
Responses are `no-store`; disabled, rotated, malformed, and unknown links return
the same `404 not-found`. The public API has no write method.
