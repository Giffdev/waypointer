"use client";

import { useEffect, useState } from "react";
import { SharedMapProjectionView } from "@/components/shared-map-view";
import {
  parseMapSharePreviewFragment,
  readMapSharePreview,
} from "@/lib/sharing/client-preview";
import type { PublicMapProjection } from "@/lib/sharing/service";

type PreviewState =
  | { phase: "loading" }
  | { phase: "ready"; projection: PublicMapProjection }
  | { phase: "unavailable" };

export function SharedMapPreview() {
  const [state, setState] = useState<PreviewState>({ phase: "loading" });

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      try {
        const nonce = parseMapSharePreviewFragment(window.location.hash);
        const projection = readMapSharePreview(
          window.sessionStorage,
          nonce,
        );
        if (nonce) {
          window.history.replaceState(
            window.history.state,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
        }
        setState(
          projection
            ? { phase: "ready", projection }
            : { phase: "unavailable" },
        );
      } catch {
        setState({ phase: "unavailable" });
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  if (state.phase === "loading") {
    return (
      <main className="shared-map-state">
        <p role="status">Loading reviewed map preview…</p>
      </main>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <main className="shared-map-state">
        <h1>Map preview unavailable</h1>
        <p role="alert">
          Return to sharing settings and choose Preview shared map again.
        </p>
      </main>
    );
  }

  return (
    <SharedMapProjectionView
      projection={state.projection}
      mode="preview"
    />
  );
}
