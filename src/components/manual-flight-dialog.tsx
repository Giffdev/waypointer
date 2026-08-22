"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plane, X } from "lucide-react";
import { AirportSearchPicker } from "./airport-search-picker";
import type { AirportSearchResult } from "@/lib/import/types";
import type { FlightClassification } from "@/lib/flight-role";

export function ManualFlightDialog({
  close,
  onCreated,
}: {
  close: () => void;
  onCreated: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [classification, setClassification] = useState<FlightClassification | "">("");
  const [date, setDate] = useState("");
  const [origin, setOrigin] = useState<AirportSearchResult | null>(null);
  const [destination, setDestination] = useState<AirportSearchResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [durationInvalid, setDurationInvalid] = useState(false);
  const [validationAttempted, setValidationAttempted] = useState(false);

  const sameAirport = Boolean(
    origin && destination && origin.airportId === destination.airportId,
  );
  const classificationInvalid = validationAttempted && !classification;
  const dateInvalid = validationAttempted && !date;
  const originInvalid = validationAttempted && (!origin || sameAirport);
  const destinationInvalid =
    validationAttempted && (!destination || sameAirport);
  const validationMessage = validationAttempted
    ? !classification || !date || !origin || !destination
      ? "Choose Personal or Commercial, a date, and both airports."
      : sameAirport
        ? "Departure and arrival must be different airports."
        : ""
    : "";
  const displayedMessage = validationMessage || message;
  const messageIsError =
    Boolean(validationMessage) || messageError;

  function clearMessage(force = false) {
    if (durationInvalid && !force) return;
    setMessage("");
    setMessageError(false);
  }

  function editOptionalField(event: FormEvent<HTMLDivElement>) {
    const editedDuration =
      (event.target as HTMLInputElement).name === "durationHours";
    if (editedDuration) {
      setDurationInvalid(false);
      clearMessage(true);
      return;
    }
    clearMessage();
  }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const appRoot = document.querySelector<HTMLElement>(".app-shell");
    appRoot?.setAttribute("inert", "");
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      appRoot?.removeAttribute("inert");
      previous?.focus();
    };
  }, [close]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationAttempted(true);
    if (!classification || !date || !origin || !destination) {
      return;
    }
    if (origin.airportId === destination.airportId) {
      return;
    }
    setValidationAttempted(false);
    const form = new FormData(event.currentTarget);
    const optionalText = (name: string) => String(form.get(name) ?? "").trim() || undefined;
    const optionalNumber = (name: string) => {
      const raw = String(form.get(name) ?? "").trim();
      return raw ? Number(raw) : undefined;
    };
    const durationHours = optionalNumber("durationHours");
    if (
      durationHours !== undefined &&
      (
        !Number.isFinite(durationHours) ||
        durationHours < 0 ||
        durationHours > 10_000 ||
        Math.abs(durationHours * 10 - Math.round(durationHours * 10)) > 1e-9
      )
    ) {
      setDurationInvalid(true);
      setMessageError(true);
      setMessage(
        "Duration in hours must be between 0 and 10,000 in 0.1-hour increments.",
      );
      return;
    }
    setDurationInvalid(false);
    setSaving(true);
    setMessageError(false);
    setMessage("Saving flight…");
    try {
      const response = await fetch("/api/flights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classification,
          date,
          originAirportId: origin.airportId,
          destinationAirportId: destination.airportId,
          departureTime: optionalText("departureTime"),
          durationHours,
          aircraft: optionalText("aircraft"),
          aircraftType: optionalText("aircraftType"),
          aircraftModel: optionalText("aircraftModel"),
          registration: optionalText("registration"),
          flightNumber: optionalText("flightNumber"),
          airline: optionalText("airline"),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessageError(true);
        setMessage(
          body.error?.code === "duplicate-flight"
            ? "An equivalent flight already exists. No duplicate was created."
            : body.error?.message ?? "The flight could not be saved.",
        );
        return;
      }
      setMessageError(false);
      setMessage("Flight saved. Opening your map…");
      onCreated();
    } catch {
      setMessageError(true);
      setMessage("The flight could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <section
        className="modal manual-flight-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-flight-title"
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" type="button" onClick={close} aria-label="Close manual flight form" ref={closeRef}>
          <X size={20} />
        </button>
        <div className="icon-tile"><Plane size={21} /></div>
        <p className="eyebrow">Manual log</p>
        <h2 id="manual-flight-title">Add one flight</h2>
        <p>Choose the flight classification explicitly. Optional details can be left blank when they are not known.</p>
        <form className="manual-flight-form" onSubmit={submit} noValidate>
          <fieldset
            className="manual-classification manual-form-section"
            data-invalid={classificationInvalid}
            aria-describedby={
              classificationInvalid ? "manual-flight-error" : undefined
            }
          >
            <legend>Flight classification (required)</legend>
            <p className="manual-section-hint">
              Choose how you experienced this flight.
            </p>
            <div className="manual-classification-options">
              <label><input type="radio" name="classification" value="personal" checked={classification === "personal"} disabled={saving} onChange={() => { setClassification("personal"); clearMessage(); }} />Personal</label>
              <label><input type="radio" name="classification" value="commercial" checked={classification === "commercial"} disabled={saving} onChange={() => { setClassification("commercial"); clearMessage(); }} />Commercial</label>
            </div>
          </fieldset>
          <fieldset className="manual-required-fields manual-form-section">
            <legend>Route and date</legend>
            <p className="manual-section-hint">
              All fields in this section are required.
            </p>
            <label>
              Date (required)
              <input
                type="date"
                value={date}
                required
                disabled={saving}
                aria-invalid={dateInvalid}
                aria-describedby={
                  dateInvalid ? "manual-flight-error" : undefined
                }
                onChange={(event) => {
                  setDate(event.target.value);
                  clearMessage();
                }}
              />
            </label>
            <div className="manual-airport-grid">
              <AirportSearchPicker
                label="Departure airport (required)"
                selected={origin}
                disabled={saving}
                required
                invalid={originInvalid}
                describedBy={
                  originInvalid ? "manual-flight-error" : undefined
                }
                onSelect={(airport) => {
                  setOrigin(airport);
                  clearMessage();
                }}
              />
              <AirportSearchPicker
                label="Arrival airport (required)"
                selected={destination}
                disabled={saving}
                required
                invalid={destinationInvalid}
                describedBy={
                  destinationInvalid ? "manual-flight-error" : undefined
                }
                onSelect={(airport) => {
                  setDestination(airport);
                  clearMessage();
                }}
              />
            </div>
          </fieldset>
          {origin && destination && (
            <article className="flight-row manual-flight-preview">
              <div className={`flight-kind ${classification === "commercial" ? "commercial" : "private"}`}><Plane size={17} /></div>
              <div className="flight-primary"><div className="route"><strong>{origin.code}</strong><span className="route-line" /><strong>{destination.code}</strong><small>{origin.name} → {destination.name}</small></div></div>
            </article>
          )}
          <details className="manual-optional-fields">
            <summary>Optional flight details</summary>
            <p className="manual-section-hint">
              Add any details you know. These fields can be left blank.
            </p>
            <div className="manual-field-grid" onInput={editOptionalField}>
              <label>Departure time (optional)<input name="departureTime" type="time" disabled={saving} /></label>
              <label>
                Duration in hours (optional)
                <input
                  name="durationHours"
                  type="number"
                  min="0"
                  max="10000"
                  step="0.1"
                  inputMode="decimal"
                  disabled={saving}
                  aria-invalid={durationInvalid}
                  aria-describedby={
                    durationInvalid ? "manual-flight-error" : undefined
                  }
                />
              </label>
              <label>Aircraft description (optional)<input name="aircraft" maxLength={160} disabled={saving} /></label>
              <label>Aircraft type (optional)<input name="aircraftType" maxLength={120} disabled={saving} /></label>
              <label>Aircraft model (optional)<input name="aircraftModel" maxLength={160} disabled={saving} /></label>
              <label>Tail number / registration (optional)<input name="registration" maxLength={40} disabled={saving} /></label>
              <label>Flight number (optional)<input name="flightNumber" maxLength={40} disabled={saving} /></label>
              <label>Airline / operator (optional)<input name="airline" maxLength={160} disabled={saving} /></label>
            </div>
          </details>
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={close}>Cancel</button>
            <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save flight"}</button>
          </div>
          <div className="manual-flight-messages">
            <p
              id="manual-flight-error"
              className="manual-flight-message error"
              role="alert"
              aria-live="assertive"
            >
              {messageIsError ? displayedMessage : ""}
            </p>
            <p
              id="manual-flight-status"
              className="manual-flight-message status"
              role="status"
              aria-live="polite"
            >
              {messageIsError ? "" : displayedMessage}
            </p>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
