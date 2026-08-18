import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { statsFactsFromFlights } from "../flight-insights";
import { aggregateStatsSlice } from "../flight-statistics";
import { InMemoryImportRepository } from "./in-memory-repository";
import { automaticallyCommitImport } from "./service";
import { stageFlightImport } from "./worker";

const airport = (code: string): Airport => ({
  code,
  name: code,
  city: "Test",
  country: "US",
  lat: 40,
  lon: -75,
  facility: "general-aviation",
});

const store = () =>
  new InMemoryImportRepository([
    { id: "a", airport: airport("KAAA"), aliases: ["KAAA", "AAA"] },
    { id: "b", airport: airport("KBBB"), aliases: ["KBBB", "BBB"] },
  ]);

async function importCsv(
  repository: InMemoryImportRepository,
  fileName: string,
  content: string,
) {
  const repositories = {
    imports: repository,
    flights: repository,
    airports: repository,
  };
  const staged = await stageFlightImport(
    "user-a",
    {
      fileName,
      mimeType: "text/csv",
      sizeBytes: Buffer.byteLength(content),
      content,
    },
    repositories,
  );
  await automaticallyCommitImport(
    "user-a",
    staged,
    repository,
    repository,
  );
}

describe("mixed import role statistics", () => {
  it("aggregates ForeFlight personal time and FR24 commercial duration", async () => {
    const repository = store();
    await importCsv(
      repository,
      "foreflight.csv",
      [
        "ForeFlight Logbook Import",
        "",
        "Aircraft Table",
        "AircraftID,TypeCode,Year,Make,Model,GearType,EngineType,equipType (FAA),aircraftClass (FAA)",
        "A,C172,2020,Cessna,172,Fixed,Reciprocating,airplane,Airplane Single Engine Land",
        "Flights Table",
        "Date,AircraftID,From,To,Distance,TimeOut,TotalTime",
        "2026-04-04,A,KAAA,KBBB,100,08:00,1.2",
      ].join("\n"),
    );
    await importCsv(
      repository,
      "fr24.csv",
      [
        "Date,Flight number,From,To,Dep time,Arr time,Duration,Airline,Aircraft,Registration,Seat number,Seat type,Flight class,Flight reason,Note,Dep_id,Arr_id,Airline_id,Aircraft_id",
        "2026-04-05,AB123,Origin (AAA/KAAA),Destination (BBB/KBBB),10:00,12:30,02:30:00,Airline,A320,N123AB,1A,Window,Economy,Leisure,,1,2,AB,3",
      ].join("\n"),
    );

    const slice = aggregateStatsSlice(statsFactsFromFlights(
      await repository.listFlights("user-a"),
    ), {
      preset: "custom",
      startDate: "2026-01-01",
      endDateExclusive: "2027-01-01",
      isPartial: false,
      elapsedDays: 365,
    });

    expect(slice.byRole.pilot.durationHours).toMatchObject({
      value: 1.2,
      knownCount: 1,
      eligibleCount: 1,
    });
    expect(slice.byRole.passenger.durationHours).toMatchObject({
      value: 2.5,
      knownCount: 1,
      eligibleCount: 1,
    });
  });
});
