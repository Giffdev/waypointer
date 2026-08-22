import {
  buildRouteScopedView,
  createSharedFlightData,
  findLatestYearForMonth,
  formatCivilDateLabel,
  formatComparisonBasis,
  formatPeriodRange,
} from "@/components/dashboard-shared";
import type { FlightFilters } from "./flight-filters";
import type { LocalFlightData } from "./local-flight-data";
import type { LocalFlightStatisticsContext } from "./local-flight-statistics";
import type {
  FlightsPageContract,
  ImportPageContract,
  MapPageContract,
  RouteFilterContract,
} from "./route-contracts";
import { FLIGHT_IMPORT_FORMATS } from "./import/registry";
import {
  normalizeAircraftMetadata,
  normalizeRegistrationMetadata,
} from "./flight-metadata";
import {
  DEFAULT_DISTANCE_UNIT,
  formatDistanceForUnit,
  type DistanceUnit,
} from "./distance-unit";
import {
  DEFAULT_MAP_VIEW_MODE,
  type MapViewMode,
} from "./map-view-mode";
import { flightAirportSequence } from "./flight-data";

function buildFilterContract(
  filters: FlightFilters,
  localData: LocalFlightData | null,
  statisticsContext?: LocalFlightStatisticsContext | null,
  distanceUnit: DistanceUnit = DEFAULT_DISTANCE_UNIT,
) {
  const shared = createSharedFlightData(localData, statisticsContext);
  const scoped = buildRouteScopedView(shared, filters, distanceUnit);
  const filterContract: RouteFilterContract = {
    filters,
    filterOptions: scoped.filterOptions,
    periodRange: formatPeriodRange(scoped.insightsPeriods.primary),
    asOfDate: formatCivilDateLabel(shared.stableStatisticsContext.asOfDate),
    timeZone: shared.stableStatisticsContext.timeZone,
    distanceUnit,
    latestYearByMonth: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const month = index + 1;
        return [
          month,
          findLatestYearForMonth(
            shared.indexedFlights,
            filters,
            month,
          ),
        ];
      }),
    ),
  };
  return { shared, scoped, filterContract };
}

export function buildMapPageContract(
  filters: FlightFilters,
  localData: LocalFlightData | null,
  statisticsContext?: LocalFlightStatisticsContext | null,
  distanceUnit: DistanceUnit = DEFAULT_DISTANCE_UNIT,
  mapViewMode: MapViewMode = DEFAULT_MAP_VIEW_MODE,
): MapPageContract {
  const { shared, scoped, filterContract } = buildFilterContract(
    filters,
    localData,
    statisticsContext,
    distanceUnit,
  );
  return {
    ...filterContract,
    hasLocalData: Boolean(localData),
    dataMode: localData?.authoritative
      ? "persisted"
      : localData
        ? "local-preview"
        : "representative",
    filteredFlightCount: scoped.filteredFlights.length,
    routes: scoped.filteredRoutes,
    airports: shared.displayAirports,
    activeAirportCodes: [...scoped.activeAirportCodes],
    homeFrame: shared.homeFrame,
    statsCards: scoped.statsCards,
    busiestRoute: scoped.busiestRoute
      ? {
          id: scoped.busiestRoute.id,
          originCode: scoped.busiestRoute.origin.code,
          destinationCode: scoped.busiestRoute.destination.code,
          flightCount: scoped.busiestRoute.flightCount,
        }
      : null,
    comparisonText: scoped.insightsPeriods.comparison
      ? `${formatPeriodRange(scoped.insightsPeriods.comparison)} · ${formatComparisonBasis(scoped.insightsPeriods)}`
      : "Not available for all history",
    completenessText: scoped.completenessText,
    mapViewMode,
  };
}

export function buildFlightsPageContract(
  filters: FlightFilters,
  localData: LocalFlightData | null,
  statisticsContext?: LocalFlightStatisticsContext | null,
  distanceUnit: DistanceUnit = DEFAULT_DISTANCE_UNIT,
): FlightsPageContract {
  const { scoped, filterContract } = buildFilterContract(
    filters,
    localData,
    statisticsContext,
    distanceUnit,
  );
  return {
    ...filterContract,
    flights: scoped.visibleFlights.map((flight) => {
      const aircraftType = normalizeAircraftMetadata(flight.aircraftType);
      const aircraftModel = normalizeAircraftMetadata(flight.aircraftModel);
      const aircraft =
        normalizeAircraftMetadata(flight.aircraft) ??
        aircraftModel ??
        aircraftType ??
        "Aircraft not specified";
      const registration = normalizeRegistrationMetadata(flight.registration);
      const airportSequence = flightAirportSequence(flight);
      return {
        id: flight.id,
        date: flight.date,
        origin: {
          code: flight.origin.code,
          name: flight.origin.name,
          city: flight.origin.city,
        },
        destination: {
          code: flight.destination.code,
          name: flight.destination.name,
          city: flight.destination.city,
        },
        intermediateStops: airportSequence.slice(1, -1).map((airport) => ({
          code: airport.code,
          name: airport.name,
          city: airport.city,
        })),
        kind: flight.kind,
        role: flight.role,
        aircraft,
        ...(aircraftType ? { aircraftType } : {}),
        ...(aircraftModel ? { aircraftModel } : {}),
        ...(registration ? { registration } : {}),
        distance: formatDistanceForUnit(flight.distanceMiles, distanceUnit),
        source: flight.source,
      };
    }),
  };
}

export function buildImportPageContract(
  localData: LocalFlightData | null,
): ImportPageContract {
  return {
    hasLocalArtifact: Boolean(localData),
    normalizedFlightCount: localData?.stats.flights ?? 0,
    supportedFormats: FLIGHT_IMPORT_FORMATS.map((format) =>
      format.presets?.length
        ? `${format.label} (${format.presets.map(({ label }) => label).join(" and ")} presets, or map another CSV)`
        : format.label,
    ),
  };
}
