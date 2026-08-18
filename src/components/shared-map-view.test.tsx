// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedMapView } from "./shared-map-view";

vi.mock("@/components/globe-panel", () => ({
  default: ({ routes, viewMode }: { routes: unknown[]; viewMode: string }) => (
    <div data-testid="shared-globe" data-view-mode={viewMode}>{routes.length} routes</div>
  ),
}));

describe("SharedMapView", () => {
  beforeEach(() => {
    window.location.hash = `key=${"s".repeat(43)}`;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("renders only the coarse view-only projection and offers the same viewer mode toggle", async () => {
    const user = userEvent.setup();
    const replaceState = vi.spyOn(window.history, "replaceState");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      map: {
        owner: { displayName: null },
        summary: { flightCount: 3, routeCount: 2 },
        routes: [
          {
            id: "out",
            kind: "commercial",
            flightCount: 2,
            origin: { lat: 34, lon: -118.4, country: "United States" },
            destination: { lat: 24.1, lon: -110.4, country: "Mexico" },
          },
          {
            id: "back",
            kind: "commercial",
            flightCount: 1,
            origin: { lat: 24.1, lon: -110.4, country: "Mexico" },
            destination: { lat: 34, lon: -118.4, country: "United States" },
          },
        ],
      },
    })));

    render(<SharedMapView publicId="public-id" />);

    expect(await screen.findByRole("heading", { name: "Shared Waypointer map" })).toBeVisible();
    expect(screen.getByTestId("shared-globe")).toHaveTextContent("1 routes");
    await user.click(screen.getByRole("button", { name: "Flat map" }));
    expect(screen.getByTestId("shared-globe")).toHaveAttribute("data-view-mode", "flat");
    expect(screen.getByText(/Approximate aggregated routes · 3 flights · 1 routes/)).toBeVisible();
    expect(screen.queryByText(/Upload|Import|Settings|Share map|Save profile/i)).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "/api/shared/public-id",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({ key: "s".repeat(43) }),
      }),
    );
    expect(replaceState).toHaveBeenCalledWith(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    expect(window.location.hash).toBe("");
  });

  it("shows the same non-enumerating state for revoked or unknown links", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      error: { code: "not-found", message: "Waypointer shared map not found." },
    }, 404)));

    render(<SharedMapView publicId="unknown" />);

    expect(await screen.findByRole("heading", { name: "Shared map not found" })).toBeVisible();
    expect(screen.getByText(/may have been disabled or replaced/)).toBeVisible();
    expect(screen.queryByTestId("shared-globe")).toBeNull();
  });

  it("does not request a projection when the fragment capability is missing", async () => {
    window.location.hash = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<SharedMapView publicId="public-id" />);

    expect(await screen.findByRole("heading", { name: "Shared map not found" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
