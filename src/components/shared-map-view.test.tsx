// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedMapView } from "./shared-map-view";

vi.mock("@/components/globe-panel", () => ({
  default: ({ routes, viewMode }: { routes: unknown[]; viewMode: string }) => (
    <div data-testid="shared-globe" data-view-mode={viewMode}>
      {routes.length} routes
    </div>
  ),
}));

describe("SharedMapView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the public handle without a key and renders the coarse map", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(sharedMap())));

    render(<SharedMapView handle="public-handle" />);

    expect(
      await screen.findByRole("heading", { name: "Shared Waypointer map" }),
    ).toBeVisible();
    expect(screen.getByTestId("shared-globe")).toHaveTextContent("1 routes");
    await user.click(screen.getByRole("button", { name: "Flat map" }));
    expect(screen.getByTestId("shared-globe")).toHaveAttribute(
      "data-view-mode",
      "flat",
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/shared/public-handle",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("key");
  });

  it("shows the same 404 state for disabled and unknown handles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          {
            error: {
              code: "not-found",
              message: "Waypointer shared map not found.",
            },
          },
          404,
        ),
      ),
    );

    render(<SharedMapView handle="unknown" />);

    expect(
      await screen.findByRole("heading", { name: "Shared map not found" }),
    ).toBeVisible();
    expect(screen.queryByTestId("shared-globe")).not.toBeInTheDocument();
  });

  it("clears a loaded map when focus revalidation reports it disabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(sharedMap()))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "not-found",
              message: "Waypointer shared map not found.",
            },
          },
          404,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<SharedMapView handle="public-handle" />);
    expect(await screen.findByTestId("shared-globe")).toBeVisible();

    act(() => window.dispatchEvent(new Event("focus")));

    expect(
      await screen.findByRole("heading", { name: "Shared map not found" }),
    ).toBeVisible();
    expect(screen.queryByTestId("shared-globe")).not.toBeInTheDocument();
  });
});

function sharedMap() {
  return {
    map: {
      owner: { displayName: null },
      summary: { flightCount: 3, routeCount: 1 },
      routes: [
        {
          id: "route",
          kind: "commercial",
          flightCount: 3,
          origin: { lat: 34, lon: -118.4, country: "US" },
          destination: { lat: 24.1, lon: -110.4, country: "MX" },
        },
      ],
    },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
