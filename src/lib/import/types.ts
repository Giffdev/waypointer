import type {
  Airport,
  FlightKind,
  FlightRole,
  FlightSource,
} from "../flight-data";
import type { FlightRoleOrigin } from "../flight-role";

export type ImportIssue = {
  code:
    | "invalid-date"
    | "invalid-time"
    | "invalid-duration"
    | "invalid-hobbs"
    | "invalid-airport-identifier"
    | "missing-airport"
    | "invalid-number"
    | "unknown-aircraft"
    | "ambiguous-aircraft"
    | "invalid-row"
    // Route tokens never invalidate a row: a token we cannot place must
    // not cost the user the flight, so all four codes are always warnings.
    | "route-token-unmatched"
    | "route-token-ambiguous"
    | "route-token-navaid-collision"
    | "route-landing-count-mismatch";
  field: string;
  message: string;
  severity: "error" | "warning";
};

export const IMPORT_CONTRACT_VERSION = 1 as const;

export type ImportBatchStatus =
  | "pending"
  | "queued"
  | "scanning"
  | "processing"
  | "retrying"
  | "review"
  | "committing"
  | "committed"
  | "deduplicated"
  | "cancelled"
  | "quarantined"
  | "failed"
  | "expired";

export type ImportRowDecision = "pending" | "accepted" | "skipped";

export type ImportDecisionAction = "accepted" | "skipped";
export type ImportDuplicateResolution =
  | "pending"
  | "accept_new"
  | "skip_as_duplicate";

export type ImportValidationState =
  | "ready"
  | "warning"
  | "invalid"
  | "unresolved"
  | "ambiguous"
  | "duplicate";

export type VersionedFingerprint = {
  algorithm: "sha256";
  version: number;
  value: string;
};

/**
 * Which alias namespace an identifier resolved through. Route classification
 * accepts only airport-namespace matches (`icao`, `faa-lid`, `gps`, `ident`);
 * an identifier that matched *only* through `iata` or a non-US `local` alias
 * is far more likely to be a co-located navaid written into a route string
 * than the airport itself, so it is never promoted to a waypoint.
 */
export type AirportIdentifierType =
  | "icao"
  | "iata"
  | "faa-lid"
  | "gps"
  | "ident"
  | "local";

export const AIRPORT_ROUTE_NAMESPACE_TYPES: readonly AirportIdentifierType[] = [
  "icao",
  "faa-lid",
  "gps",
  "ident",
];
export type ImportAirportMatch =
  | {
      status: "resolved";
      identifier: string;
      airportId: string;
      airport: Airport;
      /**
       * **Every** alias namespace under which this identifier maps to the
       * winning airport — not just the highest-priority one.
       *
       * The distinction is load-bearing. `BFI` is Boeing Field's IATA code
       * *and* its FAA-LID; only the IATA alias wins on priority, so a guard
       * that read the winning row alone saw `["iata"]` and rejected a real
       * airport. Reading the whole set lets the guard ask the question it
       * actually means: "is there any airport-namespace route by which this
       * token names this airport?"
       *
       * Absent on matches produced before the guard shipped.
       */
      matchedCodeTypes?: readonly AirportIdentifierType[];
    }
  | {
      status: "not-found";
      identifier: string;
    }
  | {
      status: "ambiguous";
      identifier: string;
      candidates: Array<{
        airportId: string;
        code: string;
        name: string;
      }>;
    };

/**
 * One ordered node on a flight's path. Every source token becomes a node, so
 * nothing a provider wrote is silently dropped.
 *
 * `kind` answers a *single* question — is this token an airport we can place
 * on a map? It never answers "did the pilot land here". Only a field the
 * source explicitly designates as an endpoint/landing, or a deliberate user
 * action, produces `kind: "landing"`.
 */
export type ImportRouteNode =
  | {
      kind: "landing";
      identifier: string;
      match: ImportAirportMatch;
      /**
       * `From`/`To` are the source's own endpoint headers; `endpoint` is an
       * intermediate stop from an explicit airport-sequence column. All three
       * persist as `source_field = 'endpoint'`, matching what migration 0018
       * backfills onto every pre-existing stop — a landing is never derived
       * from route text, so `route` is deliberately not a landing origin.
       * `manual` is a deliberate user assertion.
       */
      sourceField: "From" | "To" | "endpoint" | "manual";
      tokenIndex?: number;
    }
  | {
      kind: "waypoint";
      identifier: string;
      match: ImportAirportMatch;
      sourceField: "Route";
      tokenIndex: number;
    }
  | {
      kind: "unmatched";
      identifier: string;
      sourceField: "Route";
      tokenIndex: number;
      reason: ImportRouteRejection["reason"];
    };

export type ImportRouteRejectionReason =
  | "structural-token"
  | "airway-or-procedure"
  | "nav-fix-shape"
  | "navaid-or-iata-collision"
  | "ambiguous"
  | "not-found"
  | "adjacent-duplicate"
  | "route-too-long";

export type ImportRouteRejection = {
  identifier: string;
  tokenIndex: number;
  reason: ImportRouteRejectionReason;
  /** Populated only for `ambiguous`, so the review UI can prefill a picker. */
  candidates?: Array<{
    airportId: string;
    code: string;
    name: string;
  }>;
};

export type ProposedImportFlight = {
  date?: string;
  departureTime?: string;
  originIdentifier?: string;
  destinationIdentifier?: string;
  origin?: ImportAirportMatch;
  destination?: ImportAirportMatch;
  airportIdentifiers?: string[];
  airportMatches?: ImportAirportMatch[];
  /**
   * Canonical ordered path covering **every** source token, including tokens
   * that are not airports. `origin`, `destination`, `airportIdentifiers`, and
   * `airportMatches` remain the landings-only projection every legacy consumer
   * already reads, so waypoints cannot leak into a statistic by accident.
   */
  routeNodes?: ImportRouteNode[];
  routeRejections?: ImportRouteRejection[];
  /** Verbatim source route text. Where non-airport nav fixes are preserved. */
  routeRaw?: string;
  /**
   * Informational only. Never adds a stop, never changes a `stop_kind`, and
   * never fires as an error.
   */
  landingCounts?: { all?: number; fullStop?: number };
  kind: FlightKind;
  role: FlightRole;
  aircraft?: string;
  aircraftType?: string;
  aircraftModel?: string;
  registration?: string;
  flightNumber?: string;
  airline?: string;
  distanceMiles?: number;
  durationHours?: number;
  source: FlightSource;
  classificationOrigin?: FlightRoleOrigin;
};

export type ImportDuplicateCandidate = {
  scope: "existing-flight" | "staged-row";
  candidateId: string;
  score: number;
  ruleVersion: number;
  explanation: string;
  signals: Array<{
    code: string;
    weight: number;
    detail: string;
  }>;
  resolution: ImportDuplicateResolution;
};

export type ImportCorrection = {
  field: keyof ProposedImportFlight | `route[${number}]`;
  originalValue: unknown;
  correctedValue: unknown;
  correctedAt: string;
};

export type ImportRowProvenance = {
  adapterId: string;
  adapterLabel: string;
  adapterVersion: number;
  source: FlightSource;
  sourceRowNumber: number;
  externalStableId?: string;
  /**
   * Content-addressed identity of the source row, plus an intra-file
   * occurrence counter. Stable across reimports of the same file **and**
   * across re-exports that insert unrelated rows above it, which the old
   * `adapterVersion:rowNumber` ordinal was not.
   */
  sourceRowKey?: string;
};

export type StoredImportRow = {
  id: string;
  batchId: string;
  rowNumber: number;
  rawSnapshot: string[] | null;
  proposedFlight: ProposedImportFlight;
  issues: ImportIssue[];
  validationState: ImportValidationState;
  commitReady: boolean;
  decision: ImportRowDecision;
  decidedAt?: string;
  rowFingerprint?: VersionedFingerprint;
  /**
   * The pre-v3 digest for this same row, carried alongside the current one so
   * a re-import can recognise — and adopt — flights committed before the
   * identity fix instead of duplicating them.
   */
  legacyRowFingerprint?: VersionedFingerprint;
  duplicateCandidate?: ImportDuplicateCandidate;
  corrections?: ImportCorrection[];
  provenance: ImportRowProvenance;
};

export type ImportBatchCounts = {
  totalRows: number;
  parsedRows: number;
  readyRows: number;
  acceptedRows: number;
  skippedRows: number;
  pendingRows: number;
  unresolvedDuplicateRows: number;
  routeWaypointRows: number;
  unresolvedRouteTokenRows: number;
  adoptedFlightRows: number;
  importedRows?: number;
  duplicateRows?: number;
  invalidRows?: number;
  reviewRequiredRows?: number;
  committedFlights: number;
  attachedSources: number;
};

export type ImportBatchSummary = {
  contractVersion: typeof IMPORT_CONTRACT_VERSION;
  id: string;
  fileName: string;
  adapterId?: string;
  adapterLabel?: string;
  adapterVersion?: number;
  /** Pipeline version that produced this batch; 0 predates the column. */
  importerVersion?: number;
  /** True when a newer importer exists *and* the source object is retained. */
  reprocessAvailable?: boolean;
  reprocessUnavailableReason?:
    | "already-current"
    | "source-file-unavailable"
    | "batch-not-reprocessable";
  reprocessedFromBatchId?: string;
  source?: FlightSource;
  status: ImportBatchStatus;
  duplicateOfBatchId?: string;
  counts: ImportBatchCounts;
  error?: {
    code: string;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
};

/**
 * Cross-surface aggregate powering the attention banner on /map, /flights and
 * /import. One indexed read; never blocks a page render.
 */
export type PendingImportAttention = {
  reviewBatches: number;
  pendingRows: number;
  unresolvedDuplicateRows: number;
  unresolvedRouteTokenRows: number;
  adoptedFlightRows: number;
  reprocessAvailableBatches: number;
  href: string;
};

export type ImportRowsPage = {
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  rows: StoredImportRow[];
};

export type OwnerImportBatchDetail = ImportBatchSummary & {
  rows: ImportRowsPage;
};

export type UploadImportResponse = {
  batchId: string;
  status: ImportBatchStatus;
  reused: boolean;
  completion?: ImportCompletionSummary;
};

export type ImportCompletionSummary = {
  totalRows: number;
  importedRows: number;
  duplicateRows: number;
  skippedRows: number;
  invalidRows: number;
  reviewRequiredRows: number;
};

export type ListImportBatchesResponse = {
  batches: ImportBatchSummary[];
};

export type DecideImportRowsRequest = {
  decisions: Array<{
    rowId: string;
    action: ImportDecisionAction;
    duplicateResolution?: Exclude<ImportDuplicateResolution, "pending">;
  }>;
};

export type AirportSearchResult = {
  airportId: string;
  code: string;
  icao?: string;
  iata?: string;
  localCode?: string;
  name: string;
  city?: string;
  country: string;
};

/**
 * Route-stop operations.
 *
 * Re-resolving one stop of the existing landing sequence is the only supported
 * operation. Route-waypoint editing (insert / remove / promote-to-landing) is
 * deliberately **not** here: those operations move a flight's identity, so
 * they ship with the review UI that can show the consequence, not ahead of it.
 */
export type ImportRouteStopOperation = { index: number; airportId: string };

export type UpdateImportRowRequest = {
  expectedUpdatedAt?: string;
  proposal: Partial<
    Pick<
      ProposedImportFlight,
      | "date"
      | "departureTime"
      | "kind"
      | "role"
      | "aircraft"
      | "aircraftType"
      | "aircraftModel"
      | "registration"
      | "flightNumber"
      | "airline"
      | "distanceMiles"
      | "durationHours"
    >
  > & {
    originAirportId?: string;
    destinationAirportId?: string;
    routeStop?: ImportRouteStopOperation;
  };
};

export type CommitImportResponse = {
  batchId: string;
  status: "review" | "committing" | "committed";
  completion?: ImportCompletionSummary;
};
