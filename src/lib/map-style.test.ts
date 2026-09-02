import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "maplibre-gl";
import { airports, type MapRoute } from "./flight-data";
import { createRouteFeatureCollection } from "./map-geojson";
import {
  createDirectionIconImage,
  DIRECTION_ICON_COLORS,
  DIRECTION_ICON_IDS,
  type DirectionIconImage,
} from "./map-icons";
import {
  AIRPORT_LAYER_IDS,
  AIRPORT_MARKER_COLORS,
  buildAirportLabelLayer,
  buildAirportMarkerLayer,
  buildFlightRouteLayers,
  buildRouteDirectionLayers,
  buildRouteLabelLayer,
  buildTerrainReliefLayer,
  ROUTE_LAYER_IDS,
  TERRAIN_RELIEF_LAYER_ID,
  TERRAIN_RELIEF_MIN_ZOOM,
  withGlobeProjection,
  withMapProjection,
} from "./map-style";

/** U+27A4 (➤) and U+2194 (↔) - the Unicode direction cues used in the DOM. */
const DIRECTION_CUE_PATTERN = /[\u27a4\u2194]/u;

/**
 * Collects every feature property a layer's `text-field` reads, so the test
 * can assert on the actual strings MapLibre would hand to the glyph pipeline.
 */
function textFieldProperties(layers: Array<{ layout?: Record<string, unknown> }>): string[] {
  const properties = new Set<string>();
  const walk = (expression: unknown) => {
    if (!Array.isArray(expression)) return;
    if (expression[0] === "get" && typeof expression[1] === "string") {
      properties.add(expression[1]);
      return;
    }
    for (const part of expression) walk(part);
  };
  for (const layer of layers) walk(layer.layout?.["text-field"]);
  return [...properties];
}

/**
 * Evaluates the nested `["match", ["get", key], ...]` expressions used for
 * `icon-image` against a plain feature-properties object, without needing a
 * real MapLibre map instance.
 */
function evaluateMatchExpression(
  expression: unknown,
  properties: Record<string, string>,
): unknown {
  if (!Array.isArray(expression)) return expression;
  const [operator, getExpression, ...rest] = expression;
  if (operator !== "match") return expression;
  const [, key] = getExpression as ["get", string];
  const value = properties[key];
  for (let index = 0; index < rest.length - 1; index += 2) {
    if (rest[index] === value) {
      return evaluateMatchExpression(rest[index + 1], properties);
    }
  }
  return evaluateMatchExpression(rest[rest.length - 1], properties);
}

function isPointSymmetric(image: DirectionIconImage): boolean {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const alpha = image.data[(y * image.width + x) * 4 + 3];
      const mirroredX = image.width - 1 - x;
      const mirroredY = image.height - 1 - y;
      const mirroredAlpha =
        image.data[(mirroredY * image.width + mirroredX) * 4 + 3];
      if (Math.abs(alpha - mirroredAlpha) > 2) return false;
    }
  }
  return true;
}

describe("cartographic map style", () => {
  it("starts in globe projection without discarding provider layers", () => {
    const style: StyleSpecification = {
      version: 8,
      projection: { type: "mercator" },
      sources: {},
      layers: [{ id: "ocean", type: "background" }],
    };

    const result = withGlobeProjection(style);

    expect(result.projection).toEqual({ type: "globe" });
    expect(result.layers).toBe(style.layers);
    expect(style.projection).toEqual({ type: "mercator" });
  });

  it("uses Web Mercator for flat mode and restores the chosen projection on style rebuild", () => {
    const style: StyleSpecification = {
      version: 8,
      sources: {},
      layers: [{ id: "ocean", type: "background" }],
    };

    expect(withMapProjection(style, "flat").projection).toEqual({
      type: "mercator",
    });
    expect(withMapProjection(style, "flat")).toEqual(
      withMapProjection(style, "flat"),
    );
    expect(withMapProjection(style, "globe").projection).toEqual({
      type: "globe",
    });
  });

  it("builds route layers that pass MapLibre style-expression validation", () => {
    const style: StyleSpecification = {
      version: 8,
      sources: {
        routes: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers: buildFlightRouteLayers("routes"),
    };

    expect(validateStyleMin(style)).toEqual([]);
    expect(style.layers.map(({ id }) => id)).toEqual([
      ROUTE_LAYER_IDS.commercial,
      ROUTE_LAYER_IDS.private,
      ROUTE_LAYER_IDS.selected,
      ROUTE_LAYER_IDS.hitbox,
    ]);
  });

  it("keeps category and frequency encodings in the built MapLibre layers", () => {
    const layers = buildFlightRouteLayers("routes");
    const commercial = layers.find(({ id }) => id === ROUTE_LAYER_IDS.commercial)!;
    const personal = layers.find(({ id }) => id === ROUTE_LAYER_IDS.private)!;

    expect(commercial.filter).toEqual(["==", ["get", "kind"], "commercial"]);
    expect(personal.filter).toEqual(["==", ["get", "kind"], "private"]);
    expect(commercial.paint?.["line-dasharray"]).toBeUndefined();
    expect(personal.paint?.["line-dasharray"]).toEqual([2.2, 1.45]);
    expect(JSON.stringify(commercial.paint?.["line-width"])).toContain(
      JSON.stringify(["get", "strength"]),
    );
    expect(JSON.stringify(personal.paint?.["line-width"])).toContain(
      JSON.stringify(["get", "strength"]),
    );
  });

  it("builds truthful midpoint direction layers with selected-route priority", () => {
    const layers = buildRouteDirectionLayers("routes");
    const style: StyleSpecification = {
      version: 8,
      sources: {
        routes: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers,
    };

    expect(validateStyleMin(style)).toEqual([]);
    expect(layers.map(({ id }) => id)).toEqual([
      ROUTE_LAYER_IDS.direction,
      ROUTE_LAYER_IDS.selectedDirection,
    ]);
    expect(layers[0].layout?.["symbol-placement"]).toBe("line-center");
    expect(layers[0].layout?.["icon-rotation-alignment"]).toBe("map");
    expect(layers[0].layout?.["icon-keep-upright"]).toBe(false);
    expect(layers[0].filter).toEqual([
      "!=",
      ["get", "directionMode"],
      "none",
    ]);
    expect(JSON.stringify(layers[1].filter)).toContain("directionMode");
    expect(layers[1].layout?.["icon-allow-overlap"]).toBe(true);
    expect(layers[1].layout?.["icon-ignore-placement"]).toBe(true);
  });

  it("selects a distinct on-map direction icon per direction mode and route kind, never falling back to text glyphs", () => {
    const [layer] = buildRouteDirectionLayers("routes");
    const iconImage = layer.layout?.["icon-image"];

    // The on-map cue must not rely on rendering a Unicode arrow character
    // through the vector-tile glyph/font pipeline: no text-field/text-font
    // should be present on the direction layers at all.
    expect(layer.layout?.["text-field"]).toBeUndefined();
    expect(layer.layout?.["text-font"]).toBeUndefined();

    for (const [directionMode, kind, expectedId] of [
      ["one-way", "private", DIRECTION_ICON_IDS.oneWayPrivate],
      ["one-way", "commercial", DIRECTION_ICON_IDS.oneWayCommercial],
      ["both", "private", DIRECTION_ICON_IDS.bothPrivate],
      ["both", "commercial", DIRECTION_ICON_IDS.bothCommercial],
    ] as const) {
      expect(
        evaluateMatchExpression(iconImage, { directionMode, kind }),
      ).toBe(expectedId);
    }
    // A route with no meaningful direction (same-airport loop) must resolve
    // to no icon, matching the layer's own `directionMode !== "none"` filter.
    expect(
      evaluateMatchExpression(iconImage, {
        directionMode: "none",
        kind: "commercial",
      }),
    ).toBe("");
  });

  it("generates a one-way icon that is not point-symmetric and a bidirectional icon that is", () => {
    const oneWay = createDirectionIconImage(
      "one-way",
      DIRECTION_ICON_COLORS.commercial,
    );
    const both = createDirectionIconImage(
      "both",
      DIRECTION_ICON_COLORS.commercial,
    );

    expect(isPointSymmetric(oneWay)).toBe(false);
    expect(isPointSymmetric(both)).toBe(true);
  });

  it("rebuilds direction layers deterministically for style reloads", () => {
    expect(buildRouteDirectionLayers("routes")).toEqual(
      buildRouteDirectionLayers("routes"),
    );
  });

  it("loads detailed DEM relief only after the low-zoom shaded basemap", () => {
    const terrain = buildTerrainReliefLayer("terrain");

    expect(terrain.minzoom).toBe(TERRAIN_RELIEF_MIN_ZOOM);
    expect(terrain.minzoom).toBe(7);
    expect(terrain.type).toBe("hillshade");
    expect(terrain.source).toBe("terrain");
  });

  it("publishes one shared shaded-relief layer id that the map runtime removes by, so the two cannot drift", () => {
    expect(buildTerrainReliefLayer("terrain").id).toBe(TERRAIN_RELIEF_LAYER_ID);
    expect(TERRAIN_RELIEF_LAYER_ID).toBe("flight-map-hillshade");

    // The component must not re-declare the id: it has to import the shared
    // constant, otherwise a rename here would silently leave an orphaned
    // hillshade layer (and a stale terrain credit) behind in flat mode.
    const component = readFileSync(
      new URL("../components/flight-globe.tsx", import.meta.url),
      "utf8",
    );
    expect(component).toContain("TERRAIN_RELIEF_LAYER_ID");
    expect(component).not.toContain('"flight-map-hillshade"');
  });

  it("never sends a Unicode direction cue character through a map text-field", () => {
    const labelLayers = [
      buildRouteLabelLayer("routes"),
      ...buildRouteDirectionLayers("routes"),
      buildAirportLabelLayer(
        "airports",
        AIRPORT_LAYER_IDS.hubLabels,
        0,
        ["==", ["get", "isHub"], true],
        4.5,
      ),
      buildAirportLabelLayer("airports", AIRPORT_LAYER_IDS.labels, 4.5),
    ];
    const properties = textFieldProperties(labelLayers);

    // The selected-route label must read the map-safe property, never the
    // arrow-bearing DOM label/title.
    expect(properties).toContain("mapSafeRouteLabel");
    expect(properties).not.toContain("routeLabel");
    expect(properties).not.toContain("routeTitle");
    expect(properties).not.toContain("directionDetail");

    const oneWay: MapRoute = {
      id: "one-way",
      origin: airports.SEA,
      destination: airports.PAE,
      kind: "commercial",
      flightCount: 4,
      forwardFlightCount: 4,
      reverseFlightCount: 0,
    };
    const bidirectional: MapRoute = {
      id: "both",
      origin: airports.PAE,
      destination: airports.SEA,
      kind: "private",
      flightCount: 5,
      forwardFlightCount: 3,
      reverseFlightCount: 2,
    };
    const features = createRouteFeatureCollection([oneWay, bidirectional]).features;

    for (const feature of features) {
      for (const property of properties) {
        const value = (feature.properties as Record<string, unknown>)[property];
        if (typeof value !== "string") continue;
        expect(value).not.toMatch(DIRECTION_CUE_PATTERN);
      }
    }

    // Discriminating counterpart: the DOM-facing strings still carry the
    // cues, so the loop above would fail the moment a text-field is pointed
    // back at them. Direction on the map stays with the raster icons.
    expect(features[0].properties.routeTitle).toMatch(DIRECTION_CUE_PATTERN);
    expect(features[1].properties.routeLabel).toMatch(DIRECTION_CUE_PATTERN);
    expect(features[1].properties.directionDetail).toMatch(DIRECTION_CUE_PATTERN);
    expect(features[0].properties.mapSafeRouteLabel).toBe("SEA-PAE · 4 flights");
    expect(features[1].properties.mapSafeRouteLabel).toBe(
      "PAE-SEA · 5 flights (3 PAE-SEA · 2 SEA-PAE)",
    );
    expect(
      buildRouteLabelLayer("routes").layout?.["text-field"],
    ).toEqual(["get", "mapSafeRouteLabel"]);
    expect(buildRouteLabelLayer("routes").id).toBe(ROUTE_LAYER_IDS.labels);
    expect(
      validateStyleMin({
        version: 8,
        sources: {
          routes: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
        },
        layers: [buildRouteLabelLayer("routes")],
      }),
    ).toEqual([]);
  });

  it("uses one facility-neutral marker and label treatment for every airport", () => {
    const layers = [
      buildAirportMarkerLayer("airports"),
      buildAirportLabelLayer(
        "airports",
        AIRPORT_LAYER_IDS.hubLabels,
        0,
        ["==", ["get", "isHub"], true],
        4.5,
      ),
      buildAirportLabelLayer(
        "airports",
        AIRPORT_LAYER_IDS.labels,
        4.5,
      ),
    ];
    const style: StyleSpecification = {
      version: 8,
      sources: {
        airports: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers,
    };

    expect(validateStyleMin(style)).toEqual([]);
    expect(layers[0].id).toBe(AIRPORT_LAYER_IDS.markers);
    expect(layers[0].filter).toBeUndefined();
    expect(layers[0].minzoom).toBe(1);
    expect(JSON.stringify(layers)).not.toContain("facility");
    expect(JSON.stringify(layers[0].paint)).toContain("isActive");
    expect(layers[0].paint?.["circle-color"]).not.toBe("#147f91");
    expect(layers[2].minzoom).toBe(4.5);
  });

  it("paints flown airports with the exported AIRPORT_MARKER_COLORS.active color", () => {
    // Guards against the marker paint layer and MapLegend's swatch (see
    // map-legend.test.tsx) silently drifting apart: both must import and
    // render the same shared constant rather than independent hex literals.
    const layer = buildAirportMarkerLayer("airports");
    const circleColor = layer.paint?.["circle-color"];
    expect(Array.isArray(circleColor)).toBe(true);
    expect(circleColor).toContain(AIRPORT_MARKER_COLORS.active);
    expect(circleColor).not.toContain("#f0c56b");
  });
});
