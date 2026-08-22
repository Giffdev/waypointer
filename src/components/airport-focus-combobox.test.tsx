// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { airportExactIdentity, type Airport } from "@/lib/flight-data";
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

function Harness({
  onChange = vi.fn(),
  airportOptions = airports,
}: {
  onChange?: (identity: string) => void;
  airportOptions?: Airport[];
}) {
  const [value, setValue] = useState("");
  return (
    <AirportFocusCombobox
      airports={airportOptions}
      activeAirportCodes={new Set([airportExactIdentity(airportOptions[0]!)])}
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
    expect(onChange).toHaveBeenCalledWith(airportExactIdentity(airports[0]!));
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
    expect(onChange).toHaveBeenCalledWith(airportExactIdentity(airports[0]!));

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

  it("selects same-code airports by exact identity", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const duplicate = {
      ...airports[0]!,
      identity: "distinct-sea",
      name: "Distinct SEA Airport",
      lat: airports[0]!.lat + 0.5,
    };
    render(
      <Harness
        onChange={onChange}
        airportOptions={[airports[0]!, duplicate]}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "Focus airport on map",
    });

    await user.click(input);
    await user.clear(input);
    await user.type(input, "Distinct");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(airportExactIdentity(duplicate));

    await user.click(input);
    await user.clear(input);
    await user.type(input, "Tacoma");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(
      airportExactIdentity(airports[0]!),
    );
  });
});
