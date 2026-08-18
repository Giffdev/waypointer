import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createAirportResolver,
  parseOurAirportsCsv,
  type AirportReference,
} from "./airport-resolution";
import { CsvSyntaxError, parseCsv } from "./csv";
import {
  ForeFlightImportError,
  parseForeFlightCsv,
  registrationFromForeFlightAircraftId,
} from "./foreflight";
import {
  ALL_FLIGHT_FILTERS,
  filterIndexedFlights,
  getFilterOptions,
  indexFlights,
} from "../flight-filters";
import { buildLocalMapArtifact } from "./map-artifact";

const fixture = readFileSync(
  fileURLToPath(new URL("./__fixtures__/foreflight-v1.csv", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const airport = (
  ident: string,
  aliases: Partial<Pick<AirportReference, "gpsCode" | "iataCode" | "localCode">> = {},
): AirportReference => ({
  ident,
  type: "small_airport",
  name: `Synthetic ${ident}`,
  latitude: 40,
  longitude: -75,
  isoCountry: "US",
  municipality: "Example City",
  scheduledService: false,
  ...aliases,
});

describe("CSV parser", () => {
  it("supports escaped quotes, commas, and multiline fields", () => {
    expect(parseCsv('a,b\r\n"x, y","line 1\nline ""2"""')).toEqual([
      { cells: ["a", "b"], rowNumber: 1 },
      { cells: ["x, y", 'line 1\nline "2"'], rowNumber: 2 },
    ]);
  });

  it("reports malformed quoting with a row number", () => {
    expect(() => parseCsv('a,b\n"unterminated')).toThrow(CsvSyntaxError);
  });
});

describe("ForeFlight CSV adapter v1", () => {
  it.each([
    ["N1", "N1"],
    ["n9900m", "N9900M"],
    [" N12345 ", "N12345"],
    ["n123ab", "N123AB"],
  ])("accepts valid US N-number AircraftID %j as %s", (input, expected) => {
    expect(registrationFromForeFlightAircraftId(input)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "N0123",
    "N1234AB",
    "N12I",
    "N12O",
    "N-9900M",
    "N 9900M",
    "TRAINER",
    "SYNTH-A",
    "12345",
  ])("does not promote non-registration AircraftID %j", (input) => {
    expect(registrationFromForeFlightAircraftId(input)).toBeUndefined();
  });

  it("normalizes supported flights and retains correction-ready provenance", () => {
    const parsed = parseForeFlightCsv(fixture);

    expect(parsed.adapter.version).toBe(1);
    expect(parsed.flights).toHaveLength(2);
    expect(parsed.flights[0]).toMatchObject({
      date: "2026-01-02",
      departureTime: "08:05",
      originIdentifier: "KAAA",
      destinationIdentifier: "KBBB",
      distanceNauticalMiles: 125.5,
      totalTimeHours: 1.2,
      totalTimeStatus: "known",
      hobbsStatus: "missing",
      aircraftDisplayName: "C172",
      aircraftType: "C172",
      aircraftModel: "Example Aviation Trainer",
      aircraftCategory: "airplane-single-engine-land",
      kind: "private",
      issues: [],
      provenance: {
        source: "ForeFlight",
        adapterVersion: 1,
        original: {
          date: "2026-01-02",
          aircraftId: "SYNTH-A",
          originIdentifier: "KAAA",
          destinationIdentifier: "KBBB",
          totalTime: "1.2",
        },
      },
    });
    expect(parsed.flights[0]).not.toHaveProperty("registration");
  });

  it("extracts canonical registrations from AircraftID without changing aircraft semantics", () => {
    const parsed = parseForeFlightCsv(fixture.replaceAll("SYNTH-A", "n9900m"));

    expect(parsed.flights[0]).toMatchObject({
      registration: "N9900M",
      aircraftDisplayName: "C172",
      aircraftType: "C172",
      aircraftModel: "Example Aviation Trainer",
      provenance: {
        original: { aircraftId: "n9900m" },
      },
    });
  });

  it("rejects a document without the versioned ForeFlight marker", () => {
    expect(() => parseForeFlightCsv(fixture.replace("ForeFlight Logbook Import", "Other Export")))
      .toThrowError(ForeFlightImportError);
  });

  it("reports the missing required header and its CSV row", () => {
    expect(() => parseForeFlightCsv(fixture.replace("Date,AircraftID,From", "Date,AircraftID,Origin")))
      .toThrowError(/requires the "From" column.*CSV row 8/);
  });

  it("returns useful row issues instead of inventing malformed values", () => {
    const malformed = fixture.replace(
      "2026-01-02,SYNTH-A,KAAA,KBBB,125.5,8:05",
      "2026-02-30,SYNTH-A,,bad value,-2,25:99",
    );
    const [flight] = parseForeFlightCsv(malformed).flights;

    expect(flight.date).toBeUndefined();
    expect(flight.originIdentifier).toBeUndefined();
    expect(flight.destinationIdentifier).toBeUndefined();
    expect(flight.distanceNauticalMiles).toBeUndefined();
    expect(flight.issues.map((issue) => issue.code)).toEqual([
      "invalid-date",
      "missing-airport",
      "invalid-airport-identifier",
      "invalid-number",
      "invalid-time",
    ]);
  });

  it("does not choose between conflicting aircraft definitions", () => {
    const ambiguous = fixture.replace(
      "SYNTH-B,PA44,2021,Fictional Aircraft,Twin,Retractable,Reciprocating,airplane,Airplane Multi Engine Land",
      "SYNTH-A,PA44,2021,Fictional Aircraft,Twin,Retractable,Reciprocating,airplane,Airplane Multi Engine Land",
    );
    const [flight] = parseForeFlightCsv(ambiguous).flights;

    expect(flight.aircraft).toMatchObject({ status: "ambiguous" });
    expect(flight.aircraftType).toBeUndefined();
    expect(flight.aircraftModel).toBeUndefined();
    expect(flight.issues).toContainEqual(
      expect.objectContaining({ code: "ambiguous-aircraft", severity: "warning" }),
    );
  });
});

describe("airport resolution and map artifact", () => {
  it("parses the documented OurAirports schema", () => {
    const references = parseOurAirportsCsv(
      [
        "ident,type,name,latitude_deg,longitude_deg,iso_country,municipality,scheduled_service,gps_code,iata_code,local_code",
        "KAAA,small_airport,Synthetic Alpha,40,-75,US,Example City,no,KAAA,AAA,AAA",
      ].join("\n"),
    );

    expect(references).toEqual([
      expect.objectContaining({ ident: "KAAA", iataCode: "AAA", scheduledService: false }),
    ]);
  });

  it("surfaces ambiguous aliases rather than choosing an airport", () => {
    const resolve = createAirportResolver([
      airport("KAAA", { localCode: "DUP" }),
      airport("KBBB", { localCode: "DUP" }),
    ]);

    expect(resolve("dup")).toEqual({
      status: "ambiguous",
      identifier: "DUP",
      candidateIdents: ["KAAA", "KBBB"],
    });
  });

  it("classifies the current OurAirports overlay heuristic explicitly", () => {
    const resolve = createAirportResolver([
      airport("KLGE", { iataCode: "LGE" }),
      { ...airport("KCOM"), type: "large_airport", scheduledService: true },
      airport("KSTR"),
    ]);

    expect(resolve("KCOM")).toMatchObject({
      status: "resolved",
      airport: { facility: "commercial" },
    });
    expect(resolve("KLGE")).toMatchObject({
      status: "resolved",
      airport: { facility: "general-aviation" },
    });
    expect(resolve("KSTR")).toMatchObject({
      status: "resolved",
      airport: { facility: "airstrip" },
    });
  });

  it("keeps duplicate candidates as flights and marks exact versus ambiguous matches", () => {
    const repeated = fixture
      .replace(
        '2026-01-03,SYNTH-B,KBBB,KCCC,,14:30,1.4,"Invented\nmultiline note"',
        [
          '2026-01-02,SYNTH-A,KAAA,KBBB,125.5,8:05,1.2,"Exact candidate"',
          '2026-01-02,SYNTH-A,KAAA,KBBB,125.5,,1.4,"Ambiguous candidate"',
        ].join("\n"),
      );
    const parsed = parseForeFlightCsv(repeated);
    const resolve = createAirportResolver([
      airport("KAAA"),
      airport("KBBB"),
      airport("KCCC"),
    ]);
    const artifact = buildLocalMapArtifact(parsed, resolve, {
      generatedAt: "2026-01-04T00:00:00.000Z",
      sourceFileSha256: "synthetic-hash",
      airportDataset: "synthetic",
    });

    expect(artifact.flights).toHaveLength(3);
    expect(artifact.recentFlights).toHaveLength(3);
    expect(artifact.stats).toMatchObject({
      records: 2,
      flights: 2,
      mappedFlights: 3,
      durationHours: 2.6,
    });
    expect(artifact.summary.exactDuplicateCandidates).toBe(1);
    expect(artifact.summary.ambiguousDuplicateCandidates).toBe(1);
    expect(artifact.review.duplicateCandidates.map((candidate) => candidate.confidence)).toEqual([
      "exact",
      "ambiguous",
    ]);
    expect(JSON.stringify(artifact)).not.toContain("SYNTH-A");
    expect(JSON.stringify(artifact)).not.toContain('"original"');
    expect(artifact.flights[0]).toMatchObject({
      aircraftType: "C172",
      aircraftModel: "Example Aviation Trainer",
    });
  });

  it("deduplicates registration options and filters ForeFlight flights by canonical registration", () => {
    const registered = fixture
      .replaceAll("SYNTH-A", "n9900m")
      .replaceAll("SYNTH-B", "N9900M");
    const artifact = buildLocalMapArtifact(
      parseForeFlightCsv(registered),
      createAirportResolver([
        airport("KAAA"),
        airport("KBBB"),
        airport("KCCC"),
      ]),
      {
        generatedAt: "2026-01-04T00:00:00.000Z",
        sourceFileSha256: "synthetic-hash",
        airportDataset: "synthetic",
      },
    );
    const indexed = indexFlights(artifact.flights);

    expect(artifact.flights).toHaveLength(2);
    expect(artifact.flights.every((flight) => flight.registration === "N9900M")).toBe(true);
    expect(
      getFilterOptions(indexed, ALL_FLIGHT_FILTERS).registrations.map(({ value }) => value),
    ).toEqual(["N9900M"]);
    expect(
      filterIndexedFlights(indexed, {
        ...ALL_FLIGHT_FILTERS,
        registration: "n9900m",
      }),
    ).toHaveLength(2);
    expect(JSON.stringify(artifact)).not.toContain('"registration":"n9900m"');
  });

  it("derives only positive Hobbs deltas and keeps non-flight activity facts", () => {
    const input = [
      "ForeFlight Logbook Import",
      "",
      "Aircraft Table",
      "AircraftID,TypeCode,Make,Model,equipType (FAA),aircraftClass (FAA)",
      "SYNTH-A,C172,Example,Trainer,airplane,Airplane Single Engine Land",
      "Flights Table",
      "Date,AircraftID,From,To,Distance,TimeOut,TotalTime,HobbsStart,HobbsEnd,SimulatedFlight,GroundTraining",
      "2026-01-01,SYNTH-A,KAAA,KBBB,100,,1.2,10.0,11.2,,",
      "2026-01-02,SYNTH-A,KAAA,KBBB,100,,1.0,0,0,,",
      "2026-01-03,SYNTH-A,KAAA,KBBB,100,,1.0,12,11,,",
      "2026-01-04,SYNTH-A,KAAA,KBBB,100,,1.0,,, ,",
      "2026-01-05,SYNTH-A,,,0,,0,,,1.0,",
      "2026-01-06,SYNTH-A,,,0,,0,,,,1.0",
    ].join("\n");
    const artifact = buildLocalMapArtifact(
      parseForeFlightCsv(input),
      createAirportResolver([airport("KAAA"), airport("KBBB")]),
      {
        generatedAt: "2026-01-07T00:00:00.000Z",
        sourceFileSha256: "synthetic-hash",
        airportDataset: "synthetic",
      },
    );

    expect(artifact.statsFacts.map((fact) => fact.hobbsStatus)).toEqual([
      "known",
      "invalid",
      "invalid",
      "missing",
      "missing",
      "missing",
    ]);
    expect(artifact.statsFacts[0].hobbsElapsedHours).toBe(1.2);
    expect(artifact.statsFacts.map((fact) => fact.activity)).toEqual([
      "flight",
      "flight",
      "flight",
      "flight",
      "simulator",
      "ground",
    ]);
    expect(artifact.statsFacts.filter((fact) => !fact.mapReady)).toHaveLength(2);
    expect(artifact.stats).toMatchObject({ records: 6, flights: 4 });
  });

  it("converts logged nautical miles and labels great-circle estimates", () => {
    const parsed = parseForeFlightCsv(fixture);
    const artifact = buildLocalMapArtifact(
      parsed,
      createAirportResolver([
        airport("KAAA"),
        { ...airport("KBBB"), longitude: -74 },
        { ...airport("KCCC"), longitude: -73 },
      ]),
      {
        generatedAt: "2026-01-04T00:00:00.000Z",
        sourceFileSha256: "synthetic-hash",
        airportDataset: "synthetic",
      },
    );

    expect(artifact.statsFacts[0]).toMatchObject({
      distanceMiles: 144.422821,
      distanceBasis: "logged-nautical-converted",
      distanceStatus: "known",
    });
    expect(artifact.statsFacts[1]).toMatchObject({
      distanceBasis: "great-circle",
      distanceStatus: "missing",
    });
  });
});
