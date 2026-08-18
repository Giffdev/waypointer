"use client";

import { useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  Plane,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import {
  flightSourceLabels,
  flightTypeLabels,
  formatFlightDate,
  hasActiveFlightFilters,
  MONTH_NAMES,
  periodLabels,
  quickPeriods,
  serializeFiltersForHref,
} from "@/components/dashboard-shared";
import { FilterCombobox } from "@/components/filter-combobox";
import { FlightEntryDialog } from "@/components/flight-entry-dialog";
import { ManualFlightDialog } from "@/components/manual-flight-dialog";
import type { FlightFilters, FlightPeriodFilter } from "@/lib/flight-filters";
import type {
  FlightsPageContract,
  SanitizedHistoryFlight,
} from "@/lib/route-contracts";

const emptyFilters: FlightFilters = {
  type: "all",
  period: "any",
  year: "all",
  month: "all",
  source: "all",
  aircraft: "all",
  registration: "all",
};

export default function FlightsRouteClient({
  data,
}: {
  data: FlightsPageContract;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const filters = data.filters;
  const [historySearch, setHistorySearch] = useState("");
  const [localEdits, setLocalEdits] = useState<
    Record<
      string,
      Pick<SanitizedHistoryFlight, "origin" | "destination">
    >
  >({});
  const [excludedFlightIds, setExcludedFlightIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeAction, setActiveAction] = useState<{
    mode: "edit" | "delete";
    flight: SanitizedHistoryFlight;
  } | null>(null);
  const [actionStatus, setActionStatus] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const recordsStatusRef = useRef<HTMLParagraphElement>(null);

  const sessionFlights = useMemo(
    () =>
      data.flights
        .filter((flight) => !excludedFlightIds.has(flight.id))
        .map((flight) => ({ ...flight, ...localEdits[flight.id] })),
    [data.flights, excludedFlightIds, localEdits],
  );

  const historyFlights = useMemo(() => {
    const search = historySearch.trim().toLowerCase();
    return sessionFlights.filter((flight) => {
      if (!search) return true;
      return [
        flight.origin.code,
        flight.origin.name,
        flight.origin.city,
        flight.destination.code,
        flight.destination.name,
        flight.destination.city,
        flight.aircraft,
        flight.aircraftType,
        flight.aircraftModel,
        flight.registration,
        flight.role,
        flight.source,
      ].some((value) => value?.toLowerCase().includes(search));
    });
  }, [sessionFlights, historySearch]);

  const updateFilters = (nextFilters: FlightFilters) => {
    router.push(`${pathname}${serializeFiltersForHref(nextFilters)}`, {
      scroll: false,
    });
  };

  return (
    <main className="app-shell" id="main-content" tabIndex={-1}>
      <section className="content-section records-section route-page" id="records">
        <div className="map-control-panel panel-surface route-filter-header">
          <details className="route-filter-disclosure">
            <summary>
              <span className="route-filter-summary-copy">
                <span className="control-kicker">Flight filters</span>
                <strong>
                  {data.flights.length.toLocaleString()} flights in history
                </strong>
                <span className="route-filter-summary-state">
                  {periodLabels[filters.period]} ·{" "}
                  {flightTypeLabels[filters.type]}
                  {filters.source !== "all"
                    ? ` · ${flightSourceLabels[filters.source]}`
                    : ""}
                  {filters.aircraft !== "all"
                    ? ` · ${filters.aircraft}`
                    : ""}
                  {filters.registration !== "all"
                    ? ` · ${filters.registration}`
                    : ""}
                </span>
              </span>
              <span className="route-filter-summary-toggle">
                <SlidersHorizontal aria-hidden="true" size={16} />
                <span>Filters</span>
                <ChevronDown aria-hidden="true" size={16} />
              </span>
            </summary>
            <div className="route-filter-body">
              <div className="route-filter-actions">
                <span>Refine the URL-owned history view</span>
                <button
                  className="clear-filters"
                  type="button"
                  onClick={() => updateFilters(emptyFilters)}
                  disabled={!hasActiveFlightFilters(filters)}
                >
                  <RotateCcw size={15} />
                  Clear filters
                </button>
              </div>
              <div className="route-filter-controls">
                <fieldset className="flight-type-filter">
                  <legend>Flight role / type</legend>
                  <label className="period-select compact-type-select">
                    <span className="period-select-control">
                      <select
                        aria-label="Filter flights by flight role or type"
                        value={filters.type}
                        onChange={(event) =>
                          updateFilters({
                            ...filters,
                            type: event.target.value as FlightFilters["type"],
                          })
                        }
                      >
                        {Object.keys(flightTypeLabels).map((type) => (
                          <option value={type} key={type}>
                            {
                              flightTypeLabels[
                                type as keyof typeof flightTypeLabels
                              ]
                            }
                          </option>
                        ))}
                      </select>
                      <ChevronDown aria-hidden="true" size={17} />
                    </span>
                  </label>
                </fieldset>
                <fieldset className="quick-period-filter">
                  <legend>Quick date range</legend>
                  <label className="period-select">
                    <span className="period-select-control">
                      <select
                        aria-label="Filter flights by period"
                        value={filters.period}
                        onChange={(event) =>
                          updateFilters({
                            ...filters,
                            period: event.target.value as FlightPeriodFilter,
                          })
                        }
                      >
                        {quickPeriods.map((period) => (
                          <option value={period} key={period}>
                            {periodLabels[period]}
                          </option>
                        ))}
                      </select>
                      <ChevronDown aria-hidden="true" size={17} />
                    </span>
                    <span className="period-range">
                      <span>Resolved range</span>{" "}
                      <strong>{data.periodRange}</strong>
                    </span>
                  </label>
                </fieldset>
                {filters.period === "custom" && (
                  <fieldset className="route-custom-date-filter">
                    <legend>Custom date</legend>
                    <div className="filter-select-grid">
                      <label className="airport-select">
                        <span>Custom year</span>
                        <select
                          aria-label="Filter flights by year"
                          value={filters.year}
                          onChange={(event) =>
                            updateFilters({
                              ...filters,
                              period: "custom",
                              year:
                                event.target.value === "all"
                                  ? "all"
                                  : Number(event.target.value),
                            })
                          }
                        >
                          <option value="all">All years</option>
                          {data.filterOptions.years.map(
                            ({ value, available }) => (
                              <option
                                value={value}
                                key={value}
                                disabled={
                                  !available && filters.year !== value
                                }
                              >
                                {value}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <label className="airport-select">
                        <span>Custom month</span>
                        <select
                          aria-label="Filter flights by month"
                          value={filters.month}
                          onChange={(event) => {
                            const month =
                              event.target.value === "all"
                                ? "all"
                                : Number(event.target.value);
                            const selectedYear =
                              month === "all" || filters.year !== "all"
                                ? filters.year
                                : data.latestYearByMonth[month];
                            updateFilters({
                              ...filters,
                              period: "custom",
                              year: selectedYear,
                              month,
                            });
                          }}
                        >
                          <option value="all">All months</option>
                          {data.filterOptions.months.map(
                            ({ value, available }) => (
                              <option
                                value={value}
                                key={value}
                                disabled={
                                  !available && filters.month !== value
                                }
                              >
                                {MONTH_NAMES[value - 1]}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    </div>
                  </fieldset>
                )}
                <fieldset className="aircraft-metadata-filter">
                  <legend>Aircraft metadata</legend>
                  <div className="filter-select-grid">
                    <FilterCombobox
                      label="Aircraft type / model"
                      ariaLabel="Filter flights by aircraft type or model"
                      searchLabel="aircraft search"
                      allLabel="All available aircraft"
                      value={filters.aircraft}
                      options={data.filterOptions.aircraft}
                      onChange={(aircraft) =>
                        updateFilters({ ...filters, aircraft })
                      }
                    />
                    <FilterCombobox
                      label="Tail number / registration"
                      ariaLabel="Filter flights by tail number or registration"
                      searchLabel="registration search"
                      allLabel="All available registrations"
                      value={filters.registration}
                      options={data.filterOptions.registrations}
                      onChange={(registration) =>
                        updateFilters({ ...filters, registration })
                      }
                    />
                  </div>
                </fieldset>
              </div>
              <p className="filter-status" role="status" aria-live="polite">
                <strong>{periodLabels[filters.period]}:</strong>{" "}
                {data.periodRange} · {flightTypeLabels[filters.type]}
                {filters.aircraft !== "all"
                  ? ` · Aircraft ${filters.aircraft}`
                  : ""}
                {filters.registration !== "all"
                  ? ` · Registration ${filters.registration}`
                  : ""}
                {filters.source !== "all"
                  ? ` · Source ${flightSourceLabels[filters.source]}`
                  : ""}{" "}
                · As of {data.asOfDate} ({data.timeZone}).
              </p>
            </div>
          </details>
        </div>
        <div className="section-heading record-heading">
          <div>
            <p className="eyebrow">Flight history</p>
            <h1>Review your current flight records.</h1>
          </div>
          <p>
            Search the map-safe record set. Edit an incorrectly imported
            departure or arrival, or remove a flight from this view.
          </p>
          <button className="primary-button" type="button" onClick={() => setManualOpen(true)}>
            <Plus size={17} aria-hidden="true" />
            Add flight
          </button>
        </div>
        {manualOpen && (
          <ManualFlightDialog
            close={() => setManualOpen(false)}
            onCreated={() => {
              setManualOpen(false);
              router.push("/map");
              router.refresh();
            }}
          />
        )}
        <div className="history-toolbar">
          <label className="history-search">
            <span>Search flight history</span>
            <div className="search-field">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={historySearch}
                onChange={(event) => setHistorySearch(event.target.value)}
                placeholder="Route, airport, aircraft, role, or source"
              />
            </div>
          </label>
          <label className="history-source">
            <span>Import source</span>
            <select
              aria-label="Filter flights by import source"
              value={filters.source}
              onChange={(event) =>
                updateFilters({
                  ...filters,
                  source: event.target.value as FlightFilters["source"],
                })
              }
            >
              <option value="all">{flightSourceLabels.all}</option>
              {data.filterOptions.sources.map(({ value, available }) => (
                <option
                  value={value}
                  key={value}
                  disabled={!available && filters.source !== value}
                >
                  {
                    flightSourceLabels[
                      value as Exclude<FlightFilters["source"], "all">
                    ]
                  }
                </option>
              ))}
            </select>
          </label>
        </div>
        <p
          className="records-status"
          role="status"
          aria-label="Flight records status"
          aria-live="polite"
          tabIndex={-1}
          ref={recordsStatusRef}
        >
          {historyFlights.length.toLocaleString()} of{" "}
          {sessionFlights.length.toLocaleString()} records shown from the current
          map filter
          {historyFlights.length > 50 ? " · first 50 rendered" : ""}.
          {actionStatus ? ` ${actionStatus}` : ""}
        </p>
        <div className="flight-list">
          {historyFlights.length === 0 && (
            <div className="flight-empty-state">
              <Plane size={20} />
              <strong>
                {data.flights.length === 0
                  ? "No records in the current map filter"
                  : sessionFlights.length === 0
                    ? "No active records in this view"
                  : "No records match this history search"}
              </strong>
              <span>
                {data.flights.length === 0
                  ? "Clear or adjust the map filters to restore history."
                  : sessionFlights.length === 0
                    ? "Reload the page to restore flights removed from this temporary view."
                  : "Change the search or source filter; no records were modified."}
              </span>
            </div>
          )}
          {historyFlights.slice(0, 50).map((flight) => (
            <article className="flight-row" key={flight.id}>
              <div className={`flight-kind ${flight.kind}`}>
                <Plane size={17} />
              </div>
              <div className="flight-primary">
                <div className="route">
                  <strong>{flight.origin.code}</strong>
                  <span className="route-line" />
                  <strong>{flight.destination.code}</strong>
                  <small>
                    {flight.origin.city} → {flight.destination.city}
                  </small>
                </div>
                <div className="record-tags">
                  <span>{flight.role === "pilot" ? "Pilot" : "Passenger"}</span>
                  <span>{flight.source}</span>
                </div>
              </div>
              <div className="flight-meta">
                <strong>{formatFlightDate(flight.date)}</strong>
                <span>
                  {flight.aircraftModel ??
                    flight.aircraftType ??
                    flight.aircraft}
                  {flight.registration ? ` · ${flight.registration}` : ""}
                  {` · ${flight.distance}`}
                </span>
              </div>
              <div className="flight-actions">
                <button
                  className="flight-action-button"
                  type="button"
                  aria-label={`Edit ${flight.origin.code} to ${flight.destination.code} flight`}
                  onClick={() => setActiveAction({ mode: "edit", flight })}
                >
                  Edit
                </button>
                <button
                  className="flight-action-button danger"
                  type="button"
                  aria-label={`Delete ${flight.origin.code} to ${flight.destination.code} flight`}
                  onClick={() => setActiveAction({ mode: "delete", flight })}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
        {activeAction && (
          <FlightEntryDialog
            mode={activeAction.mode}
            flight={activeAction.flight}
            close={() => setActiveAction(null)}
            save={(endpoints) => {
              setLocalEdits((current) => ({
                ...current,
                [activeAction.flight.id]: endpoints,
              }));
              setActionStatus(
                "Flight updated in this view only. Reloading restores imported data.",
              );
              setActiveAction(null);
            }}
            remove={() => {
              setExcludedFlightIds((current) => {
                const next = new Set(current);
                next.add(activeAction.flight.id);
                return next;
              });
              setActionStatus(
                "Flight removed from this view only. Reloading restores imported data.",
              );
              setActiveAction(null);
              window.requestAnimationFrame(() => recordsStatusRef.current?.focus());
            }}
          />
        )}
      </section>
    </main>
  );
}
