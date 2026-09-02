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
import { airportExactIdentity } from "@/lib/flight-data";
import { formatRouteDirection } from "@/lib/route-direction";
import type { PublicMapProjection } from "@/lib/sharing/service";
import { SharedMapView, toSharedMapData } from "./shared-map-view";

vi.mock("@/components/globe-panel", () => ({
  default: ({
    airports,
    routes,
    viewMode,
    focusAirportCode,
  }: {
    airports: Array<{ code: string; name: string }>;
    routes: unknown[];
    viewMode: string;
    focusAirportCode: string;
  }) => (
    <div
      data-testid="shared-globe"
      data-view-mode={viewMode}
      data-focus={focusAirportCode}
    >
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
    expect(screen.getByTestId("shared-globe")).toHaveAttribute(
      "data-focus",
      "",
    );
    expect(screen.getByTestId("shared-globe")).toHaveTextContent(
      "LAX Los Angeles International Airport",
    );
    expect(screen.getByTestId("shared-globe")).toHaveTextContent(
      "SJD Los Cabos International Airport",
    );
    expect(screen.getByTestId("shared-globe")).not.toHaveTextContent(/\bR\d+\b/);
    expect(
      screen.getByRole("combobox", {
        name: "Filter shared flights by airport",
      }),
    ).toHaveValue("All shared airports");
    const busiestRoute = screen.getByText(/Busiest route:/).parentElement;
    expect(busiestRoute).toHaveTextContent(
      "LAX — Los Angeles International Airport",
    );
    expect(busiestRoute).toHaveTextContent(
      "SJD — Los Cabos International Airport",
    );
    expect(
      screen.getByText(/route details use published airport codes and names/i),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent(/Approximate region/i);
    expect(screen.getByText("Map legend")).toBeVisible();
    expect(screen.getByText(/Showing 3 of 3 shared flights/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Flat map" }));
    expect(screen.getByTestId("shared-globe")).toHaveAttribute(
      "data-view-mode",
      "flat",
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/shared/public-handle?contract=3",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("key");
  });

  it("preserves filters, statistics, legend, and route-direction cues across a view-mode toggle", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(json(sharedMap()));
    vi.stubGlobal("fetch", fetchMock);

    render(<SharedMapView handle="public-handle" />);
    expect(
      await screen.findByRole("heading", { name: "Shared Waypointer map" }),
    ).toBeVisible();

    // Sensible default: the shared map opens in 3D globe mode, matching the
    // private map's default (DEFAULT_MAP_VIEW_MODE).
    expect(screen.getByRole("button", { name: "3D globe" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("shared-globe")).toHaveAttribute(
      "data-view-mode",
      "globe",
    );

    await user.selectOptions(
      screen.getByRole("combobox", {
        name: "Filter shared flights by role",
      }),
      "pilot",
    );
    expect(screen.getByText(/Showing 2 of 3 shared flights/)).toBeVisible();
    const busiestRouteBefore = screen.getByText(/Busiest route:/).parentElement;
    expect(busiestRouteBefore).toHaveTextContent(
      "LAX — Los Angeles International Airport",
    );
    expect(screen.getByText("Map legend")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Flat map" }));
    expect(screen.getByRole("button", { name: "Flat map" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("shared-globe")).toHaveAttribute(
      "data-view-mode",
      "flat",
    );
    // Toggling the view mode must not refetch, re-filter, or drop context.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("combobox", { name: "Filter shared flights by role" }),
    ).toHaveValue("pilot");
    expect(screen.getByText(/Showing 2 of 3 shared flights/)).toBeVisible();
    expect(screen.getByText(/Busiest route:/).parentElement).toHaveTextContent(
      "LAX — Los Angeles International Airport",
    );
    expect(screen.getByText("Map legend")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "3D globe" }));
    expect(screen.getByTestId("shared-globe")).toHaveAttribute(
      "data-view-mode",
      "globe",
    );
    expect(
      screen.getByRole("combobox", { name: "Filter shared flights by role" }),
    ).toHaveValue("pilot");
    expect(screen.getByText(/Showing 2 of 3 shared flights/)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("consumes the canonical public direction contract without re-aggregation", () => {
    const canonical: PublicMapProjection["routes"][number] = {
      ...sharedMap().map.routes[0],
      kind: "commercial" as const,
      directionMode: "both",
    };
    const mapData = toSharedMapData([canonical]);

    expect(mapData.routes).toHaveLength(1);
    expect(mapData.routes[0]).toMatchObject({
      id: "route",
      forwardFlightCount: 2,
      reverseFlightCount: 1,
      directionMode: "both",
    });
    expect(formatRouteDirection(mapData.routes[0])).toBe("LAX ↔ SJD");
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

  it("clears a selected airport when republishing removes that identity", async () => {
    const user = userEvent.setup();
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    let completeRevalidation!: (response: Response) => void;
    const revalidation = new Promise<Response>((resolve) => {
      completeRevalidation = resolve;
    });
    const republished = sharedMap();
    republished.map.routes[0]!.origin = airport(
      "SEA",
      "Seattle-Tacoma International Airport",
      "Seattle",
      "US",
      47.44898,
      -122.30931,
    );
    republished.map.routes[0]!.destination = airport(
      "JFK",
      "John F Kennedy International Airport",
      "New York",
      "US",
      40.63993,
      -73.77869,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(sharedMap()))
      .mockReturnValueOnce(revalidation);
    vi.stubGlobal("fetch", fetchMock);

    render(<SharedMapView handle="public-handle" />);
    const airportFilter = await screen.findByRole("combobox", {
      name: "Filter shared flights by airport",
    });
    await user.selectOptions(
      screen.getByRole("combobox", {
        name: "Filter shared flights by role",
      }),
      "pilot",
    );
    await user.clear(airportFilter);
    await user.type(airportFilter, "LAX");
    await user.keyboard("{Enter}");
    expect(airportFilter).toHaveValue(
      "LAX — Los Angeles International Airport, Los Angeles",
    );
    expect(screen.getByTestId("shared-globe")).toHaveAttribute(
      "data-focus",
      airportExactIdentity(sharedMap().map.routes[0]!.origin),
    );

    now.mockReturnValue(131_000);
    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("combobox", {
        name: "Filter shared flights by role",
      }),
    ).toHaveValue("pilot");
    expect(airportFilter).toHaveValue(
      "LAX — Los Angeles International Airport, Los Angeles",
    );
    await act(async () => completeRevalidation(json(republished)));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", {
          name: "Filter shared flights by airport",
        }),
      ).toHaveValue("All shared airports"),
    );
    expect(
      screen.getByRole("combobox", {
        name: "Filter shared flights by role",
      }),
    ).toHaveValue("pilot");
    expect(screen.getByTestId("shared-globe")).toHaveTextContent(
      "SEA Seattle-Tacoma International Airport",
    );
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
        forwardFlightCount: 1,
        reverseFlightCount: 0,
        directionMode: "one-way" as const,
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

  it("keeps the shared page's DOM order unchanged from header through privacy notice", async () => {
    // The mobile map-first layout (see src/app/map-layout.test.ts) is CSS
    // `order` only; the underlying DOM order must stay
    // header -> controls -> statistics -> canvas -> privacy so tab order,
    // screen-reader reading order, and desktop layout are all unaffected.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(sharedMap())));

    const { container } = render(<SharedMapView handle="public-handle" />);
    await screen.findByRole("heading", { name: "Shared Waypointer map" });

    const page = container.querySelector(".shared-map-page");
    expect(page).not.toBeNull();
    const sectionClasses = Array.from(page!.children).map(
      (child) => child.className.split(" ")[0],
    );
    expect(sectionClasses).toEqual([
      "shared-map-header",
      "shared-map-controls",
      "shared-map-statistics",
      "shared-map-canvas",
      "shared-map-privacy",
    ]);
  });
});

function sharedMap() {
  return {
    map: {
      schemaVersion: 3,
      owner: { displayName: null },
      summary: { flightCount: 3, routeCount: 1 },
      routes: [
        {
          id: "route",
          kind: "commercial",
          flightCount: 3,
          forwardFlightCount: 2,
          reverseFlightCount: 1,
          directionMode: "both",
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
          routeLegs: [{ routeId: "route", direction: "forward" }],
        },
        {
          date: "2026-02-15",
          kind: "commercial",
          role: "pilot",
          aircraft: ["Boeing 777"],
          registration: "N777AA",
          routeLegs: [{ routeId: "route", direction: "reverse" }],
        },
        {
          date: "2026-03-20",
          kind: "commercial",
          role: "pilot",
          aircraft: ["Airbus A320"],
          registration: "N320BB",
          routeLegs: [{ routeId: "route", direction: "forward" }],
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
