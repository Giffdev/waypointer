"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FilterCombobox } from "@/components/filter-combobox";
import GlobePanel from "@/components/globe-panel";
import type { Airport, MapRoute } from "@/lib/flight-data";
import { deriveInitialMapFrame } from "@/lib/map-framing";
import { MapViewToggle } from "@/components/map-view-toggle";
import { MapLegend } from "@/components/map-legend";
import type { MapViewMode } from "@/lib/map-view-mode";
import { parsePublicMapProjection } from "@/lib/sharing/client-projection";
import {
  DEFAULT_PUBLIC_MAP_FILTERS,
  derivePublicMapSlice,
  hasActivePublicMapFilters,
  publicMapFilterOptions,
  publicMapFilterOptionsForFilters,
  type PublicMapFilters,
} from "@/lib/sharing/public-map-filtering";
import type { PublicMapProjection } from "@/lib/sharing/service";
import { formatRouteDirection } from "@/lib/route-direction";

const PUBLIC_MAP_REVALIDATE_INTERVAL_MS = 30_000;

export function SharedMapView({ handle }: { handle: string }) {
  const [projection, setProjection] = useState<PublicMapProjection | null>(null);
  const [state, setState] = useState<
    | "loading"
    | "ready"
    | "not-found"
    | "republish-required"
    | "rate-limited"
    | "error"
  >("loading");
  const nextRequestAtRef = useRef(0);

  useEffect(() => {
    nextRequestAtRef.current = 0;
    let disposed = false;
    let activeController: AbortController | null = null;

    function loadProjection() {
      if (
        disposed ||
        activeController ||
        Date.now() < nextRequestAtRef.current
      ) {
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      nextRequestAtRef.current =
        Date.now() + PUBLIC_MAP_REVALIDATE_INTERVAL_MS;
      setState((current) => (current === "ready" ? current : "loading"));

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
          if (
            response.status === 409 &&
            isRecord(body) &&
            isRecord(body.error) &&
            body.error.code === "republish-required"
          ) {
            setProjection(null);
            setState("republish-required");
            return;
          }
          if (response.status === 429) {
            const retryAfterSeconds = Number(
              response.headers.get("Retry-After"),
            );
            if (
              Number.isSafeInteger(retryAfterSeconds) &&
              retryAfterSeconds > 0
            ) {
              nextRequestAtRef.current = Math.max(
                nextRequestAtRef.current,
                Date.now() + retryAfterSeconds * 1_000,
              );
            }
            setProjection(null);
            setState("rate-limited");
            return;
          }
          if (!response.ok) throw new Error();
          const parsedProjection = parsePublicMapProjection(
            isRecord(body) ? body.map : undefined,
          );
          nextRequestAtRef.current =
            Date.now() + PUBLIC_MAP_REVALIDATE_INTERVAL_MS;
          setProjection(parsedProjection);
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
  if (state === "republish-required") {
    return (
      <main className="shared-map-state">
        <h1>Shared map needs republishing</h1>
        <p>
          The owner must republish this map before it can show real airport
          names and codes.
        </p>
      </main>
    );
  }
  if (state === "rate-limited") {
    return (
      <main className="shared-map-state">
        <h1>Shared map temporarily busy</h1>
        <p role="alert">Please wait a moment, then try this link again.</p>
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

  return <SharedMapProjectionView key={handle} projection={projection} />;
}

export function SharedMapProjectionView({
  projection,
}: {
  projection: PublicMapProjection;
}) {
  const [viewMode, setViewMode] = useState<MapViewMode>("globe");
  const [filters, setFilters] = useState<PublicMapFilters>(
    DEFAULT_PUBLIC_MAP_FILTERS,
  );
  const projectionAirportOptions = useMemo(
    () => publicMapFilterOptions(projection).airports,
    [projection],
  );
  const resolvedFilters = useMemo(
    () =>
      filters.airport === "all" ||
      projectionAirportOptions.some(({ value }) => value === filters.airport)
        ? filters
        : { ...filters, airport: "all" },
    [filters, projectionAirportOptions],
  );
  useEffect(() => {
    const validAirportValues = new Set(
      projectionAirportOptions.map(({ value }) => value),
    );
    const timeout = window.setTimeout(() => {
      setFilters((current) =>
        current.airport === "all" ||
        validAirportValues.has(current.airport)
          ? current
          : { ...current, airport: "all" },
      );
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [projectionAirportOptions]);
  const slice = useMemo(
    () => derivePublicMapSlice(projection, resolvedFilters),
    [projection, resolvedFilters],
  );
  const filterOptions = useMemo(
    () => publicMapFilterOptionsForFilters(projection, resolvedFilters),
    [projection, resolvedFilters],
  );
  const mapData = useMemo(
    () => toSharedMapData(slice.routes),
    [slice.routes],
  );
  const focusedAirportCode = useMemo(
    () =>
      mapData.airports.find(
        (airport) => publicAirportKey(airport) === resolvedFilters.airport,
      )?.code ?? "",
    [mapData.airports, resolvedFilters.airport],
  );
  const busiestRoute = useMemo(
    () =>
      mapData.routes.toSorted(
        (left, right) =>
          right.flightCount - left.flightCount ||
          left.id.localeCompare(right.id),
      )[0] ?? null,
    [mapData.routes],
  );
  const activeFilters = hasActivePublicMapFilters(resolvedFilters);
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
          Shared airport routes · {slice.summary.flightCount.toLocaleString()} flights · {slice.summary.routeCount.toLocaleString()} routes
        </p>
        <MapViewToggle value={viewMode} onChange={setViewMode} />
      </header>
      <section
        className="shared-map-controls panel-surface"
        aria-labelledby="shared-map-filters-title"
      >
          <div className="shared-map-controls-heading">
            <div>
              <p className="eyebrow">Viewer controls</p>
              <h2 id="shared-map-filters-title">Filter shared flights</h2>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={!activeFilters}
              onClick={() => setFilters(DEFAULT_PUBLIC_MAP_FILTERS)}
            >
              Clear filters
            </button>
          </div>
          <div className="shared-map-filter-grid">
            <label>
              <span>Role</span>
              <select
                aria-label="Filter shared flights by role"
                value={resolvedFilters.role}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    role: event.target.value as PublicMapFilters["role"],
                  }))
                }
              >
                <option value="all">All roles</option>
                <option value="pilot">Pilot</option>
                <option value="passenger">Passenger</option>
              </select>
            </label>
            <label>
              <span>From date</span>
              <input
                aria-label="Filter shared flights from date"
                type="date"
                value={resolvedFilters.startDate}
                max={resolvedFilters.endDate || undefined}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    startDate: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Through date</span>
              <input
                aria-label="Filter shared flights through date"
                type="date"
                value={resolvedFilters.endDate}
                min={resolvedFilters.startDate || undefined}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    endDate: event.target.value,
                  }))
                }
              />
            </label>
            <FilterCombobox
              label="Aircraft type / model"
              ariaLabel="Filter shared flights by aircraft"
              searchLabel="shared aircraft search"
              allLabel="All shared aircraft"
              value={resolvedFilters.aircraft}
              options={filterOptions.aircraft}
              onChange={(aircraft) =>
                setFilters((current) => ({ ...current, aircraft }))
              }
            />
            <FilterCombobox
              label="Tail number / registration"
              ariaLabel="Filter shared flights by tail number or registration"
              searchLabel="shared registration search"
              allLabel="All shared registrations"
              value={resolvedFilters.registration}
              options={filterOptions.registrations}
              onChange={(registration) =>
                setFilters((current) => ({ ...current, registration }))
              }
            />
            <FilterCombobox
              label="Airport"
              ariaLabel="Filter shared flights by airport"
              searchLabel="shared airport search"
              allLabel="All shared airports"
              value={resolvedFilters.airport}
              options={filterOptions.airports}
              sortOptions={false}
              onChange={(airport) =>
                setFilters((current) => ({ ...current, airport }))
              }
            />
          </div>
          <p className="shared-map-filter-status" role="status" aria-live="polite">
            Showing {slice.summary.flightCount.toLocaleString()} of{" "}
            {projection.summary.flightCount.toLocaleString()} shared flights.
            Filters apply only in this browser.
          </p>
          {slice.summary.flightCount === 0 && (
            <div className="filter-empty-state">
              <strong>No shared flights match these filters</strong>
              <span>Choose another filter or use Clear filters.</span>
            </div>
          )}
      </section>
      <section
        className="shared-map-statistics"
        aria-labelledby="shared-map-statistics-title"
      >
        <h2 id="shared-map-statistics-title">Statistics for this view</h2>
        <div className="shared-map-stat-grid">
          <SharedStatistic
            label="Flights"
            value={slice.summary.flightCount}
          />
          <SharedStatistic label="Routes" value={slice.summary.routeCount} />
          <SharedStatistic
            label="Airports"
            value={slice.summary.airportCount}
          />
          <SharedStatistic
            label="Countries"
            value={slice.summary.countryCount}
          />
        </div>
        {busiestRoute && (
          <p className="shared-map-route-detail">
            <strong>Busiest route:</strong>{" "}
            {formatRouteDirection(busiestRoute, formatPublicAirport)} ·{" "}
            {busiestRoute.flightCount.toLocaleString()}{" "}
            {busiestRoute.flightCount === 1 ? "flight" : "flights"}
          </p>
        )}
      </section>
      <section className="shared-map-canvas" aria-label="Shared Waypointer map">
        <GlobePanel
          airports={mapData.airports}
          routes={mapData.routes}
          visibleKind="all"
          zoom={mapData.homeFrame.zoom}
          zoomCommandToken={0}
          focusAirportCode={focusedAirportCode}
          selectedRouteId=""
          resetToken={0}
          homeFrame={mapData.homeFrame}
          autoRotate={false}
          viewMode={viewMode}
          onSelectAirport={() => {}}
          onSelectRoute={() => {}}
          onZoomChange={() => {}}
        />
        <MapLegend
          airports={mapData.airports}
          routes={mapData.routes}
          selectedRouteId=""
        />
        <p className="shared-map-airport-label-note">
          Airport labels and route details use published airport codes and
          names.
        </p>
      </section>
      <p className="shared-map-privacy">
        Airport names, codes, and public map locations are shared. This public
        view cannot edit flights or access the owner’s account.
      </p>
    </main>
  );
}

function SharedStatistic({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </article>
  );
}

function formatPublicAirport(
  airport: Airport,
): string {
  return `${airport.code} — ${airport.name}`;
}

const MAX_PUBLIC_FRAME_ROUTES = 128;

export function toSharedMapData(
  publicRoutes: PublicMapProjection["routes"],
) {
  const airportByKey = new Map<string, Airport>();
  const routes = new Map<string, MapRoute>();
  const airportFor = (point: PublicMapProjection["routes"][number]["origin"]) => {
    const key = publicAirportKey(point);
    const existing = airportByKey.get(key);
    if (existing) return existing;
    const airport: Airport = { ...point };
    airportByKey.set(key, airport);
    return airport;
  };
  for (const route of publicRoutes) {
    const origin = airportFor(route.origin);
    const destination = airportFor(route.destination);
    const originKey = publicAirportKey(route.origin);
    const destinationKey = publicAirportKey(route.destination);
    const endpoints = [originKey, destinationKey].sort();
    const key = `${route.kind}|${endpoints.join("|")}`;
    const existing = routes.get(key);
    if (existing) {
      existing.flightCount += route.flightCount;
      const incomingForward = endpoints[0] === originKey;
      if (incomingForward) {
        existing.forwardFlightCount =
          (existing.forwardFlightCount ?? 0) + route.flightCount;
      } else {
        existing.reverseFlightCount =
          (existing.reverseFlightCount ?? 0) + route.flightCount;
      }
      continue;
    }
    const canonical = endpoints[0] === originKey;
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
  const frameStride = Math.max(
    1,
    Math.ceil(aggregatedRoutes.length / MAX_PUBLIC_FRAME_ROUTES),
  );
  const frameRoutes =
    frameStride === 1
      ? aggregatedRoutes
      : aggregatedRoutes
          .filter((_, index) => index % frameStride === 0)
          .slice(0, MAX_PUBLIC_FRAME_ROUTES);
  return {
    airports: [...airportByKey.values()],
    routes: aggregatedRoutes,
    homeFrame: deriveInitialMapFrame(frameRoutes),
  };
}

function publicAirportKey(
  point: PublicMapProjection["routes"][number]["origin"],
): string {
  return `${point.code}|${point.country}|${point.lat}|${point.lon}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
