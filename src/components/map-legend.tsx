import type { Airport, MapRoute } from "@/lib/flight-data";
import { routeDirectionVisibility } from "@/lib/map-geojson";

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
  const directionVisibility = routeDirectionVisibility(routes);
  const hasDirection =
    [...directionVisibility.values()].some(Boolean) || Boolean(selectedRouteId);
  const activeAirportCodes = new Set(
    routes.flatMap(({ origin, destination }) => [origin.code, destination.code]),
  );
  const hasActiveAirports = activeAirportCodes.size > 0;
  const hasContextAirports = airports.some(
    ({ code }) => !activeAirportCodes.has(code),
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
    hasDirection && (
      <span key="direction">
        <i className="legend-direction" aria-hidden="true">
          ➤
        </i>
        Flight direction
      </span>
    ),
    hasActiveAirports && (
      <span key="active-airport">
        <i className="legend-airport active" aria-hidden="true" />
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
