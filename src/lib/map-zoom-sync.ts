import { clampMapZoom } from "./map-camera";

type ZoomCompletionSource = {
  getZoom: () => number;
  on: (event: "zoomend", listener: () => void) => unknown;
  off: (event: "zoomend", listener: () => void) => unknown;
};

export function displayedMapZoom(zoom: number): number {
  return Math.round(clampMapZoom(zoom) * 10) / 10;
}

export function bindCompletedMapZoom(
  map: ZoomCompletionSource,
  onComplete: (zoom: number) => void,
): () => void {
  const publish = () => onComplete(map.getZoom());
  map.on("zoomend", publish);
  return () => {
    map.off("zoomend", publish);
  };
}
