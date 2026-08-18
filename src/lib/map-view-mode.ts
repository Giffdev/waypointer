export const MAP_VIEW_MODES = ["globe", "flat"] as const;
export type MapViewMode = (typeof MAP_VIEW_MODES)[number];
export const DEFAULT_MAP_VIEW_MODE: MapViewMode = "globe";

export function isMapViewMode(value: unknown): value is MapViewMode {
  return MAP_VIEW_MODES.includes(value as MapViewMode);
}
