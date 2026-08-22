"use client";

import { useMemo, type RefObject } from "react";
import { airportExactIdentity, type Airport } from "@/lib/flight-data";
import {
  FilterCombobox,
  type FilterComboboxOption,
} from "./filter-combobox";

export function AirportFocusCombobox({
  airports,
  activeAirportCodes,
  value,
  onChange,
  inputRef,
  describedBy,
}: {
  airports: Airport[];
  activeAirportCodes: ReadonlySet<string>;
  value: string;
  onChange: (identity: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  describedBy?: string;
}) {
  const options = useMemo<FilterComboboxOption[]>(
    () =>
      airports
        .toSorted(
          (left, right) =>
            Number(activeAirportCodes.has(airportExactIdentity(right))) -
              Number(activeAirportCodes.has(airportExactIdentity(left))) ||
            left.code.localeCompare(right.code),
        )
        .map((airport) => ({
          value: airportExactIdentity(airport),
          label: `${airport.code} — ${airport.name}, ${airport.city}${
            activeAirportCodes.has(airportExactIdentity(airport))
              ? " · active"
              : ""
          }`,
          searchText: `${airport.code} ${airport.name} ${airport.city} ${airport.country}`,
          available: true,
        })),
    [activeAirportCodes, airports],
  );

  return (
    <FilterCombobox
      label="Airport focus"
      ariaLabel="Focus airport on map"
      searchLabel="airport search"
      allLabel="No airport focus"
      allValue=""
      value={value}
      options={options}
      onChange={onChange}
      inputRef={inputRef}
      describedBy={describedBy}
      className="airport-focus-select"
      sortOptions={false}
    />
  );
}
