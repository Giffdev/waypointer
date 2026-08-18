// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInitialFilters } from "@/components/dashboard-shared";
import {
  buildFlightsPageContract,
  buildImportPageContract,
  buildMapPageContract,
} from "@/lib/route-page-data";
import MapRouteClient from "./(routes)/map/route-client";
import FlightsRouteClient from "./(routes)/flights/route-client";
import ImportRouteClient from "./(routes)/import/route-client";

const push = vi.fn();
let pathname = "/map";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push }),
}));

vi.mock("@/components/globe-panel", () => ({
  default: ({
    routes,
    airports,
    viewMode,
  }: {
    routes: unknown[];
    airports: unknown[];
    viewMode: string;
  }) => (
    <div aria-label="Cartographic flight map" data-view-mode={viewMode}>
      {routes.length} routes and {airports.length} airports
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("route clients", () => {
  beforeEach(() => {
    push.mockClear();
    pathname = "/map";
  });

  it("navigates map filter changes and follows server-provided back state", async () => {
    const user = userEvent.setup();
    const mapData = buildMapPageContract(getInitialFilters(), null, null);
    const { rerender } = render(
      <MapRouteClient
        data={{
          ...mapData,
          filterOptions: {
            ...mapData.filterOptions,
            aircraft: [{ value: "C172", available: true }],
            registrations: [{ value: "N123EX", available: true }],
          },
        }}
      />,
    );
    expect(screen.getByLabelText("Cartographic flight map")).toBeInTheDocument();
    const typeFilter = screen.getByRole("combobox", {
      name: "Filter flights by flight role or type",
    });
    expect(typeFilter.tagName).toBe("SELECT");
    expect(
      screen.getByRole("combobox", { name: "Filter flights by period" })
        .tagName,
    ).toBe("SELECT");
    fireEvent.change(
      typeFilter,
      { target: { value: "commercial" } },
    );
    expect(push).toHaveBeenCalledWith("/map?type=commercial", { scroll: false });
    const aircraftFilter = screen.getByRole("combobox", {
      name: "Filter flights by aircraft type or model",
    });
    expect(aircraftFilter.tagName).toBe("INPUT");
    await user.click(aircraftFilter);
    await user.clear(aircraftFilter);
    await user.type(aircraftFilter, "C172");
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/map?aircraft=C172", { scroll: false });

    rerender(
      <MapRouteClient
        data={buildMapPageContract(
          getInitialFilters({ aircraft: "C172", registration: "N123EX" }),
          null,
          null,
        )}
      />,
    );
    expect(
      screen.getByRole("combobox", {
        name: "Filter flights by aircraft type or model",
      }),
    ).toHaveValue("C172");
    expect(
      screen.getByRole("combobox", {
        name: "Filter flights by tail number or registration",
      }),
    ).toHaveValue("N123EX");
  });

  it("offers a production keyboard-selectable airport focus and Home reset", async () => {
    const user = userEvent.setup();
    render(
      <MapRouteClient
        data={buildMapPageContract(getInitialFilters(), null, null)}
      />,
    );
    const selector = screen.getByRole("combobox", {
      name: "Focus airport on map",
    });

    await user.click(selector);
    await user.keyboard("{ArrowDown}{Enter}");
    const selectedCode = (selector as HTMLInputElement).value.split(" ")[0];
    expect(
      screen.getByRole("status", { name: "Airport focus status" }),
    ).toHaveTextContent(`Map focused on ${selectedCode}`);
    fireEvent.click(screen.getByRole("button", { name: "Fit my flights" }));
    expect(
      screen.getByRole("status", { name: "Airport focus status" }),
    ).toHaveTextContent("No airport focus");
  });

  it("switches projection without losing focus and persists explicit owner preference", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ profile: { mapViewMode: "flat" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    const mapData = buildMapPageContract(getInitialFilters(), null, null);
    render(<MapRouteClient data={{ ...mapData, dataMode: "persisted" }} />);
    const selector = screen.getByRole("combobox", { name: "Focus airport on map" });
    await user.click(selector);
    await user.keyboard("{ArrowDown}{Enter}");
    const focusText = screen.getByRole("status", { name: "Airport focus status" }).textContent;
    const routeSelector = screen.getByRole("combobox", {
      name: "Inspect a connected route",
    });
    expect(routeSelector.querySelectorAll("option").length).toBeGreaterThan(1);
    await user.selectOptions(
      routeSelector,
      routeSelector.querySelectorAll("option")[1].value,
    );
    const selectedRoute = (routeSelector as HTMLSelectElement).value;

    await user.click(screen.getByRole("button", { name: "Flat map" }));

    expect(screen.getByLabelText("Cartographic flight map")).toHaveAttribute("data-view-mode", "flat");
    expect(screen.getByRole("status", { name: "Airport focus status" })).toHaveTextContent(focusText!);
    expect(routeSelector).toHaveValue(selectedRoute);
    expect(fetch).toHaveBeenCalledWith(
      "/api/account/profile",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ mapViewMode: "flat" }),
      }),
    );
    expect(await screen.findByText("Map view preference saved.")).toBeVisible();
  });

  it("honors a saved flat-map preference on cold load", () => {
    render(
      <MapRouteClient
        data={buildMapPageContract(
          getInitialFilters(),
          null,
          null,
          undefined,
          "flat",
        )}
      />,
    );

    expect(screen.getByRole("button", { name: "Flat map" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Cartographic flight map")).toHaveAttribute("data-view-mode", "flat");
  });

  it("keeps Flights distinct, URL-filtered, searchable, and editable", async () => {
    const user = userEvent.setup();
    pathname = "/flights";
    const { container } = render(
      <FlightsRouteClient
        data={buildFlightsPageContract(getInitialFilters(), null, null)}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /review your current flight records/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Flight history")).toBeInTheDocument();
    expect(screen.queryByText("Existing normalized history")).not.toBeInTheDocument();
    const filterDisclosure = container.querySelector(
      "details.route-filter-disclosure",
    );
    const filterSummary = filterDisclosure?.querySelector("summary");
    expect(filterDisclosure).not.toHaveAttribute("open");
    expect(filterSummary).toHaveTextContent(/flight filters/i);
    expect(filterSummary).toHaveTextContent(/filters/i);
    await user.click(filterSummary!);
    expect(filterDisclosure).toHaveAttribute("open");
    const typeFilter = screen.getByRole("combobox", {
      name: "Filter flights by flight role or type",
    });

    expect(typeFilter.tagName).toBe("SELECT");
    fireEvent.change(typeFilter, { target: { value: "private" } });
    expect(push).toHaveBeenCalledWith("/flights?type=private", { scroll: false });
    expect(
      screen.getByRole("combobox", {
        name: "Filter flights by aircraft type or model",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", {
        name: "Filter flights by aircraft type or model",
      }).tagName,
    ).toBe("INPUT");

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "no-such-flight" },
    });

    expect(screen.getByText("No records match this history search")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    const edit = screen.getAllByRole("button", {
      name: /^Edit .* flight$/,
    })[0];
    await user.click(edit);
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Correct departure or arrival",
    );
    expect(screen.getByLabelText("Departure airport code")).toBeInTheDocument();
    expect(screen.getByLabelText("Arrival airport code")).toBeInTheDocument();
    expect(screen.queryByText(/review correction/i)).not.toBeInTheDocument();
  });

  it("opens the manual-log flow from Flights with explicit classification", async () => {
    const user = userEvent.setup();
    pathname = "/flights";
    render(
      <FlightsRouteClient
        data={buildFlightsPageContract(getInitialFilters(), null, null)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add flight" }));
    expect(screen.getByRole("dialog", { name: "Add one flight" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Personal" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Commercial" })).not.toBeChecked();
  });

  it("keeps every Flights filter URL-owned when one filter changes", async () => {
    const user = userEvent.setup();
    pathname = "/flights";
    const aircraft = "C172";
    const registration = "N123EX";
    const year = 2025;
    const month = 3;
    const filters = getInitialFilters({
      type: "private",
      period: "custom",
      year: String(year),
      month: String(month),
      aircraft,
      registration,
    });

    const baseData = buildFlightsPageContract(filters, null, null);

    const { container } = render(
      <FlightsRouteClient
        data={{
          ...baseData,
          filterOptions: {
            ...baseData.filterOptions,
            years: [{ value: year, available: true }],
            months: [{ value: month, available: true }],
            aircraft: [{ value: aircraft, available: true }],
            registrations: [{ value: registration, available: true }],
          },
          latestYearByMonth: { ...baseData.latestYearByMonth, [month]: year },
        }}
      />,
    );
    await user.click(
      container.querySelector("details.route-filter-disclosure > summary")!,
    );
    const yearFilter = screen.getByRole("combobox", {
      name: "Filter flights by year",
    });
    const monthFilter = screen.getByRole("combobox", {
      name: "Filter flights by month",
    });
    const aircraftFilter = screen.getByRole("combobox", {
      name: "Filter flights by aircraft type or model",
    });
    const registrationFilter = screen.getByRole("combobox", {
      name: "Filter flights by tail number or registration",
    });
    expect(yearFilter).toHaveValue(String(year));
    expect(monthFilter).toHaveValue(String(month));
    expect(aircraftFilter).toHaveValue(aircraft);
    expect(registrationFilter).toHaveValue(registration);
    expect(yearFilter.tagName).toBe("SELECT");
    expect(monthFilter.tagName).toBe("SELECT");
    expect(aircraftFilter.tagName).toBe("INPUT");
    expect(registrationFilter.tagName).toBe("INPUT");

    await user.click(registrationFilter);
    await user.click(
      screen.getByRole("option", { name: "All available registrations" }),
    );
    const expectedQuery = new URLSearchParams({
      type: "private",
      period: "custom",
      year: String(year),
      month: String(month),
      aircraft,
    });
    expect(push).toHaveBeenCalledWith(
      `/flights?${expectedQuery.toString()}`,
      { scroll: false },
    );
  });

  it("keeps import source URL-owned and filters the rendered history contract", () => {
    pathname = "/flights";
    const { container, rerender } = render(
      <FlightsRouteClient
        data={buildFlightsPageContract(getInitialFilters(), null, null)}
      />,
    );
    const sourceFilter = screen.getByRole("combobox", {
      name: "Filter flights by import source",
    });

    fireEvent.change(sourceFilter, { target: { value: "ForeFlight" } });
    expect(push).toHaveBeenCalledWith("/flights?source=ForeFlight", {
      scroll: false,
    });

    rerender(
      <FlightsRouteClient
        data={buildFlightsPageContract(
          getInitialFilters({ source: "foreflight" }),
          null,
          null,
        )}
      />,
    );
    expect(sourceFilter).toHaveValue("ForeFlight");
    expect(
      Array.from(
        container.querySelectorAll(".record-tags span:last-child"),
      ).map((element) => element.textContent),
    ).toEqual(["ForeFlight", "ForeFlight", "ForeFlight"]);
    expect(
      screen.getByRole("status", { name: "Flight records status" }),
    ).toHaveTextContent(/3 of 3 records shown/);
  });

  it.each([
    {
      route: "Map",
      pathname: "/map",
      filter: "aircraft",
      ariaLabel: "Filter flights by aircraft type or model",
      lowercase: "cessna 172",
      canonical: "Cessna 172",
    },
    {
      route: "Map",
      pathname: "/map",
      filter: "registration",
      ariaLabel: "Filter flights by tail number or registration",
      lowercase: "n9900m",
      canonical: "N9900M",
    },
    {
      route: "Flights",
      pathname: "/flights",
      filter: "aircraft",
      ariaLabel: "Filter flights by aircraft type or model",
      lowercase: "cessna 172",
      canonical: "Cessna 172",
    },
    {
      route: "Flights",
      pathname: "/flights",
      filter: "registration",
      ariaLabel: "Filter flights by tail number or registration",
      lowercase: "n9900m",
      canonical: "N9900M",
    },
  ])(
    "canonicalizes a lowercase $filter URL value on $route focus and Enter",
    async ({ route, pathname: routePath, filter, ariaLabel, lowercase, canonical }) => {
      const user = userEvent.setup();
      pathname = routePath;
      const filters = getInitialFilters({ [filter]: lowercase });
      const baseData =
        route === "Map"
          ? buildMapPageContract(filters, null, null)
          : buildFlightsPageContract(filters, null, null);
      const data = {
        ...baseData,
        filterOptions: {
          ...baseData.filterOptions,
          aircraft: [{ value: "Cessna 172", available: true }],
          registrations: [{ value: "N9900M", available: true }],
        },
      };
      const { container } = render(
        route === "Map" ? (
          <MapRouteClient data={data as ReturnType<typeof buildMapPageContract>} />
        ) : (
          <FlightsRouteClient
            data={data as ReturnType<typeof buildFlightsPageContract>}
          />
        ),
      );
      if (route === "Flights") {
        await user.click(
          container.querySelector("details.route-filter-disclosure > summary")!,
        );
      }
      const input = screen.getByRole("combobox", { name: ariaLabel });

      expect(input).toHaveValue(canonical);
      await user.click(input);
      const selected = screen.getByRole("option", { name: canonical });
      expect(selected).toHaveAttribute("aria-selected", "true");
      expect(input).toHaveAttribute("aria-activedescendant", selected.id);
      await user.keyboard("{Enter}");

      expect(push).toHaveBeenCalledWith(
        `${routePath}?${filter}=${encodeURIComponent(canonical).replace("%20", "+")}`,
        { scroll: false },
      );
      expect(input).toHaveValue(canonical);
    },
  );

  it("cancels edits safely and restores focus to the entry action", async () => {
    const user = userEvent.setup();
    pathname = "/flights";
    render(
      <FlightsRouteClient
        data={buildFlightsPageContract(getInitialFilters(), null, null)}
      />,
    );
    const edit = screen.getAllByRole("button", {
      name: /^Edit .* flight$/,
    })[0];
    await user.click(edit);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.clear(screen.getByLabelText("Departure airport code"));
    await user.type(screen.getByLabelText("Departure airport code"), "ZZZ");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(edit).toHaveFocus());
    expect(
      screen.queryByRole("button", { name: /^Edit ZZZ to .* flight$/ }),
    ).not.toBeInTheDocument();
  });

  it("saves endpoint edits only in the current view", async () => {
    const user = userEvent.setup();
    pathname = "/flights";
    render(
      <FlightsRouteClient
        data={buildFlightsPageContract(getInitialFilters(), null, null)}
      />,
    );
    await user.click(
      screen.getAllByRole("button", { name: /^Edit .* flight$/ })[0],
    );
    await user.clear(screen.getByLabelText("Departure airport code"));
    await user.type(screen.getByLabelText("Departure airport code"), "ZZZ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      screen.getByRole("button", { name: /^Edit ZZZ to .* flight$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Flight records status" }),
    ).toHaveTextContent(
      "Flight updated in this view only. Reloading restores imported data.",
    );
  });

  it("requires confirmation to delete and allows cancellation", async () => {
    const user = userEvent.setup();
    pathname = "/flights";
    render(
      <FlightsRouteClient
        data={buildFlightsPageContract(getInitialFilters(), null, null)}
      />,
    );
    const initialDeleteButtons = screen.getAllByRole("button", {
      name: /^Delete .* flight$/,
    });
    await user.click(initialDeleteButtons[0]);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      "Delete this flight?",
    );
    expect(screen.getByText(/only from the current view/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(initialDeleteButtons[0]).toHaveFocus());
    expect(
      screen.getAllByRole("button", { name: /^Delete .* flight$/ }),
    ).toHaveLength(initialDeleteButtons.length);

    await user.click(initialDeleteButtons[0]);
    await user.click(screen.getByRole("button", { name: "Delete flight" }));
    expect(
      screen.getAllByRole("button", { name: /^Delete .* flight$/ }),
    ).toHaveLength(initialDeleteButtons.length - 1);
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Flight records status" }),
      ).toHaveFocus(),
    );
    expect(
      screen.getByRole("status", { name: "Flight records status" }),
    ).toHaveTextContent(
      "Flight removed from this view only. Reloading restores imported data.",
    );
  });

  it("renders Import from aggregate workflow data only", () => {
    pathname = "/import";
    render(
      <ImportRouteClient
        data={{
          ...buildImportPageContract(null),
          hasLocalArtifact: true,
          normalizedFlightCount: 321,
        }}
        developmentPreviewEnabled
      />,
    );
    expect(
      screen.getByRole("heading", { name: /stage new flight records/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /The map is showing 321 flights imported earlier on this computer/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /ForeFlight Logbook.*myFlightradar24 Flight Diary.*Digital logbook CSV/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Source format" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/ambiguous or unsupported files stop here/i))
      .toBeInTheDocument();
    const stages = screen.getByLabelText("Import review stages");
    expect(stages.querySelectorAll(".status-chip.pending")).toHaveLength(1);
    expect(screen.getAllByText("Not started")).toHaveLength(1);
    expect(screen.queryByText("Not run")).not.toBeInTheDocument();
    expect(screen.getByText("Available")).toHaveClass("status-chip", "available");
    expect(screen.getByText("Unavailable in preview")).toHaveClass(
      "status-chip",
      "planned",
    );
    expect(screen.getByLabelText("Choose one supported CSV")).toBeEnabled();
    expect(screen.getByRole("button", { name: /commit unavailable in preview mode/i }))
      .toBeDisabled();
    expect(screen.queryByText(/review your current flight records/i)).not.toBeInTheDocument();
  });

  it("explains source classification defaults and bulk generic overrides", () => {
    pathname = "/import";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ batches: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    render(
      <ImportRouteClient
        data={buildImportPageContract(null)}
        apiEnabled
      />,
    );

    expect(screen.getByText(/ForeFlight, MyFlightbook, and CrewLounge Pilotlog use Personal \/ Pilot/i)).toBeVisible();
    expect(screen.getByText(/myFlightradar24 uses Commercial \/ Passenger/i)).toBeVisible();
    expect(screen.getByText(/default applies to the whole file and can be changed before upload/i)).toBeVisible();
  });
});
