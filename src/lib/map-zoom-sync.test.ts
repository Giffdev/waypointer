import { describe, expect, it, vi } from "vitest";
import { bindCompletedMapZoom, displayedMapZoom } from "./map-zoom-sync";

class FakeMap {
  private zoom = 2.08;
  private listeners = new Map<string, Set<() => void>>();

  getZoom = () => this.zoom;

  on = (event: "zoomend", listener: () => void) => {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  };

  off = (event: "zoomend", listener: () => void) => {
    this.listeners.get(event)?.delete(listener);
  };

  setZoom(zoom: number) {
    this.zoom = zoom;
  }

  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

describe("completed map zoom synchronization", () => {
  it("publishes once after native zoom completion, not during high-frequency frames", () => {
    const map = new FakeMap();
    const onComplete = vi.fn();
    const unbind = bindCompletedMapZoom(map, onComplete);

    for (let index = 0; index < 100; index += 1) map.emit("zoom");
    expect(onComplete).not.toHaveBeenCalled();

    map.setZoom(2.26);
    map.emit("zoomend");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(2.26);

    unbind();
    map.emit("zoomend");
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("rounds the accessible readout to the displayed precision", () => {
    expect(displayedMapZoom(2.26)).toBe(2.3);
    expect(displayedMapZoom(2.12)).toBe(2.1);
  });
});
