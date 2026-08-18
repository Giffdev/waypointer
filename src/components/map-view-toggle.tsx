"use client";

import type { KeyboardEvent } from "react";
import type { MapViewMode } from "@/lib/map-view-mode";

export function MapViewToggle({
  value,
  onChange,
  labelledBy,
}: {
  value: MapViewMode;
  onChange: (mode: MapViewMode) => void;
  labelledBy?: string;
}) {
  const select = (mode: MapViewMode) => {
    if (mode !== value) onChange(mode);
  };
  const handleKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    select(event.key === "ArrowLeft" || event.key === "Home" ? "globe" : "flat");
  };

  return (
    <div
      className="map-view-toggle"
      role="group"
      aria-label={labelledBy ? undefined : "Map view"}
      aria-labelledby={labelledBy}
      onKeyDown={handleKeys}
    >
      <button
        type="button"
        aria-pressed={value === "globe"}
        onClick={() => select("globe")}
      >
        3D globe
      </button>
      <button
        type="button"
        aria-pressed={value === "flat"}
        onClick={() => select("flat")}
      >
        Flat map
      </button>
    </div>
  );
}
