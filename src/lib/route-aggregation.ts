import {
  airportExactIdentity,
  deriveRouteDirectionMode,
  flightLegs,
  type AggregatedMapRoute,
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

export function airportIdentity(airport: Airport): string {
  return airportExactIdentity(airport);
}

export function unorderedRouteKey(
  kind: MapRoute["kind"],
  first: Airport,
  second: Airport,
): string {
  const identities = [airportIdentity(first), airportIdentity(second)].sort();
  return JSON.stringify([kind, identities[0], identities[1]]);
}

export function aggregateRoutesFromFlights(
  flights: readonly RouteFlight[],
): AggregatedMapRoute[] {
  const routes = new Map<string, RouteAccumulator>();
  for (const flight of flights) {
    for (const leg of flightLegs(flight)) {
      const originIdentity = airportIdentity(leg.origin);
      const destinationIdentity = airportIdentity(leg.destination);
      const [firstIdentity, secondIdentity] = [
        originIdentity,
        destinationIdentity,
      ].sort();
      const key = JSON.stringify([
        flight.kind,
        firstIdentity,
        secondIdentity,
      ]);
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

  return [...routes.values()].map((route) => {
    const sameAirport = route.firstIdentity === route.secondIdentity;
    return {
      id: `flight-route-${encodeURIComponent(
        JSON.stringify([
          route.kind,
          route.firstIdentity,
          route.secondIdentity,
        ]),
      )}`,
      origin: withNormalizedCode(route.firstAirport),
      destination: withNormalizedCode(route.secondAirport),
      kind: route.kind,
      flightCount: route.forwardFlightCount + route.reverseFlightCount,
      forwardFlightCount: route.forwardFlightCount,
      reverseFlightCount: route.reverseFlightCount,
      directionMode: deriveRouteDirectionMode(
        route.forwardFlightCount,
        route.reverseFlightCount,
        sameAirport,
      ),
    };
  });
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
