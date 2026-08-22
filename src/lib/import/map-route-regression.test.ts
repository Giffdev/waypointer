import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { ALL_FLIGHT_FILTERS } from "../flight-filters";
import { createRouteFeatureCollection } from "../map-geojson";
import { buildPersistedFlightData } from "../persisted-flight-data";
import { buildMapPageContract } from "../route-page-data";
import { InMemoryImportRepository } from "./in-memory-repository";
import {
  automaticallyCommitImport,
  getUserImportBatch,
} from "./service";
import { stageFlightImport } from "./worker";

const airport = (
  code: string,
  name: string,
  city: string,
  lat: number,
  lon: number,
): Airport => ({
  code,
  name,
  city,
  country: code === "KCMD" ? "US" : "AU",
  lat,
  lon,
  facility: "commercial",
});

function foreFlight(rows: string[]) {
  return [
    "ForeFlight Logbook Import",
    "",
    "Aircraft Table",
    "AircraftID,TypeCode,Year,Make,Model,GearType,EngineType,equipType (FAA),aircraftClass (FAA)",
    "SYNTH-A,B738,2020,Example,737-800,Fixed,Jet,airplane,Airplane Multi Engine Land",
    "Flights Table",
    "Date,AircraftID,From,To,Distance,TimeOut,TotalTime",
    ...rows,
    "",
  ].join("\n");
}

describe("imported Australian map routes", () => {
  it("aggregates MEL-SYD directions while retaining ambiguous CMD for review", async () => {
    const store = new InMemoryImportRepository([
      {
        id: "airport-kcmd",
        airport: airport(
          "KCMD",
          "Cullman Regional Airport-Folsom Field",
          "Cullman",
          34.2687,
          -86.858,
        ),
        aliases: ["KCMD", "CMD"],
      },
      {
        id: "airport-yctm",
        airport: airport(
          "YCTM",
          "Cootamundra Airport",
          "Cootamundra",
          -34.624283,
          148.036641,
        ),
        aliases: ["YCTM", "CMD"],
      },
      {
        id: "airport-mel",
        airport: airport(
          "MEL",
          "Melbourne Airport",
          "Melbourne",
          -37.670732,
          144.837898,
        ),
        aliases: ["MEL", "YMML"],
      },
      {
        id: "airport-syd",
        airport: airport(
          "SYD",
          "Sydney Kingsford Smith International Airport",
          "Sydney",
          -33.946098,
          151.177002,
        ),
        aliases: ["SYD", "YSSY"],
      },
    ]);
    const content = foreFlight([
      "2026-01-01,SYNTH-A,CMD,MEL,100,08:00,1.0",
      "2026-01-02,SYNTH-A,MEL,SYD,385,09:00,1.4",
      "2026-01-03,SYNTH-A,MEL,SYD,385,10:00,1.4",
      "2026-01-04,SYNTH-A,SYD,MEL,385,11:00,1.4",
    ]);
    const staged = await stageFlightImport(
      "owner",
      {
        fileName: "synthetic-australia.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(content),
        content,
      },
      { imports: store, flights: store, airports: store },
    );
    const completed = await automaticallyCommitImport(
      "owner",
      staged,
      store,
      store,
    );

    expect(completed).toMatchObject({
      status: "review",
      completion: {
        importedRows: 3,
        reviewRequiredRows: 1,
      },
    });
    const review = await getUserImportBatch(
      "owner",
      completed.batchId,
      1,
      25,
      store,
    );
    expect(review?.rows.rows).toEqual([
      expect.objectContaining({
        rowNumber: 8,
        proposedFlight: expect.objectContaining({
          origin: expect.objectContaining({
            status: "ambiguous",
            identifier: "CMD",
          }),
        }),
      }),
    ]);

    const flights = await store.listFlights("owner");
    const map = buildMapPageContract(
      ALL_FLIGHT_FILTERS,
      buildPersistedFlightData(flights),
      null,
    );
    expect(map.filteredFlightCount).toBe(3);
    expect(map.routes).toHaveLength(1);
    expect(map.routes[0].flightCount).toBe(3);
    expect(
      [map.routes[0].origin.code, map.routes[0].destination.code].sort(),
    ).toEqual(["MEL", "SYD"]);
    expect(
      [
        map.routes[0].forwardFlightCount,
        map.routes[0].reverseFlightCount,
      ].sort(),
    ).toEqual([1, 2]);

    const geojson = createRouteFeatureCollection(map.routes);
    expect(geojson.features[0]).toMatchObject({
      properties: {
        flightCount: 3,
        kind: "private",
        bidirectional: true,
        directionMode: "reciprocal",
        directionCue: "↔",
        laneOffset: 0,
      },
      geometry: { type: "MultiLineString" },
    });
  });
});
