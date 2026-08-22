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
  it("keeps persistent labels and exposes accessible required-field errors", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <>
        <div className="app-shell" />
        <ManualFlightDialog close={() => {}} onCreated={vi.fn()} />
      </>,
    );

    expect(
      screen.getByRole("group", { name: "Flight classification (required)" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Date (required)")).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Departure airport (required)" }),
    ).toHaveAttribute("aria-required", "true");
    expect(
      screen.getByRole("combobox", { name: "Arrival airport (required)" }),
    ).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText("Flight number (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Aircraft type (optional)")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Tail number / registration (optional)"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save flight" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose Personal or Commercial, a date, and both airports.",
    );
    expect(
      screen.getByRole("group", { name: "Flight classification (required)" }),
    ).toHaveAttribute("data-invalid", "true");
    expect(screen.getByLabelText("Date (required)")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      screen.getByRole("combobox", { name: "Departure airport (required)" }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByRole("combobox", { name: "Arrival airport (required)" }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("announces and marks a same-airport route instead of submitting it", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => json({ airports: [origin] }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <>
        <div className="app-shell" />
        <ManualFlightDialog close={() => {}} onCreated={vi.fn()} />
      </>,
    );

    await user.click(screen.getByRole("radio", { name: "Personal" }));
    await user.type(screen.getByLabelText("Date (required)"), "2026-08-10");
    await chooseAirport(user, "Departure airport (required)", "W01", origin.name);
    await chooseAirport(user, "Arrival airport (required)", "W01", origin.name);
    await user.click(screen.getByRole("button", { name: "Save flight" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Departure and arrival must be different airports.",
    );
    expect(
      screen.getByRole("combobox", { name: "Departure airport (required)" }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByRole("combobox", { name: "Arrival airport (required)" }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/flights",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("enforces duration constraints without hiding the error during other edits", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const fetchMock = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/api/import/airports")) {
        return json({ airports: url.includes("W01") ? [origin] : [destination] });
      }
      if (url === "/api/flights" && init?.method === "POST") {
        return json({ flight: { id: "flight" } }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <>
        <div className="app-shell" />
        <ManualFlightDialog close={() => {}} onCreated={onCreated} />
      </>,
    );

    await user.click(screen.getByRole("radio", { name: "Personal" }));
    await user.type(screen.getByLabelText("Date (required)"), "2026-08-10");
    await chooseAirport(user, "Departure airport (required)", "W01", origin.name);
    await chooseAirport(user, "Arrival airport (required)", "OMK", destination.name);
    await user.click(screen.getByText("Optional flight details"));
    const duration = screen.getByLabelText("Duration in hours (optional)");
    const date = screen.getByLabelText("Date (required)");
    const postRequests = () =>
      fetchMock.mock.calls.filter(([input]) => input === "/api/flights");
    await user.type(duration, "20000");
    await user.click(screen.getByRole("button", { name: "Save flight" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Duration in hours must be between 0 and 10,000 in 0.1-hour increments.",
    );
    expect(duration).toHaveAttribute("aria-invalid", "true");
    expect(postRequests()).toHaveLength(0);

    await user.clear(date);
    await user.type(date, "2026-08-11");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Duration in hours must be between 0 and 10,000 in 0.1-hour increments.",
    );
    expect(duration).toHaveAttribute("aria-invalid", "true");

    for (const invalidDuration of ["-1", "0.15"]) {
      await user.clear(duration);
      await user.type(duration, invalidDuration);
      await user.click(screen.getByRole("button", { name: "Save flight" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Duration in hours must be between 0 and 10,000 in 0.1-hour increments.",
      );
      expect(duration).toHaveAttribute("aria-invalid", "true");
      expect(postRequests()).toHaveLength(0);
    }

    await user.clear(duration);
    await user.type(duration, "1.5");
    await user.click(screen.getByRole("button", { name: "Save flight" }));

    expect(onCreated).toHaveBeenCalled();
    expect(postRequests()).toHaveLength(1);
    expect(JSON.parse(String(postRequests()[0]?.[1]?.body))).toMatchObject({
      durationHours: 1.5,
    });
  });

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

  it("announces an arbitrary API failure as an error", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/import/airports")) {
        return json({ airports: url.includes("W01") ? [origin] : [destination] });
      }
      return json({
        error: { code: "access-revoked", message: "Permission was revoked." },
      }, 403);
    }));
    render(
      <>
        <div className="app-shell" />
        <ManualFlightDialog close={() => {}} onCreated={vi.fn()} />
      </>,
    );

    await user.click(screen.getByRole("radio", { name: "Personal" }));
    await user.type(screen.getByLabelText("Date (required)"), "2026-08-10");
    await chooseAirport(user, "Departure airport (required)", "W01", origin.name);
    await chooseAirport(user, "Arrival airport (required)", "OMK", destination.name);
    await user.click(screen.getByRole("button", { name: "Save flight" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Permission was revoked.",
    );
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
