// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AirportSearchPicker } from "./airport-search-picker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AirportSearchPicker", () => {
  it.each([
    ["W01", "W01", "Tonasket Municipal Airport"],
    ["KOMK", "OMK", "Omak Airport"],
    ["S18", "S18", "Forks Airport"],
    ["UIL", "UIL", "Quillayute Airport"],
    ["Quileute", "UIL", "Quillayute Airport"],
  ])("searches %s and requires explicit official-airport selection", async (query, code, name) => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      json({
        airports: [{
          airportId: "00000000-0000-4000-8000-000000000001",
          code,
          icao: code === "OMK" ? "KOMK" : code === "UIL" ? "KUIL" : undefined,
          localCode: code === "W01" || code === "S18" ? code : undefined,
          name,
          city: "Washington",
          country: "United States",
        }],
      }),
    ));
    render(<AirportSearchPicker label="Departure airport" onSelect={onSelect} />);

    await user.type(screen.getByRole("combobox", { name: "Departure airport" }), query);
    const option = await screen.findByRole("option", { name: new RegExp(name) });
    expect(option).toHaveTextContent("Codes:");
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(option);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ code, name }));
  });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
