// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  airportExactIdentity,
  type Airport,
  type MapRoute,
} from "@/lib/flight-data";
import type { MapFrame } from "@/lib/map-framing";
import { DIRECTION_ICON_IDS } from "@/lib/map-icons";
import { TERRAIN_RELIEF_LAYER_ID } from "@/lib/map-style";

const mapMocks = vi.hoisted(() => {
  const instances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const attributionOptions: Array<Record<string, unknown>> = [];
  const mapOptions: Array<Record<string, unknown>> = [];
  return { attributionOptions, instances, mapOptions };
});

vi.mock("maplibre-gl", () => ({
  AttributionControl: class {
    constructor(options: Record<string, unknown>) {
      mapMocks.attributionOptions.push(options);
    }
  },
  ScaleControl: class {},
  Popup: class {
    setLngLat() { return this; }
    setHTML() { return this; }
    addTo() { return this; }
  },
  setWorkerUrl: vi.fn(),
  Map: class {
    constructor(options: Record<string, unknown>) {
      mapMocks.mapOptions.push(options);
      const sourceIds = new Set<string>();
      const layerIds = new Set<string>();
      const imageIds = new Set<string>();
      const methods: Record<string, ReturnType<typeof vi.fn>> = {
        addControl: vi.fn(),
        addImage: vi.fn((id: string) => {
          imageIds.add(id);
        }),
        addLayer: vi.fn((layer: { id: string }) => {
          layerIds.add(layer.id);
        }),
        addSource: vi.fn((id: string) => {
          sourceIds.add(id);
        }),
        cameraForBounds: vi.fn((bounds: [[number, number], [number, number]]) => ({
          center: [
            (bounds[0][0] + bounds[1][0]) / 2,
            (bounds[0][1] + bounds[1][1]) / 2,
          ],
          zoom: 3,
        })),
        easeTo: vi.fn(),
        fitBounds: vi.fn(),
        flyTo: vi.fn(),
        getCanvas: vi.fn(() => ({ style: {} })),
        getCenter: vi.fn(() => ({ lng: 0, lat: 0 })),
        getContainer: vi.fn(() => ({ clientWidth: 1024, clientHeight: 640 })),
        getLayer: vi.fn((id: string) => (layerIds.has(id) ? { id } : undefined)),
        getSource: vi.fn((id: string) =>
          sourceIds.has(id) ? { id, setData: vi.fn() } : undefined,
        ),
        getStyle: vi.fn(() => ({ layers: [] })),
        getZoom: vi.fn(() => 4),
        hasImage: vi.fn((id: string) => imageIds.has(id)),
        jumpTo: vi.fn(),
        off: vi.fn(),
        on: vi.fn(),
        once: vi.fn((event: string, callback: () => void) => {
          if (event === "load" || event === "moveend") queueMicrotask(callback);
        }),
        queryRenderedFeatures: vi.fn(() => []),
        remove: vi.fn(),
        removeLayer: vi.fn((id: string) => {
          layerIds.delete(id);
        }),
        removeSource: vi.fn((id: string) => {
          sourceIds.delete(id);
        }),
        resize: vi.fn(),
        setCenter: vi.fn(),
        setFilter: vi.fn(),
        setLayoutProperty: vi.fn(),
        setPaintProperty: vi.fn(),
        setProjection: vi.fn(),
        stop: vi.fn(),
      };
      mapMocks.instances.push(methods);
      return methods;
    }
  },
}));

import FlightGlobe from "./flight-globe";

const origin: Airport = {
  code: "AAA",
  name: "Alpha",
  city: "Alpha",
  country: "US",
  lat: 10,
  lon: 20,
  facility: "commercial",
};
const destination: Airport = {
  code: "DDD",
  name: "Delta",
  city: "Delta",
  country: "US",
  lat: 30,
  lon: 40,
  facility: "general-aviation",
};
const route: MapRoute = {
  id: "route",
  origin,
  destination,
  kind: "private",
  flightCount: 1,
};
const originIdentity = airportExactIdentity(origin);
const homeFrame: MapFrame = {
  center: [5, 6],
  zoom: 3,
  bounds: [[-10, -10], [10, 10]],
  scope: "regional",
  confidence: 1,
};

beforeEach(() => {
  mapMocks.attributionOptions.length = 0;
  mapMocks.instances.length = 0;
  mapMocks.mapOptions.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      version: 8,
      sources: {
        openmaptiles: {
          type: "vector",
          url: "https://tiles.openfreemap.org/planet",
        },
      },
      layers: [],
    }),
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FlightGlobe reduced motion", () => {
  it("keeps required map attribution compact and persistent without unnecessary branding text", async () => {
    installMatchMedia(false);

    render(<FlightGlobe {...defaultProps()} />);
    await readyMap();

    expect(mapMocks.attributionOptions).toEqual([
      {
        compact: false,
        customAttribution: expect.stringContaining("OpenStreetMap"),
      },
    ]);
    expect(mapMocks.mapOptions[0]).toMatchObject({
      style: {
        sources: {
          openmaptiles: {
            attribution: expect.stringContaining("OpenStreetMap"),
          },
        },
      },
    });
    expect(
      screen.queryByText(/Mapzen Terrarium/),
    ).not.toBeInTheDocument();
    const summary = screen.getByText("Terrain data credits");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(summary.closest(".terrain-attribution")).toBeVisible();
    expect(mapMocks.attributionOptions[0]?.customAttribution)
      .not.toContain("OpenFreeMap");
    expect(
      screen.getByText(/ArcticDEM terrain data DEM\(s\) were created from/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/DigitalGlobe, Inc\., imagery/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/3DEP \(formerly NED\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Full terrain provider attribution (joerd)" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
    );
  });

  it("omits the shaded-relief terrain source and the full required upstream terrain attribution when starting in flat map mode (no DEM in use)", async () => {
    installMatchMedia(false);

    render(<FlightGlobe {...defaultProps()} viewMode="flat" />);
    const map = await readyMap();

    expect(
      map.addSource.mock.calls.some(
        (call: unknown[]) => call[0] === "flight-map-terrain",
      ),
    ).toBe(false);
    expect(
      screen.queryByText("Terrain data credits"),
    ).not.toBeInTheDocument();
    // The full required upstream-provider attribution text must not be
    // rendered at all when no DEM/terrain source is in use, since it would
    // be misleading to credit data that flat mode never fetches.
    expect(screen.queryByText(/3DEP \(formerly NED\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Kartverket/)).not.toBeInTheDocument();
  });

  it("adds and removes the shaded-relief terrain source and the full required upstream terrain attribution as the view mode pivots between 3D globe (DEM active) and flat map (no DEM)", async () => {
    installMatchMedia(false);

    const props = defaultProps();
    const view = render(<FlightGlobe {...props} />);
    const map = await readyMap();

    expect(screen.getByText("Terrain data credits")).toBeInTheDocument();
    // While the DEM/terrain source is active (3D globe), the full required
    // upstream-provider attribution text must be reachable, not just a
    // generic summary link.
    expect(screen.getByText(/3DEP \(formerly NED\)/)).toBeInTheDocument();
    expect(screen.getByText(/Kartverket/)).toBeInTheDocument();
    const terrainAddCallsBeforeToggle = map.addSource.mock.calls.filter(
      (call: unknown[]) => call[0] === "flight-map-terrain",
    ).length;
    expect(terrainAddCallsBeforeToggle).toBe(1);

    view.rerender(<FlightGlobe {...props} viewMode="flat" />);
    await waitFor(() =>
      expect(map.removeSource).toHaveBeenCalledWith("flight-map-terrain"),
    );
    expect(map.removeLayer).toHaveBeenCalledWith("flight-map-hillshade");
    // The removal must target the id the style module actually builds, so a
    // rename in one place can never orphan the layer in the other.
    expect(map.removeLayer).toHaveBeenCalledWith(TERRAIN_RELIEF_LAYER_ID);
    expect(
      screen.queryByText("Terrain data credits"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/3DEP \(formerly NED\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Kartverket/)).not.toBeInTheDocument();

    view.rerender(<FlightGlobe {...props} viewMode="globe" />);
    await waitFor(() => {
      const terrainAddCallsAfterToggle = map.addSource.mock.calls.filter(
        (call: unknown[]) => call[0] === "flight-map-terrain",
      ).length;
      expect(terrainAddCallsAfterToggle).toBe(2);
    });
    expect(screen.getByText("Terrain data credits")).toBeInTheDocument();
    expect(screen.getByText(/3DEP \(formerly NED\)/)).toBeInTheDocument();
    expect(screen.getByText(/Kartverket/)).toBeInTheDocument();
  });

  it("computes shaded relief before updating state, keeping map mutation out of the React updater", async () => {
    const component = readFileSync(
      resolve(process.cwd(), "src/components/flight-globe.tsx"),
      "utf8",
    );

    // React may invoke a state updater more than once (and at an arbitrary
    // later time), so the MapLibre mutation must run eagerly in the effect
    // and only its result may be pushed into state.
    expect(component).not.toMatch(/setTerrainActive\([^)]*=>/);
    expect(component).toMatch(
      /const active = addShadedRelief\(map\);\s*setTerrainActive\(active\);/,
    );
  });

  it("restores a shaded-relief layer dropped by a style reload instead of trusting the surviving DEM source", async () => {
    installMatchMedia(false);

    render(<FlightGlobe {...defaultProps()} />);
    const map = await readyMap();

    const hillshadeAdds = () =>
      map.addLayer.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as { id?: string } | undefined)?.id === TERRAIN_RELIEF_LAYER_ID,
      ).length;
    expect(hillshadeAdds()).toBe(1);

    const styleLoad = map.on.mock.calls.find(
      (call: unknown[]) => call[0] === "style.load",
    )?.[1] as (() => void) | undefined;
    expect(typeof styleLoad).toBe("function");

    // A style reload discards layers while the DEM source object survives:
    // the terrain credit is only truthful if the hillshade layer is rebuilt.
    map.removeLayer(TERRAIN_RELIEF_LAYER_ID);
    await act(async () => {
      styleLoad?.();
    });

    expect(hillshadeAdds()).toBe(2);
    expect(map.getLayer(TERRAIN_RELIEF_LAYER_ID)).toBeTruthy();
    expect(screen.getByText("Terrain data credits")).toBeInTheDocument();
    expect(screen.getByText(/3DEP \(formerly NED\)/)).toBeInTheDocument();
  });

  it("withholds terrain credits when the DEM source cannot be created, leaving no half-built relief stack", async () => {
    installMatchMedia(false);

    const props = defaultProps();
    const view = render(<FlightGlobe {...props} viewMode="flat" />);
    const map = await readyMap();

    expect(screen.queryByText("Terrain data credits")).not.toBeInTheDocument();
    map.addSource.mockImplementation((id: string) => {
      if (id === "flight-map-terrain") throw new Error("DEM unavailable");
    });

    view.rerender(<FlightGlobe {...props} viewMode="globe" />);
    await waitFor(() =>
      expect(map.setProjection).toHaveBeenCalledWith({ type: "globe" }),
    );

    // The credit line describes real DEM activity, so a failed activation
    // must not leave it on screen, and no hillshade layer may be left behind.
    expect(screen.queryByText("Terrain data credits")).not.toBeInTheDocument();
    expect(screen.queryByText(/3DEP \(formerly NED\)/)).not.toBeInTheDocument();
    expect(
      map.addLayer.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { id?: string } | undefined)?.id === TERRAIN_RELIEF_LAYER_ID,
      ),
    ).toBe(false);
    expect(map.getLayer(TERRAIN_RELIEF_LAYER_ID)).toBeUndefined();
  });

  it("registers all four route-direction icons once, instead of relying on text glyphs", async () => {
    installMatchMedia(false);

    render(<FlightGlobe {...defaultProps()} />);
    const map = await readyMap();

    const registeredIds = map.addImage.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(new Set(registeredIds)).toEqual(
      new Set([
        DIRECTION_ICON_IDS.oneWayPrivate,
        DIRECTION_ICON_IDS.oneWayCommercial,
        DIRECTION_ICON_IDS.bothPrivate,
        DIRECTION_ICON_IDS.bothCommercial,
      ]),
    );
    expect(map.addImage).toHaveBeenCalledTimes(4);
    // Each registered id must report itself present to `hasImage`, matching
    // the `if (!map.hasImage(id)) map.addImage(id, image)` guard that keeps
    // re-registration on later style reloads from throwing.
    const hasImage = map.hasImage as unknown as (id: string) => boolean;
    for (const id of registeredIds) {
      expect(hasImage(id as string)).toBe(true);
    }
  });

  it("uses immediate camera updates while preserving every final state", async () => {
    installMatchMedia(true);
    const props = defaultProps();
    const view = render(<FlightGlobe {...props} />);
    const map = await readyMap();

    expect(map.jumpTo).toHaveBeenCalled();
    expect(map.flyTo).not.toHaveBeenCalled();

    view.rerender(
      <FlightGlobe {...props} focusAirportCode={originIdentity} />,
    );
    await waitFor(() =>
      expect(map.jumpTo).toHaveBeenCalledWith({
        center: [20, 10],
        zoom: 8,
      }),
    );

    view.rerender(
      <FlightGlobe
        {...props}
        focusAirportCode=""
        selectedRouteId="route"
      />,
    );
    await waitFor(() =>
      expect(map.fitBounds).toHaveBeenCalledWith(
        [[20, 10], [40, 30]],
        expect.objectContaining({ duration: 0 }),
      ),
    );

    view.rerender(
      <FlightGlobe {...props} viewMode="flat" zoom={7} zoomCommandToken={1} />,
    );
    await waitFor(() => {
      expect(map.setProjection).toHaveBeenCalledWith({ type: "mercator" });
      expect(map.jumpTo).toHaveBeenCalledWith({ zoom: 7 });
    });

    view.rerender(
      <FlightGlobe
        {...props}
        homeFrame={{
          ...homeFrame,
          center: [12, 13],
          bounds: [[11, 12], [13, 14]],
        }}
        resetToken={1}
      />,
    );
    await waitFor(() => {
      expect(map.jumpTo).toHaveBeenCalledWith(
        expect.objectContaining({ center: [12, 13] }),
      );
      expect(map.easeTo).not.toHaveBeenCalled();
      expect(map.flyTo).not.toHaveBeenCalled();
    });
  });

  it("gives a selected route to only the selected direction layer", async () => {
    installMatchMedia(true);
    const props = defaultProps();
    const view = render(<FlightGlobe {...props} />);
    const map = await readyMap();

    view.rerender(<FlightGlobe {...props} selectedRouteId="route" />);

    await waitFor(() =>
      expect(map.setFilter).toHaveBeenCalledWith(
        "flight-route-direction",
        [
          "all",
          ["!=", ["get", "directionMode"], "none"],
          ["!=", ["get", "id"], "route"],
        ],
      ),
    );
    expect(map.setFilter).toHaveBeenCalledWith(
      "flight-route-selected-direction",
      [
        "all",
        ["==", ["get", "id"], "route"],
        ["!=", ["get", "directionMode"], "none"],
      ],
    );
  });

  it("animates ordinary navigation without overriding reduced-motion settings", async () => {
    installMatchMedia(false);
    const props = defaultProps();
    const view = render(<FlightGlobe {...props} />);
    const map = await readyMap();

    view.rerender(
      <FlightGlobe {...props} focusAirportCode={originIdentity} />,
    );
    await waitFor(() =>
      expect(map.flyTo).toHaveBeenCalledWith({
        center: [20, 10],
        zoom: 8,
        duration: 900,
      }),
    );

    view.rerender(
      <FlightGlobe {...props} focusAirportCode="" zoom={7} zoomCommandToken={1} />,
    );
    await waitFor(() =>
      expect(map.easeTo).toHaveBeenCalledWith({ zoom: 7, duration: 240 }),
    );
    expect(JSON.stringify(map.flyTo.mock.calls)).not.toContain("essential");
  });
});

function defaultProps() {
  return {
    airports: [origin, destination],
    routes: [route],
    visibleKind: "all" as const,
    zoom: 4,
    zoomCommandToken: 0,
    focusAirportCode: "",
    selectedRouteId: "",
    resetToken: 0,
    homeFrame,
    autoRotate: false,
    viewMode: "globe" as const,
    onSelectAirport: vi.fn(),
    onSelectRoute: vi.fn(),
    onZoomChange: vi.fn(),
  };
}

async function readyMap() {
  await waitFor(() => expect(mapMocks.instances).toHaveLength(1));
  const map = mapMocks.instances[0];
  await waitFor(() => expect(map.setProjection).toHaveBeenCalled());
  return map;
}

function installMatchMedia(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}
