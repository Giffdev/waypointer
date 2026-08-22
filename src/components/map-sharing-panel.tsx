"use client";

import { useEffect, useState } from "react";
import { canonicalPublicUrl } from "@/lib/public-origin";

type OwnerShareStatusResponse = {
  enabled: boolean;
  sharePath: string | null;
  publishedFlightCount: number;
  publicHandle: string;
};

type ShareStatusState =
  | { phase: "loading" }
  | { phase: "loaded"; value: OwnerShareStatusResponse }
  | { phase: "failed" };

async function fetchShareStatus(
  signal?: AbortSignal,
): Promise<OwnerShareStatusResponse> {
  const response = await fetch("/api/account/sharing", {
    cache: "no-store",
    signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(apiErrorMessage(body));
  return body.sharing as OwnerShareStatusResponse;
}

export function MapSharingPanel() {
  const [statusState, setStatusState] = useState<ShareStatusState>({
    phase: "loading",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const status =
    statusState.phase === "loaded" ? statusState.value : null;
  const shareUrl = status?.sharePath
    ? resolveShareUrl(status.sharePath)
    : null;

  useEffect(() => {
    const controller = new AbortController();
    void fetchShareStatus(controller.signal)
      .then((nextStatus) => {
        setStatusState({ phase: "loaded", value: nextStatus });
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

  async function retryStatus() {
    setStatusState({ phase: "loading" });
    setError("");
    try {
      const nextStatus = await fetchShareStatus();
      setStatusState({ phase: "loaded", value: nextStatus });
    } catch {
      setStatusState({ phase: "failed" });
      setError("Sharing status could not be loaded.");
    }
  }

  async function toggleSharing() {
    if (!status) return;
    await updateSharing(
      status.enabled ? "DELETE" : "POST",
      status.enabled
        ? "Sharing disabled."
        : "Public map enabled. Copy the link to share it.",
    );
  }

  async function republishSharing() {
    await updateSharing(
      "POST",
      "Public map republished with the latest flights and airports.",
    );
  }

  async function updateSharing(
    method: "POST" | "DELETE",
    successMessage: string,
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/account/sharing", {
        method,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body));
      setStatusState({ phase: "loaded", value: body.sharing });
      setMessage(successMessage);
    } catch (requestError) {
      setError(
        requestError instanceof Error && requestError.message
          ? requestError.message
          : "Sharing could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setMessage("Public map link copied.");
      setError("");
    } catch {
      setError("The link could not be copied. Select and copy it manually.");
    }
  }

  return (
    <section
      className="settings-panel sharing-panel"
      aria-labelledby="sharing-title"
    >
      <div className="sharing-heading">
        <div>
          <h2 id="sharing-title">Public map</h2>
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
              ? "Checking sharing status..."
              : statusState.phase === "failed"
                ? "Sharing status unavailable"
                : statusState.value.enabled
                  ? "Public sharing is on"
                  : "Private - sharing is off"}
          </p>
        </div>
      </div>

      <p>
        Enabling sharing publishes your entire map at{" "}
        <strong>/{status?.publicHandle ?? "username"}</strong>. The page is
        intentionally public and can be opened by anyone who knows or finds
        your username.
      </p>
      <small>
        Individual flights cannot be selected or hidden, and Waypointer does
        not cap or truncate the published map. Viewers receive airport codes,
        names, cities, countries, and public map locations plus flight dates,
        roles, aircraft, and tail numbers so they can filter their view. Notes,
        account details, and other private flight metadata stay private.
      </small>

      {status?.enabled && (
        <p className="sharing-snapshot" role="status">
          Public map: <strong>{status.publishedFlightCount}</strong>{" "}
          {status.publishedFlightCount === 1 ? "flight" : "flights"} represented.
        </p>
      )}

      <div className="sharing-actions">
        <button
          type="button"
          className={status?.enabled ? "danger-button" : "primary-button"}
          disabled={busy || statusState.phase !== "loaded"}
          onClick={toggleSharing}
        >
          {busy
            ? "Updating..."
            : status?.enabled
              ? "Disable sharing"
              : "Share my map"}
        </button>
        {status?.enabled && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={republishSharing}
          >
            Republish map
          </button>
        )}
      </div>

      {status?.enabled && shareUrl && (
        <div className="sharing-live-controls">
          <label>
            Public map link
            <input
              aria-label="Public map link"
              readOnly
              value={shareUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="sharing-actions">
            <a
              className="secondary-button"
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open public map
            </a>
            <button type="button" onClick={copyLink}>
              Copy link
            </button>
          </div>
        </div>
      )}

      {statusState.phase === "failed" && (
        <button type="button" disabled={busy} onClick={() => void retryStatus()}>
          Retry sharing status
        </button>
      )}

      <p
        className="sharing-feedback"
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {error || message}
      </p>
    </section>
  );
}

function apiErrorMessage(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string" &&
    body.error.message
  ) {
    return body.error.message;
  }
  return "Sharing could not be updated.";
}

export function resolveShareUrl(sharePath: string): string {
  return canonicalPublicUrl(sharePath);
}
