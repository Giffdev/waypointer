// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedMapPreview } from "./shared-map-preview";
import {
  MAP_SHARE_PREVIEW_STORAGE_KEY,
  mapSharePreviewFragment,
  storeMapSharePreview,
} from "@/lib/sharing/client-preview";

vi.mock("@/components/globe-panel", () => ({
  default: ({ routes }: { routes: unknown[] }) => (
    <div data-testid="shared-globe">{routes.length} routes</div>
  ),
}));

const previewNonce = "b".repeat(32);

describe("SharedMapPreview", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/shared/preview");
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
  });

  it("keeps the validated tab-local projection after first mount", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    storeMapSharePreview(
      window.sessionStorage,
      previewNonce,
      projection(),
    );
    window.history.replaceState(
      {},
      "",
      `/shared/preview${mapSharePreviewFragment(previewNonce)}`,
    );

    render(<SharedMapPreview />);

    expect(
      await screen.findByRole("heading", {
        name: "Shared Waypointer map preview",
      }),
    ).toBeVisible();
    expect(
      screen.getByText("Private sharing preview · not published"),
    ).toBeVisible();
    expect(
      screen.getByText(/remains private until you return to Settings/),
    ).toBeVisible();
    expect(screen.getByTestId("shared-globe")).toHaveTextContent("1 routes");
    expect(
      window.sessionStorage.getItem(MAP_SHARE_PREVIEW_STORAGE_KEY),
    ).not.toBeNull();
    expect(window.location.hash).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the same projection after unmount and remount", async () => {
    storeMapSharePreview(
      window.sessionStorage,
      previewNonce,
      projection(),
    );
    window.history.replaceState(
      {},
      "",
      `/shared/preview${mapSharePreviewFragment(previewNonce)}`,
    );

    const firstRender = render(<SharedMapPreview />);
    expect(
      await screen.findByText(
        "Approximate aggregated routes · 3 flights · 1 routes",
      ),
    ).toBeVisible();
    firstRender.unmount();

    render(<SharedMapPreview />);

    expect(
      await screen.findByText(
        "Approximate aggregated routes · 3 flights · 1 routes",
      ),
    ).toBeVisible();
    expect(screen.getByTestId("shared-globe")).toHaveTextContent("1 routes");
  });

  it("rejects a fragment for a different preview tab", async () => {
    storeMapSharePreview(
      window.sessionStorage,
      previewNonce,
      projection(),
    );
    window.history.replaceState(
      {},
      "",
      `/shared/preview${mapSharePreviewFragment("c".repeat(32))}`,
    );

    render(<SharedMapPreview />);

    expect(
      await screen.findByRole("heading", {
        name: "Map preview unavailable",
      }),
    ).toBeVisible();
    expect(
      window.sessionStorage.getItem(MAP_SHARE_PREVIEW_STORAGE_KEY),
    ).not.toBeNull();
  });

  it("shows explicit recovery when the tab-local preview is missing", async () => {
    render(<SharedMapPreview />);

    expect(
      await screen.findByRole("heading", {
        name: "Map preview unavailable",
      }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "choose Preview shared map again",
    );
  });
});

function projection() {
  return {
    owner: { displayName: null },
    summary: { flightCount: 3, routeCount: 1 },
    routes: [
      {
        id: "coarse-route",
        kind: "commercial",
        flightCount: 3,
        origin: { lat: 34, lon: -118.4, country: "US" },
        destination: { lat: 24.1, lon: -110.4, country: "MX" },
      },
    ],
  };
}
