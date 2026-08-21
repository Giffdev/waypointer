"use client";

import { useEffect, useRef, useState } from "react";
import {
  createMapSharePreviewNonce,
  mapSharePreviewFragment,
  parseMapSharePreview,
  storeMapSharePreview,
} from "@/lib/sharing/client-preview";
import type {
  MapSharePreview,
  OwnerShareStatus,
  PublicMapProjection,
} from "@/lib/sharing/service";

type ShareStatusState =
  | { phase: "loading" }
  | { phase: "loaded"; value: OwnerShareStatus }
  | { phase: "failed" };

async function fetchShareStatus(
  signal?: AbortSignal,
): Promise<OwnerShareStatus> {
  const response = await fetch("/api/account/sharing", {
    cache: "no-store",
    signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message);
  return body.sharing as OwnerShareStatus;
}

export function MapSharingPanel() {
  const [statusState, setStatusState] = useState<ShareStatusState>({
    phase: "loading",
  });
  const [preview, setPreview] = useState<MapSharePreview | null>(null);
  const [includeDisplayName, setIncludeDisplayName] = useState(false);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<"revoke" | "regenerate" | "">("");
  const confirmationActionRef = useRef<HTMLButtonElement>(null);
  const status =
    statusState.phase === "loaded" ? statusState.value : null;

  async function retryStatus() {
    setStatusState({ phase: "loading" });
    setError("");
    try {
      const nextStatus = await fetchShareStatus();
      setStatusState({ phase: "loaded", value: nextStatus });
      if (nextStatus.enabled) {
        setIncludeDisplayName(nextStatus.includeDisplayName);
      }
    } catch {
      setStatusState({ phase: "failed" });
      setError("Sharing status could not be loaded.");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetchShareStatus(controller.signal)
      .then((nextStatus) => {
        setStatusState({ phase: "loaded", value: nextStatus });
        if (nextStatus.enabled) {
          setIncludeDisplayName(nextStatus.includeDisplayName);
        }
      })
      .catch((requestError) => {
        if (
          requestError instanceof DOMException &&
          requestError.name === "AbortError"
        ) {
          return;
        }
        setStatusState({ phase: "failed" });
        setError("Sharing status could not be loaded.");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (confirmation) confirmationActionRef.current?.focus();
  }, [confirmation]);

  function invalidatePreview() {
    setPreview(null);
    setConsented(false);
    setMessage("");
  }

  async function requestPreview() {
    const openedTab = openProtectedBlankTab();
    if (!openedTab.ok) {
      setError(openedTab.error);
      setMessage("");
      return;
    }
    const previewTab = openedTab.tab;

    setBusy("preview");
    setError("");
    setMessage("");
    setConfirmation("");
    try {
      let body: unknown;
      try {
        const response = await fetch("/api/account/sharing/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            includeDisplayName,
          }),
        });
        body = await response.json();
        if (!response.ok) {
          throw new Error(
            apiErrorMessage(body) ??
              "The sharing preview could not be created.",
          );
        }
      } catch (requestError) {
        setError(
          closePreviewTabMessage(
            previewTab,
            requestError instanceof Error && requestError.message
              ? requestError.message
              : "The sharing preview could not be created.",
          ),
        );
        return;
      }

      let nextPreview: MapSharePreview;
      try {
        nextPreview = parseMapSharePreview(
          isRecord(body) ? body.preview : undefined,
        );
      } catch {
        setError(
          closePreviewTabMessage(
            previewTab,
            "The sharing preview response was invalid.",
          ),
        );
        return;
      }

      let nonce: string;
      try {
        nonce = createMapSharePreviewNonce();
      } catch {
        setError(
          closePreviewTabMessage(
            previewTab,
            "The preview tab could not be initialized.",
          ),
        );
        return;
      }

      let projection: PublicMapProjection;
      try {
        projection = storeMapSharePreview(
          previewTab.sessionStorage,
          nonce,
          nextPreview.projection,
        );
      } catch {
        setError(
          closePreviewTabMessage(
            previewTab,
            "The preview tab could not store the reviewed map. Check browser storage settings and try again.",
          ),
        );
        return;
      }

      const previewUrl = new URL(
        "/shared/preview",
        window.location.origin,
      );
      previewUrl.hash = mapSharePreviewFragment(nonce);
      try {
        previewTab.location.replace(previewUrl.href);
      } catch {
        setError(
          closePreviewTabMessage(
            previewTab,
            "The preview tab could not navigate to the reviewed map.",
          ),
        );
        return;
      }

      setPreview({
        ...nextPreview,
        projection,
      });
      setConsented(false);
      setMessage(
        "Interactive map preview opened in a new tab. Review it before publishing.",
      );
    } finally {
      setBusy("");
    }
  }

  function previewLiveMap() {
    if (!status?.sharePath) return;
    const openedTab = openProtectedBlankTab();
    if (!openedTab.ok) {
      setError(openedTab.error);
      setMessage("");
      return;
    }
    const previewTab = openedTab.tab;

    try {
      previewTab.location.replace(
        new URL(status.sharePath, window.location.origin).href,
      );
      setError("");
      setMessage("Live shared map opened in a new tab.");
    } catch {
      setError(
        closePreviewTabMessage(
          previewTab,
          "The live shared map could not be opened. Try again.",
        ),
      );
      setMessage("");
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
          includeDisplayName: preview.includeDisplayName,
          previewId: preview.previewId,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.error?.code === "sharing-preview-stale") invalidatePreview();
        throw new Error(body.error?.message);
      }
      setStatusState({ phase: "loaded", value: body.sharing });
      setPreview(null);
      setConsented(false);
      setMessage(
        status?.enabled
          ? "Shared map updated."
          : "View-only map published.",
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
      setStatusState({ phase: "loaded", value: body.sharing });
      setConfirmation("");
      if (action === "revoke") {
        setPreview(null);
        setIncludeDisplayName(false);
      }
      setMessage(
        action === "revoke"
          ? "Sharing disabled. The previous link cannot load the map again. Content already opened, copied, forwarded, or screenshotted cannot be recalled."
          : "Link replaced. The previous link cannot load the map again; the shared map is unchanged. Content already opened, copied, forwarded, or screenshotted cannot be recalled.",
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
        preview.projection.routes.flatMap((route) => [
          route.origin.country,
          route.destination.country,
        ]),
      ).size
    : 0;

  return (
    <section className="settings-panel sharing-panel" aria-labelledby="sharing-title">
      <div className="sharing-heading">
        <div>
          <h2 id="sharing-title">Share my map</h2>
          <p
            className={`sharing-state ${
              status?.enabled
                ? "enabled"
                : statusState.phase === "failed"
                  ? "failed"
                  : ""
            }`}
          >
            {statusState.phase === "loading"
              ? "Checking sharing status…"
              : statusState.phase === "failed"
                ? "Sharing status unavailable"
                : statusState.value.enabled
                  ? "View-only sharing is on"
                  : "Private · sharing is off"}
          </p>
        </div>
      </div>
      {statusState.phase === "failed" && (
        <button
          type="button"
          disabled={busy !== ""}
          onClick={() => void retryStatus()}
        >
          Retry sharing status
        </button>
      )}
      <div className="sharing-warning" role="note">
        <strong>Anyone with the link can copy, forward, or screenshot it.</strong>
        <span>Replacing or revoking the link prevents future loads, but cannot recall content already opened, copied, forwarded, or screenshotted.</span>
      </div>
      <p>
        Publish a read-only globe showing the places you have traveled and the
        approximate routes between them. Direct account identifiers are omitted,
        and your display name is omitted unless you choose to include it.
        Repeated endpoints and route patterns can still reveal your home region,
        routines, employer, or identity, even at one-decimal precision.
      </p>
      <small>
        Editing or deleting a flight included on the shared map turns sharing
        off until you review and publish the map again.
      </small>

      {status?.enabled && (
        <p className="sharing-snapshot" role="status">
          Current shared map: <strong>{status.publishedFlightCount}</strong>{" "}
          {status.publishedFlightCount === 1 ? "flight" : "flights"} represented ·
          display name{" "}
          <strong>{status.includeDisplayName ? "shown" : "omitted"}</strong>.
          New flights remain private until you preview and publish an updated
          complete-map snapshot.
        </p>
      )}

      <p className="sharing-inclusion-summary">
        Each preview is built from every flight currently on your private map.
        Individual flights cannot be selected or excluded, and Waypointer never
        publishes a partial or truncated snapshot.
      </p>

      <label className="sharing-name-option">
        <input
          type="checkbox"
          checked={includeDisplayName}
          disabled={busy !== ""}
          onChange={(event) => {
            setIncludeDisplayName(event.target.checked);
            invalidatePreview();
          }}
        />
        Include my display name
      </label>
      <small>
        Email, username, exact airports, exact timings, internal IDs, flight
        records, and import details are never included. Map locations are
        approximate.
      </small>

      <button
        type="button"
        className="primary-button"
        disabled={busy !== "" || statusState.phase !== "loaded"}
        onClick={requestPreview}
      >
        {busy === "preview"
          ? "Preparing map…"
          : status?.enabled
            ? "Preview map update"
            : "Preview shared map"}
      </button>
      {preview && (
        <section className="sharing-preview" aria-labelledby="sharing-preview-title">
          <h3 id="sharing-preview-title">Preview your shared map</h3>
          <p>
            This view-only globe uses approximate locations and aggregated
            routes. It includes all {preview.projection.summary.flightCount}{" "}
            {preview.projection.summary.flightCount === 1
              ? "flight"
              : "flights"}{" "}
            currently on your map. Review the summary before publishing.
          </p>
          <dl>
            <div><dt>Display name</dt><dd>{preview.projection.owner.displayName ?? "Omitted"}</dd></div>
            <div><dt>Flights represented</dt><dd>{preview.projection.summary.flightCount}</dd></div>
            <div><dt>Routes shown</dt><dd>{preview.projection.summary.routeCount}</dd></div>
            <div><dt>Countries represented</dt><dd>{countries}</dd></div>
          </dl>
          <details>
            <summary>{preview.projection.routes.length} approximate route groups</summary>
            <ul className="sharing-route-preview">
              {preview.projection.routes.map((route) => (
                <li key={route.id}>
                  <strong>{route.origin.country} → {route.destination.country}</strong>
                  <span>{route.kind} · {route.flightCount} {route.flightCount === 1 ? "flight" : "flights"} · approximate {route.origin.lat.toFixed(1)}, {route.origin.lon.toFixed(1)} to {route.destination.lat.toFixed(1)}, {route.destination.lon.toFixed(1)}</span>
                </li>
              ))}
            </ul>
          </details>
          <div className="sharing-warning" role="note">
            <strong>Recognizable travel patterns are included in this snapshot.</strong>
            <span>Repeated endpoints and routes may reveal your home region, routines, employer, or identity, even without your display name.</span>
          </div>
          <label className="sharing-consent">
            <input
              type="checkbox"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
            I reviewed this shared-map snapshot and understand that repeated
            endpoints and routes may reveal my home region, routines, employer,
            or identity, and that anyone with the link can copy, forward, or
            screenshot it.
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
                ? "Update shared map"
                : "Publish shared map"}
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
            <button
              type="button"
              disabled={busy !== ""}
              onClick={previewLiveMap}
            >
              Preview live shared map
            </button>
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
            The current link will be blocked from future loads. This cannot
            recall content already opened, copied, forwarded, or screenshotted.
            {confirmation === "regenerate" && " The shared map snapshot will not change."}
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

type ProtectedBlankTabResult =
  | { ok: true; tab: Window }
  | { ok: false; error: string };

function openProtectedBlankTab(): ProtectedBlankTabResult {
  let previewTab: Window | null;
  try {
    previewTab = window.open("about:blank", "_blank");
  } catch {
    return {
      ok: false,
      error:
        "Your browser blocked the preview tab. Allow pop-ups for Waypointer and try again.",
    };
  }
  if (!previewTab) {
    return {
      ok: false,
      error:
        "Your browser blocked the preview tab. Allow pop-ups for Waypointer and try again.",
    };
  }

  try {
    previewTab.opener = null;
  } catch {
    return {
      ok: false,
      error: closePreviewTabMessage(
        previewTab,
        "The preview tab could not be isolated from the settings tab, so the preview was stopped. Try again.",
      ),
    };
  }

  try {
    previewTab.sessionStorage.clear();
  } catch {
    return {
      ok: false,
      error: closePreviewTabMessage(
        previewTab,
        "The preview tab could not clear inherited browser storage, so the preview was stopped. Try again.",
      ),
    };
  }

  try {
    const referrerPolicy = previewTab.document.createElement("meta");
    referrerPolicy.name = "referrer";
    referrerPolicy.content = "no-referrer";
    previewTab.document.head.append(referrerPolicy);
    return { ok: true, tab: previewTab };
  } catch {
    return {
      ok: false,
      error: closePreviewTabMessage(
        previewTab,
        "The preview tab could not apply its no-referrer protection, so the preview was stopped. Try again.",
      ),
    };
  }
}

function closePreviewTab(previewTab: Window): boolean {
  try {
    previewTab.close();
    return true;
  } catch {
    return false;
  }
}

function closePreviewTabMessage(
  previewTab: Window,
  message: string,
): string {
  return closePreviewTab(previewTab)
    ? message
    : `${message} Close the blank preview tab manually.`;
}

function apiErrorMessage(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.message === "string" && body.error.message
    ? body.error.message
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
