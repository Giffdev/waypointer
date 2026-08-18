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
    | "invalid-row";
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

export type ImportAirportMatch =
  | {
      status: "resolved";
      identifier: string;
      airportId: string;
      airport: Airport;
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

export type ProposedImportFlight = {
  date?: string;
  departureTime?: string;
  originIdentifier?: string;
  destinationIdentifier?: string;
  origin?: ImportAirportMatch;
  destination?: ImportAirportMatch;
  airportIdentifiers?: string[];
  airportMatches?: ImportAirportMatch[];
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
  unresolvedDuplicateRows?: number;
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
    routeStop?: {
      index: number;
      airportId: string;
    };
  };
};

export type CommitImportResponse = {
  batchId: string;
  status: "review" | "committing" | "committed";
  completion?: ImportCompletionSummary;
};
