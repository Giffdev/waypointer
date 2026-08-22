// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedMapView, toSharedMapData } from "./shared-map-view";

vi.mock("@/components/globe-panel", () => ({
  default: ({
    airports,
    routes,
    viewMode,
  }: {
    airports: Array<{ code: string; name: string }>;
    routes: unknown[];
    viewMode: string;
  }) => (
    <div data-testid="shared-globe" data-view-mode={viewMode}>
      {routes.length} routes ·{" "}
      {airports.map(({ code, name }) => `${code} ${name}`).join(" · ")}
    </div>
  ),
}));

describe("SharedMapView", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the public handle with real airport names and codes", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(sharedMap())));

    render(<SharedMapView handle="public-handle" />);

    expect(
      await screen.findByRole("heading", { name: "Shared Waypointer map" }),
    ).toBeVisible();
    expect(screen.getByTestId("shared-globe")).toHaveTextContent("1 routes");
    expect(screen.getByTestId("shared-globe")).toHaveTextContent(
      "LAX Los Angeles International Airport",
    );
    expect(screen.getByTestId("shared-globe")).toHaveTextContent(
      "SJD Los Cabos International Airport",
    );
    expect(screen.getByTestId("shared-globe")).not.toHaveTextContent(/\bR\d+\b/);
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
    const registration = screen.getByRole("combobox", {
      name: "Filter shared flights by tail number or registration",
    });
    await user.clear(registration);
    await user.type(registration, "N777AA");
    await user.keyboard("{Enter}");

    expect(screen.getByText(/Showing 1 of 3 shared flights/)).toBeVisible();
    expect(screen.getByTestId("shared-globe")).toHaveTextContent("1 routes");
    expect(screen.getByText("Flights").parentElement).toHaveTextContent("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.type(
      screen.getByLabelText("Filter shared flights from date"),
      "2027-01-01",
    );
    expect(
      screen.getByText("No shared flights match these filters"),
    ).toBeVisible();
    expect(screen.getByTestId("shared-globe")).toHaveTextContent("0 routes");

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText(/Showing 3 of 3 shared flights/)).toBeVisible();
    expect(
      screen.queryByText("No shared flights match these filters"),
    ).not.toBeInTheDocument();
  });

  it("never fabricates airports for a malformed current snapshot", async () => {
    const malformed = sharedMap();
    (malformed.map as { flights: unknown }).flights = null;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(malformed)));

    render(<SharedMapView handle="public-handle" />);

    expect(
      await screen.findByRole("heading", { name: "Shared map unavailable" }),
    ).toBeVisible();
    expect(screen.queryByTestId("shared-globe")).not.toBeInTheDocument();
  });

  it("asks owners to republish snapshots that predate real airports", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          {
            error: {
              code: "republish-required",
              message:
                "This shared map must be republished to show real airports.",
            },
          },
          409,
        ),
      ),
    );

    render(<SharedMapView handle="legacy-handle" />);

    expect(
      await screen.findByRole("heading", {
        name: "Shared map needs republishing",
      }),
    ).toBeVisible();
    expect(screen.getByText(/real airport names and codes/i)).toBeVisible();
    expect(screen.queryByTestId("shared-globe")).not.toBeInTheDocument();
  });

  it("bounds framing work for thousands of unique public routes", () => {
    const routes = Array.from({ length: 2_000 }, (_, index) => {
      const lat = -80 + Math.floor(index / 360) / 10;
      const lon = -170 + (index % 360) / 10;
      return {
        id: `route-${index}`,
        kind: "commercial" as const,
        flightCount: 1,
        origin: airport(
          `A${index}`,
          `Origin ${index}`,
          "Origin city",
          "US",
          lat,
          lon,
        ),
        destination: airport(
          `B${index}`,
          `Destination ${index}`,
          "Destination city",
          "US",
          lat + 1,
          lon + 0.1,
        ),
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

  it("honors retry-after and throttles lifecycle retries after a 429", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({}, 429, { "Retry-After": "60" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SharedMapView handle="busy-handle" />);

    expect(
      await screen.findByRole("heading", {
        name: "Shared map temporarily busy",
      }),
    ).toBeVisible();
    now.mockReturnValue(131_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(161_000);
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("suppresses successful lifecycle revalidation inside the response budget", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const fetchMock = vi.fn().mockResolvedValue(json(sharedMap()));
    vi.stubGlobal("fetch", fetchMock);

    render(<SharedMapView handle="public-handle" />);
    expect(await screen.findByTestId("shared-globe")).toBeVisible();

    now.mockReturnValue(110_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(131_000);
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("clears a loaded map when focus revalidation reports it disabled", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
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

    now.mockReturnValue(131_000);
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
      schemaVersion: 2,
      owner: { displayName: null },
      summary: { flightCount: 3, routeCount: 1 },
      routes: [
        {
          id: "route",
          kind: "commercial",
          flightCount: 3,
          origin: airport(
            "LAX",
            "Los Angeles International Airport",
            "Los Angeles",
            "US",
            33.9425,
            -118.4081,
          ),
          destination: airport(
            "SJD",
            "Los Cabos International Airport",
            "San José del Cabo",
            "MX",
            23.1518,
            -109.721,
          ),
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

function airport(
  code: string,
  name: string,
  city: string,
  country: string,
  lat: number,
  lon: number,
) {
  return {
    code,
    name,
    city,
    country,
    lat,
    lon,
    facility: "commercial" as const,
  };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
