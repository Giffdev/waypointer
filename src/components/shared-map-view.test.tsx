// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedMapView, toSharedMapData } from "./shared-map-view";

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
    expect(screen.getByText("Map legend")).toBeVisible();
    expect(screen.getByText(/Showing 3 of 3 shared flights/)).toBeVisible();
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

  it("filters locally and updates current-view routes and statistics", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(json(sharedMap()));
    vi.stubGlobal("fetch", fetchMock);

    render(<SharedMapView handle="public-handle" />);
    expect(
      await screen.findByText(/Showing 3 of 3 shared flights/),
    ).toBeVisible();

    await user.selectOptions(
      screen.getByRole("combobox", {
        name: "Filter shared flights by role",
      }),
      "pilot",
    );
    await user.selectOptions(
      screen.getByRole("combobox", {
        name: "Filter shared flights by tail number",
      }),
      "N777AA",
    );

    expect(screen.getByText(/Showing 1 of 3 shared flights/)).toBeVisible();
    expect(screen.getByTestId("shared-globe")).toHaveTextContent("1 routes");
    expect(screen.getByText("Flights").parentElement).toHaveTextContent("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText(/Showing 3 of 3 shared flights/)).toBeVisible();
  });

  it("keeps legacy snapshots readable and explains how to enable filters", async () => {
    const legacy = sharedMap();
    (legacy.map as { flights: unknown }).flights = null;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(legacy)));

    render(<SharedMapView handle="public-handle" />);

    expect(
      await screen.findByText(/owner can republish it to enable viewer filters/i),
    ).toBeVisible();
    expect(
      screen.queryByRole("combobox", {
        name: "Filter shared flights by role",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("shared-globe")).toHaveTextContent("1 routes");
  });

  it("bounds framing work for thousands of unique public routes", () => {
    const routes = Array.from({ length: 2_000 }, (_, index) => {
      const lat = -80 + Math.floor(index / 360) / 10;
      const lon = -170 + (index % 360) / 10;
      return {
        id: `route-${index}`,
        kind: "commercial" as const,
        flightCount: 1,
        origin: { lat, lon, country: "US" },
        destination: { lat: lat + 1, lon: lon + 0.1, country: "US" },
      };
    });
    const startedAt = performance.now();
    const mapData = toSharedMapData(routes);
    expect(mapData.routes).toHaveLength(2_000);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
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
      flights: [
        {
          date: "2026-01-10",
          kind: "commercial",
          role: "passenger",
          aircraft: ["Boeing 737"],
          registration: "N12345",
          routeIds: ["route"],
        },
        {
          date: "2026-02-15",
          kind: "commercial",
          role: "pilot",
          aircraft: ["Boeing 777"],
          registration: "N777AA",
          routeIds: ["route"],
        },
        {
          date: "2026-03-20",
          kind: "commercial",
          role: "pilot",
          aircraft: ["Airbus A320"],
          registration: "N320BB",
          routeIds: ["route"],
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
