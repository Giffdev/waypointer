// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Airport, MapRoute } from "@/lib/flight-data";
import type { MapFrame } from "@/lib/map-framing";

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
      const methods: Record<string, ReturnType<typeof vi.fn>> = {
        addControl: vi.fn(),
        addLayer: vi.fn(),
        addSource: vi.fn(),
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
        getLayer: vi.fn(() => undefined),
        getSource: vi.fn(() => undefined),
        getStyle: vi.fn(() => ({ layers: [] })),
        getZoom: vi.fn(() => 4),
        jumpTo: vi.fn(),
        off: vi.fn(),
        on: vi.fn(),
        once: vi.fn((event: string, callback: () => void) => {
          if (event === "load" || event === "moveend") queueMicrotask(callback);
        }),
        queryRenderedFeatures: vi.fn(() => []),
        remove: vi.fn(),
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
  it("keeps required map attribution visible and exposes complete terrain credits", async () => {
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
    const terrainAttribution = screen.getByRole("link", {
      name: "Mapzen Terrarium terrain attribution",
    });
    expect(terrainAttribution).toBeVisible();
    expect(terrainAttribution).toHaveAttribute(
      "href",
      "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
    );
    expect(mapMocks.attributionOptions[0]?.customAttribution)
      .not.toContain("OpenFreeMap");
    expect(
      screen.getByText(/ArcticDEM terrain from DigitalGlobe imagery/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Terrain licence details" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
    );
  });

  it("uses immediate camera updates while preserving every final state", async () => {
    installMatchMedia(true);
    const props = defaultProps();
    const view = render(<FlightGlobe {...props} />);
    const map = await readyMap();

    expect(map.jumpTo).toHaveBeenCalled();
    expect(map.flyTo).not.toHaveBeenCalled();

    view.rerender(<FlightGlobe {...props} focusAirportCode="AAA" />);
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

    view.rerender(<FlightGlobe {...props} focusAirportCode="AAA" />);
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
