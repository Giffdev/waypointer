"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Share2 } from "lucide-react";
import { useOwnerSharingStatus } from "@/lib/sharing/owner-sharing-client";

/**
 * Lightweight map-page discoverability entry point for sharing. Shows
 * status and the essentials (enable, copy, open) without duplicating the
 * full management surface, which stays in Settings (disable/republish).
 */
export function MapShareControl() {
  const popupId = useId();
  const headingId = `${popupId}-heading`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const {
    statusState,
    status,
    shareUrl,
    busy,
    message,
    error,
    ensureLoaded,
    retryStatus,
    toggleSharing,
    copyLink,
  } = useOwnerSharingStatus({ autoLoad: false });

  useEffect(() => {
    if (!open) {
      if (restoreFocusRef.current) {
        restoreFocusRef.current = false;
        buttonRef.current?.focus();
      }
      return;
    }
    ensureLoaded();
    popupRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, ensureLoaded]);

  const closePopup = (restoreFocus = false) => {
    restoreFocusRef.current = restoreFocus;
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePopup(true);
    }
  };

  const loading = statusState.phase === "loading" || statusState.phase === "idle";
  const failed = statusState.phase === "failed";

  return (
    <div className="map-share-control" ref={wrapperRef}>
      <button
        type="button"
        ref={buttonRef}
        aria-label="Share map"
        title="Share map"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        onClick={() => (open ? closePopup() : setOpen(true))}
      >
        <Share2 size={17} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="map-share-popup"
          id={popupId}
          ref={popupRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
        >
          <h2 id={headingId}>Share your map</h2>
          <p className="sharing-state" role="status" aria-live="polite">
            {loading
              ? "Checking sharing status..."
              : failed
                ? "Sharing status unavailable"
                : status?.enabled
                  ? "Public sharing is on"
                  : "Not shared"}
          </p>

          {!loading && !failed && !status?.enabled && (
            <>
              <p>
                Sharing publishes your entire map at{" "}
                <strong>/{status?.publicHandle ?? "username"}</strong>. Anyone
                who knows or finds your username can open it.
              </p>
              <button
                type="button"
                className="primary-button"
                disabled={busy || statusState.phase !== "loaded"}
                onClick={() => toggleSharing()}
              >
                {busy ? "Enabling..." : "Share my map"}
              </button>
            </>
          )}

          {!loading && !failed && status?.enabled && shareUrl && (
            <>
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
                <button
                  type="button"
                  onClick={() => copyLink()}
                >
                  Copy link
                </button>
                <a
                  className="secondary-button"
                  href={shareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open public map
                </a>
              </div>
            </>
          )}

          {failed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => retryStatus()}
            >
              Retry sharing status
            </button>
          )}

          <p role={error ? "alert" : "status"} aria-live="polite">
            {error || message}
          </p>

          <Link
            href="/settings#sharing-title"
            className="map-share-manage-link"
            onClick={() => closePopup()}
          >
            Manage sharing settings
          </Link>
        </div>
      ) : null}
    </div>
  );
}
