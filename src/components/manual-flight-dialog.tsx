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
    if (!classification || !date || !origin || !destination) {
      setMessage("Choose Personal or Commercial, a date, and both airports.");
      return;
    }
    if (origin.airportId === destination.airportId) {
      setMessage("Departure and arrival must be different airports.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const optionalText = (name: string) => String(form.get(name) ?? "").trim() || undefined;
    const optionalNumber = (name: string) => {
      const raw = String(form.get(name) ?? "").trim();
      return raw ? Number(raw) : undefined;
    };
    setSaving(true);
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
          durationHours: optionalNumber("durationHours"),
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
        setMessage(
          body.error?.code === "duplicate-flight"
            ? "An equivalent flight already exists. No duplicate was created."
            : body.error?.message ?? "The flight could not be saved.",
        );
        return;
      }
      setMessage("Flight saved. Opening your map…");
      onCreated();
    } catch {
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
        <form className="manual-flight-form" onSubmit={submit}>
          <fieldset className="manual-classification">
            <legend>Flight classification (required)</legend>
            <label><input type="radio" name="classification" value="personal" checked={classification === "personal"} onChange={() => setClassification("personal")} />Personal</label>
            <label><input type="radio" name="classification" value="commercial" checked={classification === "commercial"} onChange={() => setClassification("commercial")} />Commercial</label>
          </fieldset>
          <label>Date (required)<input type="date" value={date} required onChange={(event) => setDate(event.target.value)} /></label>
          <div className="manual-airport-grid">
            <AirportSearchPicker label="Departure airport (required)" selected={origin} onSelect={setOrigin} />
            <AirportSearchPicker label="Arrival airport (required)" selected={destination} onSelect={setDestination} />
          </div>
          {origin && destination && (
            <article className="flight-row manual-flight-preview">
              <div className={`flight-kind ${classification === "commercial" ? "commercial" : "private"}`}><Plane size={17} /></div>
              <div className="flight-primary"><div className="route"><strong>{origin.code}</strong><span className="route-line" /><strong>{destination.code}</strong><small>{origin.name} → {destination.name}</small></div></div>
            </article>
          )}
          <details className="manual-optional-fields">
            <summary>Optional flight details</summary>
            <div className="manual-field-grid">
              <label>Departure time<input name="departureTime" type="time" /></label>
              <label>Duration in hours<input name="durationHours" type="number" min="0" max="10000" step="0.1" inputMode="decimal" /></label>
              <label>Aircraft description<input name="aircraft" maxLength={160} /></label>
              <label>Aircraft type<input name="aircraftType" maxLength={120} /></label>
              <label>Aircraft model<input name="aircraftModel" maxLength={160} /></label>
              <label>Registration / tail number<input name="registration" maxLength={40} /></label>
              <label>Flight number<input name="flightNumber" maxLength={40} /></label>
              <label>Airline / operator<input name="airline" maxLength={160} /></label>
            </div>
          </details>
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={close}>Cancel</button>
            <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save flight"}</button>
          </div>
          <p role={message.includes("could not") || message.includes("exists") || message.includes("Choose") ? "alert" : "status"} aria-live="polite">{message}</p>
        </form>
      </section>
    </div>,
    document.body,
  );
}
