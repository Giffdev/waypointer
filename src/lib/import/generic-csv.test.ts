import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryImportRepository } from "./in-memory-repository";
import {
  GENERIC_CSV_PRESETS,
  detectGenericCsvPreset,
  fingerprintGenericCsvMapping,
  inspectGenericCsv,
  parseMappedGenericCsv,
  parseGenericCsvMapping,
  previewMappedGenericCsv,
  previewGenericCsv,
  serializeGenericCsvMapping,
  type GenericCsvMapping,
} from "./generic-csv";
import { commitImportBatch, decideImportRows } from "./service";
import { stageMappedFlightImport } from "./worker";

const myFlightbook = fixture("myflightbook.csv");
const pilotLog = fixture("crewlounge-pilotlog.csv");
const generic = fixture("generic-logbook.csv");
const owner = "owner-a";

describe("generic digital logbook CSV", () => {
  it.each([
    [
      myFlightbook,
      "myflightbook-export",
      {
        date: "Date",
        origin: "From",
        destination: "To",
        duration: "Total Flight Time",
        aircraftModel: "Model",
        registration: "Tail Number",
      },
    ],
    [
      pilotLog,
      "crewlounge-pilotlog",
      {
        date: "PILOTLOG_DATE",
        origin: "AF_DEP",
        destination: "AF_ARR",
        duration: "TIME_TOTAL",
        aircraftModel: "AC_MODEL",
        registration: "AC_REG",
      },
    ],
  ])("detects an evidence-backed mapping preset", (content, presetId, columns) => {
    expect(inspectGenericCsv(content)).toMatchObject({
      totalRows: 1,
      preset: { id: presetId, suggestedMapping: { columns } },
    });
  });

  it.each([
    ["myflightbook-export" as const, myFlightbook, "1.5", "N100ZZ"],
    ["crewlounge-pilotlog" as const, pilotLog, "1.083", "N200ZZ"],
  ])("normalizes the %s preset fixture", (presetId, content, duration, tail) => {
    const preset = GENERIC_CSV_PRESETS.find(({ id }) => id === presetId);
    if (!preset) throw new Error("Missing test preset");
    const parsed = parseMappedGenericCsv(content, {
      ...preset.suggestedMapping,
      defaults: { kind: "private", role: "pilot" },
    });
    expect(parsed.flights[0]).toMatchObject({
      date: presetId === "myflightbook-export" ? "2026-06-01" : "2026-06-02",
      originIdentifier: presetId === "myflightbook-export" ? "KSEA" : "KPDX",
      destinationIdentifier: presetId === "myflightbook-export" ? "KPDX" : "KSEA",
      durationHours: Number(duration),
      registration: tail,
      kind: "private",
      role: "pilot",
      issues: [],
    });
    expect(JSON.stringify(parsed)).not.toContain("Synthetic fixture");
  });

  it("maps arbitrary headers with explicit formats and previews validation", () => {
    const parsed = parseMappedGenericCsv(generic, genericMapping());
    expect(parsed.flights[0]).toMatchObject({
      date: "2026-06-03",
      originIdentifier: "KSEA",
      destinationIdentifier: "KJFK",
      durationHours: 5.25,
      aircraftModel: "B737",
      registration: "N300ZZ",
      role: "pilot",
      issues: [],
    });

    const invalid = parseMappedGenericCsv(
      "Flight Date,Departure,Arrival\n31/31/2026,private note,???",
      {
        ...genericMapping(),
        columns: {
          date: "Flight Date",
          origin: "Departure",
          destination: "Arrival",
        },
      },
    );
    expect(invalid.flights[0].issues.map(({ code }) => code)).toEqual([
      "invalid-date",
      "invalid-airport-identifier",
      "invalid-airport-identifier",
    ]);
    expect(JSON.stringify(invalid)).not.toContain("private note");
    expect(previewMappedGenericCsv(generic, genericMapping())).toMatchObject({
      totalRows: 1,
      counts: { validRows: 1, invalidRows: 0, warningRows: 0 },
      previewRows: [{ date: "2026-06-03" }],
    });
    expect(previewGenericCsv(generic, genericMapping())).toMatchObject({
      validRowCount: 1,
      invalidRowCount: 0,
      rows: [{ date: "2026-06-03" }],
      issues: [],
    });
  });

  it("exports UI-safe preset detection and conservative generic suggestions", () => {
    const preset = detectGenericCsvPreset(
      inspectGenericCsv(myFlightbook).headers,
    );
    expect(preset).toMatchObject({
      preset: {
        id: "myflightbook-export",
        description: expect.any(String),
        requiredHeaders: expect.arrayContaining(["Date", "From", "To"]),
      },
      confidence: 1,
      suggestedMapping: {
        columns: { date: "Date", origin: "From", destination: "To" },
        dateFormat: "iso",
      },
    });
    expect(
      detectGenericCsvPreset([
        "Flight Date",
        "Departure",
        "Arrival",
        "Notes",
      ]),
    ).toEqual({
      confidence: 0.6,
      suggestedMapping: {
        columns: {
          date: "Flight Date",
          origin: "Departure",
          destination: "Arrival",
          departureTime: undefined,
          duration: undefined,
          distance: undefined,
          aircraft: undefined,
          aircraftType: undefined,
          aircraftModel: undefined,
          registration: undefined,
          flightNumber: undefined,
          airline: undefined,
          kind: undefined,
          role: undefined,
        },
        dateFormat: "iso",
        timeFormat: "24-hour",
      },
    });
  });

  it("rejects incomplete, duplicate, or stale mappings before staging", () => {
    expect(() =>
      parseMappedGenericCsv(generic, {
        ...genericMapping(),
        columns: {
          date: "Flight Date",
          origin: "Departure",
          destination: "Departure",
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "duplicate-mapped-header" }),
    );
    expect(() =>
      parseMappedGenericCsv(generic, {
        ...genericMapping(),
        columns: {
          date: "Flight Date",
          origin: "Departure",
          destination: "Missing header",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "mapped-header-missing" }));
  });

  it("strictly normalizes and fingerprints untrusted mapping JSON", () => {
    const mapping = genericMapping();
    const reordered = {
      defaults: { role: "pilot", kind: "private" },
      durationFormat: "minutes",
      dateFormat: "mdy",
      columns: {
        role: "role",
        registration: "Tail",
        aircraftModel: "Airframe",
        duration: "Elapsed Minutes",
        destination: "Arrival",
        origin: "Departure",
        date: "flight date",
      },
    };
    expect(parseGenericCsvMapping(mapping)).toMatchObject({
      version: 1,
      columns: mapping.columns,
      dateFormat: "mdy",
      durationFormat: "minutes",
      defaults: { kind: "private", role: "pilot" },
    });
    expect(serializeGenericCsvMapping(reordered)).toBe(
      serializeGenericCsvMapping(mapping),
    );
    expect(fingerprintGenericCsvMapping(reordered)).toBe(
      fingerprintGenericCsvMapping(mapping),
    );
  });

  it.each([
    [{ ...genericMapping(), version: 99 }, "unsupported-mapping-version"],
    [{ ...genericMapping(), presetId: "invented" }, "unsupported-preset"],
    [{ ...genericMapping(), hidden: true }, "invalid-mapping"],
    [
      { ...genericMapping(), columns: { ...genericMapping().columns, secret: "x" } },
      "invalid-mapping-columns",
    ],
    [{ ...genericMapping(), dateFormat: "guess" }, "invalid-date-format"],
    [
      { ...genericMapping(), defaults: { kind: "private", role: "captain" } },
      "invalid-default-role",
    ],
    [
      {
        ...genericMapping(),
        columns: { ...genericMapping().columns, departureTime: "Off blocks" },
      },
      "missing-mapped-field-format",
    ],
  ])("rejects unsafe mapping payloads with code %s", (value, code) => {
    expect(() => parseGenericCsvMapping(value)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("bounds serialized mapping and mapped header size", () => {
    expect(() =>
      parseGenericCsvMapping({
        ...genericMapping(),
        padding: "x".repeat(9_000),
      }),
    ).toThrowError(expect.objectContaining({ code: "mapping-too-large" }));
    expect(() =>
      parseGenericCsvMapping({
        ...genericMapping(),
        columns: {
          ...genericMapping().columns,
          aircraft: "x".repeat(101),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-mapped-header" }));
  });

  it("stages mapped rows through owner-scoped review/dedupe and scrubs raw rows on commit", async () => {
    const store = repository();
    const staged = await stageMappedFlightImport(
      owner,
      upload(generic),
      genericMapping(),
      { imports: store, flights: store, airports: store },
    );
    expect(staged).toMatchObject({ status: "review", reused: false });
    const [row] = (await store.getRowsForCommit(owner, staged.batchId)) ?? [];
    expect(row).toMatchObject({
      commitReady: true,
      provenance: { adapterId: "generic-csv-v1", source: "CSV" },
    });
    expect(row.rawSnapshot).not.toBeNull();
    await decideImportRows(
      owner,
      staged.batchId,
      { decisions: [{ rowId: row.id, action: "accepted" }] },
      store,
    );
    await commitImportBatch(owner, staged.batchId, store, store);
    expect((await store.getRowsForCommit(owner, staged.batchId))?.[0].rawSnapshot)
      .toBeNull();
    expect(await store.listFlights(owner)).toHaveLength(1);
    expect(await store.listFlights("owner-b")).toEqual([]);

    const rerun = await stageMappedFlightImport(
      owner,
      upload(generic),
      genericMapping(),
      { imports: store, flights: store, airports: store },
    );
    expect(rerun).toMatchObject({
      batchId: staged.batchId,
      status: "committed",
      reused: true,
    });
  });
});

function genericMapping(): GenericCsvMapping {
  return {
    version: 1,
    columns: {
      date: "Flight Date",
      origin: "Departure",
      destination: "Arrival",
      duration: "Elapsed Minutes",
      aircraftModel: "Airframe",
      registration: "Tail",
      role: "Role",
    },
    defaults: { kind: "private", role: "pilot" },
    dateFormat: "mdy",
    durationFormat: "minutes",
  };
}

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
    "utf8",
  );
}

function upload(content: string) {
  return {
    fileName: "synthetic-logbook.csv",
    mimeType: "text/csv",
    sizeBytes: Buffer.byteLength(content),
    content,
  };
}

function repository(): InMemoryImportRepository {
  const airport = (code: string) => ({
    code,
    name: `Synthetic ${code}`,
    city: code,
    country: "US",
    lat: 0,
    lon: 0,
    facility: "commercial" as const,
  });
  return new InMemoryImportRepository([
    { id: "sea", airport: airport("KSEA"), aliases: ["KSEA"] },
    { id: "pdx", airport: airport("KPDX"), aliases: ["KPDX"] },
    { id: "jfk", airport: airport("KJFK"), aliases: ["KJFK"] },
  ]);
}
