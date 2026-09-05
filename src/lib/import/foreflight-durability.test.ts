import { describe, expect, it } from "vitest";
import { readCsvRecords } from "./csv";
import { parseForeFlightCsv } from "./foreflight";
import {
  detectFlightImportFormat,
  TRUNCATION_DISCLOSURE_THRESHOLD,
} from "./registry";

/**
 * ForeFlight durability.
 *
 * These began as one-off audit probes against a real export. They are
 * permanent tests now because each one describes a shape of real logbook that
 * the importer previously mishandled — a large Aircraft Table, a remark with
 * an embedded newline, a Route column — and "we checked once by hand" is not
 * a guarantee that survives the next refactor.
 */

const AIRCRAFT_HEADER =
  "AircraftID,TypeCode,Year,Make,Model,GearType,EngineType,equipType (FAA),aircraftClass (FAA)";
const FLIGHT_HEADER =
  "Date,AircraftID,From,To,Route,Distance,TimeOut,TotalTime,DayLandingsFullStop,NightLandingsFullStop,AllLandings,PilotComments";

function foreFlightExport({
  aircraftRows = 2,
  flightRows = ['2026-05-01,SYNTH-1,KMFR,KEUG,"KMFR KRBG KEUG",120,08:05,1.4,1,0,2,"Nice day"'],
}: { aircraftRows?: number; flightRows?: string[] } = {}): string {
  return [
    "ForeFlight Logbook Import",
    "",
    "Aircraft Table",
    AIRCRAFT_HEADER,
    ...Array.from(
      { length: aircraftRows },
      (_, index) =>
        `SYNTH-${index + 1},C172,2020,Example Aviation,Trainer,Fixed Tricycle,Reciprocating,airplane,Airplane Single Engine Land`,
    ),
    "Flights Table",
    FLIGHT_HEADER,
    ...flightRows,
    "",
  ].join("\n");
}

describe("record-aware detection window", () => {
  it("recognizes an export whose Aircraft Table has 300+ rows", () => {
    // The predecessor scanned 256 *physical lines*. A pilot with a club
    // membership and a few hundred tail numbers pushed `Flights Table` past
    // that window and was told their valid ForeFlight export was an
    // unsupported format.
    const detection = detectFlightImportFormat(
      foreFlightExport({ aircraftRows: 320 }),
    );
    expect(detection.status).toBe("recognized");
    if (detection.status === "recognized") {
      expect(detection.adapterId).toBe("foreflight-v1");
      expect(detection.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("counts a quoted multi-line remark as one record, not many lines", () => {
    const detection = detectFlightImportFormat(
      foreFlightExport({
        aircraftRows: 200,
        flightRows: [
          '2026-05-01,SYNTH-1,KMFR,KEUG,"KMFR KRBG KEUG",120,08:05,1.4,1,0,2,"line one\nline two\nline three"',
        ],
      }),
    );
    expect(detection.status).toBe("recognized");
  });

  it("still recognizes the minimal export with no Route column", () => {
    const legacy = [
      "ForeFlight Logbook Import",
      "",
      "Aircraft Table",
      AIRCRAFT_HEADER,
      "SYNTH-1,C172,2020,Example,Trainer,Fixed,Reciprocating,airplane,Airplane Single Engine Land",
      "Flights Table",
      "Date,AircraftID,From,To,Distance,TimeOut,TotalTime,PilotComments",
      "2026-05-01,SYNTH-1,KMFR,KEUG,120,08:05,1.4,ok",
      "",
    ].join("\n");
    expect(detectFlightImportFormat(legacy).status).toBe("recognized");
  });

  it("keeps a bounded budget, and discloses truncation instead of guessing", () => {
    // The DoS ceiling survives the unit change: a huge file is still only
    // partially read, and a partial ForeFlight signature is reported as such
    // rather than silently accepted or silently rejected.
    const huge = [
      "ForeFlight Logbook Import",
      "",
      "Aircraft Table",
      AIRCRAFT_HEADER,
      ...Array.from(
        { length: 40_000 },
        (_, index) => `SYNTH-${index},C172,2020,${"X".repeat(80)},T,F,R,a,A`,
      ),
      "Flights Table",
      FLIGHT_HEADER,
      '2026-05-01,SYNTH-1,KMFR,KEUG,"KMFR KRBG KEUG",120,08:05,1.4,1,0,2,"note"',
    ].join("\n");
    const detection = detectFlightImportFormat(huge);
    expect(detection.status).not.toBe("recognized");
    if (detection.status !== "recognized") {
      expect(detection.reason).toContain("detection-truncated");
      const foreflight = detection.candidates.find(
        (candidate) => candidate.adapterId === "foreflight-v1",
      );
      expect(foreflight?.confidence).toBeGreaterThanOrEqual(
        TRUNCATION_DISCLOSURE_THRESHOLD,
      );
    }
  });

  it("keeps the records parsed before a syntax error instead of discarding them", () => {
    // A stray quote after a valid header used to throw out of the reader, the
    // detector caught it and returned *zero* records, every adapter scored
    // zero, and a recognisable export was reported as an unsupported format —
    // an answer about the file's identity produced by a defect in its tail.
    const malformed = [
      "ForeFlight Logbook Import",
      "",
      "Aircraft Table",
      AIRCRAFT_HEADER,
      'SYNTH-1,C172,2020,Exam"ple,Trainer,Fixed,Reciprocating,airplane,Airplane Single Engine Land',
      "Flights Table",
      FLIGHT_HEADER,
      "2026-05-01,SYNTH-1,KMFR,KEUG,,120,08:05,1.4,1,0,2,ok",
    ].join("\n");

    const lenient = readCsvRecords(malformed, { onSyntaxError: "truncate" });
    expect(lenient.truncated).toBe(true);
    expect(lenient.syntaxError?.name).toBe("CsvSyntaxError");
    // Everything before the fault survives, including the signature record
    // and the aircraft header.
    expect(lenient.records[0].cells[0]).toBe("ForeFlight Logbook Import");
    expect(lenient.records.length).toBeGreaterThanOrEqual(4);

    const detection = detectFlightImportFormat(malformed);
    expect(detection.status).not.toBe("recognized");
    if (detection.status !== "recognized") {
      // Not "we don't support this" — "we stopped reading".
      expect(detection.reason).toContain("detection-truncated");
      const foreflight = detection.candidates.find(
        (candidate) => candidate.adapterId === "foreflight-v1",
      );
      expect(foreflight?.confidence).toBeGreaterThanOrEqual(
        TRUNCATION_DISCLOSURE_THRESHOLD,
      );
    }
  });

  it("still fails loudly on the import path, so a broken file never imports short", () => {
    // Leniency is a *detection* affordance only. Parsing a malformed file
    // leniently would import a silently shortened logbook.
    expect(() =>
      readCsvRecords('a,b\n"x"y,2\n3,4'),
    ).toThrowError(/closing quote/);
  });

  it("reads records lazily and stops at the caller's budget", () => {
    const content = ["a,b", ...Array.from({ length: 500 }, (_, i) => `${i},x`)].join(
      "\n",
    );
    expect(readCsvRecords(content, { maxRecords: 10 }).records).toHaveLength(10);
    expect(readCsvRecords(content, { maxRecords: 10 }).truncated).toBe(true);
    expect(readCsvRecords("a,b\n1,2").truncated).toBe(false);
  });

  it("treats both budgets as exact and inclusive at the boundary", () => {
    // "Exactly the budget" must not be reported as truncation. Detection maps
    // `truncated` to "we stopped reading", and saying that about a file we
    // read to the last byte is the same class of lie the old line window told
    // in the other direction.
    const threeRecords = "a,b\n1,2\n3,4";
    const exact = readCsvRecords(threeRecords, {
      maxRecords: 3,
      maxCharacters: threeRecords.length,
    });
    expect(exact.records).toHaveLength(3);
    expect(exact.truncated).toBe(false);

    // The same input with a trailing newline still ends on record 3.
    const trailing = readCsvRecords(`${threeRecords}\n`, {
      maxRecords: 3,
      maxCharacters: threeRecords.length + 1,
    });
    expect(trailing.records).toHaveLength(3);
    expect(trailing.truncated).toBe(false);

    // One record over, and one character short, are both truncation.
    expect(readCsvRecords(`${threeRecords}\n5,6`, { maxRecords: 3 }).truncated)
      .toBe(true);
    const oneShort = readCsvRecords(threeRecords, {
      maxCharacters: threeRecords.length - 1,
    });
    expect(oneShort.truncated).toBe(true);
    // The record the character budget cut in half is dropped, never emitted
    // half-parsed: a caller cannot tell a partial record from a real one.
    expect(oneShort.records).toHaveLength(2);
  });

  it("clears any realistic ForeFlight Aircraft Table within the default budget", () => {
    // The documented bound is 2 000 records or 1 MiB. The Aircraft Table
    // precedes the `Flights Table` marker and its size is not something we
    // control, so the number that matters is how large a table can be and
    // still be detected. 1 500 aircraft is far beyond any real logbook and is
    // still read.
    const detection = detectFlightImportFormat(
      foreFlightExport({ aircraftRows: 1_500 }),
    );
    expect(detection.status).toBe("recognized");
  });
});

describe("ForeFlight flight rows", () => {
  it("reads Route and preserves the raw route text", () => {
    const parsed = parseForeFlightCsv(foreFlightExport());
    expect(parsed.flights).toHaveLength(1);
    const [flight] = parsed.flights;
    expect(flight.routeRaw).toBe("KMFR KRBG KEUG");
    // The endpoints are still, and only, the endpoints.
    expect([flight.originIdentifier, flight.destinationIdentifier]).toEqual([
      "KMFR",
      "KEUG",
    ]);
  });

  it("does not parse the landing-count columns into any field", () => {
    // ForeFlight reports how many landings a leg had, never where. A count
    // cannot add a stop without inventing a place, and it cannot honestly
    // raise a warning either: a pattern lesson logs ten landings against a
    // single From/To pair, so comparing the count to the landing-airport
    // count would flag routine training as a problem. Parsing it into a field
    // nothing reads is worse than not parsing it — it implies behaviour that
    // does not ship.
    const parsed = parseForeFlightCsv(foreFlightExport());
    expect(parsed.flights[0]).not.toHaveProperty("landings");
    expect(parsed.flights[0].provenance.original).not.toHaveProperty(
      "allLandings",
    );
  });

  it("degrades silently when the Route column is absent", () => {
    const parsed = parseForeFlightCsv(
      [
        "ForeFlight Logbook Import",
        "",
        "Aircraft Table",
        AIRCRAFT_HEADER,
        "SYNTH-1,C172,2020,Example,Trainer,Fixed,Reciprocating,airplane,Airplane Single Engine Land",
        "Flights Table",
        "Date,AircraftID,From,To,Distance,TimeOut,TotalTime,PilotComments",
        "2026-05-01,SYNTH-1,KMFR,KEUG,120,08:05,1.4,ok",
        "",
      ].join("\n"),
    );
    expect(parsed.flights[0].routeRaw).toBeUndefined();
    expect(parsed.flights[0].issues).toEqual([]);
  });

  it("keeps a blank TimeOut blank rather than inventing one", () => {
    // Downstream, a blank departure time is the signal that this row needs a
    // source-row tiebreaker in its fingerprint. Filling it in here would
    // reintroduce the collapse.
    const parsed = parseForeFlightCsv(
      foreFlightExport({
        flightRows: [
          '2026-05-01,SYNTH-1,KMFR,KEUG,"KMFR KRBG KEUG",120,,1.4,1,0,2,"first leg"',
          '2026-05-01,SYNTH-1,KMFR,KEUG,"KMFR KRBG KEUG",120,,1.4,1,0,2,"second leg"',
        ],
      }),
    );
    expect(parsed.flights).toHaveLength(2);
    expect(parsed.flights[0].departureTime).toBeUndefined();
    expect(parsed.flights[1].departureTime).toBeUndefined();
    // Two distinct source rows: the parser must never merge them.
    expect(parsed.flights[0].provenance.sourceRowNumber).not.toBe(
      parsed.flights[1].provenance.sourceRowNumber,
    );
  });
});
