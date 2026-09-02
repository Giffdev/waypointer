"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { canonicalPublicUrl } from "@/lib/public-origin";

export type OwnerShareStatusResponse = {
  enabled: boolean;
  sharePath: string | null;
  publishedFlightCount: number;
  publicHandle: string;
};

export type ShareStatusState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; value: OwnerShareStatusResponse }
  | { phase: "failed" };

const STATUS_LOAD_FAILED_MESSAGE = "Sharing status could not be loaded.";
const SHARING_UPDATE_FAILED_MESSAGE = "Sharing could not be updated.";
const COPY_FAILED_MESSAGE =
  "The link could not be copied. Select and copy it manually.";

export function resolveShareUrl(sharePath: string): string {
  return canonicalPublicUrl(sharePath);
}

export function sharingErrorMessage(body: unknown): string {
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
  return SHARING_UPDATE_FAILED_MESSAGE;
}

async function fetchShareStatus(
  signal?: AbortSignal,
): Promise<OwnerShareStatusResponse> {
  const response = await fetch("/api/account/sharing", {
    cache: "no-store",
    signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(sharingErrorMessage(body));
  return body.sharing as OwnerShareStatusResponse;
}

export type OwnerSharingController = {
  statusState: ShareStatusState;
  status: OwnerShareStatusResponse | null;
  shareUrl: string | null;
  busy: boolean;
  message: string;
  error: string;
  /** Triggers the first status fetch only if one hasn't happened yet. */
  ensureLoaded: () => void;
  retryStatus: () => void;
  toggleSharing: () => void;
  republishSharing: () => void;
  copyLink: () => void;
};

/**
 * Shared status/fetch/enable/error/URL behavior for owner-facing sharing
 * surfaces (the Settings sharing panel and the map-page share control).
 * When `autoLoad` is false, no request is made until `ensureLoaded` is
 * called, so callers can lazily fetch status only once a control opens.
 */
export function useOwnerSharingStatus(
  { autoLoad = true }: { autoLoad?: boolean } = {},
): OwnerSharingController {
  const [statusState, setStatusState] = useState<ShareStatusState>(
    autoLoad ? { phase: "loading" } : { phase: "idle" },
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const hasRequestedRef = useRef(false);

  const status = statusState.phase === "loaded" ? statusState.value : null;
  const shareUrl = status?.sharePath ? resolveShareUrl(status.sharePath) : null;

  // Only resolves the request and applies the result; never sets state
  // synchronously so it stays safe to call directly from an effect (the
  // "idle"/"loading" phases already cover the in-flight UI state).
  const fetchAndApplyStatus = useCallback((signal?: AbortSignal) => {
    void fetchShareStatus(signal)
      .then((nextStatus) => {
        setStatusState({ phase: "loaded", value: nextStatus });
        setError("");
      })
      .catch((requestError) => {
        if (
          requestError instanceof DOMException &&
          requestError.name === "AbortError"
        ) {
          return;
        }
        setStatusState({ phase: "failed" });
        setError(STATUS_LOAD_FAILED_MESSAGE);
      });
  }, []);

  useEffect(() => {
    if (!autoLoad) return;
    hasRequestedRef.current = true;
    const controller = new AbortController();
    fetchAndApplyStatus(controller.signal);
    return () => controller.abort();
    // Deliberately runs once per mount; `fetchAndApplyStatus` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad]);

  const ensureLoaded = useCallback(() => {
    if (hasRequestedRef.current) return;
    hasRequestedRef.current = true;
    fetchAndApplyStatus();
  }, [fetchAndApplyStatus]);

  // Safe to call only from event handlers (never from an effect body):
  // resets the visible phase to "loading" before re-fetching.
  const retryStatus = useCallback(() => {
    hasRequestedRef.current = true;
    setStatusState({ phase: "loading" });
    fetchAndApplyStatus();
  }, [fetchAndApplyStatus]);

  const updateSharing = useCallback(
    (method: "POST" | "DELETE", successMessage: string) => {
      setBusy(true);
      setError("");
      setMessage("");
      void fetch("/api/account/sharing", { method })
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(sharingErrorMessage(body));
          setStatusState({ phase: "loaded", value: body.sharing });
          setMessage(successMessage);
        })
        .catch((requestError) => {
          setError(
            requestError instanceof Error && requestError.message
              ? requestError.message
              : SHARING_UPDATE_FAILED_MESSAGE,
          );
        })
        .finally(() => setBusy(false));
    },
    [],
  );

  const toggleSharing = useCallback(() => {
    if (!status) return;
    updateSharing(
      status.enabled ? "DELETE" : "POST",
      status.enabled
        ? "Sharing disabled."
        : "Public map enabled. Copy the link to share it.",
    );
  }, [status, updateSharing]);

  const republishSharing = useCallback(() => {
    updateSharing(
      "POST",
      "Public map republished with the latest flights and airports.",
    );
  }, [updateSharing]);

  const copyLink = useCallback(() => {
    if (!shareUrl) return;
    void navigator.clipboard
      .writeText(shareUrl)
      .then(() => {
        setMessage("Public map link copied.");
        setError("");
      })
      .catch(() => {
        setError(COPY_FAILED_MESSAGE);
      });
  }, [shareUrl]);

  return {
    statusState,
    status,
    shareUrl,
    busy,
    message,
    error,
    ensureLoaded,
    retryStatus,
    toggleSharing,
    republishSharing,
    copyLink,
  };
}
