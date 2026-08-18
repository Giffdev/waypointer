"use client";

import { Plane } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const MAX_SHARED_FLIGHTS = 500;
const PAGE_SIZE = 50;

export type ShareFlightOption = {
  id: string;
  date: string;
  kind: "commercial" | "private";
  airportCodes: string[];
  cities: string[];
};

type ShareStatus = {
  enabled: boolean;
  sharePath: string | null;
  includeDisplayName: boolean;
  selectedFlightCount: number;
  selectedFlightIds: string[];
};

type CoarsePlace = { lat: number; lon: number; country: string };

type SharePreview = {
  previewId: string;
  selection: {
    flightIds: string[];
    includeDisplayName: boolean;
    selectedFlightCount: number;
  };
  projection: {
    owner: { displayName: string | null };
    summary: { flightCount: number; routeCount: number };
    routes: Array<{
      id: string;
      kind: "commercial" | "private";
      flightCount: number;
      origin: CoarsePlace;
      destination: CoarsePlace;
    }>;
    flights: Array<{
      id: string;
      kind: "commercial" | "private";
      legs: Array<{
        index: number;
        origin: CoarsePlace;
        destination: CoarsePlace;
      }>;
    }>;
  };
};

export function MapSharingPanel({ flights }: { flights: ShareFlightOption[] }) {
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [includeDisplayName, setIncludeDisplayName] = useState(false);
  const [consented, setConsented] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "commercial" | "private">("all");
  const [renderLimit, setRenderLimit] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<"revoke" | "regenerate" | "">("");
  const confirmationActionRef = useRef<HTMLButtonElement>(null);

  const filteredFlights = useMemo(() => {
    const query = search.trim().toLowerCase();
    return flights.filter((flight) => {
      if (kind !== "all" && flight.kind !== kind) return false;
      if (!query) return true;
      return [
        flight.date,
        flight.kind,
        ...flight.airportCodes,
        ...flight.cities,
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [flights, kind, search]);
  const visibleFlights = filteredFlights.slice(0, renderLimit);
  const selectedFlightIds = useMemo(
    () => [...selectedIds].toSorted(),
    [selectedIds],
  );
  const filteredSelectionWouldExceedLimit =
    new Set([...selectedIds, ...filteredFlights.map(({ id }) => id)]).size >
    MAX_SHARED_FLIGHTS;

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/account/sharing", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message);
        const nextStatus = body.sharing as ShareStatus;
        setStatus(nextStatus);
        if (nextStatus.enabled) {
          setIncludeDisplayName(nextStatus.includeDisplayName);
          const availableIds = new Set(flights.map(({ id }) => id));
          setSelectedIds(
            new Set(
              nextStatus.selectedFlightIds.filter((id) => availableIds.has(id)),
            ),
          );
        }
      })
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError("Sharing status could not be loaded.");
      });
    return () => controller.abort();
  }, [flights]);

  useEffect(() => {
    if (confirmation) confirmationActionRef.current?.focus();
  }, [confirmation]);

  function invalidatePreview() {
    setPreview(null);
    setConsented(false);
    setMessage("");
  }

  function toggleFlight(flightId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(flightId)) next.delete(flightId);
      else if (next.size < MAX_SHARED_FLIGHTS) next.add(flightId);
      return next;
    });
    invalidatePreview();
  }

  function selectFilteredFlights() {
    if (filteredSelectionWouldExceedLimit) return;
    setSelectedIds(
      (current) =>
        new Set([...current, ...filteredFlights.map(({ id }) => id)]),
    );
    invalidatePreview();
  }

  function clearSelection() {
    setSelectedIds(new Set());
    invalidatePreview();
  }

  async function requestPreview() {
    if (selectedFlightIds.length === 0) return;
    setBusy("preview");
    setError("");
    setMessage("");
    setConfirmation("");
    try {
      const response = await fetch("/api/account/sharing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flightIds: selectedFlightIds,
          includeDisplayName,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message);
      setPreview(body.preview);
      setConsented(false);
      setMessage("Preview ready. Review the exact public projection.");
    } catch (requestError) {
      setError(
        requestError instanceof Error && requestError.message
          ? requestError.message
          : "The sharing preview could not be created.",
      );
    } finally {
      setBusy("");
    }
  }

  async function enableSharing() {
    if (!preview || !consented) return;
    setBusy("enable");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/account/sharing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flightIds: preview.selection.flightIds,
          includeDisplayName: preview.selection.includeDisplayName,
          previewId: preview.previewId,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message);
      setStatus(body.sharing);
      setConsented(false);
      setMessage(
        status?.enabled
          ? "Shared map updated with only this selection."
          : "View-only map sharing enabled.",
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error && requestError.message
          ? requestError.message
          : "Sharing could not be enabled.",
      );
    } finally {
      setBusy("");
    }
  }

  async function mutateSharing(action: "revoke" | "regenerate") {
    setBusy(action);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        action === "revoke"
          ? "/api/account/sharing"
          : "/api/account/sharing/regenerate",
        { method: action === "revoke" ? "DELETE" : "POST" },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message);
      setStatus(body.sharing);
      setConfirmation("");
      if (action === "revoke") {
        setSelectedIds(new Set());
        setPreview(null);
        setIncludeDisplayName(false);
      }
      setMessage(
        action === "revoke"
          ? "Sharing disabled. The previous link no longer works."
          : "Link replaced. The previous link no longer works; the selected flights are unchanged.",
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error && requestError.message
          ? requestError.message
          : "Sharing could not be updated.",
      );
    } finally {
      setBusy("");
    }
  }

  async function copyLink() {
    if (!status?.sharePath) return;
    try {
      await navigator.clipboard.writeText(
        new URL(status.sharePath, window.location.origin).href,
      );
      setMessage("Share link copied. Anyone it is forwarded to can open it.");
      setError("");
    } catch {
      setError("The link could not be copied. Select and copy it manually.");
    }
  }

  const countries = preview
    ? new Set(
        preview.projection.flights.flatMap((flight) =>
          flight.legs.flatMap((leg) => [
            leg.origin.country,
            leg.destination.country,
          ]),
        ),
      ).size
    : 0;

  return (
    <section className="settings-panel sharing-panel" aria-labelledby="sharing-title">
      <div className="sharing-heading">
        <div>
          <h2 id="sharing-title">Share map</h2>
          <p className={`sharing-state ${status?.enabled ? "enabled" : ""}`}>
            {status?.enabled ? "View-only sharing is on" : "Private · sharing is off"}
          </p>
        </div>
      </div>
      <div className="sharing-warning" role="note">
        <strong>Anyone with the link can copy, forward, or screenshot it.</strong>
        <span>Recipients cannot edit your account or flights. You can replace or revoke the link.</span>
      </div>
      <p>
        Choose flights explicitly. Future flights are never added automatically.
        Editing or deleting a selected flight revokes the shared map until you
        review and enable a new snapshot.
      </p>

      {status?.enabled && (
        <p className="sharing-snapshot" role="status">
          Current snapshot: <strong>{status.selectedFlightCount}</strong>{" "}
          {status.selectedFlightCount === 1 ? "flight" : "flights"} · identity{" "}
          <strong>{status.includeDisplayName ? "shown" : "hidden"}</strong>.
          New flights remain private.
        </p>
      )}

      <fieldset className="sharing-flight-picker">
        <legend>Select flights to share</legend>
        <div className="sharing-filter-controls">
          <label>
            Search flights
            <input
              type="search"
              value={search}
              placeholder="Airport, city, or date"
              onChange={(event) => {
                setSearch(event.target.value);
                setRenderLimit(PAGE_SIZE);
              }}
            />
          </label>
          <label>
            Flight type
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as typeof kind);
                setRenderLimit(PAGE_SIZE);
              }}
            >
              <option value="all">All flights</option>
              <option value="commercial">Commercial</option>
              <option value="private">Private</option>
            </select>
          </label>
        </div>
        <div className="sharing-selection-actions">
          <span aria-live="polite">
            {selectedIds.size} of {MAX_SHARED_FLIGHTS} selected ·{" "}
            {filteredFlights.length} filtered
          </span>
          <button
            type="button"
            onClick={selectFilteredFlights}
            disabled={
              filteredFlights.length === 0 ||
              filteredSelectionWouldExceedLimit
            }
          >
            Select filtered flights
          </button>
          <button
            type="button"
            onClick={clearSelection}
            disabled={selectedIds.size === 0}
          >
            Clear selection
          </button>
        </div>
        {filteredSelectionWouldExceedLimit && (
          <p role="alert">
            This filtered set would exceed the {MAX_SHARED_FLIGHTS}-flight
            sharing limit. Narrow the filters or select flights individually.
          </p>
        )}
        <div className="sharing-flight-list" aria-label="Available flights">
          {visibleFlights.map((flight) => {
            const route = flight.airportCodes.join(" → ");
            const cityRoute = flight.cities.join(" → ");
            const checked = selectedIds.has(flight.id);
            const inCurrentSnapshot = Boolean(
              status?.enabled && status.selectedFlightIds.includes(flight.id),
            );
            return (
              <label className={`sharing-flight-row ${checked ? "selected" : ""}`} key={flight.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && selectedIds.size >= MAX_SHARED_FLIGHTS}
                  onChange={() => toggleFlight(flight.id)}
                  aria-label={`Share ${route} flight on ${flight.date}`}
                />
                <span className={`flight-kind ${flight.kind}`}>
                  <Plane aria-hidden="true" size={17} />
                </span>
                <span className="sharing-flight-primary">
                  <strong>{route}</strong>
                  <small>
                    {cityRoute}
                    {inCurrentSnapshot ? " · Currently shared" : ""}
                  </small>
                </span>
                <span className="sharing-flight-meta">
                  <strong>{flight.date}</strong>
                  <span>{flight.kind}</span>
                </span>
              </label>
            );
          })}
          {filteredFlights.length === 0 && <p>No flights match these filters.</p>}
        </div>
        {renderLimit < filteredFlights.length && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => setRenderLimit((current) => current + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, filteredFlights.length - renderLimit)} more flights
          </button>
        )}
      </fieldset>

      <label className="sharing-name-option">
        <input
          type="checkbox"
          checked={includeDisplayName}
          onChange={(event) => {
            setIncludeDisplayName(event.target.checked);
            invalidatePreview();
          }}
        />
        Include my display name
      </label>
      <small>
        Identity is hidden by default and handled separately from flight
        selection. Email, username, exact airports, exact timings, internal IDs,
        flight records, and import details are never included.
      </small>

      <button
        type="button"
        className="secondary-button"
        disabled={busy !== "" || selectedIds.size === 0}
        onClick={requestPreview}
      >
        {busy === "preview" ? "Preparing preview…" : "Preview selected flights"}
      </button>
      {selectedIds.size === 0 && (
        <p className="sharing-zero-selection" role="status">
          Select at least one flight before previewing or enabling sharing.
        </p>
      )}

      {preview && (
        <section className="sharing-preview" aria-labelledby="sharing-preview-title">
          <h3 id="sharing-preview-title">Exactly what will be public</h3>
          <dl>
            <div><dt>Identity</dt><dd>{preview.projection.owner.displayName ?? "Hidden"}</dd></div>
            <div><dt>Flights represented</dt><dd>{preview.projection.summary.flightCount}</dd></div>
            <div><dt>Aggregated routes</dt><dd>{preview.projection.summary.routeCount}</dd></div>
            <div><dt>Countries represented</dt><dd>{countries}</dd></div>
          </dl>
          <ol className="sharing-flight-preview">
            {preview.projection.flights.map((flight, flightIndex) => (
              <li key={flight.id}>
                <strong>Flight {flightIndex + 1} · {flight.kind}</strong>
                <span>
                  {flight.legs.map((leg, legIndex) => (
                    <span key={leg.index}>
                      {legIndex > 0 ? " · " : ""}
                      {leg.origin.country} ({leg.origin.lat.toFixed(1)}, {leg.origin.lon.toFixed(1)})
                      {" → "}
                      {leg.destination.country} ({leg.destination.lat.toFixed(1)}, {leg.destination.lon.toFixed(1)})
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ol>
          <details>
            <summary>{preview.projection.routes.length} aggregated route groups</summary>
            <ul className="sharing-route-preview">
              {preview.projection.routes.map((route) => (
                <li key={route.id}>
                  <strong>{route.origin.country} → {route.destination.country}</strong>
                  <span>{route.kind} · {route.flightCount} {route.flightCount === 1 ? "flight" : "flights"} · approximate {route.origin.lat.toFixed(1)}, {route.origin.lon.toFixed(1)} to {route.destination.lat.toFixed(1)}, {route.destination.lon.toFixed(1)}</span>
                </li>
              ))}
            </ul>
          </details>
          <label className="sharing-consent">
            <input
              type="checkbox"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
            I reviewed this exact snapshot and understand that anyone with the
            link can copy, forward, or screenshot it.
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={busy !== "" || !consented}
            onClick={enableSharing}
          >
            {busy === "enable"
              ? "Publishing…"
              : status?.enabled
                ? "Replace shared snapshot"
                : "Enable sharing"}
          </button>
        </section>
      )}

      {status?.enabled && status.sharePath && (
        <div className="sharing-live-controls">
          <label>
            View-only share link
            <input
              aria-label="View-only share link"
              readOnly
              value={status.sharePath}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="sharing-actions">
            <button type="button" onClick={copyLink}>Copy link</button>
            <button type="button" onClick={() => setConfirmation("regenerate")}>Replace link</button>
            <button type="button" className="danger-button" onClick={() => setConfirmation("revoke")}>Disable sharing</button>
          </div>
        </div>
      )}

      {confirmation && (
        <div
          className="sharing-confirmation"
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="sharing-confirmation-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") setConfirmation("");
          }}
        >
          <strong id="sharing-confirmation-title">
            {confirmation === "revoke" ? "Disable sharing?" : "Replace this link?"}
          </strong>
          <p>
            The current link will stop working immediately.
            {confirmation === "regenerate" && " The snapshotted flight selection will not change."}
          </p>
          <div>
            <button type="button" onClick={() => setConfirmation("")}>Cancel</button>
            <button
              ref={confirmationActionRef}
              type="button"
              className="danger-button"
              disabled={busy !== ""}
              onClick={() => mutateSharing(confirmation)}
            >
              {confirmation === "revoke" ? "Disable sharing" : "Replace link"}
            </button>
          </div>
        </div>
      )}

      <p className="sharing-feedback" role={error ? "alert" : "status"} aria-live="polite">
        {error || message}
      </p>
    </section>
  );
}
