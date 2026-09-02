"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
import {
  airportExactIdentity,
  type Airport,
  type FlightKind,
  type MapRoute,
} from "@/lib/flight-data";
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
  buildRouteLabelLayer,
  buildTerrainReliefLayer,
  ROUTE_LAYER_IDS,
  routeLineOpacity,
  TERRAIN_RELIEF_LAYER_ID,
  withMapProjection,
  withGlobeProjection,
} from "@/lib/map-style";
import { bindCompletedMapZoom } from "@/lib/map-zoom-sync";
import { buildDirectionIconSet, DIRECTION_ICON_IDS } from "@/lib/map-icons";
import type { MapViewMode } from "@/lib/map-view-mode";

setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const DEFAULT_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const OPENFREEMAP_SOURCE_PREFIX = "https://tiles.openfreemap.org/";
const REQUIRED_BASEMAP_ATTRIBUTION =
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const TERRAIN_SOURCE_ID = "flight-map-terrain";
const ROUTE_SOURCE_ID = "flight-map-routes";
const AIRPORT_SOURCE_ID = "flight-map-airports";
const AIRPORT_CIRCLE_LAYERS = [AIRPORT_LAYER_IDS.markers];

/**
 * Every layer id this app owns. Used to tell the app's own layers apart from
 * the basemap's when resolving a stable insertion point.
 */
const APP_LAYER_IDS = new Set<string>([
  ...Object.values(ROUTE_LAYER_IDS),
  ...Object.values(AIRPORT_LAYER_IDS),
  TERRAIN_RELIEF_LAYER_ID,
]);

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

/**
 * Result of a shaded-relief teardown attempt. `removed` is only true when the
 * hillshade layer *and* the DEM source are both verified absent afterwards,
 * so callers can never turn the terrain credit off while the map is still
 * rendering DEM-driven relief.
 */
type TerrainTeardown = { removed: boolean; message: string };

const TERRAIN_TEARDOWN_ERROR_PREFIX = "Terrain relief could not be removed";
const DIRECTION_ICON_ERROR =
  "Route direction cues could not be registered, so the map cannot show which way each route runs.";

export default function FlightGlobe(props: FlightGlobeProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  // Stable id linking the map region back to the terrain-attribution
  // control once it renders outside that region (see the `aria-describedby`
  // usage below, and the comment on `.terrain-attribution`'s placement).
  const terrainAttributionId = useId();
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
  const [terrainActive, setTerrainActive] = useState(false);
  const [terrainError, setTerrainError] = useState("");

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
      const loadedStyle = await loadStyle(
        styleUrl,
        abortController.signal,
        viewModeRef.current,
      );
      const style = loadedStyle.style;
      if (disposed || !containerRef.current) return;
      setBasemapMode(loadedStyle.isFallback ? "fallback" : "open-map");

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
      const customAttribution = usesOpenFreeMap(style)
        ? { customAttribution: REQUIRED_BASEMAP_ATTRIBUTION }
        : {};
      map.addControl(
        new AttributionControl({
          compact: false,
          ...customAttribution,
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
          if (viewModeRef.current === "globe") {
            setTerrainActive(addShadedRelief(map));
            setTerrainError("");
          } else {
            const teardown = removeShadedRelief(map);
            setTerrainActive(!teardown.removed);
            setTerrainError(
              teardown.removed
                ? ""
                : `${TERRAIN_TEARDOWN_ERROR_PREFIX} · ${teardown.message}`,
            );
          }
          if (!ensureDirectionIcons(map)) {
            throw new Error(DIRECTION_ICON_ERROR);
          }
          addFlightLayers(map, latest.airports, latest.routes);
          applyRoutePresentation(
            map,
            latest.visibleKind,
            latest.focusAirportCode,
          );
          applySelectedRoutePresentation(
            map,
            selectedRouteIdRef.current,
            latest.visibleKind,
            latest.focusAirportCode,
          );
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
          const latest = dataReadinessRef.current.currentIfReady();
          clearSelectedRoute(
            map,
            selectedRouteIdRef,
            latest?.visibleKind ?? "all",
            latest?.focusAirportCode ?? "",
          );
          showAirportPopup(map, feature);
          const identity = String(feature.properties?.identity ?? "");
          if (identity) onSelectAirportRef.current(identity);
          return;
        }

        const route = map.queryRenderedFeatures(event.point, {
          layers: map.getLayer(ROUTE_LAYER_IDS.hitbox) ? [ROUTE_LAYER_IDS.hitbox] : [],
        })[0];
        if (!route) {
          const latest = dataReadinessRef.current.currentIfReady();
          clearSelectedRoute(
            map,
            selectedRouteIdRef,
            latest?.visibleKind ?? "all",
            latest?.focusAirportCode ?? "",
          );
          onSelectRouteRef.current("");
          return;
        }
        const routeId = String(route.properties?.id ?? "");
        if (!routeId) return;
        selectedRouteIdRef.current = routeId;
        onSelectRouteRef.current(routeId);
        const latest = dataReadinessRef.current.currentIfReady();
        applySelectedRoutePresentation(
          map,
          routeId,
          latest?.visibleKind ?? "all",
          latest?.focusAirportCode ?? "",
        );
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
    if (props.viewMode === "globe") {
      const active = addShadedRelief(map);
      setTerrainActive(active);
      setTerrainError("");
    } else {
      // Teardown is verified, not assumed: the credit line may only be
      // withdrawn once the hillshade layer and the DEM source are both gone.
      // A failed removal keeps the terrain state (and its attribution) on,
      // and surfaces the failure instead of silently claiming a flat,
      // DEM-free map.
      const teardown = removeShadedRelief(map);
      setTerrainActive(!teardown.removed);
      setTerrainError(
        teardown.removed
          ? ""
          : `${TERRAIN_TEARDOWN_ERROR_PREFIX} · ${teardown.message}`,
      );
    }
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
    clearSelectedRoute(
      map,
      selectedRouteIdRef,
      props.visibleKind,
      props.focusAirportCode,
    );
    applyRoutePresentation(map, props.visibleKind, props.focusAirportCode);
  }, [props.focusAirportCode, props.visibleKind]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    selectedRouteIdRef.current = props.selectedRouteId;
    applySelectedRoutePresentation(
      map,
      props.selectedRouteId,
      props.visibleKind,
      props.focusAirportCode,
    );
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
  }, [
    prefersReducedMotion,
    props.focusAirportCode,
    props.routes,
    props.selectedRouteId,
    props.visibleKind,
  ]);

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
    const airport = props.airports.find(
      (candidate) =>
        airportExactIdentity(candidate) === props.focusAirportCode,
    );
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
    <div className="globe-frame">
      <div
        className="globe-shell cartographic-map"
        role="region"
        aria-label={`Interactive ${props.viewMode === "globe" ? "3D globe" : "flat projected map"} with land, water, place labels${terrainActive ? ", terrain relief" : ""}, airports, and flight routes`}
        aria-busy={!mapReady}
        aria-describedby={terrainActive ? terrainAttributionId : undefined}
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
        {terrainError && (
          <div className="map-layer-status error" role="alert">
            {terrainError}
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
      {/*
        `.terrain-attribution` renders as a sibling of `.globe-shell` under
        `.globe-frame`, not nested inside `.globe-shell` as it was before
        this fix. Two structural changes follow from that, versus the
        pre-fix markup:
          1. It now comes *after* `.globe-hint` in DOM/reading order
             (previously it was nested inside `.globe-shell`, before
             `.globe-hint`).
          2. It is no longer inside the `role="region"` map element, since
             it lives outside `.globe-shell` entirely.
        Both are one-time structural changes made by this fix, not
        per-breakpoint reordering: the same DOM position is used on both
        desktop and mobile, and only the CSS `position` differs between
        them (`.terrain-attribution` stays absolute on desktop, in-flow on
        mobile — see globals.css). This is what keeps a single focusable
        `<details>` control from ever being duplicated in the a11y tree,
        and avoids the focus/read-order mismatch a prior *visual-only*
        CSS `order` reorder caused (see PR #40 / commit 67b92e3).
        Since the control is no longer a descendant of the region, the
        region carries `aria-describedby={terrainAttributionId}` (above)
        pointing at this element's `id` so assistive tech still gets an
        explicit, programmatic association between the map and its
        terrain-data attribution.
      */}
      {terrainActive && (
        <div className="terrain-attribution" id={terrainAttributionId}>
          <details>
            <summary>Terrain data credits</summary>
            <div className="terrain-attribution-content">
              <p>
                Elevation (terrain) tiles are served directly from the AWS
                Open Data Registry (elevation-tiles-prod), not through
                Mapzen&apos;s hosted service. The required upstream provider
                attribution for those tiles, reproduced from Tilezen&apos;s
                joerd project, is:
              </p>
              <ul>
                <li>
                  ArcticDEM terrain data DEM(s) were created from
                  DigitalGlobe, Inc., imagery and funded under National
                  Science Foundation awards 1043681, 1559691, and 1542736;
                </li>
                <li>
                  Australia terrain data © Commonwealth of Australia
                  (Geoscience Australia) 2017;
                </li>
                <li>
                  Austria terrain data © offene Daten Österreichs – Digitales
                  Geländemodell (DGM) Österreich;
                </li>
                <li>
                  Canada terrain data contains information licensed under the
                  Open Government Licence – Canada;
                </li>
                <li>
                  Europe terrain data produced using Copernicus data and
                  information funded by the European Union - EU-DEM layers;
                </li>
                <li>
                  Global ETOPO1 terrain data U.S. National Oceanic and
                  Atmospheric Administration
                </li>
                <li>Mexico terrain data source: INEGI, Continental relief, 2016;</li>
                <li>
                  New Zealand terrain data Copyright 2011 Crown copyright (c)
                  Land Information New Zealand and the New Zealand Government
                  (All rights reserved);
                </li>
                <li>Norway terrain data © Kartverket;</li>
                <li>
                  United Kingdom terrain data © Environment Agency copyright
                  and/or database right 2015. All rights reserved;
                </li>
                <li>
                  United States 3DEP (formerly NED) and global GMTED2010 and
                  SRTM terrain data courtesy of the U.S. Geological Survey.
                </li>
              </ul>
              <a
                href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md"
                rel="noopener"
                target="_blank"
              >
                Full terrain provider attribution (joerd)
              </a>
            </div>
          </details>
        </div>
      )}
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
): Promise<{ isFallback: boolean; style: StyleSpecification }> {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(signal.reason);
  signal.addEventListener("abort", abortRequest, { once: true });
  const timeout = window.setTimeout(() => requestController.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: requestController.signal });
    if (!response.ok) throw new Error(`Map style returned ${response.status}`);
    const style = (await response.json()) as StyleSpecification;
    return {
      isFallback: false,
      style: withMapProjection(withRequiredBasemapAttribution(style), viewMode),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      isFallback: true,
      style: withMapProjection(FALLBACK_STYLE, viewMode),
    };
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abortRequest);
  }
}

function usesOpenFreeMap(style: StyleSpecification): boolean {
  return Object.values(style.sources).some(
    (source) =>
      "url" in source &&
      typeof source.url === "string" &&
      source.url.startsWith(OPENFREEMAP_SOURCE_PREFIX),
  );
}

function withRequiredBasemapAttribution(
  style: StyleSpecification,
): StyleSpecification {
  return {
    ...style,
    sources: Object.fromEntries(
      Object.entries(style.sources).map(([id, source]) => {
        const sourceUrl =
          "url" in source && typeof source.url === "string"
            ? source.url
            : "";
        return [
          id,
          sourceUrl.startsWith(OPENFREEMAP_SOURCE_PREFIX)
            ? { ...source, attribution: REQUIRED_BASEMAP_ATTRIBUTION }
            : source,
        ];
      }),
    ),
  };
}

/**
 * Ensures both halves of the shaded-relief stack (DEM source + hillshade
 * layer) exist, and reports whether the DEM is actually driving a rendered
 * layer. The return value gates the upstream terrain attribution, so it must
 * describe real DEM activity: a half-restored stack (for example a source
 * that survived a style reload while its layer did not) is completed here
 * rather than reported as active.
 */
function addShadedRelief(map: MapLibreMap): boolean {
  try {
    if (!map.getSource(TERRAIN_SOURCE_ID)) {
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
    }
    if (!map.getLayer(TERRAIN_RELIEF_LAYER_ID)) {
      map.addLayer(
        buildTerrainReliefLayer(TERRAIN_SOURCE_ID),
        terrainReliefBeforeId(map),
      );
    }
    return shadedReliefIsRendering(map);
  } catch {
    // The basemap remains usable when the optional elevation source is
    // unavailable; tear down any half-built stack so no terrain credit is
    // shown for DEM tiles that are not being rendered. The report still
    // describes what actually survived the teardown, so state and map
    // resources cannot diverge even when cleanup itself fails.
    removeShadedRelief(map);
    return shadedReliefIsRendering(map);
  }
}

/**
 * True only when both halves of the relief stack are present, which is the
 * exact condition under which DEM tiles are being fetched and rendered — and
 * therefore the exact condition under which the upstream terrain credit must
 * be shown.
 */
function shadedReliefIsRendering(map: MapLibreMap): boolean {
  try {
    return Boolean(
      map.getSource(TERRAIN_SOURCE_ID) && map.getLayer(TERRAIN_RELIEF_LAYER_ID),
    );
  } catch {
    return false;
  }
}

/**
 * Stable insertion point for the shaded-relief layer.
 *
 * The hillshade must always sit *below* the flight route lines: from
 * `TERRAIN_RELIEF_MIN_ZOOM` upwards the relief is opaque enough to wash the
 * routes out. "First symbol layer in the current style" is not a stable
 * anchor, because after a flat → 3D pivot the app's own route-direction
 * symbol layers already exist and sort first, which would insert the
 * hillshade above the route lines. Prefer the bottom-most app route layer
 * whenever it exists, and fall back to the basemap's first symbol layer only
 * during the initial style load, before any route layer has been added. Both
 * paths land the hillshade in the same slot, so a directly loaded 3D map and
 * one reached through flat → 3D end up with identical layer order.
 */
function terrainReliefBeforeId(map: MapLibreMap): string | undefined {
  if (map.getLayer(ROUTE_LAYER_IDS.commercial)) {
    return ROUTE_LAYER_IDS.commercial;
  }
  return firstBasemapSymbolLayerId(map);
}

/**
 * First symbol layer contributed by the basemap style. The app's own symbol
 * layers are excluded so the insertion point cannot drift once route
 * direction cues or airport labels exist.
 */
function firstBasemapSymbolLayerId(map: MapLibreMap): string | undefined {
  return map
    .getStyle()
    .layers.find(
      (layer) => layer.type === "symbol" && !APP_LAYER_IDS.has(layer.id),
    )?.id;
}

/**
 * Tears the shaded-relief stack down and *verifies* the outcome. Both halves
 * are attempted independently (a failed `removeLayer` must not skip the
 * source removal), and success is decided by re-reading the map rather than
 * by the absence of a thrown error: MapLibre can reject a removal while the
 * layer keeps rendering DEM data. The caller uses `removed` to decide whether
 * the terrain state and its required upstream attribution may be turned off,
 * so a swallowed failure here would let the UI claim a flat, DEM-free map
 * while relief is still on screen.
 */
function removeShadedRelief(map: MapLibreMap): TerrainTeardown {
  const failures: string[] = [];
  try {
    if (map.getLayer(TERRAIN_RELIEF_LAYER_ID)) {
      map.removeLayer(TERRAIN_RELIEF_LAYER_ID);
    }
  } catch (error) {
    failures.push(describeError(error));
  }
  try {
    if (map.getSource(TERRAIN_SOURCE_ID)) {
      map.removeSource(TERRAIN_SOURCE_ID);
    }
  } catch (error) {
    failures.push(describeError(error));
  }

  let layerPresent = true;
  let sourcePresent = true;
  try {
    layerPresent = Boolean(map.getLayer(TERRAIN_RELIEF_LAYER_ID));
    sourcePresent = Boolean(map.getSource(TERRAIN_SOURCE_ID));
  } catch (error) {
    failures.push(describeError(error));
  }
  if (!layerPresent && !sourcePresent) return { removed: true, message: "" };

  const leftover = [
    layerPresent ? "hillshade layer" : "",
    sourcePresent ? "elevation source" : "",
  ].filter(Boolean).join(" and ");
  const message =
    failures[0] ?? `${leftover || "terrain resources"} still attached`;
  console.error("Shaded relief teardown failed.", { leftover, failures });
  return { removed: false, message };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers the four direction-cue icons and reports whether every id the
 * direction layers reference is actually available. Direction is an
 * acceptance-critical cue, and a symbol layer whose `icon-image` resolves to
 * a missing image renders nothing, so a partial registration must be treated
 * as a failure rather than quietly producing a map with no direction cues.
 */
function ensureDirectionIcons(map: MapLibreMap): boolean {
  for (const { id, image } of buildDirectionIconSet()) {
    try {
      if (!map.hasImage(id)) map.addImage(id, image);
    } catch (error) {
      console.error(`Direction icon "${id}" could not be registered.`, error);
    }
  }
  return Object.values(DIRECTION_ICON_IDS).every((id) => {
    try {
      return Boolean(map.hasImage(id));
    } catch {
      return false;
    }
  });
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
  const firstSymbolLayer = firstBasemapSymbolLayerId(map);

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
  map.addLayer(buildRouteLabelLayer(ROUTE_SOURCE_ID));
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
      ["==", ["get", "originIdentity"], focusAirportCode],
      ["==", ["get", "destinationIdentity"], focusAirportCode],
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
      ["==", ["get", "originIdentity"], focusAirportCode],
      ["==", ["get", "destinationIdentity"], focusAirportCode],
    ]);
  }
  if (filters.length === 0) return ["has", "id"];
  return filters.length === 1 ? filters[0] : ["all", ...filters];
}

function routeDirectionFilter(
  visibleKind: FlightGlobeProps["visibleKind"],
  focusAirportCode: string,
  selectedRouteId = "",
) {
  const filters: unknown[] = [["!=", ["get", "directionMode"], "none"]];
  if (visibleKind !== "all") {
    filters.push(["==", ["get", "kind"], visibleKind]);
  }
  if (focusAirportCode) {
    filters.push([
      "any",
      ["==", ["get", "originIdentity"], focusAirportCode],
      ["==", ["get", "destinationIdentity"], focusAirportCode],
    ]);
  }
  if (selectedRouteId) {
    filters.push(["!=", ["get", "id"], selectedRouteId]);
  }
  return filters.length === 1 ? filters[0] : ["all", ...filters];
}

function clearSelectedRoute(
  map: MapLibreMap,
  selectedRouteIdRef: { current: string },
  visibleKind: FlightGlobeProps["visibleKind"],
  focusAirportCode: string,
) {
  if (!selectedRouteIdRef.current || !map.getLayer(ROUTE_LAYER_IDS.selected)) return;
  selectedRouteIdRef.current = "";
  applySelectedRoutePresentation(map, "", visibleKind, focusAirportCode);
}

function applySelectedRoutePresentation(
  map: MapLibreMap,
  routeId: string,
  visibleKind: FlightGlobeProps["visibleKind"],
  focusAirportCode: string,
) {
  const selectedFilter = [
    "==",
    ["get", "id"],
    routeId || "__none__",
  ] as never;
  map.setFilter(ROUTE_LAYER_IDS.selected, selectedFilter);
  map.setFilter(ROUTE_LAYER_IDS.labels, selectedFilter);
  map.setFilter(
    ROUTE_LAYER_IDS.direction,
    routeDirectionFilter(
      visibleKind,
      focusAirportCode,
      routeId,
    ) as never,
  );
  map.setFilter(
    ROUTE_LAYER_IDS.selectedDirection,
    [
      "all",
      selectedFilter,
      ["!=", ["get", "directionMode"], "none"],
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
  title.textContent = String(feature.properties?.routeTitle ?? "");
  detail.textContent = `${flightCount.toLocaleString()} ${flightCount === 1 ? "flight" : "flights"} · ${feature.properties?.kind === "private" ? "Personal logbook" : "Commercial"} · ${String(feature.properties?.directionDetail ?? "Direction unavailable")}`;
  content.className = "airport-popup";
  content.append(title, detail);
  new Popup({ closeButton: true, closeOnClick: true, offset: 10 })
    .setLngLat([coordinates.lng, coordinates.lat])
    .setDOMContent(content)
    .addTo(map);
}
