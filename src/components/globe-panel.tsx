"use client";

import FlightGlobe from "./flight-globe";
import type {
  Airport,
  FlightKind,
  MapRoute,
  MapRoutePathFlight,
} from "@/lib/flight-data";
import type { MapFrame } from "@/lib/map-framing";
import type { MapViewMode } from "@/lib/map-view-mode";

type GlobePanelProps = {
  airports: Airport[];
  routes: MapRoute[];
  /** Optional. Absent means landing-only rendering, exactly as before. */
  routePathFlights?: MapRoutePathFlight[];
  visibleKind: "all" | FlightKind;
  zoom: number;
  zoomCommandToken: number;
  focusAirportCode: string;
  selectedRouteId: string;
  resetToken: number;
  homeFrame: MapFrame;
  autoRotate: boolean;
  viewMode: MapViewMode;
  onSelectAirport: (identity: string) => void;
  onSelectRoute: (routeId: string) => void;
  onZoomChange: (zoom: number) => void;
};

export default function GlobePanel(props: GlobePanelProps) {
  return <FlightGlobe {...props} />;
}
