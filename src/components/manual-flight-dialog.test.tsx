// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualFlightDialog } from "./manual-flight-dialog";

const origin = {
  airportId: "00000000-0000-4000-8000-000000000001",
  code: "W01",
  localCode: "W01",
  name: "Tonasket Municipal Airport",
  city: "Tonasket",
  country: "United States",
};
const destination = {
  airportId: "00000000-0000-4000-8000-000000000002",
  code: "OMK",
  icao: "KOMK",
  iata: "OMK",
  name: "Omak Airport",
  city: "Omak",
  country: "United States",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ManualFlightDialog", () => {
  it.each(["Personal", "Commercial"])("creates an explicitly classified %s flight", async (classification) => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/import/airports")) {
        return json({ airports: url.includes("W01") ? [origin] : [destination] });
      }
      if (url === "/api/flights" && init?.method === "POST") {
        return json({ flight: { id: "flight" } }, 201);
      }
      throw new Error(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<><div className="app-shell" /><ManualFlightDialog close={() => {}} onCreated={onCreated} /></>);

    await user.click(screen.getByRole("radio", { name: classification }));
    await user.type(screen.getByLabelText("Date (required)"), "2026-08-10");
    await chooseAirport(user, "Departure airport (required)", "W01", origin.name);
    await chooseAirport(user, "Arrival airport (required)", "OMK", destination.name);
    await user.click(screen.getByRole("button", { name: "Save flight" }));

    expect(onCreated).toHaveBeenCalled();
    const request = fetchMock.mock.calls.find(([input]) => input === "/api/flights");
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      classification: classification.toLowerCase(),
      date: "2026-08-10",
      originAirportId: origin.airportId,
      destinationAirportId: destination.airportId,
    });
  });

  it("shows the duplicate response without navigating or hiding the form", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/import/airports")) {
        return json({ airports: url.includes("W01") ? [origin] : [destination] });
      }
      return json({
        error: { code: "duplicate-flight", message: "An equivalent flight already exists." },
      }, 409);
    }));
    render(<><div className="app-shell" /><ManualFlightDialog close={() => {}} onCreated={onCreated} /></>);

    await user.click(screen.getByRole("radio", { name: "Personal" }));
    await user.type(screen.getByLabelText("Date (required)"), "2026-08-10");
    await chooseAirport(user, "Departure airport (required)", "W01", origin.name);
    await chooseAirport(user, "Arrival airport (required)", "OMK", destination.name);
    await user.click(screen.getByRole("button", { name: "Save flight" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("equivalent flight already exists");
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});

async function chooseAirport(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  query: string,
  resultName: string,
) {
  await user.type(screen.getByRole("combobox", { name: label }), query);
  await user.click(await screen.findByRole("option", { name: new RegExp(resultName) }));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
