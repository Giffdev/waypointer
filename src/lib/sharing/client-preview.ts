import type {
  MapSharePreview,
  PublicMapProjection,
} from "@/lib/sharing/service";

export const MAP_SHARE_PREVIEW_STORAGE_KEY =
  "waypointer:map-share-preview";
export const MAP_SHARE_PREVIEW_FRAGMENT_PARAM = "preview";

const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const PREVIEW_ID_PATTERN = /^[0-9a-f]{64}$/;
const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COUNTRY_PATTERN =
  /^(?:[A-Z]{2}|[\p{L}][\p{L}\p{M} .,'\u2019()&-]{1,79})$/u;

export class MapSharePreviewValidationError extends Error {
  constructor() {
    super("Invalid map share preview.");
    this.name = "MapSharePreviewValidationError";
  }
}

export function createMapSharePreviewNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export function mapSharePreviewFragment(nonce: string): string {
  assertNonce(nonce);
  return `#${MAP_SHARE_PREVIEW_FRAGMENT_PARAM}=${nonce}`;
}

export function parseMapSharePreviewFragment(
  hash: string,
): string | null {
  if (!hash) return null;
  const parameters = new URLSearchParams(hash.slice(1));
  const nonce = parameters.get(MAP_SHARE_PREVIEW_FRAGMENT_PARAM);
  if (
    parameters.size !== 1 ||
    nonce === null ||
    !NONCE_PATTERN.test(nonce)
  ) {
    throw new MapSharePreviewValidationError();
  }
  return nonce;
}

export function parseMapSharePreview(value: unknown): MapSharePreview {
  const preview = exactRecord(value, [
    "previewId",
    "includeDisplayName",
    "projection",
  ]);
  if (
    typeof preview.previewId !== "string" ||
    !PREVIEW_ID_PATTERN.test(preview.previewId) ||
    typeof preview.includeDisplayName !== "boolean"
  ) {
    throw new MapSharePreviewValidationError();
  }

  const projection = parsePublicMapProjection(preview.projection);
  if (
    preview.includeDisplayName !==
    (projection.owner.displayName !== null)
  ) {
    throw new MapSharePreviewValidationError();
  }

  return {
    previewId: preview.previewId,
    includeDisplayName: preview.includeDisplayName,
    projection,
  };
}

export function parsePublicMapProjection(
  value: unknown,
): PublicMapProjection {
  const projection = exactRecord(value, ["owner", "summary", "routes"]);
  const owner = exactRecord(projection.owner, ["displayName"]);
  const summary = exactRecord(projection.summary, [
    "flightCount",
    "routeCount",
  ]);
  if (
    !isDisplayName(owner.displayName) ||
    !isNonNegativeInteger(summary.flightCount) ||
    !isNonNegativeInteger(summary.routeCount) ||
    !Array.isArray(projection.routes)
  ) {
    throw new MapSharePreviewValidationError();
  }

  const routes = projection.routes.map(parsePublicRoute);
  const routeIds = new Set(routes.map(({ id }) => id));
  const representedLegs = routes.reduce(
    (total, route) => total + route.flightCount,
    0,
  );
  if (
    summary.routeCount !== routes.length ||
    routeIds.size !== routes.length ||
    (summary.flightCount === 0) !== (routes.length === 0) ||
    !Number.isSafeInteger(representedLegs) ||
    summary.flightCount > representedLegs
  ) {
    throw new MapSharePreviewValidationError();
  }

  return {
    owner: { displayName: owner.displayName },
    summary: {
      flightCount: summary.flightCount,
      routeCount: summary.routeCount,
    },
    routes,
  };
}

export function storeMapSharePreview(
  storage: Storage,
  nonce: string,
  projection: unknown,
): PublicMapProjection {
  assertNonce(nonce);
  const sanitizedProjection = parsePublicMapProjection(projection);
  storage.setItem(
    MAP_SHARE_PREVIEW_STORAGE_KEY,
    JSON.stringify({
      nonce,
      projection: sanitizedProjection,
    }),
  );
  return sanitizedProjection;
}

export function readMapSharePreview(
  storage: Storage,
  requestedNonce: string | null,
): PublicMapProjection | null {
  if (requestedNonce !== null) assertNonce(requestedNonce);
  const serialized = storage.getItem(MAP_SHARE_PREVIEW_STORAGE_KEY);
  if (!serialized) return null;

  const envelope = exactRecord(JSON.parse(serialized), [
    "nonce",
    "projection",
  ]);
  if (
    typeof envelope.nonce !== "string" ||
    !NONCE_PATTERN.test(envelope.nonce) ||
    (requestedNonce !== null && envelope.nonce !== requestedNonce)
  ) {
    throw new MapSharePreviewValidationError();
  }
  return parsePublicMapProjection(envelope.projection);
}

function parsePublicRoute(
  value: unknown,
): PublicMapProjection["routes"][number] {
  const route = exactRecord(value, [
    "id",
    "kind",
    "flightCount",
    "origin",
    "destination",
  ]);
  if (
    typeof route.id !== "string" ||
    !ROUTE_ID_PATTERN.test(route.id) ||
    (route.kind !== "commercial" && route.kind !== "private") ||
    !isPositiveInteger(route.flightCount)
  ) {
    throw new MapSharePreviewValidationError();
  }
  return {
    id: route.id,
    kind: route.kind,
    flightCount: route.flightCount,
    origin: parseCoarsePlace(route.origin),
    destination: parseCoarsePlace(route.destination),
  };
}

function parseCoarsePlace(
  value: unknown,
): PublicMapProjection["routes"][number]["origin"] {
  const place = exactRecord(value, ["lat", "lon", "country"]);
  if (
    !isCoarseCoordinate(place.lat, -90, 90) ||
    !isCoarseCoordinate(place.lon, -180, 180) ||
    typeof place.country !== "string" ||
    place.country !== place.country.trim() ||
    !COUNTRY_PATTERN.test(place.country)
  ) {
    throw new MapSharePreviewValidationError();
  }
  return {
    lat: normalizeZero(place.lat),
    lon: normalizeZero(place.lon),
    country: place.country,
  };
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new MapSharePreviewValidationError();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new MapSharePreviewValidationError();
  }
  return value;
}

function isDisplayName(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value === value.trim() &&
      value.length >= 1 &&
      value.length <= 100)
  );
}

function isCoarseCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum &&
    value === Math.round(value * 10) / 10
  );
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new MapSharePreviewValidationError();
  }
}
