"use client";

import { useEffect, useMemo, useState } from "react";
import GlobePanel from "@/components/globe-panel";
import type { Airport, MapRoute } from "@/lib/flight-data";
import { deriveInitialMapFrame } from "@/lib/map-framing";
import { MapViewToggle } from "@/components/map-view-toggle";
import type { MapViewMode } from "@/lib/map-view-mode";

type PublicProjection = {
  owner: { displayName: string | null };
  summary: { flightCount: number; routeCount: number };
  routes: Array<{
    id: string;
    kind: "commercial" | "private";
    flightCount: number;
    origin: { lat: number; lon: number; country: string };
    destination: { lat: number; lon: number; country: string };
  }>;
};

export function SharedMapView({ publicId }: { publicId: string }) {
  const [projection, setProjection] = useState<PublicProjection | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not-found" | "error">("loading");
  const [viewMode, setViewMode] = useState<MapViewMode>("globe");

  useEffect(() => {
    const key = new URLSearchParams(window.location.hash.slice(1)).get("key");
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    if (!key) {
      queueMicrotask(() => setState("not-found"));
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/shared/${encodeURIComponent(publicId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json();
        if (response.status === 404) {
          setState("not-found");
          return;
        }
        if (!response.ok) throw new Error();
        setProjection(body.map);
        setState("ready");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState("error");
      });
    return () => controller.abort();
  }, [publicId]);

  const mapData = useMemo(
    () => projection ? toSharedMapData(projection.routes) : null,
    [projection],
  );

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
  if (state === "error" || !projection || !mapData) {
    return (
      <main className="shared-map-state">
        <h1>Shared map unavailable</h1>
        <p role="alert">The view-only map could not be loaded. Try again later.</p>
      </main>
    );
  }

  return (
    <main className="shared-map-page" id="main-content">
      <header className="shared-map-header">
        <p className="eyebrow">View-only shared map</p>
        <h1>{projection.owner.displayName ? `${projection.owner.displayName}’s Waypointer map` : "Shared Waypointer map"}</h1>
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
        Locations are intentionally approximate. This shared view cannot edit
        flights or access the owner’s account.
      </p>
    </main>
  );
}

function toSharedMapData(publicRoutes: PublicProjection["routes"]) {
  const airportByKey = new Map<string, Airport>();
  const routes = new Map<string, MapRoute>();
  const airportFor = (point: PublicProjection["routes"][number]["origin"]) => {
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
