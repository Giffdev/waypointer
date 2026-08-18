"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import type { SanitizedHistoryFlight } from "@/lib/route-contracts";
import { formatFlightDate } from "./dashboard-shared";

type FlightEndpoints = Pick<SanitizedHistoryFlight, "origin" | "destination">;

type FlightEntryDialogProps = {
  mode: "edit" | "delete";
  flight: SanitizedHistoryFlight;
  close: () => void;
  save: (endpoints: FlightEndpoints) => void;
  remove: () => void;
};

export function FlightEntryDialog({
  mode,
  flight,
  close,
  save,
  remove,
}: FlightEntryDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [origin, setOrigin] = useState(flight.origin);
  const [destination, setDestination] = useState(flight.destination);

  useEffect(() => {
    const appRoot = document.querySelector<HTMLElement>(".app-shell");
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    appRoot?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === first || !dialogRef.current.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialogRef.current.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      appRoot?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [close]);

  const normalizeAirport = (airport: SanitizedHistoryFlight["origin"]) => ({
    code: airport.code.trim().toUpperCase(),
    name: airport.name.trim(),
    city: airport.city.trim(),
  });
  const normalizedOrigin = normalizeAirport(origin);
  const normalizedDestination = normalizeAirport(destination);
  const airportIsValid = (airport: SanitizedHistoryFlight["origin"]) =>
    /^[A-Z0-9]{3,4}$/.test(airport.code) &&
    airport.name.length > 0 &&
    airport.city.length > 0;
  const changed =
    JSON.stringify({ origin: normalizedOrigin, destination: normalizedDestination }) !==
    JSON.stringify({ origin: flight.origin, destination: flight.destination });
  const canSave =
    changed &&
    airportIsValid(normalizedOrigin) &&
    airportIsValid(normalizedDestination);

  const submitEdit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    save({ origin: normalizedOrigin, destination: normalizedDestination });
  };

  const titleId = `flight-${mode}-title`;
  const descriptionId = `flight-${mode}-description`;

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <section
        className="modal flight-entry-modal"
        role={mode === "delete" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
      >
        <button
          className="modal-close"
          type="button"
          onClick={close}
          aria-label="Close"
          ref={closeButtonRef}
        >
          <X size={20} />
        </button>
        <div className={`icon-tile ${mode === "delete" ? "danger" : ""}`}>
          {mode === "edit" ? <Pencil size={21} /> : <Trash2 size={21} />}
        </div>
        <p className="eyebrow">
          {mode === "edit" ? "Edit flight" : "Remove flight"}
        </p>
        <h2 id={titleId}>
          {mode === "edit" ? "Correct departure or arrival" : "Delete this flight?"}
        </h2>
        <p id={descriptionId}>
          {mode === "edit"
            ? "Fix an airport that was imported incorrectly. Changes apply only to this view and reset when the page reloads."
            : "This removes the entry only from the current view. Reloading restores the imported flight."}
        </p>
        <dl className="flight-entry-summary">
          <div>
            <dt>Flight</dt>
            <dd>
              {flight.origin.code} → {flight.destination.code} ·{" "}
              {formatFlightDate(flight.date)}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{flight.source}</dd>
          </div>
        </dl>
        {mode === "edit" ? (
          <form className="flight-edit-form" onSubmit={submitEdit}>
            <fieldset>
              <legend>Departure / origin</legend>
              <div className="airport-edit-grid">
                <label>
                  <span>Airport code</span>
                  <input
                    aria-label="Departure airport code"
                    value={origin.code}
                    maxLength={4}
                    autoCapitalize="characters"
                    onChange={(event) =>
                      setOrigin({ ...origin, code: event.target.value.toUpperCase() })
                    }
                  />
                </label>
                <label>
                  <span>City</span>
                  <input
                    aria-label="Departure city"
                    value={origin.city}
                    onChange={(event) =>
                      setOrigin({ ...origin, city: event.target.value })
                    }
                  />
                </label>
              </div>
              <label>
                <span>Airport name</span>
                <input
                  aria-label="Departure airport name"
                  value={origin.name}
                  onChange={(event) =>
                    setOrigin({ ...origin, name: event.target.value })
                  }
                />
              </label>
            </fieldset>
            <fieldset>
              <legend>Arrival / destination</legend>
              <div className="airport-edit-grid">
                <label>
                  <span>Airport code</span>
                  <input
                    aria-label="Arrival airport code"
                    value={destination.code}
                    maxLength={4}
                    autoCapitalize="characters"
                    onChange={(event) =>
                      setDestination({
                        ...destination,
                        code: event.target.value.toUpperCase(),
                      })
                    }
                  />
                </label>
                <label>
                  <span>City</span>
                  <input
                    aria-label="Arrival city"
                    value={destination.city}
                    onChange={(event) =>
                      setDestination({
                        ...destination,
                        city: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <label>
                <span>Airport name</span>
                <input
                  aria-label="Arrival airport name"
                  value={destination.name}
                  onChange={(event) =>
                    setDestination({
                      ...destination,
                      name: event.target.value,
                    })
                  }
                />
              </label>
            </fieldset>
            <p className="field-help">
              Airport codes must contain 3–4 letters or numbers. All fields are
              required.
            </p>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={close}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={!canSave}>
                <Check size={17} />
                Save changes
              </button>
            </div>
          </form>
        ) : (
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={close}>
              Cancel
            </button>
            <button className="danger-button" type="button" onClick={remove}>
              <Trash2 size={17} />
              Delete flight
            </button>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
