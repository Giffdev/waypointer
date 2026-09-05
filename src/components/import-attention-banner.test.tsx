// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportAttentionBanner } from "./import-attention-banner";
import type { PendingImportAttention } from "@/lib/import/types";

const empty: PendingImportAttention = {
  reviewBatches: 0,
  pendingRows: 0,
  unresolvedDuplicateRows: 0,
  unresolvedRouteTokenRows: 0,
  adoptedFlightRows: 0,
  reprocessAvailableBatches: 0,
  href: "/import",
};

function stubAttention(attention: PendingImportAttention | "error") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      attention === "error"
        ? new Response("nope", { status: 500 })
        : new Response(JSON.stringify(attention), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    ),
  );
}

/**
 * Import rows the pipeline set aside are invisible on the map by design — they
 * are not flights yet. "Invisible and unmentioned" is the failure this banner
 * exists to prevent, so these tests are about whether the user is told.
 */
describe("ImportAttentionBanner", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says nothing when there is nothing outstanding", async () => {
    stubAttention(empty);
    render(<ImportAttentionBanner />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(
      screen.queryByRole("complementary", {
        name: "Imports needing your attention",
      }),
    ).not.toBeInTheDocument();
  });

  it("names route tokens that could not be placed and links into the review", async () => {
    stubAttention({
      ...empty,
      reviewBatches: 1,
      pendingRows: 2,
      unresolvedRouteTokenRows: 3,
    });
    render(<ImportAttentionBanner />);

    const banner = await screen.findByRole("complementary", {
      name: "Imports needing your attention",
    });
    expect(banner).toHaveTextContent("5 imported rows need your review");
    expect(banner).toHaveTextContent("2 awaiting a decision");
    expect(banner).toHaveTextContent(
      "3 with a route point we could not place",
    );
    // The point of the sentence: these rows are not silently on the map.
    expect(banner).toHaveTextContent(
      "They are not on your map until you decide.",
    );
    expect(screen.getByRole("link", { name: "Review imports" })).toHaveAttribute(
      "href",
      "/import",
    );
  });

  it("counts unresolved duplicates as outstanding too", async () => {
    stubAttention({ ...empty, reviewBatches: 1, unresolvedDuplicateRows: 1 });
    render(<ImportAttentionBanner />);
    const banner = await screen.findByRole("complementary", {
      name: "Imports needing your attention",
    });
    expect(banner).toHaveTextContent("1 imported row needs your review");
    expect(banner).toHaveTextContent("1 possible duplicates");
  });

  it("stays out of the way when the count cannot be read", async () => {
    // A counter must never be able to break the map. A failed read renders
    // nothing rather than an error state on top of somebody's flights.
    stubAttention("error");
    render(<ImportAttentionBanner />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(
      screen.queryByRole("complementary", {
        name: "Imports needing your attention",
      }),
    ).not.toBeInTheDocument();
  });
});
