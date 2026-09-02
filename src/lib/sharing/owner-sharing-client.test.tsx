// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOwnerSharingStatus } from "./owner-sharing-client";

describe("useOwnerSharingStatus request races", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores a stale response from a superseded request", async () => {
    const first = createDeferred<Response>();
    const second = createDeferred<Response>();
    const responses = [first.promise, second.promise];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => responses.shift()),
    );

    const { result } = renderHook(() =>
      useOwnerSharingStatus({ autoLoad: false }),
    );

    // Two overlapping GET requests are not reachable through either
    // rendered surface's UI (buttons are disabled until the prior request
    // settles), but the guard exists as defense-in-depth, so it is
    // exercised directly against the hook here, bypassing UI gating.
    act(() => {
      result.current.ensureLoaded();
    });
    act(() => {
      result.current.retryStatus();
    });

    // The newer (second) request resolves first...
    second.resolve(
      statusResponse({ enabled: true, sharePath: "/second", flights: 2 }),
    );
    await waitFor(() =>
      expect(result.current.status?.sharePath).toBe("/second"),
    );

    // ...and the older (first) request resolving late must not clobber it.
    first.resolve(
      statusResponse({ enabled: false, sharePath: null, flights: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.status?.sharePath).toBe("/second");
    expect(result.current.statusState.phase).toBe("loaded");
  });

  it("aborts the previously in-flight request's signal when a newer one begins", async () => {
    const first = createDeferred<Response>();
    const second = createDeferred<Response>();
    const signals: AbortSignal[] = [];
    const responses = [first.promise, second.promise];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return responses.shift();
      }),
    );

    const { result } = renderHook(() =>
      useOwnerSharingStatus({ autoLoad: false }),
    );

    act(() => {
      result.current.ensureLoaded();
    });
    act(() => {
      result.current.retryStatus();
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    second.resolve(
      statusResponse({ enabled: false, sharePath: null, flights: 0 }),
    );
    await waitFor(() => expect(result.current.statusState.phase).toBe("loaded"));
  });

  it("aborts the active request's signal on unmount", async () => {
    const deferred = createDeferred<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return deferred.promise;
      }),
    );

    const { result, unmount } = renderHook(() =>
      useOwnerSharingStatus({ autoLoad: false }),
    );

    act(() => {
      result.current.ensureLoaded();
    });

    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

function statusResponse(options: {
  enabled: boolean;
  sharePath: string | null;
  flights: number;
}): Response {
  return new Response(
    JSON.stringify({
      sharing: {
        enabled: options.enabled,
        publicHandle: "test-pilot",
        sharePath: options.sharePath,
        publishedFlightCount: options.flights,
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
