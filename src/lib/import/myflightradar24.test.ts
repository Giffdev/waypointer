import { describe, expect, it } from "vitest";
import {
  createAirportResolver,
  type AirportReference,
} from "./airport-resolution";
import {
  MyFlightRadar24ImportError,
  parseMyFlightRadar24Csv,
} from "./myflightradar24";
import { buildMyFlightRadar24MapArtifact } from "./myflightradar24-artifact";

const header =
  "Date,Flight number,From,To,Dep time,Arr time,Duration,Airline,Aircraft,Registration,Seat number,Seat type,Flight class,Flight reason,Note,Dep_id,Arr_id,Airline_id,Aircraft_id";
const defaultFields = {
  date: "2026-04-05",
  flightNumber: "DL123",
  from: "Seattle / Seattle-Tacoma International Airport (SEA/KSEA)",
  to: "New York / John F Kennedy International Airport (JFK/KJFK)",
  departureTime: "8:05",
  arrivalTime: "10:35:30",
  duration: "02:30:30",
  airline: "Delta Air Lines",
  aircraft: "Airbus A321",
  registration: "N123AB",
  aircraftId: "4512",
};

function row(overrides: Partial<typeof defaultFields> = {}): string {
  const fields = { ...defaultFields, ...overrides };
  return [
    fields.date,
    fields.flightNumber,
    fields.from,
    fields.to,
    fields.departureTime,
    fields.arrivalTime,
    fields.duration,
    fields.airline,
    fields.aircraft,
    fields.registration,
    "12A",
    "Window",
    "Economy",
    "Leisure",
    "Synthetic fixture",
    "101",
    "202",
    "DL",
    fields.aircraftId,
  ]
    .map((value) =>
      /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value,
    )
    .join(",");
}

const validRow = row();
const fixture = `\n${header}\n${validRow}\n`;

const airport = (
  ident: string,
  iataCode: string,
  longitude: number,
): AirportReference => ({
  ident,
  type: "large_airport",
  name: `Synthetic ${iataCode}`,
  latitude: 40,
  longitude,
  isoCountry: "ZZ",
  municipality: "Example City",
  scheduledService: true,
  iataCode,
});

const metadata = {
  generatedAt: "2026-04-05T00:00:00.000Z",
  sourceFileSha256: "synthetic-hash",
  airportDataset: "synthetic",
};

describe("myFlightradar24 CSV adapter v1", () => {
  it("strictly validates the official schema and normalizes map-safe fields", () => {
    const parsed = parseMyFlightRadar24Csv(fixture);

    expect(parsed.adapter.version).toBe(1);
    expect(parsed.flights).toHaveLength(1);
    expect(parsed.flights[0]).toMatchObject({
      date: "2026-04-05",
      departureTime: "08:05:00",
      arrivalTime: "10:35:30",
      durationMinutes: 150.5,
      originIdentifier: "SEA",
      originIcaoIdentifier: "KSEA",
      destinationIdentifier: "JFK",
      destinationIcaoIdentifier: "KJFK",
      flightNumber: "DL123",
      airline: "Delta Air Lines",
      aircraftModel: "Airbus A321",
      registration: "N123AB",
      kind: "commercial",
      role: "passenger",
      issues: [],
    });
    expect(parsed.flights[0]).not.toHaveProperty("aircraftType");
    expect(parsed.flights[0]).not.toHaveProperty("aircraftCode");
  });

  it("rejects changed headers and malformed row widths with row numbers", () => {
    expect(() =>
      parseMyFlightRadar24Csv(fixture.replace("Flight number", "Flight")),
    ).toThrowError(MyFlightRadar24ImportError);
    expect(() => parseMyFlightRadar24Csv(`${header}\n2026-04-05,DL123`)).toThrowError(
      /Expected 19 columns.*CSV row 2/,
    );
  });

  it("leaves registration absent when the source row does not provide one", () => {
    const parsed = parseMyFlightRadar24Csv(`${header}\n${row({ registration: "" })}`);
    const artifact = buildMyFlightRadar24MapArtifact(
      parsed,
      createAirportResolver([
        airport("KSEA", "SEA", -122),
        airport("KJFK", "JFK", -73),
      ]),
      metadata,
    );

    expect(parsed.flights[0].registration).toBeUndefined();
    expect(artifact.flights[0]).not.toHaveProperty("registration");
  });

  it("drops placeholder metadata and numeric aircraft IDs while retaining explicit values", () => {
    const parsed = parseMyFlightRadar24Csv(
      [
        header,
        row(),
        row({ aircraft: "()", registration: "0", aircraftId: "98765" }),
        row({ aircraft: "0", registration: "()", aircraftId: "12345" }),
        row({ aircraft: "", registration: "", aircraftId: "67890" }),
        row({ aircraft: "N/A", registration: "-", aircraftId: "24680" }),
      ].join("\n"),
    );

    expect(parsed.flights[0]).toMatchObject({
      aircraftModel: "Airbus A321",
      registration: "N123AB",
    });

    for (const flight of parsed.flights.slice(1)) {
      expect(flight).not.toHaveProperty("aircraftModel");
      expect(flight).not.toHaveProperty("registration");
      expect(flight).not.toHaveProperty("aircraftCode");
    }
    expect(JSON.stringify(parsed)).not.toContain("98765");
    expect(JSON.stringify(parsed)).not.toContain("12345");
    expect(JSON.stringify(parsed)).not.toContain("67890");
    expect(JSON.stringify(parsed)).not.toContain("24680");
  });

  it("preserves a numeric model only when it comes from the Aircraft field", () => {
    const parsed = parseMyFlightRadar24Csv(
      [
        header,
        row({ aircraft: "172", registration: "N172EX", aircraftId: "98765" }),
        row({ aircraft: "", registration: "", aircraftId: "172" }),
      ].join("\n"),
    );

    expect(parsed.flights[0]).toMatchObject({
      aircraftModel: "172",
      registration: "N172EX",
    });
    expect(parsed.flights[1]).not.toHaveProperty("aircraftModel");
    expect(JSON.stringify(parsed)).not.toContain("98765");

    const artifact = buildMyFlightRadar24MapArtifact(
      parsed,
      createAirportResolver([
        airport("KSEA", "SEA", -122),
        airport("KJFK", "JFK", -73),
      ]),
      metadata,
    );
    expect(artifact.flights[0]).toMatchObject({
      aircraft: "172",
      aircraftModel: "172",
      registration: "N172EX",
    });
    expect(artifact.flights[1]).toMatchObject({
      aircraft: "Aircraft not specified",
    });
    expect(JSON.stringify(artifact)).not.toContain("98765");
  });

  it("returns useful issues for invalid dates, times, and airport identifiers", () => {
    const malformed = row({
      date: "2026-02-30",
      departureTime: "25:10",
      from: "bad value",
      to: "",
    });
    const [flight] = parseMyFlightRadar24Csv(`${header}\n${malformed}`).flights;

    expect(flight.issues.map((issue) => issue.code)).toEqual([
      "invalid-date",
      "invalid-time",
      "invalid-airport-identifier",
      "missing-airport",
    ]);
  });

  it("resolves canonical airports and preserves unresolved rows for review", () => {
    const parsed = parseMyFlightRadar24Csv(
      `${fixture}${validRow.replace(
        "New York / John F Kennedy International Airport (JFK/KJFK)",
        "Unknown Place / Unknown Field (ZZZ/ZZZZ)",
      )}\n`,
    );
    const artifact = buildMyFlightRadar24MapArtifact(
      parsed,
      createAirportResolver([
        airport("KSEA", "SEA", -122),
        airport("KJFK", "JFK", -73),
      ]),
      metadata,
    );

    expect(artifact.summary).toMatchObject({
      importedRows: 2,
      mapReadyFlights: 1,
      unresolvedAirportRows: 1,
      roleDistinctOverlapCandidates: 0,
    });
    expect(artifact.flights[0]).toMatchObject({
      origin: { code: "SEA" },
      destination: { code: "JFK" },
      aircraftModel: "Airbus A321",
      registration: "N123AB",
    });
    expect(artifact.flights[0]).not.toHaveProperty("aircraftType");
    expect(artifact.statsFacts).toEqual([
      expect.objectContaining({
        activity: "flight",
        role: "passenger",
        durationHours: 2.508333,
        durationStatus: "known",
        distanceBasis: "great-circle",
      }),
      expect.objectContaining({
        activity: "flight",
        role: "passenger",
        durationHours: 2.508333,
        durationStatus: "known",
        mapReady: false,
      }),
    ]);
    expect(artifact.review.unresolvedAirportRows[0]).toMatchObject({
      fields: ["To"],
      identifiers: ["ZZZ"],
    });
  });

  it("produces stable idempotency keys and deterministic artifacts", () => {
    const resolver = createAirportResolver([
      airport("KSEA", "SEA", -122),
      airport("KJFK", "JFK", -73),
    ]);
    const first = buildMyFlightRadar24MapArtifact(
      parseMyFlightRadar24Csv(fixture),
      resolver,
      metadata,
    );
    const second = buildMyFlightRadar24MapArtifact(
      parseMyFlightRadar24Csv(fixture),
      resolver,
      metadata,
    );

    expect(second).toEqual(first);
    expect(first.flights[0].id).toMatch(/^fr24-/);
    expect(first.flights[0].provenance.idempotencyKey).toHaveLength(64);
  });

  it("detects same-day route overlaps without merging passenger and pilot records", () => {
    const references = [
      airport("KSEA", "SEA", -122),
      airport("KJFK", "JFK", -73),
    ];
    const resolver = createAirportResolver(references);
    const origin = resolver("SEA");
    const destination = resolver("JFK");
    if (origin.status !== "resolved" || destination.status !== "resolved") {
      throw new Error("Synthetic airports should resolve");
    }
    const artifact = buildMyFlightRadar24MapArtifact(
      parseMyFlightRadar24Csv(fixture),
      resolver,
      {
        ...metadata,
        comparisonFlights: [
          {
            id: "synthetic-pilot-flight",
            date: "2026-04-05",
            origin: origin.airport,
            destination: destination.airport,
            kind: "private",
            role: "pilot",
            aircraft: "Synthetic Trainer",
            distanceMiles: 100,
            source: "ForeFlight",
          },
        ],
      },
    );

    expect(artifact.summary.roleDistinctOverlapCandidates).toBe(1);
    expect(artifact.flights).toHaveLength(1);
    expect(artifact.flights[0].role).toBe("passenger");
  });

  it("serializes only map and review-safe fields", () => {
    const artifact = buildMyFlightRadar24MapArtifact(
      parseMyFlightRadar24Csv(fixture),
      createAirportResolver([
        airport("KSEA", "SEA", -122),
        airport("KJFK", "JFK", -73),
      ]),
      metadata,
    );
    const serialized = JSON.stringify(artifact);

    expect(serialized).toContain('"registration":"N123AB"');
    expect(serialized).toContain('"aircraftModel":"Airbus A321"');
    expect(serialized).not.toContain('"aircraftType"');
    expect(serialized).not.toContain("4512");
    expect(serialized).not.toContain("12A");
    expect(serialized).not.toContain("Private synthetic note");
    expect(serialized).not.toContain('"Registration"');
    expect(serialized).not.toContain("Seat number");
    expect(serialized).not.toContain("Note");
    expect(serialized).not.toContain("Seat type");
    expect(serialized).not.toContain("Flight reason");
  });
});
