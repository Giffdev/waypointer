import type {
  ImportBatchSummary,
  ProposedImportFlight,
  StoredImportRow,
  VersionedFingerprint,
} from "@/lib/import/types";
import type { Flight } from "@/lib/flight-data";
import type { ExistingFingerprintCandidate } from "@/lib/import/dedupe";

export type CommitAcceptedImportInput = {
  batch: ImportBatchSummary;
  rows: StoredImportRow[];
};

export type CommitAcceptedImportResult = {
  batchId: string;
  status: "review" | "committed";
  acceptedRows: number;
  createdFlights: number;
  attachedSources: number;
};

export type CreateManualFlightInput = {
  proposal: ProposedImportFlight;
  fingerprint: VersionedFingerprint;
};

export type CreateManualFlightResult = {
  flightId: string;
  created: boolean;
};

export interface FlightRepository {
  listFlights(userId: string): Promise<Flight[]>;
  findDuplicateCandidates(
    userId: string,
    rows: StoredImportRow[],
  ): Promise<ExistingFingerprintCandidate[]>;
  commitAcceptedImport(
    userId: string,
    input: CommitAcceptedImportInput,
  ): Promise<CommitAcceptedImportResult>;
  createManualFlight(
    userId: string,
    input: CreateManualFlightInput,
  ): Promise<CreateManualFlightResult>;
}
