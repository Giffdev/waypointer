import { aggregateFlightRoutes } from "./flight-filters";
import {
  airportsForRoutes,
  type Flight,
  type FlightKind,
} from "./flight-data";
import { statsFactsFromFlights } from "./flight-insights";
import type { LocalFlightData } from "./local-flight-data";
import type { LocalFlightStatisticsContext } from "./local-flight-statistics";

export function buildPersistedFlightData(
  flights: Flight[],
  generatedAt = new Date().toISOString(),
): LocalFlightData {
  const routes = aggregateFlightRoutes(flights);
  const airports = airportsForRoutes(routes);
  const importedKinds = [...new Set(flights.map((flight) => flight.kind))] as FlightKind[];
  return {
    authoritative: true,
    generatedAt,
    sourceLabel: "Authenticated PostgreSQL flight history",
    importedKinds,
    stats: {
      records: flights.length,
      flights: flights.length,
      airports: airports.length,
      distanceMiles: Math.round(
        flights.reduce((total, flight) => total + flight.distanceMiles, 0),
      ),
      routes: routes.length,
      mappedFlights: flights.length,
    },
    airports,
    routes,
    flights,
    recentFlights: flights.slice(0, 60),
  };
}

export function buildPersistedFlightStatisticsContext(
  flights: Flight[],
  now = new Date(),
): LocalFlightStatisticsContext {
  return {
    facts: statsFactsFromFlights(flights),
    asOfDate: now.toISOString().slice(0, 10) as LocalFlightStatisticsContext["asOfDate"],
    timeZone: "UTC",
  };
}
