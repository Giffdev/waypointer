"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AirportSearchResult } from "@/lib/import/types";

export function AirportSearchPicker({
  label,
  selected,
  disabled = false,
  required = false,
  invalid = false,
  describedBy,
  onSelect,
}: {
  label: string;
  selected?: AirportSearchResult | null;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onSelect: (airport: AirportSearchResult) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AirportSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void fetch(
        `/api/import/airports?query=${encodeURIComponent(normalized)}&limit=8`,
        { signal: controller.signal },
      )
        .then(async (response) => {
          if (!response.ok) throw new Error();
          const body = await response.json();
          setResults(body.airports);
          setSearched(true);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setResults([]);
          setSearched(true);
        })
        .finally(() => setLoading(false));
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const open = query.trim().length >= 2 && (loading || searched);
  return (
    <div className="airport-search-picker">
      <label htmlFor={`${id}-input`}>{label}</label>
      <input
        id={`${id}-input`}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-results`}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        aria-required={required}
        value={query}
        disabled={disabled}
        placeholder="Search code, city, airport name, or spelling"
        onChange={(event) => {
          setQuery(event.target.value);
          setResults([]);
          setSearched(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && results.length) {
            event.preventDefault();
            optionRefs.current[0]?.focus();
          }
        }}
      />
      {selected && (
        <small className="airport-search-selected">
          Selected: {airportResultLabel(selected)}
        </small>
      )}
      {open && (
        <div className="airport-search-results" id={`${id}-results`} role="listbox" aria-label={`${label} results`}>
          {loading ? (
            <p role="status">Searching airports…</p>
          ) : results.length ? (
            results.map((airport, index) => (
              <button
                key={airport.airportId}
                ref={(element) => { optionRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={selected?.airportId === airport.airportId}
                onClick={() => {
                  onSelect(airport);
                  setQuery("");
                  setResults([]);
                  setSearched(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    optionRefs.current[(index + 1) % results.length]?.focus();
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    optionRefs.current[(index - 1 + results.length) % results.length]?.focus();
                  }
                }}
              >
                <strong>{airport.code} — {airport.name}</strong>
                <span>{[airport.city, airport.country].filter(Boolean).join(", ")}</span>
                <small>Codes: {airportCodes(airport).join(" · ")}</small>
              </button>
            ))
          ) : (
            <p role="status">No matching airports. Try another official or local code, city, or spelling.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function airportResultLabel(airport: AirportSearchResult): string {
  return `${airport.code} — ${airport.name}${airport.city ? `, ${airport.city}` : ""}`;
}

function airportCodes(airport: AirportSearchResult): string[] {
  return [...new Set(
    [airport.code, airport.iata, airport.icao, airport.localCode]
      .filter((code): code is string => Boolean(code))
      .map((code) => code.toUpperCase()),
  )];
}
