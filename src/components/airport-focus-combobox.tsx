"use client";

import { useMemo, type RefObject } from "react";
import type { Airport } from "@/lib/flight-data";
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
  onChange: (code: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  describedBy?: string;
}) {
  const options = useMemo<FilterComboboxOption[]>(
    () =>
      airports
        .toSorted(
          (left, right) =>
            Number(activeAirportCodes.has(right.code)) -
              Number(activeAirportCodes.has(left.code)) ||
            left.code.localeCompare(right.code),
        )
        .map((airport) => ({
          value: airport.code,
          label: `${airport.code} — ${airport.name}, ${airport.city}${
            activeAirportCodes.has(airport.code) ? " · active" : ""
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
