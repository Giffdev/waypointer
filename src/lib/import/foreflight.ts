import { parseCsv, type CsvRecord } from "./csv.ts";
import type { ImportIssue } from "./types.ts";
import type {
  CivilDate,
  StatsValueStatus,
} from "../flight-statistics.ts";

export const FOREFLIGHT_CSV_ADAPTER = {
  source: "ForeFlight",
  format: "ForeFlight Logbook Import",
  version: 1,
} as const;

export type ForeFlightAircraft = {
  sourceRowNumber: number;
  sourceAircraftId: string;
  typeCode?: string;
  year?: string;
  make?: string;
  model?: string;
  gearType?: string;
  engineType?: string;
  equipmentType?: string;
  aircraftClass?: string;
  displayName: string;
  category?: string;
};

export type ForeFlightAircraftResolution =
  | { status: "missing" }
  | { status: "unknown"; sourceAircraftId: string }
  | { status: "resolved"; aircraft: ForeFlightAircraft }
  | { status: "ambiguous"; sourceAircraftId: string; candidateRowNumbers: number[] };

export type ForeFlightProvenance = {
  source: typeof FOREFLIGHT_CSV_ADAPTER.source;
  adapter: typeof FOREFLIGHT_CSV_ADAPTER.format;
  adapterVersion: typeof FOREFLIGHT_CSV_ADAPTER.version;
  sourceRowNumber: number;
  original: {
    date: string;
    aircraftId: string;
    originIdentifier: string;
    destinationIdentifier: string;
    distance: string;
    timeOut: string;
    totalTime: string;
  };
};

export type ForeFlightFlight = {
  sourceRowNumber: number;
  date?: CivilDate;
  departureTime?: string;
  originIdentifier?: string;
  destinationIdentifier?: string;
  distanceNauticalMiles?: number;
  totalTimeHours?: number;
  totalTimeStatus: StatsValueStatus;
  distanceStatus: StatsValueStatus;
  hobbsElapsedHours?: number;
  hobbsStatus: StatsValueStatus;
  simulatedFlightHours?: number;
  groundTrainingHours?: number;
  groundTrainingGivenHours?: number;
  aircraft: ForeFlightAircraftResolution;
  aircraftDisplayName: string;
  aircraftType?: string;
  aircraftModel?: string;
  aircraftCategory?: string;
  registration?: string;
  kind: "private";
  issues: ImportIssue[];
  provenance: ForeFlightProvenance;
};

export type ForeFlightParseResult = {
  adapter: typeof FOREFLIGHT_CSV_ADAPTER;
  aircraft: ForeFlightAircraft[];
  flights: ForeFlightFlight[];
};

type DocumentErrorCode =
  | "not-foreflight"
  | "missing-aircraft-table"
  | "missing-flights-table"
  | "missing-required-column";

export class ForeFlightImportError extends Error {
  readonly code: DocumentErrorCode;
  readonly rowNumber?: number;

  constructor(code: DocumentErrorCode, message: string, rowNumber?: number) {
    super(rowNumber ? `${message} (CSV row ${rowNumber})` : message);
    this.name = "ForeFlightImportError";
    this.code = code;
    this.rowNumber = rowNumber;
  }
}

export const FOREFLIGHT_V1_AIRCRAFT_HEADERS = [
  "AircraftID",
  "TypeCode",
  "Make",
  "Model",
  "equipType (FAA)",
  "aircraftClass (FAA)",
] as const;

export const FOREFLIGHT_V1_FLIGHT_HEADERS = [
  "Date",
  "AircraftID",
  "From",
  "To",
  "Distance",
  "TimeOut",
  "TotalTime",
] as const;

function firstCell(record: CsvRecord): string {
  return record.cells[0]?.trim() ?? "";
}

function isEmptyRecord(record: CsvRecord): boolean {
  return record.cells.every((cell) => cell.trim() === "");
}

function headerIndexes(
  record: CsvRecord,
  requiredColumns: readonly string[],
): Map<string, number> {
  const indexes = new Map<string, number>();
  record.cells.forEach((cell, index) => {
    const name = cell.trim();
    if (name && !indexes.has(name)) indexes.set(name, index);
  });

  for (const column of requiredColumns) {
    if (!indexes.has(column)) {
      throw new ForeFlightImportError(
        "missing-required-column",
        `ForeFlight ${FOREFLIGHT_CSV_ADAPTER.version} requires the "${column}" column`,
        record.rowNumber,
      );
    }
  }
  return indexes;
}

function value(record: CsvRecord, indexes: Map<string, number>, column: string): string {
  const index = indexes.get(column);
  return index === undefined ? "" : (record.cells[index] ?? "").trim();
}

function normalizeOptionalText(raw: string): string | undefined {
  const normalized = raw.trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

function normalizeAircraftCategory(raw: string): string | undefined {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || undefined;
}

const US_N_NUMBER =
  /^N(?:[1-9]\d{0,4}|[1-9]\d{0,3}[A-HJ-NP-Z]|[1-9]\d{0,2}[A-HJ-NP-Z]{2})$/;

export function registrationFromForeFlightAircraftId(
  raw: string | null | undefined,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toUpperCase();
  return US_N_NUMBER.test(normalized) ? normalized : undefined;
}

function parseAircraft(
  record: CsvRecord,
  indexes: Map<string, number>,
): ForeFlightAircraft {
  const sourceAircraftId = value(record, indexes, "AircraftID");
  const typeCode = normalizeOptionalText(value(record, indexes, "TypeCode"))?.toUpperCase();
  const make = normalizeOptionalText(value(record, indexes, "Make"));
  const model = normalizeOptionalText(value(record, indexes, "Model"));
  const displayName = typeCode || [make, model].filter(Boolean).join(" ") || "Unknown aircraft";

  return {
    sourceRowNumber: record.rowNumber,
    sourceAircraftId,
    typeCode,
    year: normalizeOptionalText(value(record, indexes, "Year")),
    make,
    model,
    gearType: normalizeOptionalText(value(record, indexes, "GearType")),
    engineType: normalizeOptionalText(value(record, indexes, "EngineType")),
    equipmentType: normalizeOptionalText(value(record, indexes, "equipType (FAA)")),
    aircraftClass: normalizeOptionalText(value(record, indexes, "aircraftClass (FAA)")),
    displayName,
    category: normalizeAircraftCategory(value(record, indexes, "aircraftClass (FAA)")),
  };
}

function normalizeDate(
  raw: string,
  issues: ImportIssue[],
): CivilDate | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    issues.push({
      code: "invalid-date",
      field: "Date",
      message: "Date must use the ForeFlight YYYY-MM-DD format",
      severity: "error",
    });
    return undefined;
  }

  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    issues.push({
      code: "invalid-date",
      field: "Date",
      message: "Date is not a valid calendar date",
      severity: "error",
    });
    return undefined;
  }
  return raw as CivilDate;
}

function normalizeTime(raw: string, issues: ImportIssue[]): string | undefined {
  if (!raw) return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) {
    issues.push({
      code: "invalid-time",
      field: "TimeOut",
      message: "TimeOut must use 24-hour H:MM or HH:MM format",
      severity: "warning",
    });
    return undefined;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeAirportIdentifier(
  raw: string,
  field: "From" | "To",
  issues: ImportIssue[],
): string | undefined {
  const normalized = raw.trim().toUpperCase();
  if (!normalized) {
    issues.push({
      code: "missing-airport",
      field,
      message: `${field} airport is required for a map-ready flight`,
      severity: "error",
    });
    return undefined;
  }
  if (!/^[A-Z0-9][A-Z0-9-]{1,9}$/.test(normalized)) {
    issues.push({
      code: "invalid-airport-identifier",
      field,
      message: `${field} airport is not a supported identifier`,
      severity: "error",
    });
    return undefined;
  }
  return normalized;
}

function normalizeNumber(
  raw: string,
  field: string,
  issues: ImportIssue[],
): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    issues.push({
      code: "invalid-number",
      field,
      message: `${field} must be a non-negative number`,
      severity: "warning",
    });
    return undefined;
  }
  return parsed;
}

function valueStatus(
  raw: string,
  normalized: number | undefined,
): StatsValueStatus {
  if (!raw) return "missing";
  return normalized === undefined ? "invalid" : "known";
}

function normalizeHobbs(
  startRaw: string,
  endRaw: string,
  issues: ImportIssue[],
): { elapsedHours?: number; status: StatsValueStatus } {
  if (!startRaw || !endRaw) return { status: "missing" };
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    issues.push({
      code: "invalid-hobbs",
      field: "HobbsStart/HobbsEnd",
      message: "Hobbs elapsed time requires numeric readings with end greater than start",
      severity: "warning",
    });
    return { status: "invalid" };
  }
  return {
    elapsedHours: Number((end - start).toFixed(3)),
    status: "known",
  };
}

function aircraftResolution(
  sourceAircraftId: string,
  aircraftById: Map<string, ForeFlightAircraft[]>,
  issues: ImportIssue[],
): ForeFlightAircraftResolution {
  if (!sourceAircraftId) return { status: "missing" };
  const candidates = aircraftById.get(sourceAircraftId) ?? [];
  if (candidates.length === 0) {
    issues.push({
      code: "unknown-aircraft",
      field: "AircraftID",
      message: "AircraftID does not match the ForeFlight aircraft table",
      severity: "warning",
    });
    return { status: "unknown", sourceAircraftId };
  }
  if (candidates.length > 1) {
    issues.push({
      code: "ambiguous-aircraft",
      field: "AircraftID",
      message: "AircraftID has multiple aircraft-table definitions and needs review",
      severity: "warning",
    });
    return {
      status: "ambiguous",
      sourceAircraftId,
      candidateRowNumbers: candidates.map((candidate) => candidate.sourceRowNumber),
    };
  }
  return { status: "resolved", aircraft: candidates[0] };
}

export function parseForeFlightCsv(input: string): ForeFlightParseResult {
  const records = parseCsv(input);
  if (firstCell(records[0] ?? { cells: [], rowNumber: 1 }) !== FOREFLIGHT_CSV_ADAPTER.format) {
    throw new ForeFlightImportError(
      "not-foreflight",
      `Expected "${FOREFLIGHT_CSV_ADAPTER.format}" as the first CSV record`,
      records[0]?.rowNumber ?? 1,
    );
  }

  const aircraftMarker = records.findIndex((record) => firstCell(record) === "Aircraft Table");
  if (aircraftMarker < 0 || !records[aircraftMarker + 1]) {
    throw new ForeFlightImportError("missing-aircraft-table", "Aircraft Table section is missing");
  }
  const flightsMarker = records.findIndex((record) => firstCell(record) === "Flights Table");
  if (flightsMarker < 0 || !records[flightsMarker + 1]) {
    throw new ForeFlightImportError("missing-flights-table", "Flights Table section is missing");
  }
  if (flightsMarker <= aircraftMarker + 1) {
    throw new ForeFlightImportError(
      "missing-flights-table",
      "Flights Table must follow the Aircraft Table",
      records[flightsMarker]?.rowNumber,
    );
  }

  const aircraftHeader = records[aircraftMarker + 1];
  const flightHeader = records[flightsMarker + 1];
  const aircraftIndexes = headerIndexes(
    aircraftHeader,
    FOREFLIGHT_V1_AIRCRAFT_HEADERS,
  );
  const flightIndexes = headerIndexes(
    flightHeader,
    FOREFLIGHT_V1_FLIGHT_HEADERS,
  );
  const aircraft = records
    .slice(aircraftMarker + 2, flightsMarker)
    .filter((record) => !isEmptyRecord(record) && value(record, aircraftIndexes, "AircraftID"))
    .map((record) => parseAircraft(record, aircraftIndexes));
  const aircraftById = new Map<string, ForeFlightAircraft[]>();

  for (const item of aircraft) {
    const existing = aircraftById.get(item.sourceAircraftId) ?? [];
    existing.push(item);
    aircraftById.set(item.sourceAircraftId, existing);
  }

  const flights = records
    .slice(flightsMarker + 2)
    .filter((record) => !isEmptyRecord(record))
    .map((record): ForeFlightFlight => {
      const issues: ImportIssue[] = [];
      const raw = {
        date: value(record, flightIndexes, "Date"),
        aircraftId: value(record, flightIndexes, "AircraftID"),
        originIdentifier: value(record, flightIndexes, "From"),
        destinationIdentifier: value(record, flightIndexes, "To"),
        distance: value(record, flightIndexes, "Distance"),
        timeOut: value(record, flightIndexes, "TimeOut"),
        totalTime: value(record, flightIndexes, "TotalTime"),
      };
      const rawDistance = raw.distance;
      const rawTotalTime = raw.totalTime;
      const rawHobbsStart = value(record, flightIndexes, "HobbsStart");
      const rawHobbsEnd = value(record, flightIndexes, "HobbsEnd");
      const resolvedAircraft = aircraftResolution(raw.aircraftId, aircraftById, issues);
      const resolvedDefinition =
        resolvedAircraft.status === "resolved" ? resolvedAircraft.aircraft : undefined;
      const aircraftModel = [resolvedDefinition?.make, resolvedDefinition?.model]
        .filter(Boolean)
        .join(" ");
      const date = normalizeDate(raw.date, issues);
      const originIdentifier = normalizeAirportIdentifier(raw.originIdentifier, "From", issues);
      const destinationIdentifier = normalizeAirportIdentifier(
        raw.destinationIdentifier,
        "To",
        issues,
      );
      const distanceNauticalMiles = normalizeNumber(rawDistance, "Distance", issues);
      const totalTimeHours = normalizeNumber(rawTotalTime, "TotalTime", issues);
      const hobbs = normalizeHobbs(rawHobbsStart, rawHobbsEnd, issues);
      const departureTime = normalizeTime(raw.timeOut, issues);
      const simulatedFlightHours = normalizeNumber(
        value(record, flightIndexes, "SimulatedFlight"),
        "SimulatedFlight",
        issues,
      );
      const groundTrainingHours = normalizeNumber(
        value(record, flightIndexes, "GroundTraining"),
        "GroundTraining",
        issues,
      );
      const groundTrainingGivenHours = normalizeNumber(
        value(record, flightIndexes, "GroundTrainingGiven"),
        "GroundTrainingGiven",
        issues,
      );
      const registration = registrationFromForeFlightAircraftId(raw.aircraftId);

      return {
        sourceRowNumber: record.rowNumber,
        date,
        departureTime,
        originIdentifier,
        destinationIdentifier,
        distanceNauticalMiles,
        totalTimeHours,
        totalTimeStatus: valueStatus(rawTotalTime, totalTimeHours),
        distanceStatus: valueStatus(rawDistance, distanceNauticalMiles),
        hobbsElapsedHours: hobbs.elapsedHours,
        hobbsStatus: hobbs.status,
        simulatedFlightHours,
        groundTrainingHours,
        groundTrainingGivenHours,
        aircraft: resolvedAircraft,
        aircraftDisplayName: resolvedDefinition?.displayName ?? "Aircraft details need review",
        ...(resolvedDefinition?.typeCode
          ? { aircraftType: resolvedDefinition.typeCode }
          : {}),
        ...(aircraftModel ? { aircraftModel } : {}),
        aircraftCategory: resolvedDefinition?.category,
        ...(registration ? { registration } : {}),
        kind: "private",
        issues,
        provenance: {
          source: FOREFLIGHT_CSV_ADAPTER.source,
          adapter: FOREFLIGHT_CSV_ADAPTER.format,
          adapterVersion: FOREFLIGHT_CSV_ADAPTER.version,
          sourceRowNumber: record.rowNumber,
          original: raw,
        },
      };
    });

  return { adapter: FOREFLIGHT_CSV_ADAPTER, aircraft, flights };
}
