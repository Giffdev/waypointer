import {
  flightLegs,
  type Airport,
  type Flight,
  type MapRoute,
} from "./flight-data";

type RouteFlight = Pick<
  Flight,
  "origin" | "destination" | "airportSequence" | "kind"
>;

type RouteAccumulator = {
  firstIdentity: string;
  secondIdentity: string;
  firstAirport: Airport;
  secondAirport: Airport;
  kind: MapRoute["kind"];
  forwardFlightCount: number;
  reverseFlightCount: number;
};

export function normalizeAirportCode(code: string): string {
  return code.trim().toUpperCase();
}

export function airportGeometryIdentity(airport: Airport): string {
  if (Number.isFinite(airport.lat) && Number.isFinite(airport.lon)) {
    return `geo:${airport.lat.toFixed(5)},${airport.lon.toFixed(5)}`;
  }
  return `code:${normalizeAirportCode(airport.code)}`;
}

export function unorderedRouteKey(
  kind: MapRoute["kind"],
  first: Airport,
  second: Airport,
): string {
  return [airportGeometryIdentity(first), airportGeometryIdentity(second)]
    .sort()
    .concat(kind)
    .join("|");
}

export function aggregateRoutesFromFlights(
  flights: readonly RouteFlight[],
): MapRoute[] {
  const routes = new Map<string, RouteAccumulator>();
  for (const flight of flights) {
    for (const leg of flightLegs(flight)) {
      const originIdentity = airportGeometryIdentity(leg.origin);
      const destinationIdentity = airportGeometryIdentity(leg.destination);
      const [firstIdentity, secondIdentity] = [
        originIdentity,
        destinationIdentity,
      ].sort();
      const key = `${flight.kind}|${firstIdentity}|${secondIdentity}`;
      const existing = routes.get(key);
      if (existing) {
        existing.firstAirport = preferredAirport(
          existing.firstAirport,
          originIdentity === firstIdentity ? leg.origin : leg.destination,
        );
        existing.secondAirport = preferredAirport(
          existing.secondAirport,
          originIdentity === firstIdentity ? leg.destination : leg.origin,
        );
        if (originIdentity === firstIdentity) existing.forwardFlightCount += 1;
        else existing.reverseFlightCount += 1;
        continue;
      }
      routes.set(key, {
        firstIdentity,
        secondIdentity,
        firstAirport:
          originIdentity === firstIdentity ? leg.origin : leg.destination,
        secondAirport:
          originIdentity === firstIdentity ? leg.destination : leg.origin,
        kind: flight.kind,
        forwardFlightCount: originIdentity === firstIdentity ? 1 : 0,
        reverseFlightCount: originIdentity === firstIdentity ? 0 : 1,
      });
    }
  }

  return [...routes.values()].map((route) => ({
    id: `flight-route-${route.kind}-${stableIdentityToken(route.firstIdentity)}-${stableIdentityToken(route.secondIdentity)}`,
    origin: withNormalizedCode(route.firstAirport),
    destination: withNormalizedCode(route.secondAirport),
    kind: route.kind,
    flightCount: route.forwardFlightCount + route.reverseFlightCount,
    forwardFlightCount: route.forwardFlightCount,
    reverseFlightCount: route.reverseFlightCount,
  }));
}

function preferredAirport(current: Airport, candidate: Airport): Airport {
  const currentCode = normalizeAirportCode(current.code);
  const candidateCode = normalizeAirportCode(candidate.code);
  return (
    candidateCode.length < currentCode.length ||
    (candidateCode.length === currentCode.length &&
      candidateCode.localeCompare(currentCode) < 0)
  )
    ? candidate
    : current;
}

function withNormalizedCode(airport: Airport): Airport {
  const code = normalizeAirportCode(airport.code);
  return code === airport.code ? airport : { ...airport, code };
}

function stableIdentityToken(identity: string): string {
  let hash = 2166136261;
  for (const character of identity) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
