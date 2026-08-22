// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { airports } from "@/lib/flight-data";
import { MapLegend } from "./map-legend";

afterEach(cleanup);

const commercialRoute = {
  id: "commercial",
  origin: airports.SEA,
  destination: airports.HNL,
  kind: "commercial" as const,
  flightCount: 4,
  forwardFlightCount: 2,
  reverseFlightCount: 2,
};
const privateRoute = {
  id: "private",
  origin: airports.PAE,
  destination: airports.SEA,
  kind: "private" as const,
  flightCount: 1,
};

describe("MapLegend", () => {
  it("does not render an empty legend container", () => {
    const { container } = render(
      <MapLegend airports={[]} routes={[]} selectedRouteId="" />,
    );

    expect(container.querySelector(".map-legend")).toBeNull();
    expect(screen.queryByText("Map legend")).toBeNull();
  });

  it("shows only map encodings active in the current slice", () => {
    render(
      <MapLegend
        airports={[airports.SEA, airports.HNL, airports.PAE, airports.SYD]}
        routes={[commercialRoute, privateRoute]}
        selectedRouteId="commercial"
      />,
    );

    expect(screen.getByText("Commercial route")).toBeTruthy();
    expect(screen.getByText("Personal route")).toBeTruthy();
    expect(screen.getByText("More flights")).toBeTruthy();
    expect(screen.getByText("Selected route")).toBeTruthy();
    expect(screen.getByText("One-way route")).toBeTruthy();
    expect(screen.getByText("Reciprocal route")).toBeTruthy();
    expect(screen.getByText("Flown airport")).toBeTruthy();
    expect(screen.getByText("Context airport")).toBeTruthy();
  });

  it("updates entries when the filtered route mode changes", () => {
    const { rerender } = render(
      <MapLegend
        airports={[airports.SEA, airports.HNL, airports.PAE]}
        routes={[commercialRoute, privateRoute]}
        selectedRouteId="commercial"
      />,
    );

    rerender(
      <MapLegend
        airports={[airports.PAE, airports.SEA]}
        routes={[privateRoute]}
        selectedRouteId=""
      />,
    );

    expect(screen.queryByText("Commercial route")).toBeNull();
    expect(screen.queryByText("More flights")).toBeNull();
    expect(screen.queryByText("Selected route")).toBeNull();
    expect(screen.queryByText("Context airport")).toBeNull();
    expect(screen.getByText("Personal route")).toBeTruthy();
    expect(screen.getByText("One-way route")).toBeTruthy();
    expect(screen.queryByText("Reciprocal route")).toBeNull();
    expect(screen.getByText("Flown airport")).toBeTruthy();
  });

  it("does not invent direction for a selected route without evidence", () => {
    render(
      <MapLegend
        airports={[airports.PAE, airports.SEA]}
        routes={[{
          ...privateRoute,
          forwardFlightCount: 0,
          reverseFlightCount: 0,
        }]}
        selectedRouteId="private"
      />,
    );

    expect(screen.getByText("Selected route")).toBeTruthy();
    expect(screen.queryByText("One-way route")).toBeNull();
    expect(screen.queryByText("Reciprocal route")).toBeNull();
  });
});
