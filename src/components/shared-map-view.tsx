"use client";

import { useEffect, useMemo, useState } from "react";
import GlobePanel from "@/components/globe-panel";
import type { Airport, MapRoute } from "@/lib/flight-data";
import { deriveInitialMapFrame } from "@/lib/map-framing";
import { MapViewToggle } from "@/components/map-view-toggle";
import type { MapViewMode } from "@/lib/map-view-mode";
import { parsePublicMapProjection } from "@/lib/sharing/client-projection";
import type { PublicMapProjection } from "@/lib/sharing/service";

export function SharedMapView({ handle }: { handle: string }) {
  const [projection, setProjection] = useState<PublicMapProjection | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not-found" | "error">("loading");

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | null = null;

    function loadProjection() {
      if (disposed || activeController) return;
      const controller = new AbortController();
      activeController = controller;
      setState("loading");

      void fetch(`/api/shared/${encodeURIComponent(handle)}`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          const body: unknown = await response.json();
          if (disposed || controller.signal.aborted) return;
          if (response.status === 404) {
            setProjection(null);
            setState("not-found");
            return;
          }
          if (!response.ok) throw new Error();
          setProjection(
            parsePublicMapProjection(
              isRecord(body) ? body.map : undefined,
            ),
          );
          setState("ready");
        })
        .catch((error) => {
          if (
            disposed ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            return;
          }
          setProjection(null);
          setState("error");
        })
        .finally(() => {
          if (activeController === controller) activeController = null;
        });
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") loadProjection();
    }

    window.addEventListener("focus", loadProjection);
    window.addEventListener("pageshow", loadProjection);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    loadProjection();

    return () => {
      disposed = true;
      activeController?.abort();
      window.removeEventListener("focus", loadProjection);
      window.removeEventListener("pageshow", loadProjection);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [handle]);

  if (state === "loading") {
    return <main className="shared-map-state"><p role="status">Loading shared map…</p></main>;
  }
  if (state === "not-found") {
    return (
      <main className="shared-map-state">
        <h1>Shared map not found</h1>
        <p>This link is unavailable. It may have been disabled or replaced.</p>
      </main>
    );
  }
  if (state === "error" || !projection) {
    return (
      <main className="shared-map-state">
        <h1>Shared map unavailable</h1>
        <p role="alert">The view-only map could not be loaded. Try again later.</p>
      </main>
    );
  }

  return <SharedMapProjectionView projection={projection} />;
}

export function SharedMapProjectionView({
  projection,
}: {
  projection: PublicMapProjection;
}) {
  const [viewMode, setViewMode] = useState<MapViewMode>("globe");
  const mapData = useMemo(
    () => toSharedMapData(projection.routes),
    [projection.routes],
  );
  return (
    <main className="shared-map-page" id="main-content">
      <header className="shared-map-header">
        <p className="eyebrow">Public shared map</p>
        <h1>
          {projection.owner.displayName
            ? `${projection.owner.displayName}’s Waypointer map`
            : "Shared Waypointer map"}
        </h1>
        <p>
          Approximate aggregated routes · {projection.summary.flightCount.toLocaleString()} flights · {mapData.routes.length.toLocaleString()} routes
        </p>
        <MapViewToggle value={viewMode} onChange={setViewMode} />
      </header>
      <section className="shared-map-canvas" aria-label="Shared Waypointer map">
        <GlobePanel
          airports={mapData.airports}
          routes={mapData.routes}
          visibleKind="all"
          zoom={mapData.homeFrame.zoom}
          zoomCommandToken={0}
          focusAirportCode=""
          selectedRouteId=""
          resetToken={0}
          homeFrame={mapData.homeFrame}
          autoRotate={false}
          viewMode={viewMode}
          onSelectAirport={() => {}}
          onSelectRoute={() => {}}
          onZoomChange={() => {}}
        />
      </section>
      <p className="shared-map-privacy">
        Locations are intentionally approximate. This public view cannot edit
        flights or access the owner’s account.
      </p>
    </main>
  );
}

function toSharedMapData(publicRoutes: PublicMapProjection["routes"]) {
  const airportByKey = new Map<string, Airport>();
  const routes = new Map<string, MapRoute>();
  const airportFor = (point: PublicMapProjection["routes"][number]["origin"]) => {
    const key = `${point.lat.toFixed(1)}|${point.lon.toFixed(1)}|${point.country}`;
    const existing = airportByKey.get(key);
    if (existing) return existing;
    const airport: Airport = {
      code: `R${airportByKey.size + 1}`,
      name: `Approximate region in ${point.country}`,
      city: point.country,
      country: point.country,
      lat: point.lat,
      lon: point.lon,
      facility: "commercial",
    };
    airportByKey.set(key, airport);
    return airport;
  };
  for (const route of publicRoutes) {
    const origin = airportFor(route.origin);
    const destination = airportFor(route.destination);
    const endpoints = [
      `${route.origin.lat.toFixed(1)}|${route.origin.lon.toFixed(1)}`,
      `${route.destination.lat.toFixed(1)}|${route.destination.lon.toFixed(1)}`,
    ].sort();
    const key = `${route.kind}|${endpoints.join("|")}`;
    const existing = routes.get(key);
    if (existing) {
      existing.flightCount += route.flightCount;
      const incomingForward =
        endpoints[0] === `${route.origin.lat.toFixed(1)}|${route.origin.lon.toFixed(1)}`;
      if (incomingForward) {
        existing.forwardFlightCount =
          (existing.forwardFlightCount ?? 0) + route.flightCount;
      } else {
        existing.reverseFlightCount =
          (existing.reverseFlightCount ?? 0) + route.flightCount;
      }
      continue;
    }
    const canonical =
      endpoints[0] === `${route.origin.lat.toFixed(1)}|${route.origin.lon.toFixed(1)}`;
    routes.set(key, {
      id: `shared-route-${routes.size + 1}`,
      origin: canonical ? origin : destination,
      destination: canonical ? destination : origin,
      kind: route.kind,
      flightCount: route.flightCount,
      forwardFlightCount: canonical ? route.flightCount : 0,
      reverseFlightCount: canonical ? 0 : route.flightCount,
    });
  }
  const aggregatedRoutes = [...routes.values()];
  return {
    airports: [...airportByKey.values()],
    routes: aggregatedRoutes,
    homeFrame: deriveInitialMapFrame(aggregatedRoutes),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
