import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "maplibre-gl";
import {
  AIRPORT_LAYER_IDS,
  buildAirportLabelLayer,
  buildAirportMarkerLayer,
  buildFlightRouteLayers,
  buildRouteDirectionLayers,
  buildTerrainReliefLayer,
  ROUTE_LAYER_IDS,
  TERRAIN_RELIEF_MIN_ZOOM,
  withGlobeProjection,
  withMapProjection,
} from "./map-style";

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
    expect(layers[0].layout?.["text-rotation-alignment"]).toBe("map");
    expect(layers[0].filter).toEqual([
      "!=",
      ["get", "directionMode"],
      "none",
    ]);
    expect(layers[0].layout?.["text-field"]).toEqual([
      "get",
      "directionCue",
    ]);
    expect(JSON.stringify(layers[1].filter)).toContain("directionMode");
    expect(layers[1].layout?.["text-allow-overlap"]).toBe(true);
    expect(layers[1].layout?.["text-ignore-placement"]).toBe(true);
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
});
