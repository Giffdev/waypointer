// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MapSharingPanel,
  type ShareFlightOption,
} from "./map-sharing-panel";

const flights: ShareFlightOption[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    date: "2026-08-01",
    kind: "commercial",
    airportCodes: ["LAX", "MEX"],
    cities: ["Los Angeles", "Mexico City"],
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    date: "2026-08-02",
    kind: "private",
    airportCodes: ["SEA", "SFO", "HNL"],
    cities: ["Seattle", "San Francisco", "Honolulu"],
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    date: "2026-08-03",
    kind: "private",
    airportCodes: ["PDX", "BOI"],
    cities: ["Portland", "Boise"],
  },
];
const sharePath =
  "/shared/00000000-0000-4000-8000-000000000010#key=" + "s".repeat(43);

describe("MapSharingPanel", () => {
  let enabled = false;
  let currentPath = sharePath;
  let currentSelected: string[] = [];
  let currentIdentity = false;
  const writeText = vi.fn();

  beforeEach(() => {
    enabled = false;
    currentPath = sharePath;
    currentSelected = [];
    currentIdentity = false;
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/account/sharing" && !init?.method) {
        return json({ sharing: status() });
      }
      if (url.endsWith("/preview")) {
        const selection = JSON.parse(String(init?.body)) as {
          flightIds: string[];
          includeDisplayName: boolean;
        };
        return json({ preview: makePreview(selection) });
      }
      if (url === "/api/account/sharing" && init?.method === "POST") {
        const selection = JSON.parse(String(init.body)) as {
          flightIds: string[];
          includeDisplayName: boolean;
        };
        enabled = true;
        currentSelected = selection.flightIds;
        currentIdentity = selection.includeDisplayName;
        return json({ sharing: status() });
      }
      if (url.endsWith("/regenerate")) {
        currentPath = currentPath.replace("s".repeat(43), "r".repeat(43));
        return json({ sharing: status() });
      }
      if (url === "/api/account/sharing" && init?.method === "DELETE") {
        enabled = false;
        return json({ sharing: status() });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts with no selection and keeps preview and enable disabled", async () => {
    render(<MapSharingPanel flights={flights} />);

    expect(await screen.findByText("Private · sharing is off")).toBeVisible();
    expect(screen.getByRole("group", { name: "Select flights to share" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview selected flights" })).toBeDisabled();
    expect(screen.getByText(/Select at least one flight/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Enable sharing" })).not.toBeInTheDocument();
    expect(screen.getByText(/Future flights are never added automatically/)).toBeVisible();
    expect(screen.getByText(/copy, forward, or screenshot/)).toBeVisible();
  });

  it("selects one flight and previews only its exact coarse ordered legs", async () => {
    const user = userEvent.setup();
    render(<MapSharingPanel flights={flights} />);
    await screen.findByText("Private · sharing is off");

    await user.click(
      screen.getByRole("checkbox", {
        name: "Share SEA → SFO → HNL flight on 2026-08-02",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Preview selected flights" }));

    expect(await screen.findByRole("heading", { name: "Exactly what will be public" })).toBeVisible();
    expect(screen.getByText("Flight 1 · private")).toBeVisible();
    expect(screen.getByText(/US \(47\.6, -122\.3\) → US \(37\.6, -122\.4\)/)).toBeVisible();
    expect(screen.getByText(/US \(37\.6, -122\.4\) → US \(21\.3, -157\.9\)/)).toBeVisible();
    expect(screen.getByText("Hidden")).toBeVisible();
    expect(screen.getByRole("button", { name: "Enable sharing" })).toBeDisabled();

    const previewCall = vi.mocked(fetch).mock.calls.find(([url]) =>
      String(url).endsWith("/preview"),
    );
    expect(JSON.parse(String(previewCall?.[1]?.body))).toEqual({
      flightIds: [flights[1].id],
      includeDisplayName: false,
    });
  });

  it("selects the filtered set and clears it accessibly", async () => {
    const user = userEvent.setup();
    render(<MapSharingPanel flights={flights} />);
    await screen.findByText("Private · sharing is off");

    await user.selectOptions(screen.getByLabelText("Flight type"), "private");
    expect(screen.getByText("0 of 500 selected · 2 filtered")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Select filtered flights" }));
    expect(screen.getByText("2 of 500 selected · 2 filtered")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /SEA → SFO → HNL/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /PDX → BOI/ })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("0 of 500 selected · 2 filtered")).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview selected flights" })).toBeDisabled();
  });

  it("keeps bulk selection within the backend cap and explains how to narrow it", async () => {
    const oversized = Array.from({ length: 501 }, (_, index) => ({
      ...flights[0],
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      airportCodes: [`A${index}`, `B${index}`],
    }));
    render(<MapSharingPanel flights={oversized} />);

    expect(await screen.findByRole("button", { name: "Select filtered flights" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "exceed the 500-flight sharing limit",
    );
    expect(screen.getByRole("button", { name: "Show 50 more flights" })).toBeVisible();
  });

  it("hydrates only an enabled snapshot and does not include future flights", async () => {
    enabled = true;
    currentSelected = [flights[0].id];
    render(<MapSharingPanel flights={flights} />);

    expect(await screen.findByText(/Current snapshot:/)).toHaveTextContent(
      "Current snapshot: 1 flight · identity hidden. New flights remain private.",
    );
    expect(screen.getByRole("checkbox", { name: /LAX → MEX/ })).toBeChecked();
    expect(screen.getByText(/Los Angeles → Mexico City · Currently shared/)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /SEA → SFO → HNL/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /PDX → BOI/ })).not.toBeChecked();
  });

  it("requires identity opt-in, exact-preview consent, and preserves scope through link rotation", async () => {
    const user = userEvent.setup();
    render(<MapSharingPanel flights={flights} />);
    await screen.findByText("Private · sharing is off");

    await user.click(screen.getByRole("checkbox", { name: /Share LAX → MEX/ }));
    await user.click(screen.getByRole("checkbox", { name: "Include my display name" }));
    await user.click(screen.getByRole("button", { name: "Preview selected flights" }));
    expect(await screen.findByText("Aviator")).toBeVisible();

    const consent = screen.getByRole("checkbox", {
      name: /I reviewed this exact snapshot/,
    });
    expect(consent).not.toBeChecked();
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "Enable sharing" }));
    expect(await screen.findByText("View-only sharing is on")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Replace link" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("snapshotted flight selection will not change");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Share LAX → MEX/ })).toBeChecked();
  });

  it("enables, copies, rotates, and revokes with explicit confirmations", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<MapSharingPanel flights={flights} />);
    await screen.findByText("Private · sharing is off");
    await user.click(screen.getByRole("checkbox", { name: /Share LAX → MEX/ }));
    await user.click(screen.getByRole("button", { name: "Preview selected flights" }));
    await user.click(await screen.findByRole("checkbox", { name: /I reviewed/ }));
    await user.click(screen.getByRole("button", { name: "Enable sharing" }));

    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/shared/"));
    expect(await screen.findByText(/Anyone it is forwarded to can open it/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Replace link" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Replace link" }));
    expect(await screen.findByText(/Link replaced/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Disable sharing" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Disable sharing" }));
    expect(await screen.findByText(/Sharing disabled/)).toBeVisible();
    expect(screen.getByText("Private · sharing is off")).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview selected flights" })).toBeDisabled();
  });

  function status() {
    return {
      enabled,
      sharePath: enabled ? currentPath : null,
      includeDisplayName: currentIdentity,
      selectedFlightCount: currentSelected.length,
      selectedFlightIds: currentSelected,
    };
  }
});

function makePreview(selection: {
  flightIds: string[];
  includeDisplayName: boolean;
}) {
  const selected = flights.filter(({ id }) => selection.flightIds.includes(id));
  const previewFlights = selected.map((flight) => ({
    id: `public-${flight.id}`,
    kind: flight.kind,
    legs:
      flight.id === flights[1].id
        ? [
            {
              index: 0,
              origin: { lat: 47.6, lon: -122.3, country: "US" },
              destination: { lat: 37.6, lon: -122.4, country: "US" },
            },
            {
              index: 1,
              origin: { lat: 37.6, lon: -122.4, country: "US" },
              destination: { lat: 21.3, lon: -157.9, country: "US" },
            },
          ]
        : [{
            index: 0,
            origin: { lat: 34, lon: -118.4, country: "United States" },
            destination: { lat: 24.1, lon: -110.4, country: "Mexico" },
          }],
  }));
  const routes = previewFlights.flatMap((flight) =>
    flight.legs.map((leg, index) => ({
      id: `${flight.id}-${index}`,
      kind: flight.kind,
      flightCount: 1,
      origin: leg.origin,
      destination: leg.destination,
    })),
  );
  return {
    previewId: "a".repeat(64),
    selection: {
      ...selection,
      selectedFlightCount: selection.flightIds.length,
    },
    projection: {
      owner: {
        displayName: selection.includeDisplayName ? "Aviator" : null,
      },
      summary: {
        flightCount: previewFlights.length,
        routeCount: routes.length,
      },
      routes,
      flights: previewFlights,
    },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
