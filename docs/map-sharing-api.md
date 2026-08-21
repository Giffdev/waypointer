# Read-only map sharing API

Owner routes require the normal authenticated session and same-origin writes:

- `GET /api/account/sharing` — returns enabled state, identity choice, published
  flight count, and the current capability path when enabled. The settings UI
  treats a pending or failed response as unknown; it never reports sharing as
  off unless this request succeeds with `enabled: false`.
- `POST /api/account/sharing/preview` with `{ includeDisplayName }` — derives
  every flight currently owned by the account in the database transaction and
  returns the exact coarse projection plus a snapshot-bound `previewId`. The
  settings click opens a blank same-origin tab synchronously before this request
  starts. On success, the browser writes only the coarse projection to that
  tab's session storage and navigates it to `/shared/preview`; the preview route
  consumes the tab-local projection without publishing it or creating a
  capability. A blocked tab is reported explicitly, and a failed request closes
  the blank tab.
- `POST /api/account/sharing` with
  `{ includeDisplayName, previewId }` — rederives the complete flight set and
  publishes only when it still matches the reviewed snapshot; stale previews
  are rejected with `409 sharing-preview-stale`
- `DELETE /api/account/sharing` — prevents subsequent public loads; it cannot
  recall a response that a viewer already opened, copied, forwarded, or
  screenshotted
- `POST /api/account/sharing/regenerate` — rotates the capability without
  changing the published snapshot

Callers cannot submit flight IDs, subsets, exclusions, or an empty selection.
There is no product flight-count ceiling: the server reads every eligible
parent flight and either returns and publishes the complete aggregate or fails
the request without changing the existing snapshot. If the authoritative set
changes after preview, including a move from 500 to 501, enablement fails as
stale and requires another review; an existing enabled snapshot remains
available. Owner stops and referenced airports are selected by owner-scoped
queries rather than expanding flight IDs into request parameters, and
membership is replaced with one database-side `INSERT ... SELECT`. Large maps
therefore remain bounded by PostgreSQL, function memory/time, and response-size
resources instead of an arbitrary flight count; operational exhaustion returns
the normal no-store `503 account-service-unavailable` response and never a
partial or truncated map.
Flight and route-stop inserts, updates, and deletes acquire the same
owner-keyed PostgreSQL transaction lock as enablement. Enablement takes that
lock before rederiving the snapshot, so an overlapping committed mutation is
either included in the comparison or occurs after publication; a stale enable
cannot overwrite mutation-triggered revocation.

Publishing is snapshot-based: flights added after enablement remain private
until the owner requests an update, whose preview again includes every current
flight automatically. Any update or delete of a published flight, and any
insert, update, or delete of a route stop attached to a published membership,
conservatively disables the entire share. This applies even when the edited
field is owner-only. The mutation does not remove one flight or mark it pending:
the `map_share_flights` membership rows remain as the disabled snapshot record
until the next successful publish replaces them. Direct account identifiers are
omitted and the display name remains omitted unless separately opted in.
One-decimal coordinates and aggregated routes can still reveal recognizable
endpoints, routines, employers, or identity, so the preview and confirmation
warn about re-identification and downstream copying.

The capability remains stable for updates while sharing is continuously
enabled. Rotation creates a new key generation. Disablement is permanent for
that capability: re-enabling creates a new public ID and key generation, so the
old URL continues to return `404 not-found`. The key is derived server-side
from the public ID, generation, and sharing secret, while only its digest is
stored in `map_shares`; consequently an authenticated status request can return
the active `sharePath` on every successful load.

The owner UI renders `sharePath` as `/shared/[publicId]#key=[secret]`. The
shared page reads the fragment locally and loads:

- `POST /api/shared/[publicId]` with `{ key }` — unauthenticated, read-only
  `{ map: { owner, summary, routes } }`

The public response contains only an optional owner display name, aggregate
flight/route counts, and coarse aggregate routes: route ID, flight kind,
aggregate count, country, and coordinates rounded to one decimal degree. It has
no per-flight DTO and no dates, duration, departure time, exact airports,
aircraft, registration, source, provenance, raw import fields, or private
account identifiers. `summary.flightCount` counts snapshotted parent flights
while `routes` aggregates their projected legs.

The owner UI distinguishes the reviewed pre-publish preview from the enabled
map. “Preview shared map” or “Preview map update” opens the tab-local reviewed
snapshot and does not change sharing. When sharing is already enabled, “Preview
live shared map” opens the current `sharePath`; its capability stays in the URL
fragment and the shared page retains the no-referrer policy.

Responses use the exact
`Cache-Control: no-store, max-age=0, s-maxage=0, must-revalidate` header;
disabled, rotated, malformed, and unknown links return the same
`404 not-found`. The shared viewer keeps the fragment key only in memory and
revalidates with the same POST when the window regains focus, the document
becomes visible, or a browser-history page is restored through `pageshow`.
Generic `404 not-found` revalidation clears the rendered projection. A network
or service failure also hides stale content but reports only temporary
unavailability, not revocation. The public API has no write method.
