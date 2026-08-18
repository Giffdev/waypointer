import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FLIGHT_IMPORT_ADAPTERS,
  FLIGHT_IMPORT_DETECTION_THRESHOLD,
  FLIGHT_IMPORT_FORMATS,
  detectFlightImportFormat,
  parseFlightImport,
  type FlightImportAdapter,
} from "./registry";

const foreFlightFixture = readFileSync(
  fileURLToPath(new URL("./__fixtures__/foreflight-v1.csv", import.meta.url)),
  "utf8",
);
const fr24Header =
  "Date,Flight number,From,To,Dep time,Arr time,Duration,Airline,Aircraft,Registration,Seat number,Seat type,Flight class,Flight reason,Note,Dep_id,Arr_id,Airline_id,Aircraft_id";
const fr24Row =
  '2026-04-05,DL123,Seattle / Seattle-Tacoma International Airport (SEA/KSEA),New York / John F Kennedy International Airport (JFK/KJFK),8:05,10:35,02:30,Delta Air Lines,Airbus A321,N123AB,12A,Window,Economy,Leisure,"Synthetic fixture",101,202,DL,4512';
const fr24Fixture = `\n${fr24Header}\n${fr24Row}\n`;

describe("flight import adapter registry", () => {
  it("recognizes and dispatches a ForeFlight export without source selection", () => {
    const quotedMarkers = foreFlightFixture
      .replace("ForeFlight Logbook Import", '"ForeFlight Logbook Import"')
      .replace("Aircraft Table", '"Aircraft Table"')
      .replace("Flights Table", '"Flights Table"');
    const detection = detectFlightImportFormat(quotedMarkers);
    const parsed = parseFlightImport(quotedMarkers);

    expect(detection).toMatchObject({
      status: "recognized",
      adapterId: "foreflight-v1",
      source: "ForeFlight",
      confidence: 1,
    });
    expect(parsed).toMatchObject({
      status: "parsed",
      adapterId: "foreflight-v1",
      source: "ForeFlight",
    });
    expect(parsed.status).toBe("parsed");
    if (parsed.status !== "parsed" || parsed.adapterId !== "foreflight-v1") {
      throw new Error("Expected parsed ForeFlight fixture");
    }
    expect(parsed.parsed.flights[0].provenance.source).toBe("ForeFlight");
  });

  it("recognizes and dispatches a myFlightradar24 export", () => {
    const detection = detectFlightImportFormat(fr24Fixture);
    const parsed = parseFlightImport(fr24Fixture);

    expect(detection).toMatchObject({
      status: "recognized",
      adapterId: "myflightradar24-v1",
      source: "FlightRadar24",
      confidence: 1,
    });
    expect(parsed).toMatchObject({
      status: "parsed",
      adapterId: "myflightradar24-v1",
      source: "FlightRadar24",
    });
    expect(parsed.status).toBe("parsed");
    if (
      parsed.status !== "parsed" ||
      parsed.adapterId !== "myflightradar24-v1"
    ) {
      throw new Error("Expected parsed FR24 fixture");
    }
    expect(parsed.parsed.flights[0]).toMatchObject({
      aircraftModel: "Airbus A321",
      registration: "N123AB",
      provenance: { source: "FlightRadar24" },
    });
    expect(parsed.parsed.flights[0]).not.toHaveProperty("aircraftCode");
  });

  it("reports a recognized but structurally malformed file as invalid", () => {
    const result = parseFlightImport(`${fr24Header}\n2026-04-05,EX123`);

    expect(result).toEqual({
      status: "invalid",
      adapterId: "myflightradar24-v1",
      label: "myFlightradar24 Flight Diary CSV",
      source: "FlightRadar24",
      confidence: 0.94,
      errorCode: "invalid-row-width",
      reason:
        "The format was recognized, but the file did not pass that adapter's validation.",
    });
  });

  it("returns ambiguous rather than choosing when multiple adapters qualify", () => {
    const overlappingAdapters: FlightImportAdapter[] = [
      syntheticAdapter("format-a", 0.95),
      syntheticAdapter("format-b", 0.96),
    ];

    const result = detectFlightImportFormat(
      "content is deliberately irrelevant",
      overlappingAdapters,
    );

    expect(result).toMatchObject({
      status: "ambiguous",
      candidates: [
        { adapterId: "format-b", confidence: 0.96 },
        { adapterId: "format-a", confidence: 0.95 },
      ],
    });
  });

  it("returns unsupported for unknown and partial lookalike formats", () => {
    expect(
      detectFlightImportFormat("timestamp,latitude,longitude,altitude\n1,2,3,4"),
    ).toMatchObject({ status: "unsupported", candidates: [] });
    expect(
      detectFlightImportFormat(
        "ForeFlight export\nDate,AircraftID,From,To\n2026-01-01,X,A,B",
      ),
    ).toMatchObject({ status: "unsupported" });
    expect(
      detectFlightImportFormat(
        "Date,Flight number,From,To,Aircraft\n2026-01-01,X,A,B,C172",
      ),
    ).toMatchObject({ status: "unsupported", candidates: [] });
  });

  it("does not include inspected raw content in detection or error results", () => {
    const unsupportedSecret = "unimplemented,format\nPRIVATE-VALUE-DO-NOT-RETURN";
    const invalidSecret = `${fr24Header}\nPRIVATE-VALUE-DO-NOT-RETURN,short`;

    expect(JSON.stringify(detectFlightImportFormat(unsupportedSecret))).not.toContain(
      "PRIVATE-VALUE-DO-NOT-RETURN",
    );
    expect(JSON.stringify(parseFlightImport(invalidSecret))).not.toContain(
      "PRIVATE-VALUE-DO-NOT-RETURN",
    );
    expect(JSON.stringify(detectFlightImportFormat(fr24Fixture))).not.toContain(
      "Private synthetic note",
    );
  });

  it("publishes only implemented adapters above a high threshold", () => {
    expect(FLIGHT_IMPORT_DETECTION_THRESHOLD).toBeGreaterThanOrEqual(0.9);
    expect(FLIGHT_IMPORT_ADAPTERS.map(({ id }) => id)).toEqual([
      "foreflight-v1",
      "myflightradar24-v1",
    ]);
    expect(
      FLIGHT_IMPORT_FORMATS.map(({ id, capability }) => [id, capability]),
    ).toEqual([
      ["foreflight-v1", "automatic"],
      ["myflightradar24-v1", "automatic"],
      ["generic-csv-v1", "generic-mapping"],
    ]);
    expect(FLIGHT_IMPORT_FORMATS.at(-1)).toMatchObject({
      supportsExplicitMapping: true,
      acceptedExtensions: [".csv"],
      presets: [
        { id: "myflightbook-export", description: expect.any(String) },
        { id: "crewlounge-pilotlog", description: expect.any(String) },
      ],
    });
  });
});

function syntheticAdapter(
  id: string,
  confidence: number,
): FlightImportAdapter {
  return {
    id,
    label: id,
    source: id,
    detect: () => ({
      confidence,
      reasons: [`${id} synthetic signature matched`],
    }),
    parse: () => ({}),
  };
}
