import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { InMemoryImportRepository } from "./in-memory-repository";
import type { StoredImportRow } from "./types";
import { stageFlightImport } from "./worker";

/**
 * ForeFlight source-row identity.
 *
 * The defect these tests exist to keep fixed: the stable identity of a flight
 * row was projected from `aircraftDisplayName`, which is *resolved out of the
 * export's Aircraft Table* rather than read from the flight row. Renaming a
 * type code, or exporting the same logbook from an account whose aircraft
 * table had since been edited, therefore rewrote the identity of every flight
 * flown in that aircraft. The reimport recognised none of its own rows and
 * committed a second copy of each one, silently.
 *
 * Every export below leaves `TimeOut` blank on purpose. That is the collision
 * class the v3 fingerprint uses the source-row key for, so it is also the
 * class where a source-row key that moves does the most damage.
 */

const AIRCRAFT_HEADER =
  "AircraftID,TypeCode,Year,Make,Model,GearType,EngineType,equipType (FAA),aircraftClass (FAA)";
const FLIGHT_HEADER =
  "Date,AircraftID,From,To,Distance,TimeOut,TotalTime,PilotComments";

const OUTBOUND = "2026-05-01,SYNTH-1,KMFR,KEUG,120,,1.4,Outbound";
const RETURN = "2026-05-01,SYNTH-1,KEUG,KMFR,120,,1.3,Return";

function foreFlightExport({
  typeCode = "C172",
  make = "Example Aviation",
  model = "Trainer",
  flightRows = [OUTBOUND, RETURN],
  leadingRow = false,
}: {
  typeCode?: string;
  make?: string;
  model?: string;
  flightRows?: string[];
  leadingRow?: boolean;
} = {}): string {
  return [
    "ForeFlight Logbook Import",
    "",
    "Aircraft Table",
    AIRCRAFT_HEADER,
    `SYNTH-1,${typeCode},2020,${make},${model},Fixed Tricycle,Reciprocating,airplane,Airplane Single Engine Land`,
    "Flights Table",
    FLIGHT_HEADER,
    ...(leadingRow
      ? ["2026-04-30,SYNTH-1,KEUG,KMFR,120,,1.4,Older flight found later"]
      : []),
    ...flightRows,
    "",
  ].join("\n");
}

const airport = (code: string): Airport => ({
  code,
  name: `Synthetic ${code}`,
  city: "Example",
  country: "US",
  lat: 42,
  lon: -123,
  facility: "general-aviation",
});

function repository(): InMemoryImportRepository {
  return new InMemoryImportRepository([
    {
      id: "00000000-0000-4000-8000-000000000001",
      airport: airport("KMFR"),
      aliases: ["KMFR"],
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      airport: airport("KEUG"),
      aliases: ["KEUG"],
    },
  ]);
}

async function stage(
  repositories: InMemoryImportRepository,
  content: string,
  fileName: string,
): Promise<StoredImportRow[]> {
  const response = await stageFlightImport(
    "user-1",
    {
      fileName,
      mimeType: "text/csv",
      sizeBytes: content.length,
      content,
    },
    {
      imports: repositories,
      flights: repositories,
      airports: repositories,
    },
  );
  const rows = await repositories.getRowsForCommit("user-1", response.batchId);
  if (!rows) throw new Error("staged rows are missing");
  return rows;
}

async function commit(
  repositories: InMemoryImportRepository,
  rows: StoredImportRow[],
): Promise<void> {
  const batchId = rows[0].batchId;
  await repositories.applyDecisions(
    "user-1",
    batchId,
    rows.map((row) => ({ rowId: row.id, action: "accepted" as const })),
  );
  const batch = await repositories.getBatch("user-1", batchId);
  if (!batch) throw new Error("batch is missing");
  const decided = await repositories.getRowsForCommit("user-1", batchId);
  if (!decided) throw new Error("decided rows are missing");
  await repositories.commitAcceptedImport("user-1", { batch, rows: decided });
}

describe("ForeFlight source-row identity", () => {
  it("adopts the same rows after an Aircraft Table edit instead of duplicating them", async () => {
    const repositories = repository();
    const first = await stage(repositories, foreFlightExport(), "logbook.csv");
    expect(first).toHaveLength(2);
    expect(first.every((row) => row.commitReady)).toBe(true);
    // Nothing to adopt on a first import: these are genuinely new.
    expect(first.every((row) => !row.duplicateCandidate)).toBe(true);
    await commit(repositories, first);
    expect(await repositories.listFlights("user-1")).toHaveLength(2);

    // Re-exported months later. Same flights, same rows — but the aircraft
    // was re-registered in the Aircraft Table with a corrected type code and
    // a different make/model. None of that is a statement about *which
    // flight this row is*, and none of it appears in the flight rows.
    const second = await stage(
      repositories,
      foreFlightExport({
        typeCode: "C172S",
        make: "Cessna",
        model: "Skyhawk SP",
      }),
      "logbook-reexport.csv",
    );

    expect(second).toHaveLength(2);
    for (const row of second) {
      expect(row.duplicateCandidate).toBeDefined();
      expect(row.duplicateCandidate?.scope).toBe("existing-flight");
    }
    // Each staged row adopts a *distinct* existing flight, so the legs do not
    // both collapse onto whichever one was committed first.
    expect(
      new Set(second.map((row) => row.duplicateCandidate?.candidateId)).size,
    ).toBe(2);
    // The source-row key is what carries this, and it did not move.
    expect(second.map((row) => row.provenance.sourceRowKey)).toEqual(
      first.map((row) => row.provenance.sourceRowKey),
    );
    // The resolved display name *did* change, which is the point: identity is
    // independent of it rather than merely unaffected because nothing moved.
    expect(second[0].proposedFlight.aircraft).not.toBe(
      first[0].proposedFlight.aircraft,
    );
  });

  it("still distinguishes two identical blank-TimeOut rows in the same file", async () => {
    // The identity fix must not go the other way either: dropping the
    // Aircraft-Table-derived term must not make two same-day, same-route,
    // blank-time legs collapse into one flight, which is the original
    // data-loss bug.
    const repositories = repository();
    const rows = await stage(
      repositories,
      foreFlightExport({ flightRows: [OUTBOUND, OUTBOUND] }),
      "logbook.csv",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].provenance.sourceRowKey).not.toBe(
      rows[1].provenance.sourceRowKey,
    );
    expect(rows[0].rowFingerprint?.value).not.toBe(
      rows[1].rowFingerprint?.value,
    );
    // They are surfaced for review rather than silently merged or silently
    // doubled — the pilot decides which it is.
    expect(rows[1].duplicateCandidate?.scope).toBe("staged-row");
  });

  it("keeps identity stable when a re-export inserts a row above it", async () => {
    const repositories = repository();
    const before = await stage(repositories, foreFlightExport(), "logbook.csv");
    const after = await stage(
      repositories,
      foreFlightExport({ leadingRow: true }),
      "logbook-with-older-flight.csv",
    );
    // The predecessor keyed on the source row ordinal, so one older flight
    // added at the top renumbered everything below it and the whole file
    // looked new.
    expect(after.slice(1).map((row) => row.provenance.sourceRowKey)).toEqual(
      before.map((row) => row.provenance.sourceRowKey),
    );
  });
});
