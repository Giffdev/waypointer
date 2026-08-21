# Multi-user accounts and sharing

**Status:** Current implementation reference
**Product owner:** Devin Sinha
**Revision owner:** Zoe
**Last updated:** 2026-08-21

## Executive summary

Waypointer provides authenticated, owner-isolated accounts and an optional
public map. Each account owns its flights, imports, profile, and settings.
Private account data is addressed internally by an immutable user identity;
the username is a public-facing route name and never the authorization
boundary for owner operations.

Sharing has one deliberately simple contract:

- The public route is `/{username}`.
- The route contains no additional secret or opaque identifier.
- Sharing publishes the owner's complete eligible map without a flight limit.
- Owners cannot choose individual flights or publish a partial map.
- Account settings present one toggle whose states are **Share my map** and
  **Disable sharing**.
- Enabling sharing makes the page intentionally public to anyone who knows or
  discovers the username.
- Disabling sharing makes the public route unavailable.

[`map-sharing-api.md`](map-sharing-api.md) is the endpoint-level reference for
this contract.

## Current system

- Next.js 16 App Router, TypeScript, and React 19 provide the web application.
- MapLibre GL JS renders owner and public maps.
- PostgreSQL, PostGIS, Drizzle ORM, and Auth.js back account and sharing data.
- Vitest covers domain and component behavior.
- Playwright covers public-handle behavior on desktop and mobile Chrome.

## Account identity and ownership

### Identity rules

- Every account has an immutable server-generated user ID.
- Every account has one unique normalized username.
- User IDs own database rows; usernames do not.
- Email addresses and provider identities never appear in public map URLs.
- Authentication provider identity is separate from profile identity.
- Provider email matching alone does not merge accounts.

### Username rules

- Usernames use lowercase ASCII.
- Length is 3-30 characters.
- Allowed characters are `a-z`, `0-9`, single hyphens, and single underscores.
- Usernames begin and end with an alphanumeric character.
- Reserved application routes and confusing system names are rejected.
- Uniqueness is enforced atomically by the database.
- A username rename preserves the immutable account identity and all ownership.
- Old usernames are not aliases and do not redirect.

### Owner isolation

- The server derives the current actor from the authenticated session.
- Request bodies cannot choose an owner ID.
- Owner-only lookups scope resource ID and owner ID together.
- Every user-owned table carries the immutable owner ID.
- Database row-level security is defense in depth.
- Worker jobs reload persisted ownership rather than trusting queue input.
- Storage, cache, queue, and idempotency names include owner scope.
- Owner authorization failures do not reveal another account's resource.

## Authentication and account lifecycle

- Accounts are private by default.
- Registration validates username, email, and password before activation.
- Sign-in failures remain enumeration-resistant.
- Password recovery revokes existing sessions after completion.
- Linking another sign-in provider requires control of the existing account.
- Sensitive account changes require recent authentication.
- Account suspension disables sign-in and public sharing.
- Account deletion revokes sessions, disables sharing, cancels processing, and
  removes owner data according to the approved retention policy.
- Deleting or renaming an account never creates an old-route redirect.

## Imports and private flight data

- Imports belong to exactly one authenticated account.
- Upload and processing jobs are scoped to the persisted owner.
- Deduplication occurs only within one account.
- Identical flights imported by different accounts remain independent.
- Source rows and correction history remain private.
- Owner maps may show the owner's canonical detail.
- Public maps use a separate, privacy-reduced projection.

The public projection excludes raw uploads, source payloads, correction
history, notes, registration or tail numbers, seat data, account email,
provider identity, exact departure times, session data, internal row IDs, and
storage locations.

## Public sharing

### Owner control

Every account starts with sharing off. The sharing control appears in
`/settings`:

| Current state | Available action | Result |
| --- | --- | --- |
| Off | **Share my map** | Publishes the complete current eligible map at `/{username}` |
| On | **Disable sharing** | Makes `/{username}` unavailable |

There is no second publishing workflow, partial-map mode, item picker, or
separate refresh action. The service derives the complete eligible flight set;
clients cannot submit flight IDs or exclusions.

The sharing panel displays the full absolute URL, provides a normal link that
opens it in a new browser tab, and provides a copy action. The link uses
`target="_blank"` with `rel="noopener noreferrer"`.

### Public route behavior

- `/{username}` is a normal public page.
- The page is intentionally eligible for ordinary public-page metadata
  behavior.
- The browser loads public map data with `GET /api/shared/{username}`.
- No request body is required for a public read.
- An enabled account returns only the public map projection.
- An unknown, disabled, suspended, renamed, or deleted account returns the same
  generic unavailable result.
- Public responses do not reveal hidden-row counts or owner-only fields.
- Public requests are rate limited by network and normalized username.
- Shared responses use no-store caching because disable must take effect on a
  subsequent load.

### Complete, uncapped map

The Share action publishes every current eligible flight. The public
projection may aggregate flights into coarse routes, but it must preserve the
complete represented flight count. It must not:

- impose a maximum number of flights;
- truncate routes because a map is large;
- let the owner choose a subset;
- accept client-provided inclusion or exclusion lists; or
- expose owner-only records while calculating public aggregates.

The authenticated owner view remains separate and may contain more precise
information than the public map.

### Disable and revocation

Disable is authoritative in persisted sharing state. After disable:

- new public loads return the generic unavailable result;
- already-open viewers revalidate on focus, visibility restoration, and browser
  history restoration;
- a confirmed unavailable response clears the public projection from the page;
  and
- previously copied or captured content cannot be recalled.

### Breaking old links

The public username route replaces every earlier sharing URL design. Previous
sharing URLs are unsupported, do not redirect, and cannot be used to load a
map. This is an intentional breaking change. Clients, tests, documentation,
and support guidance must use only `/{username}`.

## API boundaries

| Boundary | Access and behavior |
| --- | --- |
| `GET /api/account/sharing` | Authenticated owner status |
| `POST /api/account/sharing` | Authenticated owner enables the complete public map |
| `DELETE /api/account/sharing` | Authenticated owner disables the public map |
| `GET /api/shared/{username}` | Unauthenticated read of the public projection |

Owner mutations require same-origin enforcement. Public reads allow only
`GET`; other methods return method-not-allowed.

## Storage model

| Table/group | Purpose |
| --- | --- |
| `users` | Immutable account identity and lifecycle status |
| `user_profiles` | Unique normalized username and display preferences |
| `auth_accounts` | Explicitly linked sign-in providers |
| `sessions` | Revocable authenticated sessions |
| `flights` | Private canonical owner flight records |
| `import_batches` / `import_rows` | Owner-scoped import state and provenance |
| `map_shares` | One owner sharing state and privacy-reduced public projection |
| `map_share_flights` | Complete represented owner-flight membership |
| `audit_events` | Privacy-safe action and result evidence |

Foreign keys and indexes include ownership where practical so a child record
cannot attach to another account's parent. Public serialization never reuses
the owner serializer.

## Security, privacy, and abuse controls

- Use TLS, encryption at rest, least-privilege service identities, dependency
  scanning, migration review, and environment separation.
- Protect owner mutations against cross-site requests.
- Rate limit registration, login, recovery, imports, and public map reads.
- Bound upload bytes, row counts, decompression, parser time, concurrent jobs,
  retries, and account storage.
- Keep public map rendering functional when external tiles are unavailable.
- Never log passwords, cookies, email content, raw filenames, flight rows,
  airport pairs, dates, notes, registrations, or private import content.
- Audit sensitive actions with actor, resource class, result, and correlation
  ID without recording private payloads.
- Apply the same ownership and privacy review to backups, previews, fixtures,
  support exports, and operational dashboards.

## Testing requirements

### Unit and integration

- Username normalization, reserved names, rename behavior, and atomic
  uniqueness.
- Owner-scoped database and service access.
- Complete-map membership and uncapped projection counts.
- Public projection field allowlists.
- Share and disable state transitions.
- Generic unavailable behavior for unknown and disabled usernames.
- Public route `GET` behavior and method rejection.
- Session revocation and account deletion effects.

### End to end

- Share exposes the full absolute `/{username}` URL.
- The **Open public map** link opens that exact URL in a new tab.
- The public route loads with no extra URL material.
- Desktop and mobile Chrome render the public map.
- Disable makes the route unavailable.
- Reserved static routes are not captured by the username page.
- Two owners cannot read or mutate each other's private resources.

No fixture may contain a real person's private flight data.

## Acceptance criteria

- Private account data is isolated by immutable owner identity.
- Sharing is off by default.
- Settings provide only the Share/Disable toggle for publishing control.
- Share publishes the whole eligible map with no flight or route cap.
- The only public map URL is `/{username}`.
- The public page and endpoint require no additional secret or request body.
- Public responses contain only the approved coarse projection.
- Disable, suspension, rename, and deletion prevent subsequent public loads.
- Old sharing URLs remain broken and do not redirect.
- Unit, desktop Playwright, and mobile Playwright coverage enforce this
  contract.
