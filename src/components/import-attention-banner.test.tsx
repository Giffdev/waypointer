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
    // Route-token-unresolved rows are a subset of pending rows (a row is
    // pending *because* it carries an issue like this), not an addition to
    // them: 2 rows are pending and both of those happen to carry a route
    // point that could not be placed.
    stubAttention({
      ...empty,
      reviewBatches: 1,
      pendingRows: 2,
      unresolvedRouteTokenRows: 2,
    });
    render(<ImportAttentionBanner />);

    const banner = await screen.findByRole("complementary", {
      name: "Imports needing your attention",
    });
    expect(banner).toHaveTextContent("2 imported rows need your review");
    expect(banner).toHaveTextContent("2 awaiting a decision");
    expect(banner).toHaveTextContent(
      "2 with a route point we could not place",
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
    stubAttention({
      ...empty,
      reviewBatches: 1,
      pendingRows: 1,
      unresolvedDuplicateRows: 1,
    });
    render(<ImportAttentionBanner />);
    const banner = await screen.findByRole("complementary", {
      name: "Imports needing your attention",
    });
    expect(banner).toHaveTextContent("1 imported row needs your review");
    expect(banner).toHaveTextContent("1 possible duplicates");
  });

  it("does not double-count a pending row that is also an unresolved duplicate", async () => {
    // Reviewer blocker regression: pendingRows, unresolvedDuplicateRows, and
    // unresolvedRouteTokenRows describe overlapping views of the same rows
    // (the review screen's own headline reads `counts.pendingRows` as "only
    // the N rows below need attention"), not disjoint counts to be summed.
    // Here 2 rows are pending and 1 of those 2 is also an unresolved
    // duplicate: the headline must equal the distinct row count (2), not the
    // sum (3), while the breakdown still names the duplicate subset.
    stubAttention({
      ...empty,
      reviewBatches: 1,
      pendingRows: 2,
      unresolvedDuplicateRows: 1,
    });
    render(<ImportAttentionBanner />);
    const banner = await screen.findByRole("complementary", {
      name: "Imports needing your attention",
    });
    expect(banner).toHaveTextContent("2 imported rows need your review");
    expect(banner).not.toHaveTextContent("3 imported rows need your review");
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
