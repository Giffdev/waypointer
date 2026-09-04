import {
  DEFAULT_INSPECTION_CHARACTERS,
  DEFAULT_INSPECTION_RECORDS,
  readCsvRecords,
  type CsvRecord,
} from "./csv.ts";
import {
  FOREFLIGHT_CSV_ADAPTER,
  FOREFLIGHT_V1_AIRCRAFT_HEADERS,
  FOREFLIGHT_V1_FLIGHT_HEADERS,
  parseForeFlightCsv,
  type ForeFlightParseResult,
} from "./foreflight.ts";
import {
  MY_FLIGHTRADAR24_CSV_ADAPTER,
  MY_FLIGHTRADAR24_V1_HEADERS,
  parseMyFlightRadar24Csv,
  type MyFlightRadar24ParseResult,
} from "./myflightradar24.ts";
import {
  GENERIC_CSV_PRESETS,
  type GenericCsvPresetMetadata,
} from "./generic-csv.ts";

export const FLIGHT_IMPORT_DETECTION_THRESHOLD = 0.9;
/**
 * Detection budget. Expressed in logical CSV records and characters, never in
 * physical lines: a quoted remark spanning newlines and a several-hundred-row
 * Aircraft Table are both normal, and the old 256-physical-line window pushed
 * the `Flights Table` marker out of range and reported a valid export as an
 * unsupported format. The size ceiling is preserved, only the unit changed.
 */
const MAX_INSPECTION_CHARACTERS = DEFAULT_INSPECTION_CHARACTERS;
const MAX_INSPECTION_RECORDS = DEFAULT_INSPECTION_RECORDS;
/** Confidence a partial signature must reach before truncation is worth reporting. */
export const TRUNCATION_DISCLOSURE_THRESHOLD = 0.45;

export type AdapterDetectionEvidence = {
  confidence: number;
  reasons: string[];
};

export type FlightImportAdapter = {
  id: string;
  label: string;
  source: string;
  detect: (input: string) => AdapterDetectionEvidence;
  parse: (input: string) => unknown;
};

export type FlightImportFormatMetadata = {
  id: string;
  label: string;
  capability: "automatic" | "mapping-preset" | "generic-mapping";
  description: string;
  documentationUrl?: string;
  supportsExplicitMapping: boolean;
  acceptedExtensions: readonly [".csv"];
  presets?: GenericCsvPresetMetadata[];
};

export type FlightImportDetectionCandidate = {
  adapterId: string;
  label: string;
  source: string;
  confidence: number;
  reasons: string[];
};

export type FlightImportDetection =
  | {
      status: "recognized";
      adapterId: string;
      label: string;
      source: string;
      confidence: number;
      reason: string;
    }
  | {
      status: "ambiguous";
      candidates: FlightImportDetectionCandidate[];
      reason: string;
    }
  | {
      status: "unsupported";
      candidates: FlightImportDetectionCandidate[];
      reason: string;
    };

export type ParsedFlightImport =
  | {
      status: "parsed";
      adapterId: "foreflight-v1";
      label: string;
      source: typeof FOREFLIGHT_CSV_ADAPTER.source;
      confidence: number;
      parsed: ForeFlightParseResult;
    }
  | {
      status: "parsed";
      adapterId: "myflightradar24-v1";
      label: string;
      source: typeof MY_FLIGHTRADAR24_CSV_ADAPTER.source;
      confidence: number;
      parsed: MyFlightRadar24ParseResult;
    }
  | {
      status: "invalid";
      adapterId: string;
      label: string;
      source: string;
      confidence: number;
      errorCode: string;
      reason: string;
    }
  | Exclude<FlightImportDetection, { status: "recognized" }>;

const foreFlightAdapter: FlightImportAdapter = {
  id: "foreflight-v1",
  label: "ForeFlight Logbook Import",
  source: FOREFLIGHT_CSV_ADAPTER.source,
  detect: detectForeFlight,
  parse: parseForeFlightCsv,
};

const myFlightRadar24Adapter: FlightImportAdapter = {
  id: "myflightradar24-v1",
  label: "myFlightradar24 Flight Diary CSV",
  source: MY_FLIGHTRADAR24_CSV_ADAPTER.source,
  detect: detectMyFlightRadar24,
  parse: parseMyFlightRadar24Csv,
};

export const FLIGHT_IMPORT_ADAPTERS = [
  foreFlightAdapter,
  myFlightRadar24Adapter,
] as const;

export const FLIGHT_IMPORT_FORMATS: readonly FlightImportFormatMetadata[] = [
  {
    id: "foreflight-v1",
    label: "ForeFlight Logbook",
    capability: "automatic",
    description: "Detected and parsed from the documented ForeFlight export layout.",
    supportsExplicitMapping: false,
    acceptedExtensions: [".csv"],
  },
  {
    id: "myflightradar24-v1",
    label: "myFlightradar24 Flight Diary",
    capability: "automatic",
    description: "Detected and parsed from the exact official CSV header.",
    supportsExplicitMapping: false,
    acceptedExtensions: [".csv"],
  },
  {
    id: "generic-csv-v1",
    label: "Digital logbook CSV",
    capability: "generic-mapping",
    description:
      "Detect headers, map date and airports plus optional fields, then preview validation before staging.",
    supportsExplicitMapping: true,
    acceptedExtensions: [".csv"],
    presets: GENERIC_CSV_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      evidenceUrl: preset.evidenceUrl,
      requiredHeaders: preset.requiredHeaders,
      optionalHeaders: preset.optionalHeaders,
    })),
  },
] as const;

export function detectFlightImportFormat(
  input: string,
  adapters: readonly FlightImportAdapter[] = FLIGHT_IMPORT_ADAPTERS,
): FlightImportDetection {
  const candidates = adapters
    .map((adapter): FlightImportDetectionCandidate => {
      const evidence = adapter.detect(input);
      return {
        adapterId: adapter.id,
        label: adapter.label,
        source: adapter.source,
        confidence: clampConfidence(evidence.confidence),
        reasons: evidence.reasons,
      };
    })
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.adapterId.localeCompare(right.adapterId),
    );
  const qualified = candidates.filter(
    ({ confidence }) => confidence >= FLIGHT_IMPORT_DETECTION_THRESHOLD,
  );

  if (qualified.length === 1) {
    const [selected] = qualified;
    return {
      status: "recognized",
      adapterId: selected.adapterId,
      label: selected.label,
      source: selected.source,
      confidence: selected.confidence,
      reason: selected.reasons.join("; "),
    };
  }
  if (qualified.length > 1) {
    return {
      status: "ambiguous",
      candidates: qualified,
      reason:
        "Multiple implemented adapters met the confidence threshold; no adapter was selected.",
    };
  }
  const truncated = candidates.some((candidate) =>
    candidate.reasons.some((reason) =>
      reason.startsWith("inspection-truncated"),
    ),
  );
  return {
    status: "unsupported",
    candidates: candidates.filter(({ confidence }) => confidence > 0),
    reason: truncated
      ? "detection-truncated: the file matched a known export signature but the inspection stopped before the rest of it could be read."
      : "No implemented adapter met the confidence threshold; the file was not parsed.",
  };
}

export function parseFlightImport(input: string): ParsedFlightImport {
  const detection = detectFlightImportFormat(input);
  if (detection.status !== "recognized") return detection;

  try {
    if (detection.adapterId === "foreflight-v1") {
      return {
        status: "parsed",
        adapterId: detection.adapterId,
        label: detection.label,
        source: FOREFLIGHT_CSV_ADAPTER.source,
        confidence: detection.confidence,
        parsed: parseForeFlightCsv(input),
      };
    }
    if (detection.adapterId === "myflightradar24-v1") {
      return {
        status: "parsed",
        adapterId: detection.adapterId,
        label: detection.label,
        source: MY_FLIGHTRADAR24_CSV_ADAPTER.source,
        confidence: detection.confidence,
        parsed: parseMyFlightRadar24Csv(input),
      };
    }
    return {
      status: "invalid",
      adapterId: detection.adapterId,
      label: detection.label,
      source: detection.source,
      confidence: detection.confidence,
      errorCode: "adapter-unavailable",
      reason: "The detected adapter is not available to the parser.",
    };
  } catch (error) {
    return {
      status: "invalid",
      adapterId: detection.adapterId,
      label: detection.label,
      source: detection.source,
      confidence: detection.confidence,
      errorCode: importErrorCode(error),
      reason:
        "The format was recognized, but the file did not pass that adapter's validation.",
    };
  }
}

function detectForeFlight(input: string): AdapterDetectionEvidence {
  const inspection = inspectionRecords(input);
  const records = inspection.records;
  const first = firstNonEmptyCell(records);
  let confidence = 0;
  const reasons: string[] = [];

  if (first === FOREFLIGHT_CSV_ADAPTER.format) {
    confidence += 0.45;
    reasons.push("The first non-empty record has the ForeFlight export signature");
  }
  const aircraftHeader = headerAfterMarker(records, "Aircraft Table");
  if (
    aircraftHeader &&
    hasHeaders(aircraftHeader, FOREFLIGHT_V1_AIRCRAFT_HEADERS)
  ) {
    confidence += 0.25;
    reasons.push("The aircraft table has all required ForeFlight v1 headers");
  }
  const flightHeader = headerAfterMarker(records, "Flights Table");
  if (
    flightHeader &&
    hasHeaders(flightHeader, FOREFLIGHT_V1_FLIGHT_HEADERS)
  ) {
    confidence += 0.3;
    reasons.push("The flights table has all required ForeFlight v1 headers");
  } else if (
    inspection.truncated &&
    confidence >= TRUNCATION_DISCLOSURE_THRESHOLD
  ) {
    // We stopped reading; we did not conclude the format is wrong. Saying
    // "unsupported format" here would be a lie the user cannot act on.
    reasons.push(
      "inspection-truncated: the file matched the ForeFlight signature but the flights table was not reached before the read stopped",
    );
  }

  return { confidence, reasons };
}

function detectMyFlightRadar24(input: string): AdapterDetectionEvidence {
  const { records } = inspectionRecords(input);
  const firstIndex = records.findIndex((record) => !isBlankRecord(record));
  const header = firstIndex < 0 ? undefined : trimmedCells(records[firstIndex]);
  let confidence = 0;
  const reasons: string[] = [];

  if (
    header &&
    header.length === MY_FLIGHTRADAR24_V1_HEADERS.length &&
    header.every(
      (value, index) => value === MY_FLIGHTRADAR24_V1_HEADERS[index],
    )
  ) {
    confidence += 0.94;
    reasons.push("The first non-empty record is the exact myFlightradar24 v1 header");
  }

  const firstDataRecord = records
    .slice(firstIndex + 1)
    .find((record) => !isBlankRecord(record));
  const row = firstDataRecord ? trimmedCells(firstDataRecord) : undefined;
  if (
    confidence > 0 &&
    row?.length === MY_FLIGHTRADAR24_V1_HEADERS.length &&
    /^\d{4}-\d{2}-\d{2}$/.test(row[0] ?? "") &&
    /\([A-Z]{3}\/[A-Z0-9]{4}\)$/.test(row[2] ?? "") &&
    /\([A-Z]{3}\/[A-Z0-9]{4}\)$/.test(row[3] ?? "")
  ) {
    confidence += 0.06;
    reasons.push("A data record matches the expected date and airport signature");
  }

  return { confidence, reasons };
}

function inspectionRecords(input: string): {
  records: CsvRecord[];
  truncated: boolean;
} {
  // Lenient on purpose. A syntax error is an answer about the file's
  // *contents*; detection is asking about its *identity*. Discarding every
  // record before the fault made one stray quote in a trailing remark enough
  // to report a valid ForeFlight export as an unsupported format. The records
  // read before the fault still identify the format, and `truncated` makes the
  // shortfall visible so an unrecognised result says "we stopped reading"
  // rather than "we don't support this". The import path keeps the strict
  // reader, so a malformed file still fails loudly rather than importing
  // short.
  const result = readCsvRecords(input, {
    maxRecords: MAX_INSPECTION_RECORDS,
    maxCharacters: MAX_INSPECTION_CHARACTERS,
    onSyntaxError: "truncate",
  });
  return { records: result.records, truncated: result.truncated };
}

function trimmedCells(record: CsvRecord): string[] {
  return record.cells.map((cell) => cell.trim());
}

function isBlankRecord(record: CsvRecord): boolean {
  return record.cells.every((cell) => cell.trim() === "");
}

function firstNonEmptyCell(records: CsvRecord[]): string | undefined {
  const record = records.find((candidate) => !isBlankRecord(candidate));
  return record ? trimmedCells(record)[0] : undefined;
}

function headerAfterMarker(
  records: CsvRecord[],
  marker: string,
): string[] | undefined {
  const markerIndex = records.findIndex(
    (record) => trimmedCells(record)[0] === marker,
  );
  if (markerIndex < 0) return undefined;
  const header = records
    .slice(markerIndex + 1)
    .find((record) => !isBlankRecord(record));
  return header ? trimmedCells(header) : undefined;
}

function hasHeaders(actual: string[], required: readonly string[]): boolean {
  const names = new Set(actual);
  return required.every((header) => names.has(header));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Number(value.toFixed(2))));
}

function importErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "invalid-document";
}
