"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type StyleSpecification,
} from "maplibre-gl";
import type { Airport, FlightKind, MapRoute } from "@/lib/flight-data";
import {
  calculateHomeCamera,
  initialMapZoomForWidth,
} from "@/lib/map-camera";
import type { MapFrame } from "@/lib/map-framing";
import { createMapDataReadiness } from "@/lib/map-data-readiness";
import {
  createAirportFeatureCollection,
  createRouteFeatureCollection,
} from "@/lib/map-geojson";
import {
  AIRPORT_LAYER_IDS,
  buildAirportLabelLayer,
  buildAirportMarkerLayer,
  buildFlightRouteLayers,
  buildRouteDirectionLayers,
  buildTerrainReliefLayer,
  ROUTE_LAYER_IDS,
  routeLineOpacity,
  withMapProjection,
  withGlobeProjection,
} from "@/lib/map-style";
import { bindCompletedMapZoom } from "@/lib/map-zoom-sync";
import type { MapViewMode } from "@/lib/map-view-mode";

setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const DEFAULT_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const TERRAIN_SOURCE_ID = "flight-map-terrain";
const ROUTE_SOURCE_ID = "flight-map-routes";
const AIRPORT_SOURCE_ID = "flight-map-airports";
const AIRPORT_CIRCLE_LAYERS = [AIRPORT_LAYER_IDS.markers];

const FALLBACK_STYLE: StyleSpecification = withGlobeProjection({
  version: 8,
  sources: {},
  layers: [
    {
      id: "fallback-ocean",
      type: "background",
      paint: { "background-color": "#071a27" },
    },
  ],
});

type FlightGlobeProps = {
  airports: Airport[];
  routes: MapRoute[];
  visibleKind: "all" | FlightKind;
  zoom: number;
  zoomCommandToken: number;
  focusAirportCode: string;
  selectedRouteId: string;
  resetToken: number;
  homeFrame: MapFrame;
  autoRotate: boolean;
  viewMode: MapViewMode;
  onSelectAirport: (code: string) => void;
  onSelectRoute: (routeId: string) => void;
  onZoomChange: (zoom: number) => void;
};

type BasemapMode = "loading" | "open-map" | "fallback";

export default function FlightGlobe(props: FlightGlobeProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadedRef = useRef(false);
  const initialZoomRef = useRef(props.zoom);
  const homeFrameRef = useRef(props.homeFrame);
  const appliedResetTokenRef = useRef(props.resetToken);
  const resettingRef = useRef(false);
  const onSelectAirportRef = useRef(props.onSelectAirport);
  const onZoomChangeRef = useRef(props.onZoomChange);
  const onSelectRouteRef = useRef(props.onSelectRoute);
  const dataReadinessRef = useRef(
    createMapDataReadiness({
      airports: props.airports,
      routes: props.routes,
      visibleKind: props.visibleKind,
      focusAirportCode: props.focusAirportCode,
    }),
  );
  const selectedRouteIdRef = useRef("");
  const viewModeRef = useRef(props.viewMode);
  const [basemapMode, setBasemapMode] = useState<BasemapMode>("loading");
  const [mapReady, setMapReady] = useState(false);
  const [initializationError, setInitializationError] = useState("");

  useLayoutEffect(() => {
    viewModeRef.current = props.viewMode;
    dataReadinessRef.current.setLatest({
      airports: props.airports,
      routes: props.routes,
      visibleKind: props.visibleKind,
      focusAirportCode: props.focusAirportCode,
    });
  }, [
    props.airports,
    props.focusAirportCode,
    props.routes,
    props.visibleKind,
    props.viewMode,
  ]);

  useEffect(() => {
    onSelectAirportRef.current = props.onSelectAirport;
    onZoomChangeRef.current = props.onZoomChange;
    onSelectRouteRef.current = props.onSelectRoute;
  }, [
    props.onSelectAirport,
    props.onSelectRoute,
    props.onZoomChange,
  ]);

  useEffect(() => {
    if (!containerRef.current) return;
    const abortController = new AbortController();
    let disposed = false;
    let unbindZoomSync: (() => void) | undefined;
    const failInitialization = (error: unknown) => {
      if (disposed) return;
      const message =
        error instanceof Error ? error.message : "Unknown initialization error";
      console.error("Flight globe initialization failed.", error);
      setInitializationError(message);
      setMapReady(false);
    };

    const initialize = async () => {
      setInitializationError("");
      setMapReady(false);
      const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL?.trim() || DEFAULT_STYLE_URL;
      const style = await loadStyle(
        styleUrl,
        abortController.signal,
        viewModeRef.current,
      );
      if (disposed || !containerRef.current) return;
      setBasemapMode(style === FALLBACK_STYLE ? "fallback" : "open-map");

      const map = new MapLibreMap({
        container: containerRef.current,
        style,
        center: homeFrameRef.current.center,
        zoom: initialMapZoomForWidth(
          containerRef.current.clientWidth,
          initialZoomRef.current,
          homeFrameRef.current.scope,
        ),
        minZoom: 0,
        maxZoom: 18,
        attributionControl: false,
        canvasContextAttributes: {
          antialias: true,
          powerPreference: "high-performance",
          contextType: "webgl2",
        },
        cooperativeGestures: false,
        renderWorldCopies: false,
      });
      mapRef.current = map;
      map.addControl(
        new AttributionControl({
          compact: true,
          customAttribution: [
            '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>',
            '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a>',
            '<a href="https://ourairports.com/data/" target="_blank" rel="noopener">Airport reference: OurAirports (public domain)</a>',
            '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Terrain data sources & attribution</a>',
          ],
        }),
        "bottom-right",
      );
      map.addControl(new ScaleControl({ maxWidth: 110, unit: "imperial" }), "bottom-left");

      const restoreFlightPresentation = () => {
        if (disposed) return;
        try {
          loadedRef.current = true;
          const latest = dataReadinessRef.current.markReady();
          map.setProjection({
            type: viewModeRef.current === "globe" ? "globe" : "mercator",
          });
          addShadedRelief(map);
          addFlightLayers(map, latest.airports, latest.routes);
          applyRoutePresentation(
            map,
            latest.visibleKind,
            latest.focusAirportCode,
          );
          applySelectedRoutePresentation(map, selectedRouteIdRef.current);
          setMapReady(true);
        } catch (error) {
          loadedRef.current = false;
          failInitialization(error);
        }
      };

      map.once("load", () => {
        if (disposed) return;
        try {
          restoreFlightPresentation();
          applyHomeFrame(map, homeFrameRef.current, 0);
          onZoomChangeRef.current(map.getZoom());
          map.on("style.load", restoreFlightPresentation);
        } catch (error) {
          loadedRef.current = false;
          failInitialization(error);
        }
      });

      unbindZoomSync = bindCompletedMapZoom(map, (zoom) => {
        onZoomChangeRef.current(zoom);
      });
      map.on("click", (event) => {
        const feature = map.queryRenderedFeatures(event.point, {
          layers: AIRPORT_CIRCLE_LAYERS.filter((layerId) => Boolean(map.getLayer(layerId))),
        })[0];
        if (feature) {
          clearSelectedRoute(map, selectedRouteIdRef);
          showAirportPopup(map, feature);
          const code = String(feature.properties?.code ?? "");
          if (code) onSelectAirportRef.current(code);
          return;
        }

        const route = map.queryRenderedFeatures(event.point, {
          layers: map.getLayer(ROUTE_LAYER_IDS.hitbox) ? [ROUTE_LAYER_IDS.hitbox] : [],
        })[0];
        if (!route) {
          clearSelectedRoute(map, selectedRouteIdRef);
          onSelectRouteRef.current("");
          return;
        }
        const routeId = String(route.properties?.id ?? "");
        if (!routeId) return;
        selectedRouteIdRef.current = routeId;
        onSelectRouteRef.current(routeId);
        applySelectedRoutePresentation(map, routeId);
        showRoutePopup(map, route, event.lngLat);
      });
      map.on("mousemove", (event) => {
        const airport = map.queryRenderedFeatures(event.point, {
          layers: AIRPORT_CIRCLE_LAYERS.filter((layerId) => Boolean(map.getLayer(layerId))),
        })[0];
        const route = map.getLayer(ROUTE_LAYER_IDS.hitbox)
          ? map.queryRenderedFeatures(event.point, {
              layers: [ROUTE_LAYER_IDS.hitbox],
            })[0]
          : undefined;
        map.getCanvas().style.cursor = airport || route ? "pointer" : "";
      });
    };

    void initialize().catch((error) => {
      if (
        error instanceof DOMException &&
        error.name === "AbortError" &&
        abortController.signal.aborted
      ) {
        return;
      }
      failInitialization(error);
    });
    return () => {
      disposed = true;
      abortController.abort();
      unbindZoomSync?.();
      loadedRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    map.setProjection({
      type: props.viewMode === "globe" ? "globe" : "mercator",
    });
  }, [props.viewMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    (map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
      createRouteFeatureCollection(props.routes),
    );
  }, [props.routes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    (map.getSource(AIRPORT_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
      createAirportFeatureCollection(props.airports, props.routes),
    );
  }, [props.airports, props.routes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    clearSelectedRoute(map, selectedRouteIdRef);
    applyRoutePresentation(map, props.visibleKind, props.focusAirportCode);
  }, [props.focusAirportCode, props.visibleKind]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    selectedRouteIdRef.current = props.selectedRouteId;
    applySelectedRoutePresentation(map, props.selectedRouteId);
    if (!props.selectedRouteId) return;

    const route = props.routes.find(({ id }) => id === props.selectedRouteId);
    if (!route) return;
    const longitudeSpan = Math.abs(route.origin.lon - route.destination.lon);
    if (longitudeSpan > 180) {
      moveCamera(map, {
        center: [route.origin.lon, route.origin.lat],
        zoom: Math.max(map.getZoom(), 9),
        duration: 700,
      }, prefersReducedMotion);
      return;
    }
    map.fitBounds(
      [
        [route.origin.lon, route.origin.lat],
        [route.destination.lon, route.destination.lat],
      ],
      {
        padding: 110,
        maxZoom: 12,
        duration: prefersReducedMotion ? 0 : 700,
      },
    );
  }, [prefersReducedMotion, props.routes, props.selectedRouteId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    if (
      resettingRef.current ||
      props.resetToken !== appliedResetTokenRef.current
    ) {
      return;
    }
    if (Math.abs(map.getZoom() - props.zoom) > 0.04) {
      if (prefersReducedMotion) {
        map.jumpTo({ zoom: props.zoom });
      } else {
        map.easeTo({ zoom: props.zoom, duration: 240 });
      }
    }
  }, [
    prefersReducedMotion,
    props.resetToken,
    props.zoom,
    props.zoomCommandToken,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !props.focusAirportCode) return;
    const airport = props.airports.find(({ code }) => code === props.focusAirportCode);
    if (!airport) return;
    const minimumZoom =
      airport.facility === "commercial" ? 8 : airport.facility === "general-aviation" ? 9 : 10;
    moveCamera(map, {
      center: [airport.lon, airport.lat],
      zoom: Math.max(map.getZoom(), minimumZoom),
      duration: 900,
    }, prefersReducedMotion);
  }, [prefersReducedMotion, props.airports, props.focusAirportCode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || props.resetToken === 0) return;
    appliedResetTokenRef.current = props.resetToken;
    resettingRef.current = true;
    map.stop();
    map.once("moveend", () => {
      resettingRef.current = false;
      onZoomChangeRef.current(map.getZoom());
    });
    applyHomeFrame(
      map,
      props.homeFrame,
      prefersReducedMotion ? 0 : 700,
    );
  }, [prefersReducedMotion, props.homeFrame, props.resetToken]);

  useEffect(() => {
    const map = mapRef.current;
    if (
      !map ||
      !loadedRef.current ||
      !props.autoRotate ||
      props.viewMode !== "globe"
    ) return;
    let frameId = 0;
    let previous = performance.now();
    const rotate = (now: number) => {
      const elapsedSeconds = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      const center = map.getCenter();
      map.setCenter([center.lng + elapsedSeconds * 2.2, center.lat]);
      frameId = requestAnimationFrame(rotate);
    };
    frameId = requestAnimationFrame(rotate);
    return () => cancelAnimationFrame(frameId);
  }, [props.autoRotate, props.viewMode]);

  return (
    <div
      className="globe-shell cartographic-map"
      role="region"
      aria-label={`Interactive ${props.viewMode === "globe" ? "3D globe" : "flat projected map"} with land, water, place labels, terrain relief, airports, and flight routes`}
      aria-busy={!mapReady}
      data-airport-count={props.airports.length}
      data-map-ready={mapReady}
      data-route-count={props.routes.length}
      data-view-mode={props.viewMode}
    >
      <div className="maplibre-container" ref={containerRef} />
      {initializationError && (
        <div className="map-layer-status error" role="alert">
          Interactive globe failed to initialize · {initializationError}
        </div>
      )}
      {(basemapMode === "loading" || basemapMode === "fallback") && (
        <div className={`map-layer-status ${basemapMode}`}>
          {basemapMode === "loading"
            ? "Loading open cartography…"
            : "Basemap unavailable · routes remain local"}
        </div>
      )}
      <div className="globe-hint">Drag to explore · Wheel or pinch to zoom</div>
    </div>
  );
}

function applyHomeFrame(map: MapLibreMap, frame: MapFrame, duration: number) {
  map.resize();
  const container = map.getContainer();
  const camera = calculateHomeCamera(
    map,
    frame,
    container.clientWidth,
    container.clientHeight,
  );
  if (duration === 0) {
    map.jumpTo(camera);
    return;
  }
  map.flyTo({
    ...camera,
    duration,
  });
}

function moveCamera(
  map: MapLibreMap,
  camera: Parameters<MapLibreMap["flyTo"]>[0],
  prefersReducedMotion: boolean,
) {
  if (prefersReducedMotion) {
    map.jumpTo({
      center: camera.center,
      zoom: camera.zoom,
      bearing: camera.bearing,
      pitch: camera.pitch,
    });
    return;
  }
  map.flyTo(camera);
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(query.matches);
    updatePreference();
    query.addEventListener("change", updatePreference);
    return () => query.removeEventListener("change", updatePreference);
  }, []);

  return prefersReducedMotion;
}

async function loadStyle(
  url: string,
  signal: AbortSignal,
  viewMode: MapViewMode,
): Promise<StyleSpecification> {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(signal.reason);
  signal.addEventListener("abort", abortRequest, { once: true });
  const timeout = window.setTimeout(() => requestController.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: requestController.signal });
    if (!response.ok) throw new Error(`Map style returned ${response.status}`);
    const style = (await response.json()) as StyleSpecification;
    return withMapProjection(style, viewMode);
  } catch (error) {
    if (signal.aborted) throw error;
    return withMapProjection(FALLBACK_STYLE, viewMode);
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abortRequest);
  }
}

function addShadedRelief(map: MapLibreMap) {
  try {
    map.addSource(TERRAIN_SOURCE_ID, {
      type: "raster-dem",
      tiles: [
        "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      ],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 15,
      attribution:
        '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Terrain data sources & attribution</a>',
    });
    const firstSymbolLayer = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
    map.addLayer(
      buildTerrainReliefLayer(TERRAIN_SOURCE_ID),
      firstSymbolLayer,
    );
  } catch {
    // The basemap remains usable when the optional elevation source is unavailable.
  }
}

function addFlightLayers(map: MapLibreMap, airports: Airport[], routes: MapRoute[]) {
  const routeData = createRouteFeatureCollection(routes);
  const airportData = createAirportFeatureCollection(airports, routes);
  const routeSource = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
  const airportSource = map.getSource(AIRPORT_SOURCE_ID) as GeoJSONSource | undefined;
  if (routeSource) routeSource.setData(routeData);
  else {
    map.addSource(ROUTE_SOURCE_ID, {
      type: "geojson",
      data: routeData,
      lineMetrics: true,
    });
  }
  if (airportSource) airportSource.setData(airportData);
  else {
    map.addSource(AIRPORT_SOURCE_ID, {
      type: "geojson",
      data: airportData,
    });
  }
  const firstSymbolLayer = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;

  for (const layer of buildFlightRouteLayers(ROUTE_SOURCE_ID)) {
    if (!map.getLayer(layer.id)) map.addLayer(layer, firstSymbolLayer);
  }
  for (const layer of buildRouteDirectionLayers(ROUTE_SOURCE_ID)) {
    if (!map.getLayer(layer.id)) map.addLayer(layer, firstSymbolLayer);
  }

  if (!map.getLayer(AIRPORT_LAYER_IDS.markers)) {
    map.addLayer(buildAirportMarkerLayer(AIRPORT_SOURCE_ID), firstSymbolLayer);
  }
  if (!map.getLayer(AIRPORT_LAYER_IDS.hubLabels)) {
    map.addLayer(
      buildAirportLabelLayer(
        AIRPORT_SOURCE_ID,
        AIRPORT_LAYER_IDS.hubLabels,
        0,
        ["==", ["get", "isHub"], true],
        4.5,
      ),
    );
  }
  if (!map.getLayer(AIRPORT_LAYER_IDS.labels)) {
    map.addLayer(
      buildAirportLabelLayer(
        AIRPORT_SOURCE_ID,
        AIRPORT_LAYER_IDS.labels,
        4.5,
      ),
    );
  }
  addRouteLabelLayer(map);
}

function addRouteLabelLayer(map: MapLibreMap) {
  if (map.getLayer(ROUTE_LAYER_IDS.labels)) return;
  map.addLayer({
    id: ROUTE_LAYER_IDS.labels,
    type: "symbol",
    source: ROUTE_SOURCE_ID,
    minzoom: 7,
    filter: ["==", ["get", "id"], "__none__"],
    layout: {
      "symbol-placement": "line-center",
      "text-field": ["get", "routeLabel"],
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
  });
}

function applyRoutePresentation(
  map: MapLibreMap,
  visibleKind: FlightGlobeProps["visibleKind"],
  focusAirportCode: string,
) {
  map.setLayoutProperty(
    ROUTE_LAYER_IDS.commercial,
    "visibility",
    visibleKind === "private" ? "none" : "visible",
  );
  map.setLayoutProperty(
    ROUTE_LAYER_IDS.private,
    "visibility",
    visibleKind === "commercial" ? "none" : "visible",
  );

  map.setFilter(
    ROUTE_LAYER_IDS.commercial,
    routeKindFilter("commercial", focusAirportCode) as never,
  );
  map.setFilter(
    ROUTE_LAYER_IDS.private,
    routeKindFilter("private", focusAirportCode) as never,
  );
  map.setFilter(
    ROUTE_LAYER_IDS.hitbox,
    routeInspectionFilter(visibleKind, focusAirportCode) as never,
  );
  map.setFilter(
    ROUTE_LAYER_IDS.labels,
    ["==", ["get", "id"], "__none__"] as never,
  );
  map.setFilter(
    ROUTE_LAYER_IDS.direction,
    routeDirectionFilter(visibleKind, focusAirportCode) as never,
  );
}

function routeKindFilter(kind: FlightKind, focusAirportCode: string) {
  const kindFilter = ["==", ["get", "kind"], kind];
  if (!focusAirportCode) return kindFilter;
  return [
    "all",
    kindFilter,
    [
      "any",
      ["==", ["get", "originCode"], focusAirportCode],
      ["==", ["get", "destinationCode"], focusAirportCode],
    ],
  ];
}

function routeInspectionFilter(
  visibleKind: FlightGlobeProps["visibleKind"],
  focusAirportCode: string,
) {
  const filters: unknown[] = [];
  if (visibleKind !== "all") {
    filters.push(["==", ["get", "kind"], visibleKind]);
  }
  if (focusAirportCode) {
    filters.push([
      "any",
      ["==", ["get", "originCode"], focusAirportCode],
      ["==", ["get", "destinationCode"], focusAirportCode],
    ]);
  }
  if (filters.length === 0) return ["has", "id"];
  return filters.length === 1 ? filters[0] : ["all", ...filters];
}

function routeDirectionFilter(
  visibleKind: FlightGlobeProps["visibleKind"],
  focusAirportCode: string,
) {
  const filters: unknown[] = [["==", ["get", "showDirection"], true]];
  if (visibleKind !== "all") {
    filters.push(["==", ["get", "kind"], visibleKind]);
  }
  if (focusAirportCode) {
    filters.push([
      "any",
      ["==", ["get", "originCode"], focusAirportCode],
      ["==", ["get", "destinationCode"], focusAirportCode],
    ]);
  }
  return filters.length === 1 ? filters[0] : ["all", ...filters];
}

function clearSelectedRoute(
  map: MapLibreMap,
  selectedRouteIdRef: { current: string },
) {
  if (!selectedRouteIdRef.current || !map.getLayer(ROUTE_LAYER_IDS.selected)) return;
  selectedRouteIdRef.current = "";
  applySelectedRoutePresentation(map, "");
}

function applySelectedRoutePresentation(map: MapLibreMap, routeId: string) {
  const selectedFilter = [
    "==",
    ["get", "id"],
    routeId || "__none__",
  ] as never;
  map.setFilter(ROUTE_LAYER_IDS.selected, selectedFilter);
  map.setFilter(ROUTE_LAYER_IDS.labels, selectedFilter);
  map.setFilter(
    ROUTE_LAYER_IDS.selectedDirection,
    [
      "all",
      selectedFilter,
      ["==", ["get", "showDirection"], false],
    ] as never,
  );
  map.setPaintProperty(
    ROUTE_LAYER_IDS.commercial,
    "line-opacity",
    routeId ? 0.16 : (routeLineOpacity("commercial") as never),
  );
  map.setPaintProperty(
    ROUTE_LAYER_IDS.private,
    "line-opacity",
    routeId ? 0.16 : (routeLineOpacity("private") as never),
  );
}

function showAirportPopup(map: MapLibreMap, feature: MapGeoJSONFeature) {
  if (feature.geometry.type !== "Point") return;
  const coordinates = feature.geometry.coordinates as [number, number];
  const content = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("span");
  title.textContent = `${String(feature.properties?.code ?? "")} · ${String(feature.properties?.name ?? "")}`;
  detail.textContent = `${String(feature.properties?.city ?? "")} · ${
    feature.properties?.isActive ? "Active in current filters" : "Contextual airport"
  }`;
  content.className = "airport-popup";
  content.append(title, detail);
  new Popup({ closeButton: true, closeOnClick: true, offset: 10 })
    .setLngLat(coordinates)
    .setDOMContent(content)
    .addTo(map);
}

function showRoutePopup(
  map: MapLibreMap,
  feature: MapGeoJSONFeature,
  coordinates: { lng: number; lat: number },
) {
  const content = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("span");
  const flightCount = Number(feature.properties?.flightCount ?? 0);
  title.textContent = `${String(feature.properties?.originCode ?? "")} → ${String(feature.properties?.destinationCode ?? "")}`;
  detail.textContent = `${flightCount.toLocaleString()} ${flightCount === 1 ? "flight" : "flights"} · ${feature.properties?.kind === "private" ? "Personal logbook" : "Commercial"}`;
  content.className = "airport-popup";
  content.append(title, detail);
  new Popup({ closeButton: true, closeOnClick: true, offset: 10 })
    .setLngLat([coordinates.lng, coordinates.lat])
    .setDOMContent(content)
    .addTo(map);
}
