import { parseCsv, type CsvRecord } from "./csv.ts";
import { sha256Text } from "./sha256.ts";
import type { ImportIssue } from "./types.ts";
import type { CivilDate } from "../flight-statistics.ts";
import {
  normalizeAircraftMetadata,
  normalizeRegistrationMetadata,
} from "../flight-metadata.ts";

export const MY_FLIGHTRADAR24_CSV_ADAPTER = {
  source: "FlightRadar24",
  format: "myFlightradar24 Flight Diary CSV",
  version: 1,
} as const;

export const MY_FLIGHTRADAR24_V1_HEADERS = [
  "Date",
  "Flight number",
  "From",
  "To",
  "Dep time",
  "Arr time",
  "Duration",
  "Airline",
  "Aircraft",
  "Registration",
  "Seat number",
  "Seat type",
  "Flight class",
  "Flight reason",
  "Note",
  "Dep_id",
  "Arr_id",
  "Airline_id",
  "Aircraft_id",
] as const;

export type MyFlightRadar24Provenance = {
  source: typeof MY_FLIGHTRADAR24_CSV_ADAPTER.source;
  adapter: typeof MY_FLIGHTRADAR24_CSV_ADAPTER.format;
  adapterVersion: typeof MY_FLIGHTRADAR24_CSV_ADAPTER.version;
  sourceRowNumber: number;
  idempotencyKey: string;
};

export type MyFlightRadar24Flight = {
  sourceRowNumber: number;
  date?: CivilDate;
  departureTime?: string;
  arrivalTime?: string;
  durationMinutes?: number;
  originIdentifier?: string;
  originIcaoIdentifier?: string;
  destinationIdentifier?: string;
  destinationIcaoIdentifier?: string;
  flightNumber?: string;
  airline?: string;
  airlineCode?: string;
  aircraftModel?: string;
  registration?: string;
  kind: "commercial";
  role: "passenger";
  issues: ImportIssue[];
  provenance: MyFlightRadar24Provenance;
};

export type MyFlightRadar24ParseResult = {
  adapter: typeof MY_FLIGHTRADAR24_CSV_ADAPTER;
  flights: MyFlightRadar24Flight[];
};

type DocumentErrorCode = "empty-document" | "invalid-header" | "invalid-row-width";

export class MyFlightRadar24ImportError extends Error {
  readonly code: DocumentErrorCode;
  readonly rowNumber?: number;

  constructor(code: DocumentErrorCode, message: string, rowNumber?: number) {
    super(rowNumber ? `${message} (CSV row ${rowNumber})` : message);
    this.name = "MyFlightRadar24ImportError";
    this.code = code;
    this.rowNumber = rowNumber;
  }
}

function isEmptyRecord(record: CsvRecord): boolean {
  return record.cells.every((cell) => cell.trim() === "");
}

function value(record: CsvRecord, indexes: Map<string, number>, column: string): string {
  return (record.cells[indexes.get(column) ?? -1] ?? "").trim();
}

function normalizeText(raw: string): string | undefined {
  return raw.trim().replace(/\s+/g, " ") || undefined;
}

function normalizeCode(raw: string): string | undefined {
  return normalizeText(raw)?.toUpperCase();
}

function normalizeDate(
  raw: string,
  issues: ImportIssue[],
): CivilDate | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    issues.push({
      code: "invalid-date",
      field: "Date",
      message: "Date must use the YYYY-MM-DD format",
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

function normalizeTime(
  raw: string,
  field: "Dep time" | "Arr time",
  issues: ImportIssue[],
): string | undefined {
  if (!raw) return undefined;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  const second = Number(match?.[3] ?? 0);
  if (!match || hour > 23 || minute > 59 || second > 59) {
    issues.push({
      code: "invalid-time",
      field,
      message: `${field} must use 24-hour H:MM, HH:MM, or HH:MM:SS format`,
      severity: "error",
    });
    return undefined;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function normalizeDuration(raw: string, issues: ImportIssue[]): number | undefined {
  const match = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  const seconds = Number(match?.[3] ?? 0);
  if (!match || minutes > 59 || seconds > 59) {
    issues.push({
      code: "invalid-duration",
      field: "Duration",
      message: "Duration must use H:MM, HH:MM, or HH:MM:SS format",
      severity: "warning",
    });
    return undefined;
  }
  return Math.round((hours * 60 + minutes + seconds / 60) * 10) / 10;
}

function normalizeAirportDisplay(
  raw: string,
  field: "From" | "To",
  issues: ImportIssue[],
): { iata: string; icao: string } | undefined {
  const normalized = normalizeText(raw);
  if (!normalized) {
    issues.push({
      code: "missing-airport",
      field,
      message: `${field} is required for a map-ready flight`,
      severity: "error",
    });
    return undefined;
  }
  const match = /\(([A-Z]{3})\/([A-Z0-9]{4})\)$/.exec(normalized);
  if (!match) {
    issues.push({
      code: "invalid-airport-identifier",
      field,
      message: `${field} must end with the official (IATA/ICAO) identifier pair`,
      severity: "error",
    });
    return undefined;
  }
  return { iata: match[1], icao: match[2] };
}

function idempotencyKey(parts: string[]): string {
  return sha256Text(parts.join("\u001f"));
}

export function parseMyFlightRadar24Csv(input: string): MyFlightRadar24ParseResult {
  const records = parseCsv(input);
  const headerIndex = records.findIndex((record) => !isEmptyRecord(record));
  if (headerIndex < 0) {
    throw new MyFlightRadar24ImportError("empty-document", "myFlightradar24 CSV is empty");
  }

  const header = records[headerIndex];
  const actualHeaders = header.cells.map((cell) => cell.trim());
  if (
    actualHeaders.length !== MY_FLIGHTRADAR24_V1_HEADERS.length ||
    actualHeaders.some((valueToCheck, index) => valueToCheck !== MY_FLIGHTRADAR24_V1_HEADERS[index])
  ) {
    throw new MyFlightRadar24ImportError(
      "invalid-header",
      `myFlightradar24 adapter v${MY_FLIGHTRADAR24_CSV_ADAPTER.version} requires the exact official ${MY_FLIGHTRADAR24_V1_HEADERS.length}-column header`,
      header.rowNumber,
    );
  }
  const indexes = new Map(actualHeaders.map((name, index) => [name, index]));

  const flights = records
    .slice(headerIndex + 1)
    .filter((record) => !isEmptyRecord(record))
    .map((record): MyFlightRadar24Flight => {
      if (record.cells.length !== MY_FLIGHTRADAR24_V1_HEADERS.length) {
        throw new MyFlightRadar24ImportError(
          "invalid-row-width",
          `Expected ${MY_FLIGHTRADAR24_V1_HEADERS.length} columns but found ${record.cells.length}`,
          record.rowNumber,
        );
      }

      const issues: ImportIssue[] = [];
      const date = normalizeDate(value(record, indexes, "Date"), issues);
      const departureTime = normalizeTime(value(record, indexes, "Dep time"), "Dep time", issues);
      const arrivalTime = normalizeTime(value(record, indexes, "Arr time"), "Arr time", issues);
      const durationMinutes = normalizeDuration(value(record, indexes, "Duration"), issues);
      const origin = normalizeAirportDisplay(
        value(record, indexes, "From"),
        "From",
        issues,
      );
      const destination = normalizeAirportDisplay(
        value(record, indexes, "To"),
        "To",
        issues,
      );
      const originIdentifier = origin?.iata;
      const originIcaoIdentifier = origin?.icao;
      const destinationIdentifier = destination?.iata;
      const destinationIcaoIdentifier = destination?.icao;
      const flightNumber = normalizeCode(value(record, indexes, "Flight number"));
      const airline = normalizeText(value(record, indexes, "Airline"));
      const airlineCode = normalizeCode(value(record, indexes, "Airline_id"));
      const aircraftModel = normalizeAircraftMetadata(
        value(record, indexes, "Aircraft"),
        "explicit-model",
      );
      const registration = normalizeRegistrationMetadata(
        value(record, indexes, "Registration"),
      )?.toUpperCase();
      const stableKey = idempotencyKey([
        String(MY_FLIGHTRADAR24_CSV_ADAPTER.version),
        String(record.rowNumber),
        date ?? "",
        departureTime ?? "",
        arrivalTime ?? "",
        originIdentifier ?? "",
        originIcaoIdentifier ?? "",
        destinationIdentifier ?? "",
        destinationIcaoIdentifier ?? "",
        flightNumber ?? "",
        airlineCode ?? "",
        aircraftModel ?? "",
        registration ?? "",
      ]);

      return {
        sourceRowNumber: record.rowNumber,
        date,
        departureTime,
        arrivalTime,
        durationMinutes,
        originIdentifier,
        originIcaoIdentifier,
        destinationIdentifier,
        destinationIcaoIdentifier,
        flightNumber,
        airline,
        airlineCode,
        ...(aircraftModel ? { aircraftModel } : {}),
        ...(registration ? { registration } : {}),
        kind: "commercial",
        role: "passenger",
        issues,
        provenance: {
          source: MY_FLIGHTRADAR24_CSV_ADAPTER.source,
          adapter: MY_FLIGHTRADAR24_CSV_ADAPTER.format,
          adapterVersion: MY_FLIGHTRADAR24_CSV_ADAPTER.version,
          sourceRowNumber: record.rowNumber,
          idempotencyKey: stableKey,
        },
      };
    });

  return { adapter: MY_FLIGHTRADAR24_CSV_ADAPTER, flights };
}
