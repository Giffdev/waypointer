"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, Pause, Play, RotateCcw, Sparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import { AirportFocusCombobox } from "@/components/airport-focus-combobox";
import { FilterCombobox } from "@/components/filter-combobox";
import GlobePanel from "@/components/globe-panel";
import { MapLegend } from "@/components/map-legend";
import { MapShareControl } from "@/components/map-share-control";
import { ImportAttentionBanner } from "@/components/import-attention-banner";
import { MapViewToggle } from "@/components/map-view-toggle";
import type { MapViewMode } from "@/lib/map-view-mode";
import { displayedMapZoom } from "@/lib/map-zoom-sync";
import { createMapZoomController, type MapZoomController } from "@/lib/map-camera";
import type { FlightFilters, FlightPeriodFilter } from "@/lib/flight-filters";
import type { MapPageContract } from "@/lib/route-contracts";
import { formatRouteDirection } from "@/lib/route-direction";
import { airportExactIdentity } from "@/lib/flight-data";
import { flightTypeLabels, hasActiveFlightFilters, MONTH_NAMES, periodLabels, quickPeriods, serializeFiltersForHref } from "@/components/dashboard-shared";

const emptyFilters: FlightFilters = {
  type: "all",
  period: "any",
  year: "all",
  month: "all",
  source: "all",
  aircraft: "all",
  registration: "all",
};

export default function MapRouteClient({ data }: { data: MapPageContract }) {
  const router = useRouter();
  const pathname = usePathname();
  const filters = data.filters;
  const activeAirportIdentities = useMemo(
    () => new Set(data.activeAirportIdentities),
    [data.activeAirportIdentities],
  );
  const [mapZoom, setMapZoom] = useState(data.homeFrame.zoom);
  const [mapZoomCommandToken, setMapZoomCommandToken] = useState(0);
  const [focusAirportIdentity, setFocusAirportIdentity] = useState("");
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const [autoRotate, setAutoRotate] = useState(false);
  const [mapViewMode, setMapViewMode] = useState<MapViewMode>(data.mapViewMode);
  const [mapViewStatus, setMapViewStatus] = useState("");
  const airportFocusSelectRef = useRef<HTMLInputElement>(null);
  const mapZoomControllerRef = useRef<MapZoomController | null>(null);
  const mapViewRequestRef = useRef(0);
  const activeAirportCodes = activeAirportIdentities;
  const focusAirportCode = focusAirportIdentity;
  const setFocusAirportCode = setFocusAirportIdentity;
  mapZoomControllerRef.current ??= createMapZoomController(data.homeFrame.zoom);
  const selectedAirport = useMemo(() => data.airports.find((airport) => airportExactIdentity(airport) === focusAirportIdentity), [data.airports, focusAirportIdentity]);
  const focusedRoutes = useMemo(() => focusAirportIdentity ? data.routes.filter((route) => airportExactIdentity(route.origin) === focusAirportIdentity || airportExactIdentity(route.destination) === focusAirportIdentity).toSorted((left, right) => right.flightCount - left.flightCount || left.id.localeCompare(right.id)) : [], [focusAirportIdentity, data.routes]);
  const busiestRoute = data.busiestRoute
    ? data.routes.find(({ id }) => id === data.busiestRoute?.id) ?? null
    : null;
  const focusedRouteCount = focusedRoutes.length;
  const updateFilters = (nextFilters: FlightFilters) => {
    setFocusAirportIdentity("");
    setSelectedRouteId("");
    router.push(`${pathname}${serializeFiltersForHref(nextFilters)}`, { scroll: false });
  };
  const clearAirportFocus = (restore = false) => { setFocusAirportIdentity(""); setSelectedRouteId(""); if (restore) window.setTimeout(() => airportFocusSelectRef.current?.focus(), 0); };
  const syncMapZoom = useCallback((zoom: number) => { const synchronizedZoom = mapZoomControllerRef.current!.sync(zoom); setMapZoom((currentZoom) => displayedMapZoom(currentZoom) === displayedMapZoom(synchronizedZoom) ? currentZoom : synchronizedZoom); }, []);
  const stepMapZoom = useCallback((delta: number) => { setMapZoom(mapZoomControllerRef.current!.step(delta)); setMapZoomCommandToken((token) => token + 1); }, []);
  const resetMap = () => { setFocusAirportIdentity(""); setSelectedRouteId(""); setAutoRotate(false); setResetToken((token) => token + 1); };
  const changeMapView = async (nextMode: MapViewMode) => {
    const requestId = ++mapViewRequestRef.current;
    const previousMode = mapViewMode;
    setMapViewMode(nextMode);
    if (nextMode === "flat") setAutoRotate(false);
    setMapViewStatus(data.dataMode === "persisted" ? "Saving map view…" : "");
    if (data.dataMode !== "persisted") return;
    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapViewMode: nextMode }),
      });
      if (!response.ok) throw new Error();
      if (requestId !== mapViewRequestRef.current) return;
      setMapViewStatus("Map view preference saved.");
    } catch {
      if (requestId !== mapViewRequestRef.current) return;
      setMapViewMode(previousMode);
      setMapViewStatus("Map view preference could not be saved.");
    }
  };

  return <main className="app-shell" id="main-content" tabIndex={-1}><section className="map-stage" id="map" aria-label="Your private flight map"><p className="sr-only" role="status" aria-label="Map zoom level" aria-live="polite" aria-atomic="true">Map zoom level {displayedMapZoom(mapZoom).toFixed(1)}</p><GlobePanel airports={data.airports} routes={data.routes} routePathFlights={data.routePathFlights} visibleKind="all" zoom={mapZoom} zoomCommandToken={mapZoomCommandToken} focusAirportCode={focusAirportCode} selectedRouteId={selectedRouteId} resetToken={resetToken} homeFrame={data.homeFrame} autoRotate={autoRotate} viewMode={mapViewMode} onSelectAirport={(code) => { setFocusAirportCode(code); setSelectedRouteId(""); }} onSelectRoute={setSelectedRouteId} onZoomChange={syncMapZoom} /><div className="map-overlay">{data.dataMode === "persisted" && <ImportAttentionBanner />}<div className="map-intro panel-surface"><p className="eyebrow"><Sparkles size={14} />{data.dataMode === "persisted" ? "Your saved flight history" : data.dataMode === "local-preview" ? "Local logbook preview" : "Representative flight history"}</p><h1>Your world,<br /><span>flight by flight.</span></h1><p>{data.dataMode === "persisted" ? "Review your saved routes and flight activity." : data.dataMode === "local-preview" ? "Explore sanitized flight and map details generated locally from your ignored logbook export." : "Explore commercial journeys and personal logbook routes together."} Route intensity reflects how often each connection was flown.</p></div><div className="map-control-panel panel-surface" id="map-controls"><div className="control-heading"><div><span className="control-kicker">View controls</span><strong>Explore globe & regions</strong></div><div className="icon-controls" aria-label="Globe camera controls"><button onClick={() => stepMapZoom(0.75)} aria-label="Zoom in" title="Zoom in"><ZoomIn size={17} /></button><button onClick={() => stepMapZoom(-0.75)} aria-label="Zoom out" title="Zoom out"><ZoomOut size={17} /></button>  <button onClick={() => setAutoRotate((rotating) => !rotating)} aria-pressed={autoRotate} aria-label={autoRotate ? "Pause globe rotation" : "Start globe rotation"} title={autoRotate ? "Pause rotation" : "Start rotation"} disabled={mapViewMode === "flat"}>{autoRotate ? <Pause size={16} /> : <Play size={16} />}</button><button className="home-control" onClick={resetMap} aria-label="Fit my flights" title="Return to my flight region"><RotateCcw size={16} /><span>Home</span></button>{data.dataMode === "persisted" && <MapShareControl />}  </div></div><div className="map-view-control"><span className="control-kicker" id="map-view-label">Projection</span><MapViewToggle value={mapViewMode} onChange={changeMapView} labelledBy="map-view-label" /><p className="map-view-status" role="status" aria-live="polite">{mapViewStatus}</p></div><div className="flight-filter-panel" aria-label="Map flight filters"><div className="filter-heading"><div><span className="control-kicker">Flights shown</span><strong>{data.filteredFlightCount.toLocaleString()} flights · {data.routes.length.toLocaleString()} routes</strong></div><button className="clear-filters" type="button" onClick={() => updateFilters(emptyFilters)} disabled={!hasActiveFlightFilters(filters)}><RotateCcw size={15} />Clear filters</button></div><fieldset className="flight-type-filter"><legend>Flight role / type</legend><label className="period-select compact-type-select"><span className="period-select-control"><select aria-label="Filter flights by flight role or type" value={filters.type} onChange={(event) => updateFilters({ ...filters, type: event.target.value as FlightFilters["type"] })}>{Object.keys(flightTypeLabels).map((type) => <option value={type} key={type}>{flightTypeLabels[type as keyof typeof flightTypeLabels]}</option>)}</select><ChevronDown aria-hidden="true" size={17} /></span></label></fieldset><fieldset className="quick-period-filter"><legend>Quick date range</legend><label className="period-select"><span className="period-select-control"><select aria-label="Filter flights by period" aria-describedby="period-range" value={filters.period} onChange={(event) => { const period = event.target.value as FlightPeriodFilter; updateFilters({ ...filters, period }); }} >{quickPeriods.map((period) => <option value={period} key={period}>{periodLabels[period]}</option>)}</select><ChevronDown aria-hidden="true" size={17} /></span><span className="period-range" id="period-range"><span>Resolved range</span> <strong>{data.periodRange}</strong></span></label></fieldset>{filters.period === "custom" && <div className="filter-select-grid"><label className="airport-select"><span>Custom year</span><select aria-label="Filter flights by year" value={filters.year} onChange={(event) => updateFilters({ ...filters, period: "custom", year: event.target.value === "all" ? "all" : Number(event.target.value) })}><option value="all">All years</option>{data.filterOptions.years.map(({ value, available }) => <option value={value} key={value} disabled={!available && filters.year !== value}>{value}</option>)}</select></label><label className="airport-select"><span>Custom month</span><select aria-label="Filter flights by month" value={filters.month} onChange={(event) => { const month = event.target.value === "all" ? "all" : Number(event.target.value); const selectedYear = month === "all" || filters.year !== "all" ? filters.year : data.latestYearByMonth[month]; updateFilters({ ...filters, period: "custom", year: selectedYear, month }); }}><option value="all">All months</option>{data.filterOptions.months.map(({ value, available }) => <option value={value} key={value} disabled={!available && filters.month !== value}>{MONTH_NAMES[value - 1]}</option>)}</select></label></div>}<fieldset className="aircraft-metadata-filter"><legend>Aircraft metadata</legend><div className="filter-select-grid"><FilterCombobox label="Aircraft type / model" ariaLabel="Filter flights by aircraft type or model" searchLabel="aircraft search" allLabel="All available aircraft" value={filters.aircraft} options={data.filterOptions.aircraft} onChange={(aircraft) => updateFilters({ ...filters, aircraft })} /><FilterCombobox label="Tail number / registration" ariaLabel="Filter flights by tail number or registration" searchLabel="registration search" allLabel="All available registrations" value={filters.registration} options={data.filterOptions.registrations} onChange={(registration) => updateFilters({ ...filters, registration })} /></div></fieldset><p className="filter-status" role="status" aria-live="polite"><strong>{periodLabels[filters.period]}:</strong> {data.periodRange} · {flightTypeLabels[filters.type]}{filters.aircraft !== "all" ? ` · Aircraft ${filters.aircraft}` : ""}{filters.registration !== "all" ? ` · Registration ${filters.registration}` : ""} · As of {data.asOfDate} ({data.timeZone}).</p>{data.filteredFlightCount === 0 && <div className="filter-empty-state"><strong>No flights match these filters</strong><span>The map remains available. Choose another filter or use Clear filters.</span></div>}</div><div className="airport-focus-toolbar"><div className="airport-focus-row">  <AirportFocusCombobox airports={data.airports} activeAirportCodes={activeAirportCodes} value={focusAirportCode} inputRef={airportFocusSelectRef} describedBy="airport-focus-status" onChange={(code) => { setFocusAirportCode(code); setSelectedRouteId(""); }} /><button className="airport-focus-clear" type="button" aria-label="Clear airport focus" disabled={!focusAirportCode} onClick={() => clearAirportFocus(true)}><X size={15} aria-hidden="true" />Clear</button></div><p className="airport-focus-status" id="airport-focus-status" role="status" aria-label="Airport focus status" aria-live="polite" aria-atomic="true">{selectedAirport ? `Map focused on ${selectedAirport.code}, ${selectedAirport.name}. ${focusedRouteCount.toLocaleString()} connected ${focusedRouteCount === 1 ? "route" : "routes"}.` : `No airport focus. ${activeAirportCodes.size.toLocaleString()} active airports and ${data.airports.length.toLocaleString()} contextual airports available.`}</p></div><details className="stats-ribbon panel-surface" open><summary><span><span className="control-kicker">Flight insights</span><strong>Statistics for this map slice</strong></span><ChevronDown size={16} aria-hidden="true" /></summary><div className="stats-ribbon-grid">{data.statsCards.map((card) => <article className="stats-ribbon-card" key={card.label} title={card.description}><span>{card.label}</span><strong>{card.value}</strong>{card.secondary && <small>{card.secondary}</small>}{card.delta && <small className={`metric-delta ${card.delta === "No prior baseline" ? "neutral" : ""}`}>{card.delta}</small>}</article>)}</div><div className="stats-insight-row"><span><strong>Busiest route:</strong> {data.busiestRoute && busiestRoute ? `${formatRouteDirection(busiestRoute)} · ${data.busiestRoute.flightCount.toLocaleString()} ${data.busiestRoute.flightCount === 1 ? "flight" : "flights"}` : "—"}</span><span><strong>Comparison:</strong> {data.comparisonText}</span></div>{data.completenessText && <p className="stats-completeness">{data.completenessText}</p>}</details>{selectedAirport && <p className="selected-airport" aria-live="polite"><strong>{selectedAirport.code}</strong>{selectedAirport.name} · Airport<span>{focusedRouteCount.toLocaleString()} connected {focusedRouteCount === 1 ? "route" : "routes"} isolated. Zoom further or select a route for its frequency.</span></p>}{selectedAirport && focusedRoutes.length > 0 && <label className="airport-select route-select"><span>Inspect a connected route</span><select value={selectedRouteId} onChange={(event) => setSelectedRouteId(event.target.value)}><option value="">Choose a route</option>{focusedRoutes.map((route) => <option value={route.id} key={route.id}>{formatRouteDirection(route)} · {route.flightCount.toLocaleString()} {route.flightCount === 1 ? "flight" : "flights"}</option>)}</select>  </label>}</div><MapLegend airports={data.airports} routes={data.routes} selectedRouteId={selectedRouteId} /></div><div className="sr-only">The map contains {data.routes.length} routes, {data.airports.length} contextual airports, and {activeAirportCodes.size} active airports.</div></section></main>;
}
