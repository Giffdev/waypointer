import { parseCsv } from "./csv.ts";
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
const MAX_INSPECTION_CHARACTERS = 256 * 1024;
const MAX_INSPECTION_LINES = 256;

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
  return {
    status: "unsupported",
    candidates: candidates.filter(({ confidence }) => confidence > 0),
    reason:
      "No implemented adapter met the confidence threshold; the file was not parsed.",
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
  const lines = inspectionLines(input);
  const first = firstNonEmptyRecordCell(lines);
  let confidence = 0;
  const reasons: string[] = [];

  if (first === FOREFLIGHT_CSV_ADAPTER.format) {
    confidence += 0.45;
    reasons.push("The first non-empty record has the ForeFlight export signature");
  }
  const aircraftHeader = headerAfterMarker(lines, "Aircraft Table");
  if (
    aircraftHeader &&
    hasHeaders(aircraftHeader, FOREFLIGHT_V1_AIRCRAFT_HEADERS)
  ) {
    confidence += 0.25;
    reasons.push("The aircraft table has all required ForeFlight v1 headers");
  }
  const flightHeader = headerAfterMarker(lines, "Flights Table");
  if (
    flightHeader &&
    hasHeaders(flightHeader, FOREFLIGHT_V1_FLIGHT_HEADERS)
  ) {
    confidence += 0.3;
    reasons.push("The flights table has all required ForeFlight v1 headers");
  }

  return { confidence, reasons };
}

function detectMyFlightRadar24(input: string): AdapterDetectionEvidence {
  const lines = inspectionLines(input);
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  const header =
    firstIndex < 0 ? undefined : parsePhysicalCsvLine(lines[firstIndex]);
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

  const firstDataLine = lines
    .slice(firstIndex + 1)
    .find((line) => line.trim() !== "");
  const row = firstDataLine ? parsePhysicalCsvLine(firstDataLine) : undefined;
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

function inspectionLines(input: string): string[] {
  return input
    .slice(0, MAX_INSPECTION_CHARACTERS)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .slice(0, MAX_INSPECTION_LINES);
}

function firstNonEmptyRecordCell(lines: string[]): string | undefined {
  const line = lines.find((candidate) => candidate.trim() !== "");
  return line ? parsePhysicalCsvLine(line)?.[0] : undefined;
}

function headerAfterMarker(
  lines: string[],
  marker: string,
): string[] | undefined {
  const markerIndex = lines.findIndex(
    (line) => parsePhysicalCsvLine(line)?.[0] === marker,
  );
  if (markerIndex < 0) return undefined;
  const headerLine = lines
    .slice(markerIndex + 1)
    .find((line) => line.trim() !== "");
  return headerLine ? parsePhysicalCsvLine(headerLine) : undefined;
}

function parsePhysicalCsvLine(line: string): string[] | undefined {
  try {
    const records = parseCsv(line);
    if (records.length !== 1) return undefined;
    return records[0].cells.map((cell) => cell.trim());
  } catch {
    return undefined;
  }
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
