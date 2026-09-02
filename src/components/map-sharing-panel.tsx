"use client";

import { useOwnerSharingStatus } from "@/lib/sharing/owner-sharing-client";

export { resolveShareUrl } from "@/lib/sharing/owner-sharing-client";

export function MapSharingPanel() {
  const {
    statusState,
    status,
    shareUrl,
    busy,
    message,
    error,
    retryStatus,
    toggleSharing,
    republishSharing,
    copyLink,
  } = useOwnerSharingStatus();

  return (
    <section
      className="settings-panel sharing-panel"
      aria-labelledby="sharing-title"
    >
      <div className="sharing-heading">
        <div>
          <h2 id="sharing-title" tabIndex={-1}>
            Public map
          </h2>
          <p
            className={`sharing-state ${
              status?.enabled
                ? "enabled"
                : statusState.phase === "failed"
                  ? "failed"
                  : ""
            }`}
          >
            {statusState.phase === "loading" || statusState.phase === "idle"
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
        <button type="button" disabled={busy} onClick={() => retryStatus()}>
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
