import {
  airportExactIdentity,
  type Airport,
  type MapRoute,
} from "@/lib/flight-data";
import { AIRPORT_MARKER_COLORS } from "@/lib/map-style";
import { routeDirection } from "@/lib/route-direction";

type MapLegendProps = {
  airports: Airport[];
  routes: MapRoute[];
  selectedRouteId: string;
};

export function MapLegend({
  airports,
  routes,
  selectedRouteId,
}: MapLegendProps) {
  const hasCommercial = routes.some(({ kind }) => kind === "commercial");
  const hasPrivate = routes.some(({ kind }) => kind === "private");
  const hasFrequencyRange = routes.some(({ flightCount }) => flightCount > 1);
  const directionModes = new Set(
    routes.map((route) => routeDirection(route).mode),
  );
  const hasOneWayDirection = directionModes.has("one-way");
  const hasBothDirections = directionModes.has("both");
  const activeAirportIdentities = new Set(
    routes.flatMap(({ origin, destination }) => [
      airportExactIdentity(origin),
      airportExactIdentity(destination),
    ]),
  );
  const hasActiveAirports = activeAirportIdentities.size > 0;
  const hasContextAirports = airports.some(
    (airport) => !activeAirportIdentities.has(airportExactIdentity(airport)),
  );
  const entries = [
    hasCommercial && (
      <span key="commercial">
        <i className="legend-route commercial" aria-hidden="true" />
        Commercial route
      </span>
    ),
    hasPrivate && (
      <span key="private">
        <i className="legend-route private" aria-hidden="true" />
        Personal route
      </span>
    ),
    hasFrequencyRange && (
      <span key="frequency">
        <i className="legend-route frequency" aria-hidden="true" />
        More flights
      </span>
    ),
    selectedRouteId && (
      <span key="selected">
        <i className="legend-route selected" aria-hidden="true" />
        Selected route
      </span>
    ),
    hasOneWayDirection && (
      <span key="one-way-direction">
        <i className="legend-direction" aria-hidden="true">
          ➤
        </i>
        One-way route
      </span>
    ),
    hasBothDirections && (
      <span key="both-directions">
        <i className="legend-direction" aria-hidden="true">
          ↔
        </i>
        Both directions
      </span>
    ),
    hasActiveAirports && (
      <span key="active-airport">
        <i
          className="legend-airport active"
          aria-hidden="true"
          style={{
            background: AIRPORT_MARKER_COLORS.active,
            borderColor: AIRPORT_MARKER_COLORS.activeHalo,
          }}
        />
        Flown airport
      </span>
    ),
    hasContextAirports && (
      <span key="context-airport">
        <i className="legend-airport context" aria-hidden="true" />
        Context airport
      </span>
    ),
  ].filter(Boolean);

  if (entries.length === 0) return null;

  return (
    <aside className="map-legend panel-surface" aria-labelledby="legend-title">
      <div className="legend-heading">
        <strong id="legend-title">Map legend</strong>
      </div>
      <div className="legend-groups">{entries}</div>
    </aside>
  );
}
