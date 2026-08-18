import type { Airport, FlightKind, FlightRole, MapRoute } from "./flight-data";
import type {
  FilterOption,
  FlightFilters,
  TextFilterOption,
} from "./flight-filters";
import type { MapFrame } from "./map-framing";
import type { StatsCard } from "@/components/dashboard-shared";
import type { DistanceUnit } from "./distance-unit";
import type { MapViewMode } from "./map-view-mode";

export type RouteFilterContract = {
  filters: FlightFilters;
  filterOptions: {
    years: FilterOption[];
    months: FilterOption[];
    sources: TextFilterOption[];
    aircraft: TextFilterOption[];
    registrations: TextFilterOption[];
  };
  periodRange: string;
  asOfDate: string;
  timeZone: string;
  distanceUnit: DistanceUnit;
  latestYearByMonth: Record<number, number | "all">;
};

export type MapPageContract = RouteFilterContract & {
  hasLocalData: boolean;
  dataMode: "representative" | "local-preview" | "persisted";
  filteredFlightCount: number;
  routes: MapRoute[];
  airports: Airport[];
  activeAirportCodes: string[];
  homeFrame: MapFrame;
  statsCards: StatsCard[];
  busiestRoute: {
    originCode: string;
    destinationCode: string;
    flightCount: number;
  } | null;
  comparisonText: string;
  completenessText: string;
  mapViewMode: MapViewMode;
};

export type SanitizedHistoryFlight = {
  id: string;
  date: string;
  origin: { code: string; name: string; city: string };
  destination: { code: string; name: string; city: string };
  intermediateStops: Array<{ code: string; name: string; city: string }>;
  kind: FlightKind;
  role: FlightRole;
  aircraft: string;
  aircraftType?: string;
  aircraftModel?: string;
  registration?: string;
  distance: string;
  source: "ForeFlight" | "CSV" | "FlightRadar24" | "Manual";
};

export type FlightsPageContract = RouteFilterContract & {
  flights: SanitizedHistoryFlight[];
};

export type ImportPageContract = {
  hasLocalArtifact: boolean;
  normalizedFlightCount: number;
  supportedFormats: string[];
};
