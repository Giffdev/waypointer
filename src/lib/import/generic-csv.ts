import type { FlightKind, FlightRole } from "../flight-data";
import type { CivilDate } from "../flight-statistics";
import { sourceRoleDefault } from "../flight-role";
import { parseCsv, type CsvRecord } from "./csv";
import { sha256Text } from "./sha256";
import type { ImportIssue } from "./types";

export const GENERIC_CSV_MAPPING_VERSION = 1 as const;
export const MAX_GENERIC_CSV_MAPPING_BYTES = 8 * 1024;

export type GenericCsvDateFormat = "iso" | "yyyymmdd" | "mdy" | "dmy";
export type GenericCsvDurationFormat =
  | "decimal-hours"
  | "hours-minutes"
  | "minutes";
export type GenericCsvDistanceUnit = "miles" | "nautical-miles";

export type GenericCsvColumnKey =
  | "date"
  | "origin"
  | "destination"
  | "route"
  | "departureTime"
  | "duration"
  | "distance"
  | "aircraft"
  | "aircraftType"
  | "aircraftModel"
  | "registration"
  | "flightNumber"
  | "airline"
  | "kind"
  | "role";

const GENERIC_CSV_COLUMN_KEYS: readonly GenericCsvColumnKey[] = [
  "date",
  "origin",
  "destination",
  "route",
  "departureTime",
  "duration",
  "distance",
  "aircraft",
  "aircraftType",
  "aircraftModel",
  "registration",
  "flightNumber",
  "airline",
  "kind",
  "role",
];

export type GenericCsvMapping = {
  version?: typeof GENERIC_CSV_MAPPING_VERSION;
  presetId?: string;
  columns: Partial<Record<GenericCsvColumnKey, string>>;
  dateFormat?: GenericCsvDateFormat;
  timeFormat?: "24-hour";
  durationFormat?: GenericCsvDurationFormat;
  distanceUnit?: GenericCsvDistanceUnit;
  defaults?: {
    kind: FlightKind;
    role: FlightRole;
  };
};

export type GenericCsvPresetId =
  | "myflightbook-export"
  | "crewlounge-pilotlog";

export type GenericCsvPresetMetadata = {
  id: GenericCsvPresetId;
  label: string;
  description: string;
  evidenceUrl: string;
  requiredHeaders: readonly string[];
  optionalHeaders?: readonly string[];
};

export type GenericCsvPreset = GenericCsvPresetMetadata & {
  suggestedMapping: GenericCsvMapping;
};

export const GENERIC_CSV_PRESETS: readonly GenericCsvPreset[] = [
  {
    id: "myflightbook-export",
    label: "MyFlightbook CSV",
    description:
      "Maps MyFlightbook's published core fields when From and To are present.",
    evidenceUrl:
      "https://github.com/ericberman/MyFlightbookWeb/blob/master/MyFlightbook.Web/App_GlobalResources/Content.en/ImportTableDescription.txt",
    requiredHeaders: [
      "Date",
      "Tail Number",
      "Total Flight Time",
      "From",
      "To",
    ],
    optionalHeaders: ["Route", "Model", "PIC", "Comments"],
    suggestedMapping: {
      presetId: "myflightbook-export",
      columns: {
        date: "Date",
        origin: "From",
        destination: "To",
        duration: "Total Flight Time",
        aircraftModel: "Model",
        registration: "Tail Number",
      },
      dateFormat: "iso",
      durationFormat: "decimal-hours",
      defaults: sourceRoleDefault({
        adapterId: "generic-csv-v1",
        presetId: "myflightbook-export",
      })!,
    },
  },
  {
    id: "crewlounge-pilotlog",
    label: "CrewLounge PILOTLOG compatible CSV",
    description:
      "Maps CrewLounge's published PILOTLOG import-wizard column names.",
    evidenceUrl:
      "https://support.crewlounge.aero/support/solutions/articles/24000034487-import-flight-records-from-another-logbook-or-my-excel-sheet",
    requiredHeaders: [
      "PILOTLOG_DATE",
      "AF_DEP",
      "AF_ARR",
      "TIME_TOTAL",
      "AC_MODEL",
      "AC_REG",
    ],
    optionalHeaders: ["TIME_DEP", "FLIGHTNUMBER", "OPERATOR"],
    suggestedMapping: {
      presetId: "crewlounge-pilotlog",
      columns: {
        date: "PILOTLOG_DATE",
        origin: "AF_DEP",
        destination: "AF_ARR",
        departureTime: "TIME_DEP",
        duration: "TIME_TOTAL",
        aircraftModel: "AC_MODEL",
        registration: "AC_REG",
        flightNumber: "FLIGHTNUMBER",
        airline: "OPERATOR",
      },
      dateFormat: "iso",
      timeFormat: "24-hour",
      durationFormat: "hours-minutes",
      defaults: sourceRoleDefault({
        adapterId: "generic-csv-v1",
        presetId: "crewlounge-pilotlog",
      })!,
    },
  },
] as const;

export type GenericCsvInspection = {
  headers: string[];
  totalRows: number;
  preset?: {
    id: GenericCsvPresetId;
    label: string;
    suggestedMapping: GenericCsvMapping;
  };
};

export type GenericCsvPresetDetection = {
  preset?: GenericCsvPresetMetadata;
  confidence: number;
  suggestedMapping: GenericCsvMapping;
};

export type GenericCsvFlight = {
  sourceRowNumber: number;
  date?: CivilDate;
  departureTime?: string;
  originIdentifier?: string;
  destinationIdentifier?: string;
  airportIdentifiers?: string[];
  durationHours?: number;
  distanceMiles?: number;
  aircraft?: string;
  aircraftType?: string;
  aircraftModel?: string;
  registration?: string;
  flightNumber?: string;
  airline?: string;
  kind: FlightKind;
  role: FlightRole;
  issues: ImportIssue[];
  idempotencyKey: string;
};

export type GenericCsvParseResult = {
  adapter: {
    source: "CSV";
    format: string;
    version: typeof GENERIC_CSV_MAPPING_VERSION;
    presetId?: GenericCsvPresetId;
  };
  headers: string[];
  flights: GenericCsvFlight[];
};

export type GenericCsvPreview = {
  headers: string[];
  totalRows: number;
  previewRows: GenericCsvFlight[];
  counts: {
    validRows: number;
    invalidRows: number;
    warningRows: number;
  };
};

export type GenericCsvUiPreview = {
  headers: string[];
  rows: GenericCsvFlight[];
  issues: Array<ImportIssue & { rowNumber: number }>;
  validRowCount: number;
  invalidRowCount: number;
};

export class GenericCsvImportError extends Error {
  constructor(readonly code: string) {
    super("The mapped CSV could not be imported.");
    this.name = "GenericCsvImportError";
  }
}

export function parseGenericCsvMapping(value: unknown): GenericCsvMapping {
  const serialized = safelySerialize(value);
  if (
    new TextEncoder().encode(serialized).byteLength >
    MAX_GENERIC_CSV_MAPPING_BYTES
  ) {
    throw new GenericCsvImportError("mapping-too-large");
  }
  const root = strictObject(
    value,
    [
      "version",
      "presetId",
      "columns",
      "dateFormat",
      "timeFormat",
      "durationFormat",
      "distanceUnit",
      "defaults",
    ],
    "invalid-mapping",
  );
  if (
    root.version !== undefined &&
    root.version !== GENERIC_CSV_MAPPING_VERSION
  ) {
    throw new GenericCsvImportError("unsupported-mapping-version");
  }
  const presetId =
    root.presetId === undefined
      ? undefined
      : boundedString(root.presetId, "invalid-preset-id");
  if (
    presetId &&
    !GENERIC_CSV_PRESETS.some((preset) => preset.id === presetId)
  ) {
    throw new GenericCsvImportError("unsupported-preset");
  }
  const columnsObject = strictObject(
    root.columns,
    GENERIC_CSV_COLUMN_KEYS,
    "invalid-mapping-columns",
  );
  const columns: GenericCsvMapping["columns"] = {};
  for (const key of GENERIC_CSV_COLUMN_KEYS) {
    if (columnsObject[key] !== undefined) {
      columns[key] = boundedString(
        columnsObject[key],
        "invalid-mapped-header",
      );
    }
  }
  if (
    !columns.date ||
    (!columns.route && (!columns.origin || !columns.destination))
  ) {
    throw new GenericCsvImportError("missing-required-mapping");
  }
  const normalizedHeaders = Object.values(columns).map(normalizedHeader);
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
    throw new GenericCsvImportError("duplicate-mapped-header");
  }
  const dateFormat = enumValue(
    root.dateFormat,
    ["iso", "yyyymmdd", "mdy", "dmy"],
    "invalid-date-format",
  );
  const timeFormat =
    root.timeFormat === undefined
      ? undefined
      : enumValue(
          root.timeFormat,
          ["24-hour"],
          "invalid-time-format",
        );
  const durationFormat =
    root.durationFormat === undefined
      ? undefined
      : enumValue(
          root.durationFormat,
          ["decimal-hours", "hours-minutes", "minutes"],
          "invalid-duration-format",
        );
  const distanceUnit =
    root.distanceUnit === undefined
      ? undefined
      : enumValue(
          root.distanceUnit,
          ["miles", "nautical-miles"],
          "invalid-distance-unit",
        );
  if (
    (columns.departureTime && !timeFormat) ||
    (columns.duration && !durationFormat) ||
    (columns.distance && !distanceUnit)
  ) {
    throw new GenericCsvImportError("missing-mapped-field-format");
  }
  const defaultsObject = strictObject(
    root.defaults,
    ["kind", "role"],
    "invalid-mapping-defaults",
  );
  const defaults = {
    kind: enumValue(
      defaultsObject.kind,
      ["private", "commercial"],
      "invalid-default-kind",
    ),
    role: enumValue(
      defaultsObject.role,
      ["pilot", "passenger"],
      "invalid-default-role",
    ),
  };
  return {
    version: GENERIC_CSV_MAPPING_VERSION,
    ...(presetId ? { presetId } : {}),
    columns,
    dateFormat,
    ...(timeFormat ? { timeFormat } : {}),
    ...(durationFormat ? { durationFormat } : {}),
    ...(distanceUnit ? { distanceUnit } : {}),
    defaults,
  };
}

export function serializeGenericCsvMapping(value: unknown): string {
  const mapping = parseGenericCsvMapping(value);
  const columns = Object.fromEntries(
    GENERIC_CSV_COLUMN_KEYS.flatMap((key) =>
      mapping.columns[key]
        ? [[key, normalizedHeader(mapping.columns[key])]]
        : [],
    ),
  );
  return JSON.stringify({
    version: mapping.version,
    ...(mapping.presetId ? { presetId: mapping.presetId } : {}),
    columns,
    dateFormat: mapping.dateFormat,
    ...(mapping.timeFormat ? { timeFormat: mapping.timeFormat } : {}),
    ...(mapping.durationFormat
      ? { durationFormat: mapping.durationFormat }
      : {}),
    ...(mapping.distanceUnit ? { distanceUnit: mapping.distanceUnit } : {}),
    defaults: mapping.defaults,
  });
}

export function fingerprintGenericCsvMapping(value: unknown): string {
  return sha256Text(serializeGenericCsvMapping(value));
}

export function inspectGenericCsv(input: string): GenericCsvInspection {
  const { header, rows } = documentRows(input);
  const headers = validateHeaders(header);
  const headerSet = new Set(headers.map(normalizedHeader));
  const preset = findPreset(headerSet);
  return {
    headers,
    totalRows: rows.length,
    preset: preset
      ? {
          id: preset.id,
          label: preset.label,
          suggestedMapping: presetMapping(preset, headerSet),
        }
      : undefined,
  };
}

export function detectGenericCsvPreset(
  headers: readonly string[],
): GenericCsvPresetDetection {
  const normalized = new Set(headers.map(normalizedHeader));
  const preset = findPreset(normalized);
  if (preset) {
    const metadata: GenericCsvPresetMetadata = {
      id: preset.id,
      label: preset.label,
      description: preset.description,
      evidenceUrl: preset.evidenceUrl,
      requiredHeaders: preset.requiredHeaders,
      ...(preset.optionalHeaders
        ? { optionalHeaders: preset.optionalHeaders }
        : {}),
    };
    return {
      preset: metadata,
      confidence: 1,
      suggestedMapping: presetMapping(preset, normalized),
    };
  }
  const columns = suggestCanonicalColumns(headers);
  const routeMatch = Boolean(columns.route);
  const endpointMatches = ["origin", "destination"].filter(
    (key) => columns[key as GenericCsvColumnKey],
  ).length;
  const requiredMatches = Number(Boolean(columns.date)) +
    (routeMatch ? 2 : endpointMatches);
  return {
    confidence: Number(((requiredMatches / 3) * 0.6).toFixed(2)),
    suggestedMapping: {
      columns,
      dateFormat: "iso",
      timeFormat: "24-hour",
    },
  };
}

export function parseMappedGenericCsv(
  input: string,
  mapping: GenericCsvMapping,
): GenericCsvParseResult {
  const validatedMapping = parseGenericCsvMapping(mapping);
  const { header, rows } = documentRows(input);
  const headers = validateHeaders(header);
  const indexes = new Map(
    headers.map((value, index) => [normalizedHeader(value), index]),
  );
  for (const column of Object.values(validatedMapping.columns)) {
    if (!indexes.has(normalizedHeader(column))) {
      throw new GenericCsvImportError("mapped-header-missing");
    }
  }
  const preset = validatedMapping.presetId
    ? GENERIC_CSV_PRESETS.find(({ id }) => id === validatedMapping.presetId)
    : undefined;
  return {
    adapter: {
      source: "CSV",
      format: preset?.label ?? "Generic mapped CSV",
      version: GENERIC_CSV_MAPPING_VERSION,
      ...(preset ? { presetId: preset.id } : {}),
    },
    headers,
    flights: rows.map((row) => mapRow(row, indexes, validatedMapping)),
  };
}

export function previewMappedGenericCsv(
  input: string,
  mapping: GenericCsvMapping,
  maxPreviewRows = 25,
): GenericCsvPreview {
  const parsed = parseMappedGenericCsv(input, mapping);
  const invalidRows = parsed.flights.filter((flight) =>
    flight.issues.some(({ severity }) => severity === "error"),
  ).length;
  const warningRows = parsed.flights.filter(
    (flight) =>
      !flight.issues.some(({ severity }) => severity === "error") &&
      flight.issues.some(({ severity }) => severity === "warning"),
  ).length;
  return {
    headers: parsed.headers,
    totalRows: parsed.flights.length,
    previewRows: parsed.flights.slice(
      0,
      Math.min(100, Math.max(1, Math.trunc(maxPreviewRows))),
    ),
    counts: {
      validRows: parsed.flights.length - invalidRows - warningRows,
      invalidRows,
      warningRows,
    },
  };
}

export function previewGenericCsv(
  input: string,
  mapping: GenericCsvMapping,
): GenericCsvUiPreview {
  const preview = previewMappedGenericCsv(input, mapping);
  return {
    headers: preview.headers,
    rows: preview.previewRows,
    issues: preview.previewRows.flatMap((row) =>
      row.issues.map((issueToReport) => ({
        ...issueToReport,
        rowNumber: row.sourceRowNumber,
      })),
    ),
    validRowCount: preview.counts.validRows + preview.counts.warningRows,
    invalidRowCount: preview.counts.invalidRows,
  };
}

function mapRow(
  row: CsvRecord,
  indexes: Map<string, number>,
  mapping: GenericCsvMapping,
): GenericCsvFlight {
  const issues: ImportIssue[] = [];
  if (row.cells.length !== indexes.size) {
    issues.push(issue("invalid-row", "row", "CSV row width differs from the header"));
  }
  const read = (field: GenericCsvColumnKey): string =>
    value(row, indexes, mapping.columns[field]);
  const date = normalizeDate(read("date"), mapping.dateFormat ?? "iso", issues);
  const hasExplicitEndpoints = Boolean(
    mapping.columns.origin && mapping.columns.destination,
  );
  const explicitOrigin = mapping.columns.origin
    ? normalizeAirport(read("origin"), "origin", issues)
    : undefined;
  const explicitDestination = mapping.columns.destination
    ? normalizeAirport(read("destination"), "destination", issues)
    : undefined;
  const routeValue = read("route");
  const routeIdentifiers = mapping.columns.route && routeValue.trim()
    ? normalizeAirportRoute(
        routeValue,
        issues,
        hasExplicitEndpoints ? 1 : 2,
        hasExplicitEndpoints,
      )
    : undefined;
  const airportIdentifiers =
    explicitOrigin && explicitDestination && routeIdentifiers
      ? composeAirportRoute(
          explicitOrigin,
          explicitDestination,
          routeIdentifiers,
        )
      : routeIdentifiers;
  if (airportIdentifiers && hasExplicitEndpoints) {
    validateAdjacentRouteStops(airportIdentifiers, issues);
  }
  const originIdentifier = explicitOrigin ?? airportIdentifiers?.[0];
  const destinationIdentifier =
    explicitDestination ?? airportIdentifiers?.at(-1);
  const kind = normalizeKind(read("kind"), mapping.defaults!.kind, issues);
  const role = normalizeRole(read("role"), mapping.defaults!.role, issues);
  const durationHours = normalizeDuration(
    read("duration"),
    mapping.durationFormat,
    issues,
  );
  const distanceMiles = normalizeDistance(
    read("distance"),
    mapping.distanceUnit,
    issues,
  );
  const departureTime = normalizeTime(read("departureTime"), issues);
  const normalized = {
    sourceRowNumber: row.rowNumber,
    date,
    departureTime,
    originIdentifier,
    destinationIdentifier,
    airportIdentifiers,
    durationHours,
    distanceMiles,
    aircraft: optionalText(read("aircraft")),
    aircraftType: optionalText(read("aircraftType")),
    aircraftModel: optionalText(read("aircraftModel")),
    registration: optionalText(read("registration"))?.toUpperCase(),
    flightNumber: optionalText(read("flightNumber")),
    airline: optionalText(read("airline")),
    kind,
    role,
    issues,
  };
  return {
    ...normalized,
    idempotencyKey: sha256Text(
      [
        GENERIC_CSV_MAPPING_VERSION,
        row.rowNumber,
        date ?? "",
        originIdentifier ?? "",
        destinationIdentifier ?? "",
        airportIdentifiers?.join(">") ?? "",
        normalized.registration ?? "",
        normalized.flightNumber ?? "",
      ].join("\u001f"),
    ),
  };
}

function documentRows(input: string): {
  header: CsvRecord;
  rows: CsvRecord[];
} {
  const records = parseCsv(input).filter(
    (record) => !record.cells.every((cell) => cell.trim() === ""),
  );
  if (records.length === 0) throw new GenericCsvImportError("empty-document");
  return { header: records[0], rows: records.slice(1) };
}

function validateHeaders(header: CsvRecord): string[] {
  if (header.cells.length > 128) {
    throw new GenericCsvImportError("too-many-columns");
  }
  const headers = header.cells.map((cell) => cell.trim());
  if (headers.some((value) => !value || value.length > 100)) {
    throw new GenericCsvImportError("invalid-header");
  }
  const normalized = headers.map(normalizedHeader);
  if (new Set(normalized).size !== normalized.length) {
    throw new GenericCsvImportError("duplicate-header");
  }
  return headers;
}

function normalizedHeader(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function safelySerialize(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      throw new GenericCsvImportError("invalid-mapping");
    }
    return serialized;
  } catch (error) {
    if (error instanceof GenericCsvImportError) throw error;
    throw new GenericCsvImportError("invalid-mapping");
  }
}

function strictObject(
  value: unknown,
  allowedKeys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GenericCsvImportError(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new GenericCsvImportError(code);
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new GenericCsvImportError(code);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GenericCsvImportError(code);
  }
  return value.trim();
}

function enumValue<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  code: string,
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw new GenericCsvImportError(code);
  }
  return value as Value;
}

function suggestCanonicalColumns(
  headers: readonly string[],
): GenericCsvMapping["columns"] {
  const byNormalized = new Map(
    headers.map((header) => [normalizedHeader(header), header]),
  );
  const first = (aliases: readonly string[]) =>
    aliases.map((alias) => byNormalized.get(alias)).find(Boolean);
  return {
    date: first(["date", "flight date"]),
    origin: first(["from", "origin", "departure", "departure airport"]),
    destination: first(["to", "destination", "arrival", "arrival airport"]),
    route: first(["route", "stops", "airport sequence"]),
    departureTime: first(["departure time", "dep time", "time out"]),
    duration: first(["duration", "total time", "total flight time"]),
    distance: first(["distance", "distance miles"]),
    aircraft: first(["aircraft"]),
    aircraftType: first(["aircraft type", "type"]),
    aircraftModel: first(["aircraft model", "model"]),
    registration: first(["registration", "tail number", "aircraft id"]),
    flightNumber: first(["flight number", "flight no"]),
    airline: first(["airline", "operator"]),
    kind: first(["kind", "flight kind"]),
    role: first(["role", "capacity"]),
  };
}

function value(
  row: CsvRecord,
  indexes: Map<string, number>,
  header: string | undefined,
): string {
  if (!header) return "";
  return (row.cells[indexes.get(normalizedHeader(header)) ?? -1] ?? "").trim();
}

function normalizeDate(
  raw: string,
  format: GenericCsvDateFormat,
  issues: ImportIssue[],
): CivilDate | undefined {
  let parts: number[] | undefined;
  if (format === "iso" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    parts = raw.split("-").map(Number);
  } else if (format === "yyyymmdd" && /^\d{8}$/.test(raw)) {
    parts = [Number(raw.slice(0, 4)), Number(raw.slice(4, 6)), Number(raw.slice(6))];
  } else {
    const match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(raw);
    if (match && format === "mdy") {
      parts = [Number(match[3]), Number(match[1]), Number(match[2])];
    } else if (match && format === "dmy") {
      parts = [Number(match[3]), Number(match[2]), Number(match[1])];
    }
  }
  if (!parts || !validDate(parts[0], parts[1], parts[2])) {
    issues.push(issue("invalid-date", "date", "Date does not match the selected format"));
    return undefined;
  }
  return `${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}` as CivilDate;
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizeAirport(
  raw: string,
  field: "origin" | "destination",
  issues: ImportIssue[],
): string | undefined {
  const valueToCheck = raw.trim().toUpperCase();
  if (!valueToCheck) {
    issues.push(issue("missing-airport", field, `${field} is required`));
    return undefined;
  }

  if (!/^[A-Z0-9-]{2,8}$/.test(valueToCheck)) {
    issues.push(
      issue(
        "invalid-airport-identifier",
        field,
        `${field} must be an IATA, ICAO, or local airport identifier`,
      ),
    );
    return undefined;
  }
  return valueToCheck;
}

function normalizeAirportRoute(
  raw: string,
  issues: ImportIssue[],
  minimumStops = 2,
  allowBoundaryDuplicates = false,
): string[] | undefined {
  const tokens = raw
    .trim()
    .toUpperCase()
    .split(/\s*(?:->|→|>|,|;|\|)\s*|\s+/)
    .filter(Boolean);
  if (tokens.length < minimumStops) {
    issues.push(
      issue(
        "missing-airport",
        "route",
        `Route must contain at least ${minimumStops} ordered airport identifier${minimumStops === 1 ? "" : "s"}`,
      ),
    );
    return undefined;
  }
  const invalidIndex = tokens.findIndex(
    (token) => !/^[A-Z0-9-]{2,8}$/.test(token),
  );
  if (invalidIndex >= 0) {
    issues.push(
      issue(
        "invalid-airport-identifier",
        `route[${invalidIndex}]`,
        `Route stop ${invalidIndex + 1} must be an IATA, ICAO, or local airport identifier`,
      ),
    );
    return undefined;
  }
  if (!allowBoundaryDuplicates && !validateAdjacentRouteStops(tokens, issues)) {
    return undefined;
  }
  return tokens;
}

function validateAdjacentRouteStops(
  route: readonly string[],
  issues: ImportIssue[],
): boolean {
  const repeatedAdjacent = route.findIndex(
    (token, index) => index > 0 && token === route[index - 1],
  );
  if (repeatedAdjacent < 0) return true;
  issues.push(
    issue(
      "invalid-row",
      `route[${repeatedAdjacent}]`,
      "Adjacent route stops must be different airports",
    ),
  );
  return false;
}

function composeAirportRoute(
  origin: string,
  destination: string,
  route: readonly string[],
): string[] {
  let firstIntermediate = 0;
  while (route[firstIntermediate] === origin) firstIntermediate += 1;

  let lastIntermediate = route.length;
  while (
    lastIntermediate > firstIntermediate &&
    route[lastIntermediate - 1] === destination
  ) {
    lastIntermediate -= 1;
  }

  return [
    origin,
    ...route.slice(firstIntermediate, lastIntermediate),
    destination,
  ];
}

function findPreset(
  normalizedHeaders: ReadonlySet<string>,
): (typeof GENERIC_CSV_PRESETS)[number] | undefined {
  return GENERIC_CSV_PRESETS.find((candidate) => {
    if (candidate.id === "myflightbook-export") {
      const core = ["date", "tail number", "total flight time"].every(
        (header) => normalizedHeaders.has(header),
      );
      return core && (
        normalizedHeaders.has("route") ||
        (normalizedHeaders.has("from") && normalizedHeaders.has("to"))
      );
    }
    return candidate.requiredHeaders.every((required) =>
      normalizedHeaders.has(normalizedHeader(required)),
    );
  });
}

function presetMapping(
  preset: (typeof GENERIC_CSV_PRESETS)[number],
  normalizedHeaders: ReadonlySet<string>,
): GenericCsvMapping {
  if (preset.id === "myflightbook-export" && normalizedHeaders.has("route")) {
    return {
      ...preset.suggestedMapping,
      columns: {
        ...preset.suggestedMapping.columns,
        route: "Route",
      },
    };
  }
  return preset.suggestedMapping;
}

function normalizeTime(raw: string, issues: ImportIssue[]): string | undefined {
  if (!raw) return undefined;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  const second = Number(match?.[3] ?? 0);
  if (!match || hour > 23 || minute > 59 || second > 59) {
    issues.push(
      issue(
        "invalid-time",
        "departureTime",
        "Time must use 24-hour H:MM or H:MM:SS",
        "warning",
      ),
    );
    return undefined;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function normalizeDuration(
  raw: string,
  format: GenericCsvDurationFormat | undefined,
  issues: ImportIssue[],
): number | undefined {
  if (!raw) return undefined;
  if (!format) {
    issues.push(
      issue(
        "invalid-duration",
        "duration",
        "Select the duration format",
        "warning",
      ),
    );
    return undefined;
  }
  let hours: number;
  if (format === "hours-minutes") {
    const match = /^(\d{1,4}):([0-5]\d)$/.exec(raw);
    hours = match ? Number(match[1]) + Number(match[2]) / 60 : Number.NaN;
  } else {
    const numeric = Number(raw);
    hours = format === "minutes" ? numeric / 60 : numeric;
  }
  if (!Number.isFinite(hours) || hours < 0 || hours > 10_000) {
    issues.push(
      issue("invalid-duration", "duration", "Duration is invalid", "warning"),
    );
    return undefined;
  }
  return Number(hours.toFixed(3));
}

function normalizeDistance(
  raw: string,
  unit: GenericCsvDistanceUnit | undefined,
  issues: ImportIssue[],
): number | undefined {
  if (!raw) return undefined;
  if (!unit) {
    issues.push(
      issue(
        "invalid-number",
        "distance",
        "Select the distance unit",
        "warning",
      ),
    );
    return undefined;
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 30_000) {
    issues.push(
      issue("invalid-number", "distance", "Distance is invalid", "warning"),
    );
    return undefined;
  }
  return Number(
    (unit === "nautical-miles" ? numeric * 1.150779448 : numeric).toFixed(2),
  );
}

function normalizeKind(
  raw: string,
  fallback: FlightKind,
  issues: ImportIssue[],
): FlightKind {
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === "private" || normalized === "commercial") return normalized;
  issues.push(
    issue(
      "invalid-row",
      "kind",
      "Kind must be private or commercial",
      "warning",
    ),
  );
  return fallback;
}

function normalizeRole(
  raw: string,
  fallback: FlightRole,
  issues: ImportIssue[],
): FlightRole {
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === "pilot" || normalized === "passenger") return normalized;
  issues.push(
    issue(
      "invalid-row",
      "role",
      "Role must be pilot or passenger",
      "warning",
    ),
  );
  return fallback;
}

function optionalText(raw: string): string | undefined {
  return raw.trim().replace(/\s+/g, " ").slice(0, 200) || undefined;
}

function issue(
  code: ImportIssue["code"],
  field: string,
  message: string,
  severity: ImportIssue["severity"] = "error",
): ImportIssue {
  return { code, field, message, severity };
}
