import { createHash } from "node:crypto";
import { and, eq, lte, ne } from "drizzle-orm";
import { withUserDb } from "@/lib/db";
import { DrizzleImportRepository } from "@/lib/db/repositories/drizzle-import-repository";
import type {
  CreateImportBatchInput,
  ImportRepository,
} from "@/lib/db/repositories/import-repository";
import { importBatches } from "@/lib/db/schema";
import { detectFlightImportFormat } from "@/lib/import/registry";
import { redactOwnerImportBatchDetail } from "@/lib/import/api-contract";
import type {
  AirportSearchResult,
  CommitImportResponse,
  ImportBatchSummary,
  ImportDecisionAction,
  OwnerImportBatchDetail,
  UpdateImportRowRequest,
  UploadImportResponse,
} from "@/lib/import/types";
import { applyDuplicateCandidates } from "@/lib/import/dedupe";
import {
  applyProposalCorrection,
  validateProposalPatch,
} from "@/lib/import/corrections";
import { createRowFingerprint } from "@/lib/import/fingerprint";
import {
  importProposalValidationState,
  isImportProposalCommitReady,
} from "@/lib/import/review";
import {
  automaticallyCommitImport,
  importCompletionSummary,
  paginateImportRows,
} from "@/lib/import/service";
import {
  DEFAULT_MAX_IMPORT_BYTES,
  stageFlightImport,
  stageMappedFlightImport,
} from "@/lib/import/worker";
import type { GenericCsvMapping } from "@/lib/import/generic-csv";
import { getPrivateObjectStorage } from "@/lib/storage";
import { CSV_MIME_TYPES } from "@/lib/import/csv-mime";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Shared with the client preview gate and the durable upload service; see
// src/lib/import/csv-mime.ts for why this must stay in sync across all
// three call sites. "" is added locally because a blank file.type is
// accepted as-is here rather than normalized to a fallback value.
const ALLOWED_MIME_TYPES = new Set<string>([...CSV_MIME_TYPES, ""]);

export class ImportServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportServiceError";
  }
}

export type ImportDecision = {
  rowId: string;
  action: ImportDecisionAction;
  duplicateResolution?: "accept_new" | "skip_as_duplicate";
};

export interface ImportService {
  createUpload(
    userId: string,
    file: File,
    mapping?: GenericCsvMapping,
  ): Promise<UploadImportResponse>;
  listBatches(userId: string): Promise<ImportBatchSummary[]>;
  getBatch(
    userId: string,
    batchId: string,
    page: number,
    pageSize: number,
  ): Promise<OwnerImportBatchDetail | null>;
  decide(
    userId: string,
    batchId: string,
    decisions: ImportDecision[],
  ): Promise<ImportBatchSummary>;
  commit(userId: string, batchId: string): Promise<CommitImportResponse>;
  searchAirports(
    userId: string,
    query: string,
    limit: number,
  ): Promise<AirportSearchResult[]>;
  updateRow(
    userId: string,
    batchId: string,
    rowId: string,
    request: UpdateImportRowRequest,
  ): Promise<ImportBatchSummary>;
}

const repository = new DrizzleImportRepository();

function maxUploadBytes(): number {
  const configured = Number(
    process.env.IMPORT_MAX_BYTES ?? DEFAULT_MAX_IMPORT_BYTES,
  );
  if (!Number.isSafeInteger(configured) || configured < 1024) {
    throw new Error("IMPORT_MAX_BYTES must be an integer of at least 1024.");
  }
  return configured;
}

function retentionDays(): number {
  const configured = Number(process.env.IMPORT_RETENTION_DAYS ?? 7);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 30) {
    throw new Error("IMPORT_RETENTION_DAYS must be an integer from 1 to 30.");
  }
  return configured;
}

// Exported for direct unit testing of the mobile-safe content-type
// allowlist without needing to mock the database/storage dependencies of
// createUpload.
export function decodeUpload(file: File, bytes: Uint8Array): string {
  if (file.size === 0) {
    throw new ImportServiceError(400, "empty-file", "The upload is empty.");
  }
  if (file.size > maxUploadBytes()) {
    throw new ImportServiceError(413, "file-too-large", "The upload is too large.");
  }
  if (!ALLOWED_MIME_TYPES.has(file.type.toLowerCase())) {
    throw new ImportServiceError(
      415,
      "unsupported-content-type",
      "The upload content type is not supported.",
    );
  }
  if (bytes.includes(0)) {
    throw new ImportServiceError(
      415,
      "binary-content",
      "Binary upload content is not supported.",
    );
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImportServiceError(
      415,
      "invalid-utf8",
      "The upload must be valid UTF-8 text.",
    );
  }

  const inspected = content.slice(0, 8192);
  const controlCharacters = [...inspected].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && ![9, 10, 13].includes(code);
  }).length;
  if (
    controlCharacters >
    Math.max(2, Math.floor(inspected.length * 0.005))
  ) {
    throw new ImportServiceError(
      415,
      "binary-content",
      "The upload appears to contain binary data.",
    );
  }
  return content.replace(/^\uFEFF/, "");
}

function cleanFileName(name: string): string {
  return (
    name
      .replace(/^.*[\\/]/, "")
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 160) || "flight-log.csv"
  );
}

function assertBatchId(batchId: string): void {
  if (!UUID_PATTERN.test(batchId)) {
    throw new ImportServiceError(400, "invalid-batch-id", "Invalid batch ID.");
  }
}

function storageAwareImportRepository(input: {
  userId: string;
  bytes: Uint8Array;
  rawFileSha256: string;
}): ImportRepository {
  const storage = getPrivateObjectStorage();
  return {
    findBatchByFileFingerprint: (...args) =>
      repository.findBatchByFileFingerprint(...args),
    async createBatch(userId: string, batch: CreateImportBatchInput) {
      const objectKey = `imports/${input.userId}/${batch.id}/${input.rawFileSha256}.csv`;
      await storage.put(objectKey, input.bytes, "text/csv");
      try {
        const created = await repository.createBatch(userId, {
          ...batch,
          originalObjectKey: objectKey,
        });
        if (created.id !== batch.id) {
          await storage.delete(objectKey).catch(() => undefined);
          return created;
        }
        await withUserDb(userId, (tx) =>
          tx
            .update(importBatches)
            .set({
              expiresAt: new Date(
                Date.now() + retentionDays() * 24 * 60 * 60_000,
              ),
              uploadCompletedAt: new Date(),
              scanStatus: "legacy_unscanned",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(importBatches.id, batch.id),
                eq(importBatches.userId, userId),
              ),
            ),
        );
        return created;
      } catch (error) {
        await storage.delete(objectKey).catch(() => undefined);
        throw error;
      }
    },
    completeStaging: (...args) => repository.completeStaging(...args),
    failBatch: (...args) => repository.failBatch(...args),
    scrubBatchRawSnapshots: (...args) =>
      repository.scrubBatchRawSnapshots(...args),
    expireBatchAndScrub: (...args) =>
      repository.expireBatchAndScrub(...args),
    listBatches: (...args) => repository.listBatches(...args),
    getBatch: (...args) => repository.getBatch(...args),
    listRows: (...args) => repository.listRows(...args),
    getRowsForCommit: (...args) => repository.getRowsForCommit(...args),
    applyDecisions: (...args) => repository.applyDecisions(...args),
    replaceReviewRows: (...args) => repository.replaceReviewRows(...args),
  };
}

async function expireOriginalUploads(userId: string): Promise<void> {
  const expired = await withUserDb(userId, (tx) =>
    tx
      .select({
        id: importBatches.id,
        originalObjectKey: importBatches.originalObjectKey,
      })
      .from(importBatches)
      .where(
        and(
          eq(importBatches.userId, userId),
          lte(importBatches.expiresAt, new Date()),
          ne(importBatches.status, "expired"),
        ),
      ),
  );
  if (expired.length === 0) return;

  const storage = getPrivateObjectStorage();
  for (const batch of expired) {
    await repository.scrubBatchRawSnapshots(userId, batch.id);
    if (batch.originalObjectKey) {
      await storage.delete(batch.originalObjectKey);
    }
    await repository.expireBatchAndScrub(userId, batch.id);
  }
}

export const importService: ImportService = {
  async createUpload(userId, file, mapping) {
    await expireOriginalUploads(userId);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const content = decodeUpload(file, bytes);
    const detection = mapping ? undefined : detectFlightImportFormat(content);
    if (detection && detection.status !== "recognized") {
      throw new ImportServiceError(
        422,
        detection.status === "ambiguous"
          ? "ambiguous-format"
          : "unsupported-format",
        detection.reason,
      );
    }

    const imports = storageAwareImportRepository({
      userId,
      bytes,
      rawFileSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const upload = {
      fileName: cleanFileName(file.name),
      mimeType: file.type,
      sizeBytes: file.size,
      content,
    };
    const workerRepositories = {
      imports,
      flights: repository,
      airports: repository,
    };
    const staged = mapping
      ? stageMappedFlightImport(
          userId,
          upload,
          mapping,
          workerRepositories,
          { maxBytes: maxUploadBytes() },
        )
      : stageFlightImport(
      userId,
      upload,
      workerRepositories,
      { maxBytes: maxUploadBytes() },
    );
    return automaticallyCommitImport(
      userId,
      await staged,
      imports,
      repository,
    );
  },

  async listBatches(userId) {
    await expireOriginalUploads(userId);
    return repository.listBatches(userId);
  },

  async getBatch(userId, batchId, page, pageSize) {
    assertBatchId(batchId);
    await expireOriginalUploads(userId);
    const batch = await repository.getBatch(userId, batchId);
    const rows = batch
      ? batch.status === "review"
        ? paginateImportRows(
            (await repository.getRowsForCommit(userId, batchId))?.filter(
              (row) => row.decision === "pending",
            ) ?? [],
            page,
            pageSize,
          )
        : await repository.listRows(userId, batchId, page, pageSize)
      : null;
    return batch && rows
      ? redactOwnerImportBatchDetail({ ...batch, rows })
      : null;
  },

  async decide(userId, batchId, decisions) {
    assertBatchId(batchId);
    await expireOriginalUploads(userId);
    if (decisions.length < 1 || decisions.length > 500) {
      throw new ImportServiceError(
        400,
        "invalid-decisions",
        "Submit between 1 and 500 decisions.",
      );
    }
    for (const decision of decisions) {
      if (
        !UUID_PATTERN.test(decision.rowId) ||
        !["accepted", "skipped"].includes(decision.action) ||
        (decision.duplicateResolution !== undefined &&
          !["accept_new", "skip_as_duplicate"].includes(
            decision.duplicateResolution,
          ))
      ) {
        throw new ImportServiceError(
          400,
          "invalid-decision",
          "A row decision is invalid.",
        );
      }
    }
    const [batch, rows] = await Promise.all([
      repository.getBatch(userId, batchId),
      repository.getRowsForCommit(userId, batchId),
    ]);
    if (!batch || !rows) {
      throw new ImportServiceError(
        404,
        "batch-or-row-not-found",
        "The batch was not found.",
      );
    }
    if (batch.status !== "review") {
      throw new ImportServiceError(
        409,
        "batch-not-reviewable",
        "Only batches in review can be changed.",
      );
    }
    const rowById = new Map(rows.map((row) => [row.id, row]));
    for (const decision of decisions) {
      const row = rowById.get(decision.rowId);
      if (!row) {
        throw new ImportServiceError(
          404,
          "batch-or-row-not-found",
          "One of the selected rows was not found.",
        );
      }
      if (decision.action === "accepted" && !row.commitReady) {
        const reason =
          row.validationState === "ambiguous"
            ? "This ambiguous airport row cannot be committed. Skip it and correct the source file before re-importing."
            : row.validationState === "unresolved"
              ? "This unresolved airport row cannot be committed. Skip it and correct the source file before re-importing."
              : "Fix validation errors or skip this row.";
        throw new ImportServiceError(409, "row-not-committable", reason);
      }
      if (
        row.duplicateCandidate &&
        decision.action === "accepted" &&
        !decision.duplicateResolution
      ) {
        throw new ImportServiceError(
          409,
          "duplicate-resolution-required",
          "Choose whether to keep this flight as new or attach its source to the duplicate.",
        );
      }
      if (!row.duplicateCandidate && decision.duplicateResolution) {
        throw new ImportServiceError(
          409,
          "unexpected-duplicate-resolution",
          "This row no longer has a duplicate candidate.",
        );
      }
    }
    const decided = await repository.applyDecisions(
      userId,
      batchId,
      decisions,
    );
    const decidedRows = await repository.getRowsForCommit(userId, batchId);
    if (!decidedRows) {
      throw new ImportServiceError(404, "batch-not-found", "Batch not found.");
    }
    const acceptedRows = decidedRows.filter(
      (row) => row.decision === "accepted",
    );
    if (
      acceptedRows.some(
        (row) => row.duplicateCandidate?.resolution === "pending",
      )
    ) {
      return decided;
    }
    if (
      acceptedRows.length > 0 ||
      decidedRows.every((row) => row.decision !== "pending")
    ) {
      await repository.commitAcceptedImport(userId, {
        batch: decided,
        rows: decidedRows,
      });
      return (await repository.getBatch(userId, batchId)) ?? decided;
    }
    return decided;
  },

  async commit(userId, batchId) {
    assertBatchId(batchId);
    await expireOriginalUploads(userId);
    const [batch, rows] = await Promise.all([
      repository.getBatch(userId, batchId),
      repository.getRowsForCommit(userId, batchId),
    ]);
    if (!batch || !rows) {
      throw new ImportServiceError(404, "batch-not-found", "Batch not found.");
    }
    if (
      rows.some(
        (row) =>
          row.decision === "accepted" &&
          row.duplicateCandidate?.resolution === "pending",
      )
    ) {
      throw new ImportServiceError(
        409,
        "duplicate-resolution-required",
        "Every accepted duplicate needs an explicit resolution before commit.",
      );
    }
    try {
      const result = await repository.commitAcceptedImport(userId, {
        batch,
        rows,
      });
      const completed = await repository.getBatch(userId, batchId);
      return {
        batchId,
        status: result.status,
        completion: completed
          ? importCompletionSummary(completed)
          : undefined,
      };
    } catch (error) {
      throw new ImportServiceError(
        409,
        "batch-not-committable",
        error instanceof Error
          ? error.message
          : "The batch cannot be committed.",
      );
    }
  },

  async searchAirports(userId, query, limit) {
    const normalized = query.trim();
    if (normalized.length < 2 || normalized.length > 80) {
      throw new ImportServiceError(
        400,
        "invalid-airport-query",
        "Airport search requires 2 to 80 characters.",
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new ImportServiceError(
        400,
        "invalid-airport-limit",
        "Airport result limit must be from 1 to 25.",
      );
    }
    return repository.search(userId, normalized, limit);
  },

  async updateRow(userId, batchId, rowId, request) {
    assertBatchId(batchId);
    if (!UUID_PATTERN.test(rowId)) {
      throw new ImportServiceError(400, "invalid-row-id", "Invalid row ID.");
    }
    await expireOriginalUploads(userId);
    const [batch, rows] = await Promise.all([
      repository.getBatch(userId, batchId),
      repository.getRowsForCommit(userId, batchId),
    ]);
    if (!batch || !rows) {
      throw new ImportServiceError(404, "batch-not-found", "Batch not found.");
    }
    if (batch.status !== "review") {
      throw new ImportServiceError(
        409,
        "batch-not-reviewable",
        "Only batches in review can be corrected.",
      );
    }
    const rowIndex = rows.findIndex((row) => row.id === rowId);
    if (rowIndex < 0) {
      throw new ImportServiceError(404, "row-not-found", "Row not found.");
    }
    let proposal: UpdateImportRowRequest["proposal"];
    try {
      proposal = validateProposalPatch(request.proposal);
    } catch (error) {
      throw new ImportServiceError(
        400,
        "invalid-row-correction",
        error instanceof Error ? error.message : "The correction is invalid.",
      );
    }
    const [origin, destination, routeStopAirport] = await Promise.all([
      proposal.originAirportId
        ? repository.findById(userId, proposal.originAirportId)
        : undefined,
      proposal.destinationAirportId
        ? repository.findById(userId, proposal.destinationAirportId)
        : undefined,
      proposal.routeStop
        ? repository.findById(userId, proposal.routeStop.airportId)
        : undefined,
    ]);
    if (proposal.originAirportId && !origin) {
      throw new ImportServiceError(
        400,
        "invalid-origin-airport",
        "The selected origin airport does not exist.",
      );
    }
    if (proposal.destinationAirportId && !destination) {
      throw new ImportServiceError(
        400,
        "invalid-destination-airport",
        "The selected destination airport does not exist.",
      );
    }
    if (proposal.routeStop && !routeStopAirport) {
      throw new ImportServiceError(
        400,
        "invalid-route-stop-airport",
        "The selected route stop airport does not exist.",
      );
    }
    const updated = applyProposalCorrection(
      rows[rowIndex],
      {
        ...proposal,
        origin: origin ?? undefined,
        destination: destination ?? undefined,
        resolvedRouteStop:
          proposal.routeStop && routeStopAirport
            ? {
                index: proposal.routeStop.index,
                airport: routeStopAirport,
              }
            : undefined,
      },
      new Date().toISOString(),
    );
    const unchanged =
      JSON.stringify(updated.proposedFlight) ===
        JSON.stringify(rows[rowIndex].proposedFlight) &&
      JSON.stringify(updated.corrections ?? []) ===
        JSON.stringify(rows[rowIndex].corrections ?? []);
    if (unchanged) return batch;
    if (
      request.expectedUpdatedAt &&
      request.expectedUpdatedAt !== batch.updatedAt
    ) {
      throw new ImportServiceError(
        409,
        "stale-import-review",
        "The import changed. Refresh it before applying this correction.",
      );
    }
    updated.commitReady = isImportProposalCommitReady(
      updated.proposedFlight,
      updated.issues,
    );
    updated.validationState = importProposalValidationState(
      updated.proposedFlight,
      updated.issues,
    );
    updated.rowFingerprint = updated.commitReady
      ? createRowFingerprint(userId, updated.proposedFlight)
      : undefined;
    rows[rowIndex] = updated;
    const existing = await repository.findDuplicateCandidates(userId, rows);
    const rescored = applyDuplicateCandidates(rows, existing);
    const corrected = rescored[rowIndex];
    if (corrected.commitReady && !corrected.duplicateCandidate) {
      corrected.decision = "accepted";
      corrected.decidedAt = new Date().toISOString();
    }
    const replaced = await repository.replaceReviewRows(
      userId,
      batchId,
      rescored,
      request.expectedUpdatedAt,
    );
    if (corrected.decision === "accepted") {
      await repository.commitAcceptedImport(userId, {
        batch: replaced,
        rows: rescored,
      });
      return (await repository.getBatch(userId, batchId)) ?? replaced;
    }
    return replaced;
  },
};
