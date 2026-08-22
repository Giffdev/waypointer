const AIRPORT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/;

export type AirportIdentifierFields = {
  iata: string | null;
  localCode: string | null;
  icao: string | null;
  sourceIdent: string | null;
};

export function preferredAirportCode(
  airport: AirportIdentifierFields,
): string | null {
  for (const candidate of [
    airport.iata,
    airport.localCode,
    airport.icao,
    airport.sourceIdent,
  ]) {
    if (isPublicAirportCode(candidate)) return candidate;
  }
  return null;
}

export function isPublicAirportCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    AIRPORT_CODE_PATTERN.test(value)
  );
}
