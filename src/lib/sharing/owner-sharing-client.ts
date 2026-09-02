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

  // Every state-affecting request (status fetch or enable/disable/
  // republish) is tagged with a monotonically increasing id and aborts
  // whatever request was previously in flight. A resolving request only
  // applies its result if it is still the most recent one, so a slow,
  // superseded response (e.g. a stale retry resolving after a newer
  // enable call, or vice versa) can never clobber fresher state. The
  // controller is also aborted on unmount to avoid setting state on an
  // unmounted component.
  const requestIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  const beginRequest = useCallback(() => {
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const id = ++requestIdRef.current;
    return { id, controller };
  }, []);

  useEffect(() => {
    return () => {
      activeControllerRef.current?.abort();
    };
  }, []);

  const status = statusState.phase === "loaded" ? statusState.value : null;
  const shareUrl = status?.sharePath ? resolveShareUrl(status.sharePath) : null;

  // Only resolves the request and applies the result; never sets state
  // synchronously so it stays safe to call directly from an effect (the
  // "idle"/"loading" phases already cover the in-flight UI state).
  const fetchAndApplyStatus = useCallback(
    (signal: AbortSignal, requestId: number) => {
      void fetchShareStatus(signal)
        .then((nextStatus) => {
          if (requestIdRef.current !== requestId) return;
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
          if (requestIdRef.current !== requestId) return;
          setStatusState({ phase: "failed" });
          setError(STATUS_LOAD_FAILED_MESSAGE);
        });
    },
    [],
  );

  useEffect(() => {
    if (!autoLoad) return;
    hasRequestedRef.current = true;
    const { id, controller } = beginRequest();
    fetchAndApplyStatus(controller.signal, id);
    return () => controller.abort();
  }, [autoLoad, beginRequest, fetchAndApplyStatus]);

  const ensureLoaded = useCallback(() => {
    if (hasRequestedRef.current) return;
    hasRequestedRef.current = true;
    const { id, controller } = beginRequest();
    fetchAndApplyStatus(controller.signal, id);
  }, [beginRequest, fetchAndApplyStatus]);

  // Safe to call only from event handlers (never from an effect body):
  // resets the visible phase to "loading" and clears any stale error
  // before re-fetching, matching the pre-extraction Settings behavior.
  const retryStatus = useCallback(() => {
    hasRequestedRef.current = true;
    setStatusState({ phase: "loading" });
    setError("");
    const { id, controller } = beginRequest();
    fetchAndApplyStatus(controller.signal, id);
  }, [beginRequest, fetchAndApplyStatus]);

  const updateSharing = useCallback(
    (method: "POST" | "DELETE", successMessage: string) => {
      setBusy(true);
      setError("");
      setMessage("");
      // Only the request id is used here (not its controller/signal): an
      // enable/disable/republish mutation that's already in flight should
      // still complete server-side even if superseded by a newer request,
      // so we only need to ignore a stale *result*, not cancel the call.
      const { id } = beginRequest();
      void fetch("/api/account/sharing", { method })
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(sharingErrorMessage(body));
          if (requestIdRef.current !== id) return;
          setStatusState({ phase: "loaded", value: body.sharing });
          setMessage(successMessage);
        })
        .catch((requestError) => {
          if (requestIdRef.current !== id) return;
          setError(
            requestError instanceof Error && requestError.message
              ? requestError.message
              : SHARING_UPDATE_FAILED_MESSAGE,
          );
        })
        // Always clears busy, even if this request was superseded: the
        // guarded `.then`/`.catch` above already prevent a stale response
        // from overwriting fresher status/error/message state, so it is
        // only the loading indicator being released here.
        .finally(() => setBusy(false));
    },
    [beginRequest],
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
