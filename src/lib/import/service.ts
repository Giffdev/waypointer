import type { FlightRepository } from "@/lib/db/repositories/flight-repository";
import type { ImportRepository } from "@/lib/db/repositories/import-repository";
import type {
  CommitImportResponse,
  DecideImportRowsRequest,
  ImportBatchSummary,
  ImportCompletionSummary,
  ImportDecisionAction,
  ImportDuplicateResolution,
  OwnerImportBatchDetail,
  StoredImportRow,
  UploadImportResponse,
} from "./types";

export async function listUserImportBatches(
  userId: string,
  imports: ImportRepository,
): Promise<ImportBatchSummary[]> {
  requireUser(userId);
  return imports.listBatches(userId);
}

export async function getUserImportBatch(
  userId: string,
  batchId: string,
  page: number,
  pageSize: number,
  imports: ImportRepository,
): Promise<OwnerImportBatchDetail | null> {
  requireUser(userId);
  const batch = await imports.getBatch(userId, batchId);
  const rows = batch
    ? batch.status === "review"
      ? paginateImportRows(
          (await imports.getRowsForCommit(userId, batchId))?.filter(
            (row) => row.decision === "pending",
          ) ?? [],
          page,
          pageSize,
        )
      : await imports.listRows(userId, batchId, page, pageSize)
    : null;
  return batch && rows ? { ...batch, rows } : null;
}

export async function decideImportRows(
  userId: string,
  batchId: string,
  request: DecideImportRowsRequest,
  imports: ImportRepository,
): Promise<ImportBatchSummary> {
  requireUser(userId);
  const rows = await imports.getRowsForCommit(userId, batchId);
  if (!rows) throw new Error("Import batch not found");
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const decision of request.decisions) {
    const row = byId.get(decision.rowId);
    if (!row) throw new Error("Import row not found");
    if (decision.action === "accepted" && !row.commitReady) {
      throw new Error("Rows with invalid or ambiguous airports cannot be accepted");
    }
    if (
      decision.action === "accepted" &&
      row.duplicateCandidate &&
      !decision.duplicateResolution
    ) {
      throw new Error("Duplicate resolution is required");
    }
  }
  return imports.applyDecisions(userId, batchId, request.decisions);
}

export async function commitImportBatch(
  userId: string,
  batchId: string,
  imports: ImportRepository,
  flights: FlightRepository,
): Promise<CommitImportResponse> {
  requireUser(userId);
  const [batch, rows] = await Promise.all([
    imports.getBatch(userId, batchId),
    imports.getRowsForCommit(userId, batchId),
  ]);
  if (!batch || !rows) throw new Error("Import batch not found");
  if (batch.status === "committed") {
    return {
      batchId,
      status: "committed",
      completion: importCompletionSummary(batch),
    };
  }
  if (batch.status !== "review") {
    throw new Error("Only reviewed batches can be committed");
  }
  if (
    rows.some(
      (row) =>
        row.decision === "accepted" &&
        row.duplicateCandidate?.resolution === "pending",
    )
  ) {
    throw new Error("Duplicate resolution is required");
  }

  const result = await flights.commitAcceptedImport(userId, { batch, rows });
  const completed = await imports.getBatch(userId, batchId);
  return {
    batchId,
    status: result.status,
    completion: completed ? importCompletionSummary(completed) : undefined,
  };
}

export async function automaticallyCommitImport(
  userId: string,
  upload: UploadImportResponse,
  imports: ImportRepository,
  flights: FlightRepository,
): Promise<UploadImportResponse> {
  requireUser(userId);
  if (upload.status !== "review") {
    const existing = await imports.getBatch(userId, upload.batchId);
    return {
      ...upload,
      completion: existing ? importCompletionSummary(existing) : undefined,
    };
  }

  return automaticallyCompleteReviewBatch(
    userId,
    upload.batchId,
    upload.reused,
    imports,
    flights,
  );
}

export async function automaticallyCompleteReviewBatch(
  userId: string,
  batchId: string,
  reused: boolean,
  imports: ImportRepository,
  flights: FlightRepository,
): Promise<UploadImportResponse> {
  requireUser(userId);
  const rows = await imports.getRowsForCommit(userId, batchId);
  if (!rows) throw new Error("Import batch not found");
  const decisions: Array<{
    rowId: string;
    action: ImportDecisionAction;
    duplicateResolution?: Exclude<ImportDuplicateResolution, "pending">;
  }> = [];
  for (const row of rows) {
    if (row.decision !== "pending") continue;
    if (!row.commitReady) continue;
    if (!row.duplicateCandidate) {
      decisions.push({ rowId: row.id, action: "accepted" });
      continue;
    }
    if (
      row.duplicateCandidate.signals.some(
        (signal) => signal.code === "exact-fingerprint",
      )
    ) {
      decisions.push({
        rowId: row.id,
        action: "skipped",
        duplicateResolution: "skip_as_duplicate",
      });
    }
  }
  if (decisions.length > 0) {
    await imports.applyDecisions(userId, batchId, decisions);
  }

  const decidedRows = await imports.getRowsForCommit(userId, batchId);
  if (!decidedRows) throw new Error("Import batch not found");
  const hasAccepted = decidedRows.some((row) => row.decision === "accepted");
  const hasPending = decidedRows.some((row) => row.decision === "pending");
  if (hasAccepted || !hasPending) {
    const batch = await imports.getBatch(userId, batchId);
    if (!batch) throw new Error("Import batch not found");
    await flights.commitAcceptedImport(userId, { batch, rows: decidedRows });
  }

  const completed = await imports.getBatch(userId, batchId);
  if (!completed) throw new Error("Import batch not found");
  return {
    batchId: completed.id,
    status:
      completed.status === "review" ||
      completed.status === "failed" ||
      completed.status === "committed"
        ? completed.status
        : "processing",
    reused,
    completion: importCompletionSummary(completed),
  };
}

export function importCompletionSummary(
  batch: ImportBatchSummary,
): ImportCompletionSummary {
  return {
    totalRows: batch.counts.totalRows,
    importedRows: batch.counts.importedRows ?? batch.counts.committedFlights,
    duplicateRows: batch.counts.duplicateRows ?? 0,
    skippedRows: batch.counts.skippedRows,
    invalidRows: batch.counts.invalidRows ?? 0,
    reviewRequiredRows:
      batch.counts.reviewRequiredRows ?? batch.counts.pendingRows,
  };
}

export function paginateImportRows(
  rows: StoredImportRow[],
  page: number,
  pageSize: number,
): OwnerImportBatchDetail["rows"] {
  const safePageSize = Math.min(100, Math.max(1, Math.trunc(pageSize)));
  const totalPages = Math.max(1, Math.ceil(rows.length / safePageSize));
  const safePage = Math.min(totalPages, Math.max(1, Math.trunc(page)));
  const start = (safePage - 1) * safePageSize;
  return {
    page: safePage,
    pageSize: safePageSize,
    totalRows: rows.length,
    totalPages,
    rows: rows.slice(start, start + safePageSize),
  };
}

function requireUser(userId: string): void {
  if (!userId.trim()) throw new Error("A userId is required");
}
