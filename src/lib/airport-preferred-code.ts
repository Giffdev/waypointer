const AIRPORT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/;

/**
 * OurAirports facility types whose public identity is the local/FAA landing
 * facility identifier rather than an IATA code.
 *
 * OurAirports assigns IATA codes to many unscheduled small fields that no
 * airline has ever served (Bandon State, ident `KS05`, local code `S05`,
 * carries IATA `BDY`), and publishing that code implies commercial
 * significance the field does not have. The demotion is deliberately narrow:
 * `scheduled_service` is a stale, unreliable flag in the upstream dataset
 * (major airports such as Phnom Penh/`PNH`, Odesa/`ODS`, Ulaanbaatar/`ULN`,
 * Istanbul Ataturk/`ISL`, and Western Sydney/`WSI` are all marked "no"), so it
 * is never used on its own. Medium and large airports keep their IATA code
 * regardless of that flag, and heliports, seaplane bases, balloonports, and
 * closed airports are untouched.
 */
const LOCAL_IDENTITY_AIRPORT_TYPES: ReadonlySet<string> = new Set([
  "small_airport",
]);

export type AirportIdentifierFields = {
  iata: string | null;
  localCode: string | null;
  icao: string | null;
  sourceIdent: string | null;
};

/**
 * Catalog-time view of an airport, as read from the OurAirports dataset.
 * Declared structurally so this module stays free of import-layer imports.
 */
export type AirportCatalogIdentity = {
  type: string;
  scheduledService: boolean;
  ident: string;
  iataCode?: string | null;
  localCode?: string | null;
};

/**
 * Single source of truth for "which identifier does a stored airport row
 * display?". Consumed by the private map read path, the public sharing
 * projection, and (through `canonicalAirportIdentifierFields`) by import and
 * seed time, so a seeded row and a later read of that row always agree.
 *
 * The precedence itself is intentionally unconditional. Whether an airport
 * publishes an IATA code at all is decided once, at catalog build time, by
 * `prefersLocalAirportCode`; a stored row therefore carries no policy inputs a
 * reader could misinterpret, and a missing or unexpected column can never
 * silently downgrade a public code.
 */
export function preferredAirportCode(
  airport: AirportIdentifierFields,
): string | null {
  const order = [
    airport.iata,
    airport.localCode,
    airport.icao,
    airport.sourceIdent,
  ];
  for (const candidate of order) {
    if (isPublicAirportCode(candidate)) return candidate;
  }
  return null;
}

/**
 * True when an OurAirports reference should publish its local/FAA identifier
 * instead of its IATA code. Applied when the catalog is built, so the
 * canonical import code and the persisted `airports.iata` column reflect one
 * decision. The IATA code itself stays fully resolvable: it is still emitted
 * as a typed `iata` entry in `airport_aliases`.
 */
export function prefersLocalAirportCode(
  reference: AirportCatalogIdentity,
): boolean {
  if (!LOCAL_IDENTITY_AIRPORT_TYPES.has(normalizeType(reference.type))) {
    return false;
  }
  if (reference.scheduledService !== false) return false;
  const localCode = normalizeCode(reference.localCode);
  if (!localCode || !normalizeCode(reference.iataCode)) return false;
  // A local code that only repeats the source identifier is the seed fallback
  // for airports with no real local/FAA code, so it carries no extra public
  // information and must not preempt a genuine IATA code.
  return (
    localCode !== normalizeCode(reference.iataCode) &&
    localCode !== normalizeCode(reference.ident)
  );
}

export function isPublicAirportCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    AIRPORT_CODE_PATTERN.test(value)
  );
}

function normalizeCode(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeType(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
