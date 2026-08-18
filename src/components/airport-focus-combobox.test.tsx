// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Airport } from "@/lib/flight-data";
import { AirportFocusCombobox } from "./airport-focus-combobox";

const airports: Airport[] = [
  {
    code: "SEA",
    name: "Seattle-Tacoma International",
    city: "Seattle",
    country: "US",
    lat: 47.45,
    lon: -122.31,
    facility: "commercial",
  },
  {
    code: "JFK",
    name: "John F. Kennedy International",
    city: "New York",
    country: "US",
    lat: 40.64,
    lon: -73.78,
    facility: "commercial",
  },
  {
    code: "BFI",
    name: "Boeing Field",
    city: "Seattle",
    country: "US",
    lat: 47.53,
    lon: -122.3,
    facility: "general-aviation",
  },
];

afterEach(cleanup);

function Harness({ onChange = vi.fn() }: { onChange?: (code: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <AirportFocusCombobox
      airports={airports}
      activeAirportCodes={new Set(["SEA"])}
      value={value}
      onChange={(code) => {
        setValue(code);
        onChange(code);
      }}
      describedBy="airport-focus-status"
    />
  );
}

describe("AirportFocusCombobox", () => {
  it("filters by airport metadata and selects with the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox", {
      name: "Focus airport on map",
    });

    expect(input).toHaveAttribute("aria-describedby", "airport-focus-status");
    await user.click(input);
    await user.clear(input);
    await user.type(input, "tacoma");

    expect(
      screen.getByRole("option", {
        name: "SEA — Seattle-Tacoma International, Seattle · active",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /John F. Kennedy/ }),
    ).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("SEA");
    expect(input).toHaveValue(
      "SEA — Seattle-Tacoma International, Seattle · active",
    );
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("supports arrow navigation and clears the selected focus", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox", {
      name: "Focus airport on map",
    });

    await user.click(input);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("SEA");

    await user.click(
      screen.getByRole("button", { name: "Clear airport focus filter" }),
    );
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(input).toHaveValue("No airport focus");
  });

  it("announces when typed airport search has no results", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("combobox", {
      name: "Focus airport on map",
    });

    await user.click(input);
    await user.clear(input);
    await user.type(input, "not-a-real-airport");

    expect(screen.getByRole("status")).toHaveTextContent(
      "No options match “not-a-real-airport”",
    );
  });
});
