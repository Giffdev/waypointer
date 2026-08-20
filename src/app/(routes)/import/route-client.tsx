"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Database,
  FileSpreadsheet,
  LoaderCircle,
  Plane,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import {
  detectFlightImportFormat,
  parseFlightImport,
  type ParsedFlightImport,
} from "@/lib/import/registry";
import {
  detectGenericCsvPreset,
  GenericCsvImportError,
  inspectGenericCsv,
  previewGenericCsv,
  serializeGenericCsvMapping,
  type GenericCsvColumnKey,
  type GenericCsvInspection,
  type GenericCsvMapping,
  type GenericCsvUiPreview,
} from "@/lib/import/generic-csv";
import {
  parseGenericCsvMapping as normalizeGenericCsvMapping,
} from "@/lib/import/generic-mapping";
import { formatFlightDate } from "@/components/dashboard-shared";
import type { ImportPageContract } from "@/lib/route-contracts";
import type {
  ImportBatchStatus,
  ImportBatchSummary,
  ImportCompletionSummary,
  ImportIssue,
  AirportSearchResult,
  ImportDuplicateResolution,
  OwnerImportBatchDetail,
  StoredImportRow,
  UploadImportResponse,
} from "@/lib/import/types";
import {
  AirportSearchPicker,
  airportResultLabel,
} from "@/components/airport-search-picker";

const PAGE_SIZE = 25;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMPORT_POLL_BASE_INTERVAL_MS = 2_000;
const IMPORT_POLL_MAX_INTERVAL_MS = 60_000;
const IMPORT_POLL_HIDDEN_BASE_INTERVAL_MS = 15_000;
const IMPORT_POLL_HIDDEN_MAX_INTERVAL_MS = 5 * 60_000;
const IMPORT_POLL_STALE_WARNING_AFTER_MS = 2 * 60_000;
const IMPORT_POLL_STALE_STOP_AFTER_MS = 20 * 60_000;
const IMPORT_POLL_REQUEST_TIMEOUT_MS = 30_000;
const IMPORT_POLL_BACKOFF_EXPONENT_CAP = 6;

type ClientPhase =
  | "idle"
  | "uploading"
  | "processing"
  | "review"
  | "committing"
  | "committed"
  | "failed";

type FilePreparation =
  | { kind: "idle" }
  | { kind: "inspecting" }
  | { kind: "automatic"; label: string; mapping?: GenericCsvMapping }
  | {
      kind: "mapping";
      inspection: GenericCsvInspection;
      mapping: GenericCsvMapping;
      preview?: GenericCsvUiPreview;
      previewError?: string;
    }
  | { kind: "error"; message: string };

type ImportPollingProgress = {
  unchangedPolls: number;
  failedPolls: number;
  startedAtMs: number;
};

type ImportPollingState = {
  batchId: string;
  lastUpdatedAt?: string;
  progress: ImportPollingProgress;
};

export type ImportPollDelayInput = {
  visible: boolean;
  unchangedPolls: number;
  failedPolls: number;
};

export function nextImportPollDelayMs({
  visible,
  unchangedPolls,
  failedPolls,
}: ImportPollDelayInput): number {
  const base = visible
    ? IMPORT_POLL_BASE_INTERVAL_MS
    : IMPORT_POLL_HIDDEN_BASE_INTERVAL_MS;
  const maximum = visible
    ? IMPORT_POLL_MAX_INTERVAL_MS
    : IMPORT_POLL_HIDDEN_MAX_INTERVAL_MS;
  const exponent = Math.min(
    IMPORT_POLL_BACKOFF_EXPONENT_CAP,
    Math.max(0, unchangedPolls, failedPolls),
  );
  return Math.min(maximum, base * 2 ** exponent);
}

export function shouldWarnImportPolling(elapsedMs: number): boolean {
  return elapsedMs >= IMPORT_POLL_STALE_WARNING_AFTER_MS;
}

export function shouldPauseImportPolling(elapsedMs: number): boolean {
  return elapsedMs >= IMPORT_POLL_STALE_STOP_AFTER_MS;
}

export default function ImportRouteClient({
  data,
  apiEnabled = false,
  developmentPreviewEnabled = false,
  durableImportEnabled = false,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  unavailableReason,
}: {
  data: ImportPageContract;
  apiEnabled?: boolean;
  developmentPreviewEnabled?: boolean;
  durableImportEnabled?: boolean;
  maxFileBytes?: number;
  unavailableReason?: string;
}) {
  return (
    <ImportRouteClientView
      data={data}
      apiEnabled={apiEnabled}
      developmentPreviewEnabled={developmentPreviewEnabled}
      durableImportEnabled={durableImportEnabled}
      maxFileBytes={maxFileBytes}
      unavailableReason={unavailableReason}
    />
  );
}

export function ImportRouteClientView({
  data,
  apiEnabled,
  developmentPreviewEnabled,
  durableImportEnabled = false,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  unavailableReason,
}: {
  data: ImportPageContract;
  apiEnabled: boolean;
  developmentPreviewEnabled: boolean;
  durableImportEnabled?: boolean;
  maxFileBytes?: number;
  unavailableReason?: string;
}) {
  if (apiEnabled) {
    return (
      <ImportWorkflow
        data={data}
        durableImportEnabled={durableImportEnabled}
        maxFileBytes={maxFileBytes}
      />
    );
  }
  return (
    <DevelopmentFallback
      data={data}
      previewEnabled={developmentPreviewEnabled}
      maxFileBytes={maxFileBytes}
      unavailableReason={unavailableReason}
    />
  );
}

function ImportWorkflow({
  data,
  durableImportEnabled,
  maxFileBytes,
}: {
  data: ImportPageContract;
  durableImportEnabled: boolean;
  maxFileBytes: number;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const mappingPreviewRequest = useRef(0);
  const fileSelectionRequest = useRef(0);
  const uploadInFlight = useRef(false);
  const detailRequest = useRef(0);
  const navigatedBatchId = useRef<string | undefined>(undefined);
  const polling = useRef<ImportPollingState | undefined>(undefined);
  const [file, setFile] = useState<File | null>(null);
  const [filePreparation, setFilePreparation] = useState<FilePreparation>({
    kind: "idle",
  });
  const [uploadBusy, setUploadBusy] = useState(false);
  const [phase, setPhase] = useState<ClientPhase>("idle");
  const [batches, setBatches] = useState<ImportBatchSummary[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string>();
  const [detail, setDetail] = useState<OwnerImportBatchDetail>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [busyRowId, setBusyRowId] = useState<string>();
  const [completion, setCompletion] = useState<ImportCompletionSummary>();
  const [redirectBatchId, setRedirectBatchId] = useState<string>();
  const [pausedPollingBatchId, setPausedPollingBatchId] = useState<string>();
  const [pollingRestartGeneration, setPollingRestartGeneration] = useState(0);
  const [visible, setVisible] = useState(
    typeof document === "undefined" || document.visibilityState === "visible",
  );

  async function selectFile(nextFile: File) {
    const requestId = ++fileSelectionRequest.current;
    const validationError = validateCsvFile(nextFile, maxFileBytes);
    setError(validationError);
    setFile(validationError ? null : nextFile);
    setFilePreparation({ kind: validationError ? "idle" : "inspecting" });
    if (validationError) return;

    try {
      const content = await readPreviewCsv(nextFile, maxFileBytes);
      if (requestId !== fileSelectionRequest.current) return;
      const detection = detectFlightImportFormat(content);
      if (detection.status === "recognized") {
        const parsed = parseFlightImport(content);
        if (parsed.status !== "parsed") {
          const message = previewParseError(parsed);
          setFile(null);
          setFilePreparation({ kind: "error", message });
          setError(message);
          return;
        }
        const preparation: FilePreparation = {
          kind: "automatic",
          label: detection.label,
        };
        setFilePreparation(preparation);
        await uploadSelectedFile(nextFile, preparation);
        return;
      }
      const inspection = inspectGenericCsv(content);
      const suggestion =
        inspection.preset?.suggestedMapping ??
        detectGenericCsvPreset(inspection.headers).suggestedMapping;
      const mapping = prepareSuggestedMapping(suggestion);
      const normalized = validGenericMapping(mapping);
      if (normalized) {
        previewGenericCsv(content, normalized);
        const preparation: FilePreparation = {
          kind: "automatic",
          label: inspection.preset?.label ?? "Generic CSV",
          mapping: normalized,
        };
        setFilePreparation(preparation);
        await uploadSelectedFile(nextFile, preparation);
        return;
      }
      setFilePreparation({
        kind: "mapping",
        inspection,
        mapping,
      });
    } catch (selectionError) {
      if (requestId !== fileSelectionRequest.current) return;
      const message =
        selectionError instanceof GenericCsvImportError
          ? "We could not inspect this CSV. Check that it has one header row and UTF-8 text."
          : messageFor(selectionError);
      setFile(null);
      setFilePreparation({
        kind: "error",
        message,
      });
      setError(message);
    }
  }

  async function updateGenericMapping(mapping: GenericCsvMapping) {
    if (!file || filePreparation.kind !== "mapping") return;
    const requestId = ++mappingPreviewRequest.current;
    const inspection = filePreparation.inspection;
    setFilePreparation({ kind: "mapping", inspection, mapping });
    const normalized = validGenericMapping(mapping);
    if (!normalized) return;

    try {
      const preview = previewGenericCsv(await file.text(), normalized);
      if (requestId !== mappingPreviewRequest.current) return;
      setFilePreparation({
        kind: "mapping",
        inspection,
        mapping: normalized,
        preview,
      });
    } catch {
      if (requestId !== mappingPreviewRequest.current) return;
      setFilePreparation({
        kind: "mapping",
        inspection,
        mapping,
        previewError:
          "The mapped preview could not be refreshed. Review the selected columns and formats.",
      });
    }
  }

  const resetPollingState = useCallback(() => {
    polling.current = undefined;
    setPausedPollingBatchId(undefined);
  }, []);

  const restartPollingState = useCallback(() => {
    resetPollingState();
    setPollingRestartGeneration((current) => current + 1);
  }, [resetPollingState]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibilityChange = () => {
      setVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const loadBatches = useCallback(async () => {
    const response = await apiRequest<{ batches: unknown[] }>(
      "/api/import/batches",
    );
    setBatches(response.batches.map(normalizeBatchSummary));
  }, []);

  const loadDetail = useCallback(
    async (
      batchId: string,
      requestedPage: number,
      signal?: AbortSignal,
      canCommit?: () => boolean,
    ): Promise<OwnerImportBatchDetail | undefined> => {
      const requestId = ++detailRequest.current;
      const response = await apiRequest<
        OwnerImportBatchDetail | { batch: unknown }
      >(
        `/api/import/batches/${encodeURIComponent(batchId)}?page=${requestedPage}&pageSize=${PAGE_SIZE}`,
        { signal },
      );
      const next = normalizeBatchDetail(
        "batch" in response ? response.batch : response,
      );
      if (
        requestId !== detailRequest.current ||
        (canCommit && !canCommit())
      ) {
        return undefined;
      }
      setDetail(next);
      setCompletion(completionFromCounts(next.counts));
      setPage(next.rows.page);
      setPhase(phaseForStatus(next.status));
      setBatches((current) => [
        next,
        ...current.filter((batch) => batch.id !== next.id),
      ]);
      if (next.status === "failed") {
        setError(next.error?.message ?? "The import failed.");
      } else {
        setError((current) =>
          current && isPollingStatusMessage(current) ? undefined : current,
        );
      }
      return next;
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadBatches().catch(() => {
        setError("Import history is temporarily unavailable.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadBatches]);

  useEffect(() => {
    if (
      uploadBusy ||
      !activeBatchId ||
      phase === "processing" ||
      phase === "committing" ||
      (detail?.id === activeBatchId && detail.rows.page === page)
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      loadDetail(activeBatchId, page).catch(() => {
        setError("The import status could not be refreshed.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeBatchId, detail, loadDetail, page, phase, uploadBusy]);

  useEffect(() => {
    if (uploadBusy) return;
    if (!activeBatchId || (phase !== "processing" && phase !== "committing")) {
      polling.current = undefined;
      return;
    }
    const pollingPaused = pausedPollingBatchId === activeBatchId;
    if (pollingPaused) return;

    if (!polling.current || polling.current.batchId !== activeBatchId) {
      polling.current = {
        batchId: activeBatchId,
        progress: {
          unchangedPolls: 0,
          failedPolls: 0,
          startedAtMs: Date.now(),
        },
      };
    }

    let cancelled = false;
    let timer: number | undefined;
    let requestController: AbortController | undefined;

    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => {
        if (!cancelled) {
          void poll();
        }
      }, delayMs);
    };

    const evaluateElapsedPolicy = (
      current: ImportPollingState,
    ): "paused" | "warned" | "fresh" => {
      const elapsedMs = Date.now() - current.progress.startedAtMs;
      if (shouldPauseImportPolling(elapsedMs)) {
        setPausedPollingBatchId(activeBatchId);
        setError(
          "Import status checks paused after a long-running batch with no terminal update. Resume checks or cancel/retry the batch.",
        );
        return "paused";
      }
      if (shouldWarnImportPolling(elapsedMs)) {
        setError(
          "This import is taking longer than expected. Status checks are still active with slower backoff.",
        );
        return "warned";
      }
      return "fresh";
    };

    const loadPollingDetail = async () => {
      const controller = new AbortController();
      requestController = controller;
      let commitAllowed = true;
      let timeout: number | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => {
          commitAllowed = false;
          controller.abort();
          reject(new Error("Import status request timed out."));
        }, IMPORT_POLL_REQUEST_TIMEOUT_MS);
      });
      try {
        return await Promise.race([
          loadDetail(
            activeBatchId,
            page,
            controller.signal,
            () => commitAllowed && !cancelled,
          ),
          timedOut,
        ]);
      } finally {
        commitAllowed = false;
        if (timeout !== undefined) window.clearTimeout(timeout);
        if (requestController === controller) {
          requestController = undefined;
        }
      }
    };

    const poll = async () => {
      if (cancelled) return;
      const current = polling.current;
      if (!current || current.batchId !== activeBatchId) return;

      try {
        const next = await loadPollingDetail();
        if (cancelled) return;
        if (!next) {
          schedule(
            nextImportPollDelayMs({
              visible,
              unchangedPolls: current.progress.unchangedPolls,
              failedPolls: current.progress.failedPolls,
            }),
          );
          return;
        }
        current.progress.failedPolls = 0;
        if (current.lastUpdatedAt === next.updatedAt) {
          current.progress.unchangedPolls += 1;
        } else {
          current.progress.unchangedPolls = 0;
          current.lastUpdatedAt = next.updatedAt;
        }
        const nextPhase = phaseForStatus(next.status);
        if (nextPhase !== "processing" && nextPhase !== "committing") return;
        const elapsedPolicy = evaluateElapsedPolicy(current);
        if (elapsedPolicy === "paused") return;
        schedule(
          nextImportPollDelayMs({
            visible,
            unchangedPolls: current.progress.unchangedPolls,
            failedPolls: current.progress.failedPolls,
          }),
        );
      } catch {
        if (cancelled) return;
        const currentAfterError = polling.current;
        if (!currentAfterError || currentAfterError.batchId !== activeBatchId) {
          return;
        }
        currentAfterError.progress.failedPolls += 1;
        const elapsedPolicy = evaluateElapsedPolicy(currentAfterError);
        if (elapsedPolicy === "paused") return;
        if (
          elapsedPolicy === "fresh" &&
          currentAfterError.progress.failedPolls >= 2
        ) {
          setError("The import status could not be refreshed. Retrying with backoff.");
        }
        schedule(
          nextImportPollDelayMs({
            visible,
            unchangedPolls: currentAfterError.progress.unchangedPolls,
            failedPolls: currentAfterError.progress.failedPolls,
          }),
        );
      }
    };

    schedule(0);
    return () => {
      cancelled = true;
      requestController?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    activeBatchId,
    loadDetail,
    page,
    pausedPollingBatchId,
    phase,
    pollingRestartGeneration,
    uploadBusy,
    visible,
  ]);

  useEffect(() => {
    if (
      !detail ||
      !redirectBatchId ||
      detail.id !== redirectBatchId ||
      activeBatchId !== redirectBatchId ||
      !isRedirectableTerminalBatch(detail) ||
      navigatedBatchId.current === redirectBatchId
    ) {
      return;
    }
    navigatedBatchId.current = redirectBatchId;
    router.replace("/map");
    router.refresh();
  }, [activeBatchId, detail, redirectBatchId, router]);

  async function uploadSelectedFile(
    selectedFile = file,
    preparation = filePreparation,
  ) {
    if (
      !selectedFile ||
      uploadInFlight.current ||
      (preparation.kind !== "automatic" && preparation.kind !== "mapping")
    ) {
      return;
    }
    const mapping =
      preparation.kind === "mapping"
        ? validGenericMapping(preparation.mapping)
        : preparation.kind === "automatic"
          ? preparation.mapping
        : undefined;
    if (preparation.kind === "mapping" && !mapping) return;
    const serializedMapping = mapping
      ? serializeGenericCsvMapping(mapping)
      : undefined;
    uploadInFlight.current = true;
    setUploadBusy(true);
    detailRequest.current += 1;
    resetPollingState();
    setRedirectBatchId(undefined);
    setDetail(undefined);
    setCompletion(undefined);
    setError(undefined);
    setPhase("uploading");
    try {
      let response: UploadImportResponse;
      if (durableImportEnabled) {
        const contentType = selectedFile.type || "text/csv";
        const initiated = await apiRequest<{
          batchId: string;
          uploadUrl: string;
          headers: Record<string, string>;
        }>("/api/import/upload/initiate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: selectedFile.name,
            contentType,
            sizeBytes: selectedFile.size,
            idempotencyKey: crypto.randomUUID(),
          }),
        });
        const uploaded = await fetch(initiated.uploadUrl, {
          method: "PUT",
          headers: initiated.headers,
          body: selectedFile,
        });
        if (!uploaded.ok) {
          throw new Error("The private upload could not be completed.");
        }
        response = await apiRequest<UploadImportResponse>(
          "/api/import/upload/finalize",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              batchId: initiated.batchId,
              ...(serializedMapping
                ? { mapping: JSON.parse(serializedMapping) }
                : {}),
            }),
          },
        );
      } else {
        const body = new FormData();
        body.set("file", selectedFile);
        if (serializedMapping) body.set("mapping", serializedMapping);
        response = await apiRequest<UploadImportResponse>(
          "/api/import/upload",
          { method: "POST", body },
        );
      }
      setCompletion(response.completion);
      setRedirectBatchId(response.batchId);
      setActiveBatchId(response.batchId);
      setPage(1);
      setPhase(phaseForStatus(response.status));
      setFile(null);
      setFilePreparation({ kind: "idle" });
      if (fileInput.current) fileInput.current.value = "";
      let refreshFailed = false;
      try {
        await loadDetail(response.batchId, 1);
      } catch {
        refreshFailed = true;
      }
      try {
        await loadBatches();
      } catch {
        refreshFailed = true;
      }
      if (refreshFailed) {
        setError(
          "The import was accepted, but its status could not be refreshed.",
        );
      }
    } catch (uploadError) {
      setPhase("failed");
      setError(messageFor(uploadError));
    } finally {
      uploadInFlight.current = false;
      setUploadBusy(false);
    }
  }

  async function cancelActiveImport() {
    if (!activeBatchId) return;
    setError(undefined);
    try {
      await apiRequest(`/api/import/batches/${activeBatchId}/cancel`, {
        method: "POST",
      });
      await loadDetail(activeBatchId, page);
      restartPollingState();
      await loadBatches();
    } catch (actionError) {
      setError(messageFor(actionError));
    }
  }

  async function retryActiveImport() {
    if (!activeBatchId) return;
    setError(undefined);
    try {
      await apiRequest(`/api/import/batches/${activeBatchId}/retry`, {
        method: "POST",
      });
      await loadDetail(activeBatchId, page);
      restartPollingState();
      await loadBatches();
    } catch (actionError) {
      setError(messageFor(actionError));
    }
  }

  async function decide(
    row: StoredImportRow,
    action: "accept" | "skip",
    duplicateResolution?: Exclude<ImportDuplicateResolution, "pending">,
  ) {
    if (!activeBatchId) return;
    setBusyRowId(row.id);
    setError(undefined);
    try {
      await apiRequest(`/api/import/batches/${activeBatchId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            {
              rowId: row.id,
              action: action === "accept" ? "accepted" : "skipped",
              duplicateResolution,
            },
          ],
        }),
      });
      await loadDetail(activeBatchId, page);
    } catch (decisionError) {
      setError(messageFor(decisionError));
    } finally {
      setBusyRowId(undefined);
    }
  }

  async function correctRow(
    row: StoredImportRow,
    proposal: Record<string, unknown>,
  ) {
    if (!activeBatchId || !detail) return;
    setBusyRowId(row.id);
    setError(undefined);
    try {
      await apiRequest(
        `/api/import/batches/${activeBatchId}/rows/${row.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt: detail.updatedAt,
            proposal,
          }),
        },
      );
      await loadDetail(activeBatchId, page);
    } catch (correctionError) {
      setError(messageFor(correctionError));
    } finally {
      setBusyRowId(undefined);
    }
  }

  const uploadDisabled =
    !file ||
    uploadBusy ||
    (filePreparation.kind === "mapping" &&
      !validGenericMapping(filePreparation.mapping));
  const showUploadAction =
    uploadBusy ||
    filePreparation.kind === "mapping" ||
    (phase === "failed" &&
      file !== null &&
      filePreparation.kind === "automatic");
  const uploadState =
    uploadBusy ? "loading" : uploadDisabled ? "disabled" : "ready";

  return (
    <main className="app-shell" id="main-content" tabIndex={-1}>
      <section className="content-section records-section route-page">
        <div className="import-workflow">
          <div className="section-heading record-heading">
            <div>
              <p className="eyebrow">Acquisition workflow</p>
              <h1>Import new flight records.</h1>
            </div>
            <p>
              Upload one CSV. Clean new flights are saved automatically,
              exact duplicates are skipped, and only rows needing correction
              or a duplicate choice remain for review.
            </p>
          </div>

          <div className="workflow-step available">
            <span className="status-chip available">1. Upload</span>
            <FileSpreadsheet size={20} aria-hidden="true" />
            <FileDropzone
              id="flight-import-file"
              inputRef={fileInput}
              file={file}
              disabled={
                uploadBusy ||
                filePreparation.kind === "inspecting"
              }
              maxFileBytes={maxFileBytes}
              onSelect={selectFile}
            />
            <GenericMappingPanel
              preparation={filePreparation}
              onChange={updateGenericMapping}
            />
            <p>{data.supportedFormats.join(" and ")}</p>
            <p className="import-role-defaults">
              <strong>Classification defaults:</strong> ForeFlight,
              MyFlightbook, and CrewLounge Pilotlog use Personal / Pilot;
              myFlightradar24 uses Commercial / Passenger. Generic files with
              no reliable role require an explicit choice in mapping, where
              the default applies to the whole file and can be changed before
              upload.
            </p>
            {showUploadAction ? (
              <button
                type="button"
                className={`import-upload-button ${uploadState}`}
                disabled={uploadDisabled}
                onClick={() => void uploadSelectedFile()}
                aria-describedby="import-upload-readiness"
                aria-busy={uploadBusy}
              >
                {uploadBusy ? (
                  <LoaderCircle size={16} aria-hidden="true" />
                ) : (
                  <CloudUpload size={16} aria-hidden="true" />
                )}
                {uploadBusy
                  ? "Uploading…"
                  : phase === "failed"
                    ? "Try import again"
                    : "Import mapped CSV"}
              </button>
            ) : null}
            <small id="import-upload-readiness" aria-live="polite">
              {uploadBusy
                ? "Uploading securely. Keep this page open."
                : file
                  ? filePreparation.kind === "mapping"
                    ? validGenericMapping(filePreparation.mapping)
                    ? "Column mapping is complete. Ready to import."
                      : "Map the date, origin, and destination columns to continue."
                    : filePreparation.kind === "inspecting"
                      ? "Inspecting CSV headers."
                      : filePreparation.kind === "error"
                        ? filePreparation.message
                        : filePreparation.kind === "automatic"
                          ? phase === "failed"
                            ? `${filePreparation.label} detected. Ready to try again.`
                            : `${filePreparation.label} detected. Import starts automatically.`
                          : "Ready to import."
                  : "Choose or drop a CSV to start an import."}
            </small>
          </div>

          {error ? (
            <div className="local-source-status" role="alert">
              <AlertTriangle size={19} aria-hidden="true" />
              <span>
                <strong>Import needs attention</strong>
                <small>{error}</small>
              </span>
            </div>
          ) : null}

          {detail ? (
            <>
              {durableImportEnabled &&
              ["pending", "queued", "scanning", "processing", "retrying"].includes(
                detail.status,
              ) ? (
                <button type="button" onClick={cancelActiveImport}>
                  Cancel import
                </button>
              ) : null}
              {durableImportEnabled &&
              detail.status === "failed" &&
              [
                "scanner-unavailable",
                "scanner-timeout",
                "scanner-signatures-stale",
                "processing-failed",
              ].includes(detail.error?.code ?? "") ? (
                <button type="button" onClick={retryActiveImport}>
                  Retry import
                </button>
              ) : null}
              {pausedPollingBatchId === detail.id &&
              ["pending", "queued", "scanning", "processing", "committing", "retrying"].includes(
                detail.status,
              ) ? (
                <button
                  type="button"
                  onClick={() => {
                    polling.current = {
                      batchId: detail.id,
                      lastUpdatedAt: detail.updatedAt,
                      progress: {
                        unchangedPolls: 0,
                        failedPolls: 0,
                        startedAtMs: Date.now(),
                      },
                    };
                    setPausedPollingBatchId(undefined);
                    setError((current) => {
                      return current && isPollingStatusMessage(current)
                        ? undefined
                        : current;
                    });
                  }}
                >
                  Resume status checks
                </button>
              ) : null}
              <BatchReview
                detail={detail}
                completion={completion}
                phase={phase}
                busyRowId={busyRowId}
                onDecide={decide}
                onCorrect={correctRow}
                onPage={(nextPage) => setPage(nextPage)}
              />
            </>
          ) : null}

          <BatchHistory
            batches={batches}
            activeBatchId={activeBatchId}
            onSelect={(batchId) => {
              detailRequest.current += 1;
              resetPollingState();
              setRedirectBatchId(undefined);
              setDetail(undefined);
              setCompletion(undefined);
              setActiveBatchId(batchId);
              setPage(1);
              setError(undefined);
            }}
          />
        </div>
      </section>
    </main>
  );
}

function BatchReview({
  detail,
  completion,
  phase,
  busyRowId,
  onDecide,
  onCorrect,
  onPage,
}: {
  detail: OwnerImportBatchDetail;
  completion?: ImportCompletionSummary;
  phase: ClientPhase;
  busyRowId?: string;
  onDecide: (
    row: StoredImportRow,
    action: "accept" | "skip",
    duplicateResolution?: Exclude<ImportDuplicateResolution, "pending">,
  ) => void;
  onCorrect: (
    row: StoredImportRow,
    proposal: Record<string, unknown>,
  ) => void;
  onPage: (page: number) => void;
}) {
  if (phase === "processing" || phase === "committing") {
    return (
      <div className="local-source-status" role="status" aria-live="polite">
        <LoaderCircle size={19} aria-hidden="true" />
        <span>
          <strong>
            {phase === "processing"
              ? "Processing uploaded CSV"
              : "Committing accepted rows"}
          </strong>
          <small>
            Completion will appear only after the server reports the final
            batch state.
          </small>
        </span>
      </div>
    );
  }
  if (detail.status === "committed") {
    return (
      <>
        <ImportCompletionStatus completion={completion} redirecting />
        <div className="local-source-status" role="status">
          <CheckCircle2 size={19} aria-hidden="true" />
          <span>
            <strong>Import complete</strong>
            <small>
              Your saved map and flight history now include the clean imported
              rows. Opening your map now.
            </small>
            <span>
              <a href="/map">View map</a>
              {" · "}
              <a href="/flights">View flights</a>
            </span>
          </span>
        </div>
      </>
    );
  }
  if (detail.status === "deduplicated") {
    return (
      <div className="local-source-status" role="status">
        <CheckCircle2 size={19} aria-hidden="true" />
        <span>
          <strong>Already imported</strong>
          <small>
            This file is already reflected on your map. Opening your map now.
          </small>
        </span>
      </div>
    );
  }
  if (["failed", "cancelled", "quarantined"].includes(detail.status)) {
    return (
      <div className="local-source-status" role="alert">
        <AlertTriangle size={19} aria-hidden="true" />
        <span>
          <strong>
            {detail.status === "cancelled"
              ? "Import cancelled"
              : detail.status === "quarantined"
                ? "Import quarantined"
                : "Import failed"}
          </strong>
          <small>
            {detail.error?.message ??
              "The import could not be processed safely."}
          </small>
        </span>
      </div>
    );
  }
  if (detail.status !== "review") return null;

  return (
    <section aria-labelledby="import-review-heading">
      <ImportCompletionStatus completion={completion} />
      <div className="section-heading record-heading">
        <div>
          <p className="eyebrow">Needs review</p>
          <h2 id="import-review-heading">Fix unresolved rows</h2>
        </div>
        <p>
          {completion?.importedRows ?? detail.counts.importedRows ?? 0} rows
          already imported from {detail.fileName}. Only the{" "}
          {detail.counts.pendingRows} rows below need attention.
        </p>
      </div>
      <div className="flight-list import-exception-list" aria-label="Unresolved import rows">
        {detail.rows.rows.map((row) => {
          const flight = row.proposedFlight;
          return (
            <article className="flight-row import-exception-row" key={row.id}>
              <div className={`flight-kind ${flight.kind}`}>
                <Plane size={17} aria-hidden="true" />
              </div>
              <div className="flight-primary">
                <div className="route">
                  <strong>{airportCode(flight.origin)}</strong>
                  <span className="route-line" />
                  <strong>{airportCode(flight.destination)}</strong>
                  <small>
                    Import row {row.rowNumber} · {reviewReason(row)}
                  </small>
                </div>
                <div className="record-tags">
                  <span>{flight.role === "pilot" ? "Pilot" : "Passenger"}</span>
                  <span>{flight.source}</span>
                  <span>Needs correction</span>
                </div>
              </div>
              <div className="flight-meta">
                <strong>
                  {flight.date ? formatFlightDate(flight.date) : "Invalid date"}
                </strong>
                <span>
                  {flight.flightNumber ??
                    flight.registration ??
                    flight.aircraft ??
                    "Flight details missing"}
                </span>
              </div>
              <div className="flight-actions import-exception-actions">
                {row.duplicateCandidate ? (
                  <>
                    <button
                      className="flight-action-button"
                      type="button"
                      disabled={!row.commitReady || busyRowId === row.id}
                      onClick={() => onDecide(row, "accept", "accept_new")}
                    >
                      Keep as new
                    </button>
                    <button
                      className="flight-action-button"
                      type="button"
                      disabled={!row.commitReady || busyRowId === row.id}
                      onClick={() =>
                        onDecide(row, "accept", "skip_as_duplicate")
                      }
                    >
                      Use existing
                    </button>
                  </>
                ) : null}
                <button
                  className="flight-action-button danger"
                  type="button"
                  disabled={busyRowId === row.id}
                  onClick={() => onDecide(row, "skip")}
                >
                  Skip
                </button>
              </div>
              <div className="import-exception-detail">
                <strong>{reviewReason(row)}</strong>
                {row.duplicateCandidate ? (
                  <small>
                    {Math.round(row.duplicateCandidate.score * 100)}% match ·{" "}
                    {row.duplicateCandidate.explanation}
                  </small>
                ) : null}
                {row.proposedFlight.origin?.status === "ambiguous" ? (
                  <small>
                    Origin candidates:{" "}
                    {row.proposedFlight.origin.candidates
                      .map((candidate) => candidate.code)
                      .join(", ")}
                  </small>
                ) : null}
                {row.proposedFlight.destination?.status === "ambiguous" ? (
                  <small>
                    Destination candidates:{" "}
                    {row.proposedFlight.destination.candidates
                      .map((candidate) => candidate.code)
                      .join(", ")}
                  </small>
                ) : null}
                {row.issues.map((issue) => (
                  <small key={`${issue.field}-${issue.code}`}>
                    {issue.message}
                  </small>
                ))}
                <RowCorrectionEditor
                  row={row}
                  disabled={busyRowId === row.id}
                  onSave={(proposal) => onCorrect(row, proposal)}
                />
              </div>
            </article>
          );
        })}
      </div>
      <div>
        <button
          type="button"
          disabled={detail.rows.page <= 1}
          onClick={() => onPage(detail.rows.page - 1)}
        >
          Previous
        </button>{" "}
        <span>
          Page {detail.rows.page} of {detail.rows.totalPages}
        </span>{" "}
        <button
          type="button"
          disabled={detail.rows.page >= detail.rows.totalPages}
          onClick={() => onPage(detail.rows.page + 1)}
        >
          Next
        </button>
      </div>
    </section>
  );
}

function ImportCompletionStatus({
  completion,
  redirecting = false,
}: {
  completion?: ImportCompletionSummary;
  redirecting?: boolean;
}) {
  if (!completion) return null;
  return (
    <div className="import-completion-summary" role="status" aria-live="polite">
      <strong>{redirecting ? "Import finished" : "Import summary"}</strong>
      <ul>
        <li>{completion.importedRows} imported</li>
        <li>{completion.duplicateRows} duplicates skipped</li>
        <li>{completion.skippedRows} other rows skipped</li>
        <li>{completion.invalidRows} invalid</li>
        <li>{completion.reviewRequiredRows} need review</li>
      </ul>
      <small>
        {redirecting
          ? "No rows need intervention. Opening your map."
          : "Only rows that genuinely need correction or a duplicate choice are shown below."}
      </small>
    </div>
  );
}

function RowCorrectionEditor({
  row,
  disabled,
  onSave,
}: {
  row: StoredImportRow;
  disabled: boolean;
  onSave: (proposal: Record<string, unknown>) => void;
}) {
  const flight = row.proposedFlight;
  const [originAirportId, setOriginAirportId] = useState(
    flight.origin?.status === "resolved" ? flight.origin.airportId : "",
  );
  const [destinationAirportId, setDestinationAirportId] = useState(
    flight.destination?.status === "resolved"
      ? flight.destination.airportId
      : "",
  );
  const [date, setDate] = useState(flight.date ?? "");
  const [departureTime, setDepartureTime] = useState(
    flight.departureTime?.slice(0, 5) ?? "",
  );
  const [flightNumber, setFlightNumber] = useState(
    flight.flightNumber ?? "",
  );
  const [registration, setRegistration] = useState(
    flight.registration ?? "",
  );
  const [aircraft, setAircraft] = useState(flight.aircraft ?? "");

  return (
    <details className="import-row-correction">
      <summary className="flight-action-button">Correct flight</summary>
      <form
        className="import-correction-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            ...(originAirportId ? { originAirportId } : {}),
            ...(destinationAirportId ? { destinationAirportId } : {}),
            date,
            ...(departureTime ? { departureTime } : {}),
            flightNumber,
            registration,
            aircraft,
          });
        }}
      >
        <AirportCorrectionSearch
          label={`Origin airport for row ${row.rowNumber}`}
          selectedLabel={airportLabel(flight.origin)}
          disabled={disabled}
          onSelect={setOriginAirportId}
        />
        <AirportCorrectionSearch
          label={`Destination airport for row ${row.rowNumber}`}
          selectedLabel={airportLabel(flight.destination)}
          disabled={disabled}
          onSelect={setDestinationAirportId}
        />
        <label>
          Date
          <input
            type="date"
            value={date}
            disabled={disabled}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label>
          Departure time
          <input
            type="time"
            value={departureTime}
            disabled={disabled}
            onChange={(event) => setDepartureTime(event.target.value)}
          />
        </label>
        <label>
          Flight number
          <input
            value={flightNumber}
            disabled={disabled}
            maxLength={100}
            onChange={(event) => setFlightNumber(event.target.value)}
          />
        </label>
        <label>
          Registration
          <input
            value={registration}
            disabled={disabled}
            maxLength={100}
            onChange={(event) => setRegistration(event.target.value)}
          />
        </label>
        <label>
          Aircraft
          <input
            value={aircraft}
            disabled={disabled}
            maxLength={100}
            onChange={(event) => setAircraft(event.target.value)}
          />
        </label>
        <button type="submit" disabled={disabled || !date}>
          Save correction
        </button>
      </form>
    </details>
  );
}

function AirportCorrectionSearch({
  label,
  selectedLabel,
  disabled,
  onSelect,
}: {
  label: string;
  selectedLabel: string;
  disabled: boolean;
  onSelect: (airportId: string) => void;
}) {
  const [selected, setSelected] = useState<AirportSearchResult | null>(null);
  return (
    <div>
      <AirportSearchPicker
        label={label}
        selected={selected}
        disabled={disabled}
        onSelect={(airport) => {
          setSelected(airport);
          onSelect(airport.airportId);
        }}
      />
      {!selected && <small>Selected: {selectedLabel}</small>}
      {selected && <small className="sr-only">{airportResultLabel(selected)}</small>}
    </div>
  );
}

function BatchHistory({
  batches,
  activeBatchId,
  onSelect,
}: {
  batches: ImportBatchSummary[];
  activeBatchId?: string;
  onSelect: (batchId: string) => void;
}) {
  if (batches.length === 0) return null;
  return (
    <section aria-labelledby="import-history-heading">
      <div className="section-heading record-heading">
        <div>
          <p className="eyebrow">Import history</p>
          <h2 id="import-history-heading">Your batches</h2>
        </div>
      </div>
      <div className="workflow-grid">
        {batches.map((batch) => (
          <button
            key={batch.id}
            type="button"
            aria-current={batch.id === activeBatchId ? "true" : undefined}
            onClick={() => onSelect(batch.id)}
          >
            <strong>{batch.fileName}</strong>
            <small style={{ display: "block" }}>
              {batch.status} · {batch.counts.totalRows} rows
            </small>
          </button>
        ))}
      </div>
    </section>
  );
}

type PreviewReviewRow = {
  rowNumber: number;
  date?: string;
  origin?: string;
  destination?: string;
  flight: string;
  issues: ImportIssue[];
};

type LocalImportPreview = {
  fileName: string;
  fileSize: number;
  adapterLabel: string;
  source: string;
  confidence: number;
  totalRows: number;
  readyRows: number;
  warningRows: number;
  errorRows: number;
  warningCount: number;
  errorCount: number;
  rows: PreviewReviewRow[];
};

const PREVIEW_ROW_LIMIT = 10;
const PREVIEW_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "text/csv",
  "text/plain",
]);

const REQUIRED_GENERIC_COLUMNS: readonly {
  key: GenericCsvColumnKey;
  label: string;
}[] = [
  { key: "date", label: "Flight date" },
  { key: "origin", label: "Origin airport" },
  { key: "destination", label: "Destination airport" },
];

const OPTIONAL_GENERIC_COLUMNS: readonly {
  key: GenericCsvColumnKey;
  label: string;
}[] = [
  { key: "departureTime", label: "Departure time" },
  { key: "duration", label: "Duration" },
  { key: "distance", label: "Distance" },
  { key: "aircraft", label: "Aircraft" },
  { key: "aircraftType", label: "Aircraft type" },
  { key: "aircraftModel", label: "Aircraft model" },
  { key: "registration", label: "Registration / tail number" },
  { key: "flightNumber", label: "Flight number" },
  { key: "airline", label: "Airline / operator" },
  { key: "kind", label: "Private or commercial" },
  { key: "role", label: "Pilot or passenger" },
];

function GenericMappingPanel({
  preparation,
  onChange,
}: {
  preparation: FilePreparation;
  onChange: (mapping: GenericCsvMapping) => void;
}) {
  if (preparation.kind === "idle") return null;
  if (preparation.kind === "inspecting") {
    return (
      <div className="generic-mapping-status" role="status">
        <LoaderCircle size={16} aria-hidden="true" />
        Inspecting CSV headers…
      </div>
    );
  }
  if (preparation.kind === "automatic") {
    return (
      <div className="generic-mapping-status success" role="status">
        <CheckCircle2 size={16} aria-hidden="true" />
        <span>
          <strong>{preparation.label}</strong> detected automatically.
        </span>
      </div>
    );
  }
  if (preparation.kind === "error") {
    return (
      <div className="generic-mapping-status error" role="status">
        <AlertTriangle size={16} aria-hidden="true" />
        {preparation.message}
      </div>
    );
  }

  const { inspection, mapping, preview, previewError } = preparation;
  const mappingValid = Boolean(validGenericMapping(mapping));

  function setColumn(key: GenericCsvColumnKey, header: string) {
    const columns = { ...mapping.columns };
    if (header) columns[key] = header;
    else delete columns[key];
    onChange({
      ...mapping,
      columns,
      ...(key === "departureTime" && header && !mapping.timeFormat
        ? { timeFormat: "24-hour" as const }
        : {}),
      ...(key === "duration" && header && !mapping.durationFormat
        ? { durationFormat: "decimal-hours" as const }
        : {}),
      ...(key === "distance" && header && !mapping.distanceUnit
        ? { distanceUnit: "miles" as const }
        : {}),
    });
  }

  const columnSelect = (
    key: GenericCsvColumnKey,
    label: string,
    required = false,
  ) => (
    <label className="generic-mapping-field" key={key}>
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      <select
        value={mapping.columns[key] ?? ""}
        onChange={(event) => setColumn(key, event.target.value)}
        required={required}
      >
        <option value="">{required ? "Choose a column" : "Not mapped"}</option>
        {inspection.headers.map((header) => (
          <option value={header} key={header}>{header}</option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="generic-mapping-panel" aria-labelledby="generic-mapping-title">
      <div className="generic-mapping-heading">
        <div>
          <p className="control-kicker">Column mapping</p>
          <h2 id="generic-mapping-title">Match this CSV to flight fields</h2>
        </div>
        <span className={`status-chip ${mappingValid ? "available" : "pending"}`}>
          {mappingValid ? "Ready" : "3 required"}
        </span>
      </div>
      <p>
        {inspection.preset
          ? `${inspection.preset.label} recognized. Review the suggested columns before upload.`
          : `${inspection.headers.length} headers found across ${inspection.totalRows.toLocaleString()} rows. Confirm the three required fields.`}
      </p>
      <div className="generic-mapping-grid">
        {REQUIRED_GENERIC_COLUMNS.map(({ key, label }) =>
          columnSelect(key, label, true),
        )}
        <label className="generic-mapping-field">
          <span>Date format</span>
          <select
            value={mapping.dateFormat ?? "iso"}
            onChange={(event) =>
              onChange({
                ...mapping,
                dateFormat: event.target.value as GenericCsvMapping["dateFormat"],
              })
            }
          >
            <option value="iso">YYYY-MM-DD</option>
            <option value="yyyymmdd">YYYYMMDD</option>
            <option value="mdy">MM/DD/YYYY</option>
            <option value="dmy">DD/MM/YYYY</option>
          </select>
        </label>
      </div>
      <details className="generic-mapping-options">
        <summary>Optional flight details</summary>
        <div className="generic-mapping-grid">
          {OPTIONAL_GENERIC_COLUMNS.map(({ key, label }) =>
            columnSelect(key, label),
          )}
          {mapping.columns.duration ? (
            <label className="generic-mapping-field">
              <span>Duration format</span>
              <select
                value={mapping.durationFormat ?? "decimal-hours"}
                onChange={(event) =>
                  onChange({
                    ...mapping,
                    durationFormat:
                      event.target.value as GenericCsvMapping["durationFormat"],
                  })
                }
              >
                <option value="decimal-hours">Decimal hours</option>
                <option value="hours-minutes">Hours and minutes</option>
                <option value="minutes">Minutes</option>
              </select>
            </label>
          ) : null}
          {mapping.columns.distance ? (
            <label className="generic-mapping-field">
              <span>Distance unit</span>
              <select
                value={mapping.distanceUnit ?? "miles"}
                onChange={(event) =>
                  onChange({
                    ...mapping,
                    distanceUnit:
                      event.target.value as GenericCsvMapping["distanceUnit"],
                  })
                }
              >
                <option value="miles">Miles</option>
                <option value="nautical-miles">Nautical miles</option>
              </select>
            </label>
          ) : null}
          <label className="generic-mapping-field">
            <span>Default flight type</span>
            <select
              value={mapping.defaults?.kind ?? "private"}
              onChange={(event) =>
                onChange({
                  ...mapping,
                  defaults: {
                    kind: event.target.value as "private" | "commercial",
                    role: mapping.defaults?.role ?? "pilot",
                  },
                })
              }
            >
              <option value="private">Personal</option>
              <option value="commercial">Commercial</option>
            </select>
          </label>
          <label className="generic-mapping-field">
            <span>Default role</span>
            <select
              value={mapping.defaults?.role ?? "pilot"}
              onChange={(event) =>
                onChange({
                  ...mapping,
                  defaults: {
                    kind: mapping.defaults?.kind ?? "private",
                    role: event.target.value as "pilot" | "passenger",
                  },
                })
              }
            >
              <option value="pilot">Pilot</option>
              <option value="passenger">Passenger</option>
            </select>
          </label>
        </div>
      </details>
      {!mappingValid ? (
        <p className="generic-mapping-error" role="status">
          Choose distinct columns for flight date, origin, and destination.
        </p>
      ) : null}
      {mappingValid ? (
        <section
          className="generic-preview"
          aria-labelledby="generic-preview-title"
          aria-live="polite"
        >
          <div className="generic-mapping-heading">
            <div>
              <p className="control-kicker">Validation preview</p>
              <h3 id="generic-preview-title">Sanitized preview</h3>
            </div>
          </div>
          <p>
            Only normalized flight fields and validation messages are shown.
            Raw CSV rows and mappings are not saved in the browser.
          </p>
          {previewError ? (
            <p className="generic-mapping-error" role="alert">
              {previewError}
            </p>
          ) : preview ? (
            <>
              <div className="generic-preview-counts">
                <strong>{preview.validRowCount} valid</strong>
                <strong>{preview.invalidRowCount} need attention</strong>
                <span>{preview.rows.length} rows previewed</span>
              </div>
              <div className="table-wrap">
                <table className="generic-preview-table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Date</th>
                      <th>Route</th>
                      <th>Flight</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 5).map((row) => (
                      <tr key={row.sourceRowNumber}>
                        <td>{row.sourceRowNumber}</td>
                        <td>{row.date ?? "Needs date"}</td>
                        <td>
                          {row.originIdentifier ?? "Needs origin"} →{" "}
                          {row.destinationIdentifier ?? "Needs destination"}
                        </td>
                        <td>
                          {row.flightNumber ??
                            row.registration ??
                            row.aircraftModel ??
                            "Not supplied"}
                        </td>
                        <td>
                          {row.issues.some((issue) => issue.severity === "error")
                            ? "Needs attention"
                            : row.issues.some(
                                  (issue) => issue.severity === "warning",
                                )
                              ? "Review warning"
                              : "Ready"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.issues.length > 0 ? (
                <div className="generic-preview-issues">
                  <strong>Validation issues</strong>
                  <ul>
                    {preview.issues.slice(0, 5).map((issue, index) => (
                      <li key={`${issue.rowNumber}-${issue.code}-${index}`}>
                        Row {issue.rowNumber}: {issue.message}
                      </li>
                    ))}
                  </ul>
                  {preview.issues.length > 5 ? (
                    <small>
                      Showing 5 of {preview.issues.length} issues. All rows will
                      remain available in import review.
                    </small>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="generic-mapping-status" role="status">
              <LoaderCircle size={16} aria-hidden="true" />
              Refreshing sanitized preview…
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}

function prepareSuggestedMapping(
  suggestion: GenericCsvMapping,
): GenericCsvMapping {
  return {
    ...suggestion,
    version: suggestion.version ?? 1,
    columns: { ...suggestion.columns },
    dateFormat: suggestion.dateFormat ?? "iso",
    ...(suggestion.columns.departureTime
      ? { timeFormat: suggestion.timeFormat ?? "24-hour" }
      : {}),
    ...(suggestion.columns.duration
      ? { durationFormat: suggestion.durationFormat ?? "decimal-hours" }
      : {}),
    ...(suggestion.columns.distance
      ? { distanceUnit: suggestion.distanceUnit ?? "miles" }
      : {}),
    defaults: suggestion.defaults ?? { kind: "private", role: "pilot" },
  };
}

function validGenericMapping(
  mapping: GenericCsvMapping,
): GenericCsvMapping | undefined {
  try {
    return normalizeGenericCsvMapping(mapping);
  } catch {
    return undefined;
  }
}

function FileDropzone({
  id,
  inputRef: externalInputRef,
  file,
  fileDescription,
  disabled,
  maxFileBytes,
  onSelect,
}: {
  id: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  file: File | null;
  fileDescription?: string;
  disabled: boolean;
  maxFileBytes: number;
  onSelect: (file: File) => void | Promise<void>;
}) {
  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? localInputRef;
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (disabled) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (disabled) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;
    const droppedFile = event.dataTransfer.files?.[0];
    if (droppedFile) void onSelect(droppedFile);
  }

  return (
    <div
      className={`file-dropzone${dragging ? " dragging" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label="CSV file drop area"
      aria-busy={disabled}
    >
      <input
        ref={inputRef}
        id={id}
        className="visually-hidden-file-input"
        type="file"
        accept=".csv"
        disabled={disabled}
        aria-label="Choose one supported CSV"
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (selected) void onSelect(selected);
        }}
      />
      <CloudUpload size={24} aria-hidden="true" />
      <strong>{dragging ? "Drop CSV to select it" : "Drag and drop a CSV here"}</strong>
      <span>or</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        Choose CSV file
      </button>
      <small>
        {fileDescription ??
          (file
            ? `${file.name} · ${formatBytes(file.size)}`
            : `.csv files only · ${formatBytes(maxFileBytes)} maximum · UTF-8 text`)}
      </small>
    </div>
  );
}

function DevelopmentFallback({
  data,
  previewEnabled,
  maxFileBytes,
  unavailableReason,
}: {
  data: ImportPageContract;
  previewEnabled: boolean;
  maxFileBytes: number;
  unavailableReason?: string;
}) {
  const [preview, setPreview] = useState<LocalImportPreview>();
  const [selectedFile, setSelectedFile] = useState<{
    name: string;
    size: number;
  }>();
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);

  async function previewSelectedFile(file: File) {
    setSelectedFile({ name: file.name, size: file.size });
    setPreview(undefined);
    setError(undefined);
    setReading(true);
    try {
      const content = await readPreviewCsv(file, maxFileBytes);
      const parsed = parseFlightImport(content);
      if (parsed.status !== "parsed") {
        setError(previewParseError(parsed));
        return;
      }
      setPreview(summarizePreview(file, parsed));
    } catch (previewError) {
      setError(messageFor(previewError));
    } finally {
      setReading(false);
    }
  }

  return (
    <main className="app-shell" id="main-content" tabIndex={-1}>
      <section className="content-section records-section route-page">
        <div className="import-workflow">
          <div className="section-heading record-heading">
            <div>
              <p className="eyebrow">Acquisition workflow</p>
              <h1>Stage new flight records for review.</h1>
            </div>
            <p>
              {previewEnabled
                ? "Development preview parses supported CSVs only in this browser. Nothing is uploaded, saved, or committed."
                : unavailableReason ??
                  "Sign in to use the configured import service."}
            </p>
          </div>
          {previewEnabled ? (
            <div className="local-source-status" role="status">
              <Database size={19} aria-hidden="true" />
              <span>
                <strong>
                  {data.hasLocalArtifact
                    ? "Flights from an earlier import are on the map"
                    : "No earlier imports are on the map"}
                </strong>
                <small>
                  {data.hasLocalArtifact
                    ? `The map is showing ${data.normalizedFlightCount.toLocaleString()} flights imported earlier on this computer. They are separate from the file selected or reviewed here. Raw file fields are not shown on the map.`
                    : "The map has no flights imported earlier on this computer. Selecting or reviewing a file here is separate from the map. Raw file fields are not shown on the map."}
                </small>
              </span>
            </div>
          ) : null}
          <p className="supported-import-formats">
            <strong>Implemented formats:</strong>{" "}
            {data.supportedFormats.join(" and ")}.
          </p>
          <div className="workflow-grid" aria-label="Import review stages">
            <article className="workflow-step available">
              <span className="status-chip available">Available</span>
              <FileSpreadsheet size={20} aria-hidden="true" />
              <strong>1. Detect format</strong>
              <p>
                Exactly one high-confidence adapter must match; ambiguous or
                unsupported files stop here.
              </p>
              {previewEnabled ? (
                <FileDropzone
                  id="preview-flight-import-file"
                  file={null}
                  fileDescription={
                    selectedFile
                      ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}`
                      : undefined
                  }
                  disabled={reading}
                  maxFileBytes={maxFileBytes}
                  onSelect={previewSelectedFile}
                />
              ) : (
                <button type="button" disabled>
                  <CloudUpload size={16} aria-hidden="true" />
                  Choose file unavailable
                </button>
              )}
            </article>
            <article className={`workflow-step${preview ? " available" : ""}`}>
              <span
                className={`status-chip ${preview ? "available" : "pending"}`}
              >
                {reading ? "Reading" : preview ? "Preview ready" : "Not started"}
              </span>
              <strong>2. Parse and stage</strong>
              <p>
                The existing adapter registry parses locally, then only a
                sanitized review summary remains in component state.
              </p>
            </article>
            <article className="workflow-step commit-step">
              <span className="status-chip planned">Unavailable in preview</span>
              <strong>3. Commit import</strong>
              <p>
                Preview mode never persists records and never simulates a
                successful commit.
              </p>
              <button type="button" disabled>
                Commit unavailable in preview mode
              </button>
            </article>
          </div>

          {error ? (
            <div className="local-source-status" role="alert">
              <AlertTriangle size={19} aria-hidden="true" />
              <span>
                <strong>File could not be previewed</strong>
                <small>{error}</small>
              </span>
            </div>
          ) : null}

          {preview ? <LocalPreviewReview preview={preview} /> : null}
        </div>
      </section>
    </main>
  );
}

function LocalPreviewReview({ preview }: { preview: LocalImportPreview }) {
  return (
    <section aria-labelledby="local-preview-review-heading">
      <div className="section-heading record-heading">
        <div>
          <p className="eyebrow">Local staged preview</p>
          <h2 id="local-preview-review-heading">{preview.fileName}</h2>
        </div>
        <p>
          Detected {preview.adapterLabel} · source {preview.source} ·{" "}
          {Math.round(preview.confidence * 100)}% confidence ·{" "}
          {formatBytes(preview.fileSize)}
        </p>
      </div>
      <div className="local-source-status" role="status" aria-live="polite">
        <CheckCircle2 size={19} aria-hidden="true" />
        <span>
          <strong>
            {preview.totalRows} rows staged for preview · {preview.readyRows}{" "}
            without errors
          </strong>
          <small>
            {preview.warningRows} rows with warnings ({preview.warningCount}{" "}
            total) · {preview.errorRows} rows with errors ({preview.errorCount}{" "}
            total). Nothing has been uploaded, saved, or committed.
          </small>
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Date</th>
              <th scope="col">Route</th>
              <th scope="col">Flight</th>
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.rowNumber}>
                <td>{row.rowNumber}</td>
                <td>{row.date ?? "Invalid date"}</td>
                <td>
                  {row.origin ?? "Unresolved"} →{" "}
                  {row.destination ?? "Unresolved"}
                </td>
                <td>{row.flight}</td>
                <td>
                  {row.issues.length === 0 ? (
                    <strong>Ready for review</strong>
                  ) : (
                    row.issues.map((issue, index) => (
                      <small
                        key={`${issue.field}-${issue.code}-${index}`}
                        style={{ display: "block" }}
                      >
                        {issue.severity}: {issue.message}
                      </small>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.totalRows > preview.rows.length ? (
        <p>
          Showing {preview.rows.length} representative rows of{" "}
          {preview.totalRows}.
        </p>
      ) : null}
    </section>
  );
}

async function readPreviewCsv(
  file: File,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<string> {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    throw new Error("Choose a file whose name ends in .csv.");
  }
  if (file.size <= 0 || file.size > maxFileBytes) {
    throw new Error(
      `The CSV must be larger than 0 bytes and no more than ${formatBytes(maxFileBytes)}.`,
    );
  }
  if (!PREVIEW_MIME_TYPES.has(file.type.toLowerCase())) {
    throw new Error(
      "The selected file is not reported as CSV or plain-text content. Export it as a CSV and try again.",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) {
    throw new Error(
      "The selected file contains binary data. Export a UTF-8 CSV and try again.",
    );
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "The selected file is not valid UTF-8 text. Re-export it as a UTF-8 CSV.",
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
    throw new Error(
      "The selected file appears to contain binary data. Export a UTF-8 CSV and try again.",
    );
  }
  return content.replace(/^\uFEFF/, "");
}

function previewParseError(
  result: Exclude<ParsedFlightImport, { status: "parsed" }>,
): string {
  if (result.status === "unsupported") {
    return "This CSV does not match a supported ForeFlight or myFlightradar24 export. Export the original CSV from one of those applications and try again.";
  }
  if (result.status === "ambiguous") {
    return "This CSV matches more than one import format. Re-export the original file without editing its headers.";
  }
  const guidance: Record<string, string> = {
    "empty-document": "The CSV contains no records.",
    "invalid-header":
      "The header does not exactly match the supported export version.",
    "invalid-row-width":
      "At least one row has an unexpected number of columns.",
    "missing-aircraft-table":
      "The ForeFlight aircraft table is missing.",
    "missing-flights-table": "The ForeFlight flights table is missing.",
    "missing-required-column":
      "A required column is missing from the recognized export.",
  };
  return `${result.label} was detected, but validation failed. ${
    guidance[result.errorCode] ??
    "Re-export the original CSV without changing its structure."
  }`;
}

function summarizePreview(
  file: File,
  parsed: Extract<ParsedFlightImport, { status: "parsed" }>,
): LocalImportPreview {
  const rows: PreviewReviewRow[] =
    parsed.adapterId === "foreflight-v1"
      ? parsed.parsed.flights.map((flight) => ({
          rowNumber: flight.sourceRowNumber,
          date: flight.date,
          origin: flight.originIdentifier,
          destination: flight.destinationIdentifier,
          flight:
            flight.registration ??
            flight.aircraftDisplayName ??
            "Not specified",
          issues: flight.issues,
        }))
      : parsed.parsed.flights.map((flight) => ({
          rowNumber: flight.sourceRowNumber,
          date: flight.date,
          origin: flight.originIdentifier,
          destination: flight.destinationIdentifier,
          flight:
            flight.flightNumber ??
            flight.registration ??
            flight.aircraftModel ??
            "Not specified",
          issues: flight.issues,
        }));
  const warningCount = rows.reduce(
    (count, row) =>
      count +
      row.issues.filter(({ severity }) => severity === "warning").length,
    0,
  );
  const errorCount = rows.reduce(
    (count, row) =>
      count + row.issues.filter(({ severity }) => severity === "error").length,
    0,
  );

  return {
    fileName: file.name,
    fileSize: file.size,
    adapterLabel: parsed.label,
    source: parsed.source,
    confidence: parsed.confidence,
    totalRows: rows.length,
    readyRows: rows.filter(
      (row) => !row.issues.some(({ severity }) => severity === "error"),
    ).length,
    warningRows: rows.filter((row) =>
      row.issues.some(({ severity }) => severity === "warning"),
    ).length,
    errorRows: rows.filter((row) =>
      row.issues.some(({ severity }) => severity === "error"),
    ).length,
    warningCount,
    errorCount,
    rows: rows.slice(0, PREVIEW_ROW_LIMIT),
  };
}

function normalizeBatchSummary(value: unknown): ImportBatchSummary {
  if (!isSharedBatch(value)) {
    throw new Error("The import API returned an unsupported batch contract.");
  }
  return value;
}

function completionFromCounts(
  counts: ImportBatchSummary["counts"],
): ImportCompletionSummary {
  return {
    totalRows: counts.totalRows,
    importedRows: counts.importedRows ?? counts.committedFlights,
    duplicateRows: counts.duplicateRows ?? 0,
    skippedRows: counts.skippedRows,
    invalidRows: counts.invalidRows ?? 0,
    reviewRequiredRows: counts.reviewRequiredRows ?? counts.pendingRows,
  };
}

function normalizeBatchDetail(value: unknown): OwnerImportBatchDetail {
  if (
    isSharedBatch(value) &&
    "rows" in value &&
    typeof value.rows === "object" &&
    value.rows !== null &&
    "totalPages" in value.rows
  ) {
    return value as OwnerImportBatchDetail;
  }
  throw new Error("The import API returned an unsupported detail contract.");
}

function isSharedBatch(value: unknown): value is ImportBatchSummary {
  return Boolean(
    value &&
      typeof value === "object" &&
      "contractVersion" in value &&
      "counts" in value,
  );
}

function phaseForStatus(status: ImportBatchStatus): ClientPhase {
  if (status === "review") return "review";
  if (status === "committed" || status === "deduplicated") return "committed";
  if (
    status === "failed" ||
    status === "expired" ||
    status === "cancelled" ||
    status === "quarantined"
  ) {
    return "failed";
  }
  if (status === "committing") return "committing";
  return "processing";
}

function isRedirectableTerminalBatch(
  detail: OwnerImportBatchDetail,
): boolean {
  if (detail.status === "deduplicated") return true;
  if (detail.status !== "committed") return false;
  return (
    (detail.counts.reviewRequiredRows ?? detail.counts.pendingRows) === 0 &&
    (detail.counts.unresolvedDuplicateRows ?? 0) === 0
  );
}

function airportLabel(
  match: StoredImportRow["proposedFlight"]["origin"],
): string {
  if (!match) return "Missing";
  if (match.status === "resolved") return match.airport.code;
  if (match.status === "ambiguous") return `${match.identifier} (ambiguous)`;
  return `${match.identifier} (not found)`;
}

function airportCode(
  match: StoredImportRow["proposedFlight"]["origin"],
): string {
  if (!match) return "—";
  if (match.status === "resolved") return match.airport.code;
  return match.identifier || "—";
}

function reviewReason(row: StoredImportRow): string {
  if (row.duplicateCandidate) return "Possible duplicate";
  if (
    row.proposedFlight.origin?.status === "ambiguous" ||
    row.proposedFlight.destination?.status === "ambiguous"
  ) {
    return "Airport match is ambiguous";
  }
  if (
    row.proposedFlight.origin?.status === "not-found" ||
    row.proposedFlight.destination?.status === "not-found"
  ) {
    return "Airport could not be found";
  }
  if (!row.proposedFlight.date) return "Flight date is invalid";
  return row.issues[0]?.message ?? "This row cannot be imported yet";
}

async function apiRequest<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => null)) as
    | T
    | {
        error?: string | { code?: string; message?: string };
        message?: string;
      }
    | null;
  if (!response.ok) {
    const errorBody = body as {
      error?: string | { code?: string; message?: string };
      message?: string;
    } | null;
    const nestedMessage =
      typeof errorBody?.error === "object"
        ? errorBody.error.message
        : undefined;
    const flatError =
      typeof errorBody?.error === "string" ? errorBody.error : undefined;
    throw new Error(
      errorBody?.message ??
        nestedMessage ??
        flatError ??
        `Request failed (${response.status})`,
    );
  }
  return body as T;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The import request failed.";
}

function isPollingStatusMessage(message: string): boolean {
  return [
    "This import is taking longer than expected. Status checks are still active with slower backoff.",
    "The import status could not be refreshed. Retrying with backoff.",
    "Import status checks paused after a long-running batch with no terminal update. Resume checks or cancel/retry the batch.",
  ].includes(message);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateCsvFile(file: File, maxFileBytes: number): string | undefined {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return "Choose a file whose name ends in .csv.";
  }
  if (file.size <= 0 || file.size > maxFileBytes) {
    return `The CSV must be larger than 0 bytes and no more than ${formatBytes(maxFileBytes)}.`;
  }
  return undefined;
}
