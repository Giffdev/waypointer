export type AirportFacility = "commercial" | "general-aviation" | "airstrip";

export type Airport = {
  identity?: string;
  code: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  facility: AirportFacility;
};

export type FlightKind = "commercial" | "private";
export type FlightRole = "passenger" | "pilot";
export type RouteDirectionMode = "one-way" | "both" | "none";
export type FlightSource =
  | "ForeFlight"
  | "CSV"
  | "FlightRadar24"
  | "Manual";

export type Flight = {
  id: string;
  date: string;
  origin: Airport;
  destination: Airport;
  airportSequence?: Airport[];
  /**
   * Presentation-only ordered path including route waypoints.
   *
   * Deliberately separate from `airportSequence`: statistics, uniqueness
   * counts, and sharing all read the landings-only sequence, so adding
   * waypoints to a flight cannot move a single number. Anything that counts
   * must use `flightAirportSequence`, never this.
   */
  routePath?: Array<{ airport: Airport; kind: "landing" | "waypoint" }>;
  /** Verbatim source route text, preserved for display. */
  routeRaw?: string;
  kind: FlightKind;
  role: FlightRole;
  aircraft: string;
  aircraftType?: string;
  aircraftModel?: string;
  registration?: string;
  flightNumber?: string;
  airline?: string;
  departureTime?: string;
  distanceMiles: number;
  durationHours?: number;
  source: FlightSource;
};

export type MapRoute = {
  id: string;
  origin: Airport;
  destination: Airport;
  kind: FlightKind;
  flightCount: number;
  forwardFlightCount?: number;
  reverseFlightCount?: number;
  directionMode?: RouteDirectionMode;
};

export type AggregatedMapRoute = MapRoute & {
  forwardFlightCount: number;
  reverseFlightCount: number;
  directionMode: RouteDirectionMode;
};

export function airportExactIdentity(
  airport: Pick<
    Airport,
    | "identity"
    | "code"
    | "name"
    | "city"
    | "country"
    | "lat"
    | "lon"
    | "facility"
  >,
): string {
  if (airport.identity) return JSON.stringify(["id", airport.identity]);
  return JSON.stringify([
    "airport",
    airport.code.trim().toUpperCase(),
    airport.name.trim(),
    airport.city.trim(),
    airport.country.trim(),
    Number.isFinite(airport.lat) ? normalizeIdentityZero(airport.lat) : null,
    Number.isFinite(airport.lon) ? normalizeIdentityZero(airport.lon) : null,
    airport.facility,
  ]);
}

export function deriveRouteDirectionMode(
  forwardFlightCount: number,
  reverseFlightCount: number,
  sameAirport = false,
): RouteDirectionMode {
  if (sameAirport || (forwardFlightCount === 0 && reverseFlightCount === 0)) {
    return "none";
  }
  return forwardFlightCount > 0 && reverseFlightCount > 0
    ? "both"
    : "one-way";
}

export type FlightLeg = {
  index: number;
  origin: Airport;
  destination: Airport;
};

export function flightAirportSequence(
  flight: Pick<Flight, "origin" | "destination" | "airportSequence">,
): Airport[] {
  return flight.airportSequence && flight.airportSequence.length >= 2
    ? flight.airportSequence
    : [flight.origin, flight.destination];
}

export function flightLegs(
  flight: Pick<Flight, "origin" | "destination" | "airportSequence">,
): FlightLeg[] {
  const sequence = flightAirportSequence(flight);
  return sequence.slice(0, -1).map((origin, index) => ({
    index,
    origin,
    destination: sequence[index + 1],
  }));
}

/**
 * The ordered path a flight actually drew on the map, including waypoints.
 *
 * Falls back to the landings sequence when a flight has no route, so callers
 * never have to branch. Presentation only — never an input to a count.
 */
export function flightRoutePath(
  flight: Pick<Flight, "origin" | "destination" | "airportSequence" | "routePath">,
): Array<{ airport: Airport; kind: "landing" | "waypoint" }> {
  if (flight.routePath && flight.routePath.length >= 2) return flight.routePath;
  return flightAirportSequence(flight).map((airport) => ({
    airport,
    kind: "landing" as const,
  }));
}

export const airports = {
  SEA: { code: "SEA", name: "Seattle–Tacoma International", city: "Seattle", country: "United States", lat: 47.449, lon: -122.309, facility: "commercial" },
  JFK: { code: "JFK", name: "John F. Kennedy International", city: "New York", country: "United States", lat: 40.64, lon: -73.779, facility: "commercial" },
  HNL: { code: "HNL", name: "Daniel K. Inouye International", city: "Honolulu", country: "United States", lat: 21.319, lon: -157.922, facility: "commercial" },
  SYD: { code: "SYD", name: "Sydney Kingsford Smith", city: "Sydney", country: "Australia", lat: -33.947, lon: 151.177, facility: "commercial" },
  HKG: { code: "HKG", name: "Hong Kong International", city: "Hong Kong", country: "Hong Kong", lat: 22.309, lon: 113.915, facility: "commercial" },
  AMS: { code: "AMS", name: "Amsterdam Schiphol", city: "Amsterdam", country: "Netherlands", lat: 52.309, lon: 4.764, facility: "commercial" },
  CPT: { code: "CPT", name: "Cape Town International", city: "Cape Town", country: "South Africa", lat: -33.968, lon: 18.605, facility: "commercial" },
  BFI: { code: "BFI", name: "Boeing Field / King County International", city: "Seattle", country: "United States", lat: 47.53, lon: -122.302, facility: "general-aviation" },
  PAE: { code: "PAE", name: "Paine Field", city: "Everett", country: "United States", lat: 47.906, lon: -122.282, facility: "general-aviation" },
  S43: { code: "S43", name: "Harvey Field", city: "Snohomish", country: "United States", lat: 47.908, lon: -122.105, facility: "general-aviation" },
  "3U2": { code: "3U2", name: "Johnson Creek Airport", city: "Yellow Pine", country: "United States", lat: 44.912, lon: -115.485, facility: "airstrip" },
  "1Q5": { code: "1Q5", name: "Gravelly Valley Airport", city: "Lake Pillsbury", country: "United States", lat: 39.451, lon: -122.955, facility: "airstrip" },
} satisfies Record<string, Airport>;

export const sampleFlights: Flight[] = [
  { id: "flt-1", date: "2026-07-28", origin: airports.SEA, destination: airports.HNL, kind: "commercial", role: "passenger", aircraft: "Boeing 737-9", distanceMiles: 2677, source: "FlightRadar24" },
  { id: "flt-2", date: "2026-07-18", origin: airports.PAE, destination: airports.SEA, kind: "private", role: "pilot", aircraft: "Cessna 172", distanceMiles: 32, source: "ForeFlight" },
  { id: "flt-3", date: "2026-06-02", origin: airports.HNL, destination: airports.SYD, kind: "commercial", role: "passenger", aircraft: "Airbus A330", distanceMiles: 5067, source: "CSV" },
  { id: "flt-4", date: "2026-05-26", origin: airports.SYD, destination: airports.HKG, kind: "commercial", role: "passenger", aircraft: "Boeing 787-9", distanceMiles: 4581, source: "FlightRadar24" },
  { id: "flt-5", date: "2026-04-11", origin: airports.AMS, destination: airports.JFK, kind: "commercial", role: "passenger", aircraft: "Boeing 777-200", distanceMiles: 3643, source: "FlightRadar24" },
  { id: "flt-6", date: "2026-03-09", origin: airports.JFK, destination: airports.CPT, kind: "commercial", role: "passenger", aircraft: "Airbus A350", distanceMiles: 7810, source: "CSV" },
  { id: "flt-7", date: "2026-02-22", origin: airports.BFI, destination: airports.S43, kind: "private", role: "pilot", aircraft: "Piper PA-28", distanceMiles: 29, source: "ForeFlight" },
  { id: "flt-8", date: "2026-01-16", origin: airports.S43, destination: airports["3U2"], kind: "private", role: "pilot", aircraft: "Cessna 182", distanceMiles: 360, source: "ForeFlight" },
];

export const mapRoutes: MapRoute[] = [
  { id: "route-sea-hnl", origin: airports.SEA, destination: airports.HNL, kind: "commercial", flightCount: 18 },
  { id: "route-hnl-syd", origin: airports.HNL, destination: airports.SYD, kind: "commercial", flightCount: 4 },
  { id: "route-syd-hkg", origin: airports.SYD, destination: airports.HKG, kind: "commercial", flightCount: 9 },
  { id: "route-ams-jfk", origin: airports.AMS, destination: airports.JFK, kind: "commercial", flightCount: 27 },
  { id: "route-jfk-cpt", origin: airports.JFK, destination: airports.CPT, kind: "commercial", flightCount: 2 },
  { id: "route-sea-jfk", origin: airports.SEA, destination: airports.JFK, kind: "commercial", flightCount: 41 },
  { id: "route-pae-sea", origin: airports.PAE, destination: airports.SEA, kind: "private", flightCount: 14 },
  { id: "route-bfi-s43", origin: airports.BFI, destination: airports.S43, kind: "private", flightCount: 7 },
  { id: "route-s43-3u2", origin: airports.S43, destination: airports["3U2"], kind: "private", flightCount: 3 },
  { id: "route-s43-1q5", origin: airports.S43, destination: airports["1Q5"], kind: "private", flightCount: 1 },
];

export const uniqueAirports = Object.values(airports);

export function mergeRouteCollections(
  representativeRoutes: MapRoute[],
  importedRoutes: MapRoute[] | undefined,
): MapRoute[] {
  if (!importedRoutes?.length) return representativeRoutes;

  const merged = new Map<string, MapRoute>();
  const importedKinds = new Set(importedRoutes.map((route) => route.kind));
  for (const route of representativeRoutes) {
    if (!importedKinds.has(route.kind)) {
      merged.set(routeKey(route), route);
    }
  }
  for (const route of importedRoutes) {
    merged.set(routeKey(route), route);
  }
  return [...merged.values()];
}

export function mergeFlightCollections(
  representativeFlights: Flight[],
  importedFlights: Flight[] | undefined,
  importedKinds: FlightKind[] | undefined,
): Flight[] {
  if (!importedFlights?.length || !importedKinds?.length) return representativeFlights;
  const kinds = new Set(importedKinds);
  return [
    ...importedFlights,
    ...representativeFlights.filter((flight) => !kinds.has(flight.kind)),
  ];
}

export function airportsForRoutes(routes: MapRoute[]): Airport[] {
  return Array.from(
    new Map(
      routes
        .flatMap((route) => [route.origin, route.destination])
        .map((airport) => [airportExactIdentity(airport), airport]),
    ).values(),
  );
}

function normalizeIdentityZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function routeKey(route: MapRoute): string {
  return unorderedRouteKey(route.kind, route.origin, route.destination);
}
import { unorderedRouteKey } from "./route-aggregation";
