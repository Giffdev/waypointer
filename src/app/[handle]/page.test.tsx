import { describe, expect, it } from "vitest";
import { SharedMapView } from "@/components/shared-map-view";
import PublicHandleMapPage, { metadata } from "./page";

describe("public handle map page", () => {
  it("publishes approved public-page metadata", () => {
    expect(metadata).toEqual({
      title: "Public Waypointer map",
    });
  });

  it("renders the public map for the username route", async () => {
    const page = await PublicHandleMapPage({
      params: Promise.resolve({ handle: "readable-pilot" }),
    });

    expect(page.type).toBe(SharedMapView);
    expect(page.props).toEqual({ handle: "readable-pilot" });
  });
});
