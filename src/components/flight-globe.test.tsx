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
import { ROUTE_LAYER_IDS, TERRAIN_RELIEF_LAYER_ID } from "@/lib/map-style";

type StyleLayerStub = { id: string; type: string };
type MapConstructorOptions = Record<string, unknown> & {
  style?: { layers?: StyleLayerStub[] };
};

const mapMocks = vi.hoisted(() => {
  /** Image ids whose `addImage` call must throw, injected per test. */
  const imageFailures = new Set<string>();
  /**
   * MapLibre stand-in that keeps a *real ordered layer list*: `addLayer`
   * honours its `beforeId` argument (and throws for an unknown one, like
   * MapLibre does), `removeLayer` splices, and `getStyle().layers` reports the
   * resulting order. Layer order is a rendering contract here — the shaded
   * relief has to stay underneath the route lines — so a mock that only
   * records "some layer was added" cannot catch the regression.
   */
  const createMapMock = (initialLayers: StyleLayerStub[]) => {
    const layers: StyleLayerStub[] = initialLayers.map((layer) => ({ ...layer }));
    const sourceIds = new Set<string>();
    const imageIds = new Set<string>();
    const indexOfLayer = (id: string) =>
      layers.findIndex((layer) => layer.id === id);

    return {
      addControl: vi.fn(),
      addImage: vi.fn((id: string) => {
        // Registration failures have to be injectable *before* the map is
        // constructed, because the direction icons are installed during the
        // very first style load.
        if (imageFailures.has(id)) {
          throw new Error(`addImage rejected "${id}"`);
        }
        imageIds.add(id);
      }),
      addLayer: vi.fn((layer: StyleLayerStub, beforeId?: string) => {
        if (indexOfLayer(layer.id) !== -1) {
          throw new Error(`Layer "${layer.id}" already exists on this map.`);
        }
        const entry = { id: layer.id, type: layer.type };
        if (beforeId === undefined) {
          layers.push(entry);
          return;
        }
        const before = indexOfLayer(beforeId);
        if (before === -1) {
          throw new Error(`Layer "${beforeId}" does not exist on this map.`);
        }
        layers.splice(before, 0, entry);
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
      getLayer: vi.fn((id: string) => layers.find((layer) => layer.id === id)),
      getSource: vi.fn((id: string) =>
        sourceIds.has(id) ? { id, setData: vi.fn() } : undefined,
      ),
      getStyle: vi.fn(() => ({ layers: layers.map((layer) => ({ ...layer })) })),
      getZoom: vi.fn(() => 4),
      hasImage: vi.fn((id: string) => imageIds.has(id)),
      jumpTo: vi.fn(),
      off: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        void event;
        void handler;
      }),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === "load" || event === "moveend") queueMicrotask(callback);
      }),
      queryRenderedFeatures: vi.fn(() => []),
      remove: vi.fn(),
      removeLayer: vi.fn((id: string) => {
        const index = indexOfLayer(id);
        if (index !== -1) layers.splice(index, 1);
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
  };

  const instances: Array<ReturnType<typeof createMapMock>> = [];
  const attributionOptions: Array<Record<string, unknown>> = [];
  const mapOptions: MapConstructorOptions[] = [];
  return {
    attributionOptions,
    createMapMock,
    imageFailures,
    instances,
    mapOptions,
  };
});

type MapMock = (typeof mapMocks.instances)[number];

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
    constructor(options: MapConstructorOptions) {
      mapMocks.mapOptions.push(options);
      const methods = mapMocks.createMapMock(options.style?.layers ?? []);
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
const BASEMAP_LAYERS = [
  { id: "basemap-background", type: "background" },
  { id: "basemap-water", type: "fill" },
  { id: "basemap-roads", type: "line" },
  { id: "basemap-place-labels", type: "symbol" },
  { id: "basemap-poi-labels", type: "symbol" },
];
const homeFrame: MapFrame = {
  center: [5, 6],
  zoom: 3,
  bounds: [[-10, -10], [10, 10]],
  scope: "regional",
  confidence: 1,
};

beforeEach(() => {
  mapMocks.attributionOptions.length = 0;
  mapMocks.imageFailures.clear();
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
      // A realistic basemap layer stack: the app inserts its own layers
      // relative to the first basemap symbol layer, so an empty list would
      // hide every ordering decision under test.
      layers: BASEMAP_LAYERS,
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
    const requiredAttributionItems = Array.from(
      summary.closest(".terrain-attribution")?.querySelectorAll("li") ?? [],
    ).map((item) => (item.textContent ?? "").replace(/\s+/g, " ").trim());
    // Exact, order-sensitive comparison of the full 11-entry joerd-required
    // attribution list (verbatim punctuation/Unicode, e.g. "©", en dashes,
    // and the ArcticDEM funding-award numbers). A missing, reordered, or
    // paraphrased entry is a real attribution-compliance regression and
    // must fail this test, not just slip past a substring spot check.
    expect(requiredAttributionItems).toEqual([
      "ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;",
      "Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;",
      "Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;",
      "Canada terrain data contains information licensed under the Open Government Licence – Canada;",
      "Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;",
      "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration",
      "Mexico terrain data source: INEGI, Continental relief, 2016;",
      "New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);",
      "Norway terrain data © Kartverket;",
      "United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;",
      "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.",
    ]);
    expect(
      screen.getByRole("link", { name: "Full terrain provider attribution (joerd)" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
    );
  });

  it("renders the terrain credits control once, as a sibling of the map region rather than a nested overlay-only duplicate", async () => {
    // Regression guard for the mobile "credits box overlays the map" fix.
    // The control must be a single DOM node so no breakpoint-specific
    // duplicate can appear twice in the accessibility tree: it lives
    // alongside `.globe-shell` (both children of `.globe-frame`), not
    // nested inside the map region, so a mobile-only CSS `position` change
    // can move it out of the map viewport into normal document flow
    // without ever touching the DOM or reading/tab order.
    installMatchMedia(false);
    const view = render(<FlightGlobe {...defaultProps()} />);
    await readyMap();

    const credits = view.container.querySelectorAll(".terrain-attribution");
    expect(credits).toHaveLength(1);
    const region = view.container.querySelector(".globe-shell");
    expect(region?.querySelector(".terrain-attribution")).toBeNull();
    expect(credits[0].parentElement).toHaveClass("globe-frame");
    expect(region?.parentElement).toBe(credits[0].parentElement);
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

  it("keeps the shaded relief beneath every flight-route layer on a direct 3D load and across repeated flat/3D pivots", async () => {
    installMatchMedia(false);

    const props = defaultProps();
    const view = render(<FlightGlobe {...props} />);
    const map = await readyMap();

    const directLoadOrder = orderedLayerIds(map);
    expectReliefBeneathRoutes(directLoadOrder);
    // The relief is inserted into the basemap stack, not on top of it.
    expect(directLoadOrder.indexOf(TERRAIN_RELIEF_LAYER_ID)).toBeLessThan(
      directLoadOrder.indexOf("basemap-place-labels"),
    );
    expect(directLoadOrder.indexOf(TERRAIN_RELIEF_LAYER_ID)).toBeGreaterThan(
      directLoadOrder.indexOf("basemap-roads"),
    );

    // Pivoting rebuilds the relief against an already-populated app layer
    // stack, where the first symbol layer is one of ours. The 3D stack must
    // come back byte-for-byte identical every time, not just once.
    for (const pivot of [1, 2]) {
      view.rerender(<FlightGlobe {...props} viewMode="flat" />);
      await waitFor(() =>
        expect(orderedLayerIds(map)).not.toContain(TERRAIN_RELIEF_LAYER_ID),
      );

      view.rerender(<FlightGlobe {...props} viewMode="globe" />);
      await waitFor(() =>
        expect(orderedLayerIds(map)).toContain(TERRAIN_RELIEF_LAYER_ID),
      );
      expectReliefBeneathRoutes(orderedLayerIds(map));
      expect({ pivot, order: orderedLayerIds(map) }).toEqual({
        pivot,
        order: directLoadOrder,
      });
    }
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
        ([layer]) => layer.id === TERRAIN_RELIEF_LAYER_ID,
      ).length;
    expect(hillshadeAdds()).toBe(1);

    const styleLoad = map.on.mock.calls.find(
      ([event]) => event === "style.load",
    )?.[1];
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
        ([layer]) => layer.id === TERRAIN_RELIEF_LAYER_ID,
      ),
    ).toBe(false);
    expect(map.getLayer(TERRAIN_RELIEF_LAYER_ID)).toBeUndefined();
  });

  it("keeps terrain state and credits on when the hillshade layer cannot be removed, instead of claiming a flat, DEM-free map", async () => {
    installMatchMedia(false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const props = defaultProps();
    const view = render(<FlightGlobe {...props} />);
    const map = await readyMap();
    expect(screen.getByText("Terrain data credits")).toBeInTheDocument();

    map.removeLayer.mockImplementation((id: string) => {
      if (id === TERRAIN_RELIEF_LAYER_ID) {
        throw new Error("hillshade layer is locked");
      }
    });

    view.rerender(<FlightGlobe {...props} viewMode="flat" />);
    await waitFor(() =>
      expect(map.setProjection).toHaveBeenCalledWith({ type: "mercator" }),
    );

    // The hillshade is still attached, so DEM data is still on screen: the
    // required upstream credit must stay, and the failure must be visible.
    expect(map.getLayer(TERRAIN_RELIEF_LAYER_ID)).toBeTruthy();
    const alert = await screen.findByText(/Terrain relief could not be removed/);
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("hillshade layer is locked");
    expect(screen.getByText("Terrain data credits")).toBeInTheDocument();
    expect(screen.getByText(/3DEP \(formerly NED\)/)).toBeInTheDocument();
    expect(screen.getByRole("region").getAttribute("aria-label")).toContain(
      "terrain relief",
    );
    consoleError.mockRestore();
  });

  it("keeps terrain state and credits on when the DEM source cannot be removed, even though the hillshade layer went away", async () => {
    installMatchMedia(false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const props = defaultProps();
    const view = render(<FlightGlobe {...props} />);
    const map = await readyMap();
    expect(screen.getByText("Terrain data credits")).toBeInTheDocument();

    map.removeSource.mockImplementation((id: string) => {
      if (id === "flight-map-terrain") {
        throw new Error("elevation source still in use");
      }
    });

    view.rerender(<FlightGlobe {...props} viewMode="flat" />);
    await waitFor(() =>
      expect(map.setProjection).toHaveBeenCalledWith({ type: "mercator" }),
    );

    // Teardown is only "done" when *both* halves are verified gone. A
    // surviving DEM source keeps fetching elevation tiles, so the credit
    // stays and the partial teardown is reported rather than swallowed.
    expect(map.getLayer(TERRAIN_RELIEF_LAYER_ID)).toBeUndefined();
    expect(map.getSource("flight-map-terrain")).toBeTruthy();
    const alert = await screen.findByText(/Terrain relief could not be removed/);
    expect(alert).toHaveTextContent("elevation source still in use");
    expect(screen.getByText("Terrain data credits")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("registers all four route-direction icons once, instead of relying on text glyphs", async () => {
    installMatchMedia(false);

    render(<FlightGlobe {...defaultProps()} />);
    const map = await readyMap();

    const registeredIds = map.addImage.mock.calls.map(([id]) => id);
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
    for (const id of registeredIds) {
      expect(map.hasImage(id)).toBe(true);
    }
  });

  it("refuses to report a ready map when a direction icon fails to register, instead of installing layers that reference a missing image", async () => {
    installMatchMedia(false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mapMocks.imageFailures.add(DIRECTION_ICON_IDS.bothCommercial);

    const view = render(<FlightGlobe {...defaultProps()} />);
    const map = await readyMap();

    // Direction is an acceptance-critical cue: a symbol layer pointing at a
    // missing image renders nothing, so the map must not silently claim it
    // initialized successfully.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Route direction cues could not be registered/);
    const region = view.container.querySelector(".globe-shell");
    expect(region).toHaveAttribute("data-map-ready", "false");
    expect(region).toHaveAttribute("aria-busy", "true");
    for (const layerId of [
      ROUTE_LAYER_IDS.direction,
      ROUTE_LAYER_IDS.selectedDirection,
    ]) {
      expect({
        layerId,
        added: map.addLayer.mock.calls.some(([layer]) => layer.id === layerId),
      }).toEqual({ layerId, added: false });
    }
    consoleError.mockRestore();
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

async function readyMap(): Promise<MapMock> {
  await waitFor(() => expect(mapMocks.instances).toHaveLength(1));
  const map = mapMocks.instances[0];
  await waitFor(() => expect(map.setProjection).toHaveBeenCalled());
  return map;
}

function orderedLayerIds(map: MapMock): string[] {
  return map.getStyle().layers.map((layer) => layer.id);
}

/**
 * The hillshade renders opaquely from `TERRAIN_RELIEF_MIN_ZOOM` upwards, so it
 * has to sit below *every* flight-route layer or it washes the routes out.
 */
function expectReliefBeneathRoutes(layerIds: string[]) {
  const relief = layerIds.indexOf(TERRAIN_RELIEF_LAYER_ID);
  expect(relief).toBeGreaterThanOrEqual(0);
  for (const routeLayerId of Object.values(ROUTE_LAYER_IDS)) {
    expect({ routeLayerId, above: layerIds.indexOf(routeLayerId) > relief })
      .toEqual({ routeLayerId, above: true });
  }
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
