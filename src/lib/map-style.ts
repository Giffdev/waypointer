import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  HillshadeLayerSpecification,
  LineLayerSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from "maplibre-gl";
import type { FlightKind } from "./flight-data";
import { DIRECTION_ICON_IDS } from "./map-icons";
import type { MapViewMode } from "./map-view-mode";

export const ROUTE_LAYER_IDS = {
  selected: "flight-routes-selected",
  commercial: "flight-routes-commercial",
  private: "flight-routes-private",
  hitbox: "flight-routes-hitbox",
  labels: "flight-route-labels",
  direction: "flight-route-direction",
  selectedDirection: "flight-route-selected-direction",
} as const;

export const TERRAIN_RELIEF_MIN_ZOOM = 7;

/**
 * Single source of truth for the shaded-relief layer id, shared by the layer
 * builder and by the runtime teardown that removes the layer when the map
 * leaves 3D mode, so the two can never drift apart.
 */
export const TERRAIN_RELIEF_LAYER_ID = "flight-map-hillshade";

export const AIRPORT_LAYER_IDS = {
  markers: "flight-airports",
  hubLabels: "flight-airport-hub-labels",
  labels: "flight-airport-labels",
} as const;

/**
 * Overflown route waypoints — their own layers, on their own sources.
 *
 * Kept apart from `ROUTE_LAYER_IDS`/`AIRPORT_LAYER_IDS` on purpose. Those
 * carry visit and frequency semantics: route strength counts flights, airport
 * markers mean "you have been here", and the legend says so. A waypoint is a
 * place a flight passed over. Sharing a layer would make it inherit a meaning
 * it does not have, so it renders dashed and hollow, and nothing that counts
 * anything reads these sources.
 */
export const OVERFLOWN_LAYER_IDS = {
  paths: "flight-overflown-paths",
  waypoints: "flight-overflown-waypoints",
  waypointLabels: "flight-overflown-waypoint-labels",
} as const;

/** Hollow, dashed, and dimmer than a flown route: passed over, not flown to. */
export const OVERFLOWN_PATH_COLOR = "#8fb8c9";

export function buildOverflownPathLayer(source: string): LineLayerSpecification {
  return {
    id: OVERFLOWN_LAYER_IDS.paths,
    type: "line",
    source,
    filter: ["==", ["get", "hasWaypoints"], true],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": OVERFLOWN_PATH_COLOR,
      "line-opacity": 0.75,
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 1.1, 8, 2.2],
      "line-dasharray": [2, 2],
    },
  };
}

export function buildOverflownWaypointLayers(
  source: string,
): [CircleLayerSpecification, SymbolLayerSpecification] {
  return [
    {
      id: OVERFLOWN_LAYER_IDS.waypoints,
      type: "circle",
      source,
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 3, 8, 5.5],
        "circle-stroke-color": OVERFLOWN_PATH_COLOR,
        "circle-stroke-width": 1.5,
        "circle-opacity": 1,
      },
    },
    {
      id: OVERFLOWN_LAYER_IDS.waypointLabels,
      type: "symbol",
      source,
      minzoom: 3.5,
      layout: {
        "text-field": ["get", "code"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": OVERFLOWN_PATH_COLOR,
        "text-halo-color": "rgba(7, 26, 39, 0.85)",
        "text-halo-width": 1.2,
      },
    },
  ];
}

export function withGlobeProjection(style: StyleSpecification): StyleSpecification {
  return withMapProjection(style, "globe");
}

export function withMapProjection(
  style: StyleSpecification,
  mode: MapViewMode,
): StyleSpecification {
  return {
    ...style,
    projection: { type: mode === "globe" ? "globe" : "mercator" },
  };
}

export function buildTerrainReliefLayer(source: string): HillshadeLayerSpecification {
  return {
    id: TERRAIN_RELIEF_LAYER_ID,
    type: "hillshade",
    source,
    minzoom: TERRAIN_RELIEF_MIN_ZOOM,
    paint: {
      "hillshade-exaggeration": 0.26,
      "hillshade-shadow-color": "#30434a",
      "hillshade-highlight-color": "#f3ead7",
      "hillshade-accent-color": "#7b8f8f",
    },
  };
}

/**
 * Single source of truth for the rendered airport marker colors, shared with
 * `MapLegend` so the legend swatch can never silently drift from the actual
 * on-map circle-color paint expression below (see AIRPORT_MARKER_COLORS.active).
 */
export const AIRPORT_MARKER_COLORS = {
  active: "#087b8f",
  activeHalo: "rgba(8, 123, 143, 0.28)",
  context: "rgba(255,255,255,0.08)",
  contextStroke: "#174b58",
} as const;

export function buildAirportMarkerLayer(source: string): CircleLayerSpecification {
  return {
    id: AIRPORT_LAYER_IDS.markers,
    type: "circle",
    source,
    minzoom: 1,
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        1,
        ["case", ["get", "isActive"], 5.2, 3.8],
        10,
        ["case", ["get", "isActive"], 8.4, 6.2],
      ],
      "circle-color": [
        "case",
        ["get", "isActive"],
        AIRPORT_MARKER_COLORS.active,
        AIRPORT_MARKER_COLORS.context,
      ],
      "circle-stroke-color": [
        "case",
        ["get", "isActive"],
        "#f7ffff",
        AIRPORT_MARKER_COLORS.contextStroke,
      ],
      "circle-stroke-width": [
        "case",
        ["get", "isActive"],
        2.1,
        1.6,
      ],
      "circle-opacity": ["case", ["get", "isActive"], 0.96, 0.82],
    },
  };
}

export function buildAirportLabelLayer(
  source: string,
  id: string,
  minzoom: number,
  filter?: unknown[],
  maxzoom?: number,
): SymbolLayerSpecification {
  return {
    id,
    type: "symbol",
    source,
    minzoom,
    ...(maxzoom === undefined ? {} : { maxzoom }),
    ...(filter === undefined ? {} : { filter: filter as never }),
    layout: {
      "text-field": ["concat", ["get", "code"], " · ", ["get", "name"]],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 0, 10, 10, 13],
      "text-offset": [0, 1.15],
      "text-anchor": "top",
      "text-optional": true,
      "text-padding": 5,
      "symbol-sort-key": ["-", ["get", "traffic"]],
    },
    paint: {
      "text-color": "#102b35",
      "text-halo-color": "rgba(255, 255, 255, 0.94)",
      "text-halo-width": 1.4,
    },
  };
}

export function buildFlightRouteLayers(source: string): LineLayerSpecification[] {
  const routeOffset = regionalRouteOffset();

  return [
    {
      id: ROUTE_LAYER_IDS.commercial,
      type: "line",
      source,
      filter: ["==", ["get", "kind"], "commercial"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "interpolate",
          ["linear"],
          ["get", "strength"],
          0,
          "#246c72",
          1,
          "#19efd6",
        ],
        "line-opacity": routeLineOpacity("commercial"),
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          0,
          ["interpolate", ["linear"], ["get", "strength"], 0, 1.1, 1, 3.6],
          8,
          ["interpolate", ["linear"], ["get", "strength"], 0, 1.6, 1, 3.2],
        ],
        "line-offset": routeOffset,
      },
    },
    {
      id: ROUTE_LAYER_IDS.private,
      type: "line",
      source,
      filter: ["==", ["get", "kind"], "private"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "interpolate",
          ["linear"],
          ["get", "strength"],
          0,
          "#9a6f24",
          1,
          "#ffd166",
        ],
        "line-opacity": routeLineOpacity("private"),
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          0,
          ["interpolate", ["linear"], ["get", "strength"], 0, 1.1, 1, 3.4],
          8,
          ["interpolate", ["linear"], ["get", "strength"], 0, 1.6, 1, 3.1],
        ],
        "line-dasharray": [2.2, 1.45],
        "line-offset": routeOffset,
      },
    },
    {
      id: ROUTE_LAYER_IDS.selected,
      type: "line",
      source,
      filter: ["==", ["get", "id"], "__none__"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "match",
          ["get", "kind"],
          "private",
          "#fff0b3",
          "#bafff6",
        ],
        "line-opacity": 0.98,
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 5, 8, 8, 14, 11],
        "line-offset": routeOffset,
      },
    },
    {
      id: ROUTE_LAYER_IDS.hitbox,
      type: "line",
      source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-opacity": 0.01,
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 7, 8, 15],
        "line-offset": routeOffset,
      },
    },
  ];
}

/**
 * Selected-route label. `text-field` renders through MapLibre's glyph
 * pipeline, so it deliberately reads the arrow-free `mapSafeRouteLabel`
 * property: the direction cue characters used in DOM surfaces are outside
 * the default Noto Sans glyph ranges served by the basemap and would render
 * as an unrelated fallback shape. Direction on the map is communicated by
 * the raster geometry icons in `buildRouteDirectionLayers`.
 */
export function buildRouteLabelLayer(source: string): SymbolLayerSpecification {
  return {
    id: ROUTE_LAYER_IDS.labels,
    type: "symbol",
    source,
    minzoom: 7,
    filter: ["==", ["get", "id"], "__none__"],
    layout: {
      "symbol-placement": "line-center",
      "text-field": ["get", "mapSafeRouteLabel"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10, 12, 12],
      "text-optional": true,
      "text-padding": 9,
      "symbol-sort-key": ["-", ["get", "flightCount"]],
    },
    paint: {
      "text-color": [
        "match",
        ["get", "kind"],
        "private",
        "#76540c",
        "#0c5e69",
      ],
      "text-halo-color": "rgba(255, 255, 255, 0.96)",
      "text-halo-width": 1.6,
    },
  };
}

export function buildRouteDirectionLayers(
  source: string,
): SymbolLayerSpecification[] {
  const iconImage: ExpressionSpecification = [
    "match",
    ["get", "directionMode"],
    "one-way",
    [
      "match",
      ["get", "kind"],
      "private",
      DIRECTION_ICON_IDS.oneWayPrivate,
      DIRECTION_ICON_IDS.oneWayCommercial,
    ],
    "both",
    [
      "match",
      ["get", "kind"],
      "private",
      DIRECTION_ICON_IDS.bothPrivate,
      DIRECTION_ICON_IDS.bothCommercial,
    ],
    "",
  ];
  const layout: SymbolLayerSpecification["layout"] = {
    "symbol-placement": "line-center",
    "icon-image": iconImage,
    "icon-rotation-alignment": "map",
    "icon-pitch-alignment": "map",
    "icon-keep-upright": false,
    "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.56, 7, 0.82],
    "icon-allow-overlap": false,
    "icon-ignore-placement": false,
    "icon-optional": true,
    "icon-padding": 5,
  };
  const paint: SymbolLayerSpecification["paint"] = {
    "icon-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.62, 7, 0.9],
  };
  return [
    {
      id: ROUTE_LAYER_IDS.direction,
      type: "symbol",
      source,
      minzoom: 1,
      filter: ["!=", ["get", "directionMode"], "none"],
      layout,
      paint,
    },
    {
      id: ROUTE_LAYER_IDS.selectedDirection,
      type: "symbol",
      source,
      minzoom: 1,
      filter: [
        "all",
        ["==", ["get", "id"], "__none__"],
        ["!=", ["get", "directionMode"], "none"],
      ],
      layout: {
        ...layout,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.7, 7, 1.05],
        "icon-offset": [0, -16],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-optional": false,
      },
      paint: {
        ...paint,
        "icon-opacity": 1,
      },
    },
  ];
}

export function routeLineOpacity(kind: FlightKind): ExpressionSpecification {
  const lowZoomMinimum = kind === "commercial" ? 0.32 : 0.38;
  const lowZoomMaximum = kind === "commercial" ? 0.94 : 0.96;
  const regionalMinimum = kind === "commercial" ? 0.68 : 0.7;

  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    0,
    [
      "interpolate",
      ["linear"],
      ["get", "strength"],
      0,
      lowZoomMinimum,
      1,
      lowZoomMaximum,
    ],
    7,
    [
      "interpolate",
      ["linear"],
      ["get", "strength"],
      0,
      regionalMinimum,
      1,
      0.98,
    ],
  ];
}

function regionalRouteOffset(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    5,
    0,
    8,
    ["*", ["get", "laneOffset"], 1],
    12,
    ["*", ["get", "laneOffset"], 1.4],
  ];
}
