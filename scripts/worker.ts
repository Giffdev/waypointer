import { timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkerDatabases } from "../src/lib/db/worker";
import { DurableImportWorker } from "../src/lib/import/durable-worker";
import { DurableJobRepository } from "../src/lib/jobs/repository";
import type { QueueMetrics } from "../src/lib/jobs/types";
import { ClamAvScanner } from "../src/lib/scanner/clamav";
import { getPrivateObjectStorage } from "../src/lib/storage";
import { isDurableImportConfiguration } from "../src/lib/runtime-mode";

export type WorkerExecutionMode = "disabled" | "on-demand" | "continuous";
export type WorkerLoopResult = "worked" | "idle" | "error";

export const WORKER_POLL_MIN_INTERVAL_MS = 5_000;
export const WORKER_POLL_MAX_INTERVAL_MS = 30_000;
export const WORKER_POLL_MAX_BACKOFF_MS = 900_000;
export const WORKER_HEALTH_FRESHNESS_GRACE_MS = 30_000;
export const WORKER_ACTIVE_LEASE_WINDOWS = 4;
export const WORKER_HEALTH_DEADLINE_MS = 5_000;

type WorkerHttpResponse = {
  statusCode: number;
  body: {
    ok: boolean;
    ready?: boolean;
    mode: WorkerExecutionMode;
    processingEnabled: boolean;
    loop?: WorkerLoopResult;
    heartbeatAt?: string;
    activeLoopStartedAt?: string | null;
    fresh?: boolean;
    queue?: QueueMetrics | null;
  };
};

type RunWorkerOptions = {
  mode: WorkerExecutionMode;
  signal: AbortSignal;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  runOne?: () => Promise<boolean>;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onLoopStart?: () => void;
  onLoopResult?: (result: WorkerLoopResult) => void;
  onError?: (error: unknown) => void;
};

type HealthDependencyCheck = (signal: AbortSignal) => Promise<QueueMetrics>;

type HealthDependencies = {
  assertScannerHealthy: (signal: AbortSignal) => Promise<void>;
  getQueueMetrics: (signal: AbortSignal) => Promise<QueueMetrics>;
};

type WorkerEnvironment = {
  NODE_ENV?: string;
  WORKER_EXECUTION_MODE?: string;
};

export function resolveExecutionMode(
  environment: WorkerEnvironment = process.env,
): WorkerExecutionMode {
  const value = environment.WORKER_EXECUTION_MODE?.trim().toLowerCase();
  if (!value) {
    return environment.NODE_ENV === "production" ? "disabled" : "continuous";
  }
  if (
    value === "disabled" ||
    value === "on-demand" ||
    value === "continuous"
  ) {
    return value;
  }
  throw new Error(
    "WORKER_EXECUTION_MODE must be one of: disabled, on-demand, continuous.",
  );
}

export function validateWorkerTiming(
  pollIntervalMs: number,
  maxPollIntervalMs: number,
): void {
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < WORKER_POLL_MIN_INTERVAL_MS ||
    pollIntervalMs > WORKER_POLL_MAX_INTERVAL_MS
  ) {
    throw new Error(
      `JOB_POLL_INTERVAL_MS must be from ${WORKER_POLL_MIN_INTERVAL_MS} to ${WORKER_POLL_MAX_INTERVAL_MS}.`,
    );
  }
  if (
    !Number.isSafeInteger(maxPollIntervalMs) ||
    maxPollIntervalMs < pollIntervalMs ||
    maxPollIntervalMs > WORKER_POLL_MAX_BACKOFF_MS
  ) {
    throw new Error(
      `JOB_POLL_MAX_INTERVAL_MS must be from JOB_POLL_INTERVAL_MS to ${WORKER_POLL_MAX_BACKOFF_MS}.`,
    );
  }
}

export function validateJobLeaseSeconds(leaseSeconds: number): void {
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 30 ||
    leaseSeconds > 900
  ) {
    throw new Error("JOB_LEASE_SECONDS must be from 30 to 900.");
  }
}

export function validateWorkerWriteMode(environment?: {
  readonly FLIGHT_MAP_RELEASE_WRITES_PAUSED?: string;
}): void {
  const source =
    environment ??
    (process.env as unknown as {
      readonly FLIGHT_MAP_RELEASE_WRITES_PAUSED?: string;
    });
  if (source.FLIGHT_MAP_RELEASE_WRITES_PAUSED !== "false") {
    throw new Error(
      "FLIGHT_MAP_RELEASE_WRITES_PAUSED must be exactly false.",
    );
  }
}

export function backoffDelayMs(
  attempts: number,
  pollIntervalMs: number,
  maxPollIntervalMs: number,
): number {
  const exponent = Math.max(0, attempts - 1);
  const saturationExponent = Math.ceil(
    Math.log2(maxPollIntervalMs / pollIntervalMs),
  );
  if (exponent >= saturationExponent) return maxPollIntervalMs;
  return Math.min(maxPollIntervalMs, pollIntervalMs * 2 ** exponent);
}

export function livenessResponse(
  mode: WorkerExecutionMode,
  shuttingDown: boolean,
): WorkerHttpResponse {
  return {
    statusCode: shuttingDown ? 503 : 200,
    body: {
      ok: !shuttingDown,
      mode,
      processingEnabled: !shuttingDown && mode !== "disabled",
    },
  };
}

export function createHealthDependencyCheck({
  assertScannerHealthy,
  getQueueMetrics,
}: HealthDependencies): HealthDependencyCheck {
  let inFlight: Promise<QueueMetrics> | undefined;

  return (signal) => {
    if (signal.aborted) {
      return Promise.reject(new Error("Worker health check was aborted."));
    }
    if (!inFlight) {
      const current = (async () => {
        await assertScannerHealthy(signal);
        throwIfHealthCheckAborted(signal);
        const queue = await getQueueMetrics(signal);
        throwIfHealthCheckAborted(signal);
        return queue;
      })();
      inFlight = current;
      void current.then(
        () => {
          if (inFlight === current) inFlight = undefined;
        },
        () => {
          if (inFlight === current) inFlight = undefined;
        },
      );
    }

    return settleBeforeHealthAbort(inFlight, signal);
  };
}

export async function detailedHealthResponse({
  mode,
  shuttingDown,
  loop,
  heartbeatAt,
  activeLoopStartedAt,
  maxPollIntervalMs,
  leaseSeconds,
  now = new Date(),
  healthDeadlineMs = WORKER_HEALTH_DEADLINE_MS,
  signal,
  checkDependencies,
}: {
  mode: WorkerExecutionMode;
  shuttingDown: boolean;
  loop: WorkerLoopResult;
  heartbeatAt: Date;
  activeLoopStartedAt: Date | null;
  maxPollIntervalMs: number;
  leaseSeconds: number;
  now?: Date;
  healthDeadlineMs?: number;
  signal?: AbortSignal;
  checkDependencies: HealthDependencyCheck;
}): Promise<WorkerHttpResponse> {
  const processingEnabled = !shuttingDown && mode !== "disabled";
  if (!processingEnabled) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        ready: false,
        mode,
        processingEnabled: false,
        loop,
        heartbeatAt: heartbeatAt.toISOString(),
        activeLoopStartedAt: activeLoopStartedAt?.toISOString() ?? null,
        fresh: false,
        queue: null,
      },
    };
  }

  const freshness = workerProgressFreshness({
    heartbeatAt,
    activeLoopStartedAt,
    maxPollIntervalMs,
    leaseSeconds,
    now,
  });
  if (!freshness.fresh) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        ready: false,
        mode,
        processingEnabled: true,
        loop,
        heartbeatAt: heartbeatAt.toISOString(),
        activeLoopStartedAt: activeLoopStartedAt?.toISOString() ?? null,
        fresh: false,
        queue: null,
      },
    };
  }
  if (loop === "error") {
    return {
      statusCode: 503,
      body: {
        ok: false,
        ready: false,
        mode,
        processingEnabled: true,
        loop,
        heartbeatAt: heartbeatAt.toISOString(),
        activeLoopStartedAt: activeLoopStartedAt?.toISOString() ?? null,
        fresh: true,
      },
    };
  }

  if (!Number.isSafeInteger(healthDeadlineMs) || healthDeadlineMs < 1) {
    throw new Error("Worker health deadline must be a positive integer.");
  }

  const healthAbort = new AbortController();
  const abortForRequest = () => healthAbort.abort();
  if (signal?.aborted) {
    healthAbort.abort();
  } else {
    signal?.addEventListener("abort", abortForRequest, { once: true });
  }
  const deadline = setTimeout(() => healthAbort.abort(), healthDeadlineMs);

  try {
    const queue = await settleBeforeHealthAbort(
      checkDependencies(healthAbort.signal),
      healthAbort.signal,
    );
    return {
      statusCode: 200,
      body: {
        ok: true,
        ready: true,
        mode,
        processingEnabled: true,
        loop,
        heartbeatAt: heartbeatAt.toISOString(),
        activeLoopStartedAt: activeLoopStartedAt?.toISOString() ?? null,
        fresh: true,
        queue,
      },
    };
  } catch {
    return {
      statusCode: 503,
      body: {
        ok: false,
        ready: false,
        mode,
        processingEnabled: true,
        loop,
        heartbeatAt: heartbeatAt.toISOString(),
        activeLoopStartedAt: activeLoopStartedAt?.toISOString() ?? null,
        fresh: true,
      },
    };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abortForRequest);
  }
}

export function workerProgressFreshness({
  heartbeatAt,
  activeLoopStartedAt,
  maxPollIntervalMs,
  leaseSeconds,
  now,
}: {
  heartbeatAt: Date;
  activeLoopStartedAt: Date | null;
  maxPollIntervalMs: number;
  leaseSeconds: number;
  now: Date;
}): { fresh: boolean; maximumAgeMs: number } {
  validateWorkerTiming(WORKER_POLL_MIN_INTERVAL_MS, maxPollIntervalMs);
  validateJobLeaseSeconds(leaseSeconds);
  const idleMaximumAgeMs =
    maxPollIntervalMs + WORKER_HEALTH_FRESHNESS_GRACE_MS;
  const activeMaximumAgeMs = Math.max(
    idleMaximumAgeMs,
    leaseSeconds * 1_000 * WORKER_ACTIVE_LEASE_WINDOWS +
      WORKER_HEALTH_FRESHNESS_GRACE_MS,
  );
  const reference = activeLoopStartedAt ?? heartbeatAt;
  const ageMs = now.getTime() - reference.getTime();
  const maximumAgeMs = activeLoopStartedAt
    ? activeMaximumAgeMs
    : idleMaximumAgeMs;
  return {
    fresh: ageMs >= 0 && ageMs <= maximumAgeMs,
    maximumAgeMs,
  };
}

export function isAuthorizedHealthRequest(
  header: string | undefined,
  healthSecret: string | undefined,
): boolean {
  if (!healthSecret) return false;
  const value = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = Buffer.from(healthSecret);
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function workerErrorDetails(error: unknown): { code: string } {
  return {
    code: error instanceof Error ? error.name : "unknown",
  };
}

export async function runWorker({
  mode,
  signal,
  pollIntervalMs,
  maxPollIntervalMs,
  runOne,
  delay = abortableDelay,
  onLoopStart,
  onLoopResult,
  onError,
}: RunWorkerOptions): Promise<void> {
  if (mode === "disabled") {
    await waitForShutdown(signal);
    return;
  }
  if (!runOne) {
    throw new Error("An enabled worker requires a job runner.");
  }

  let idleAttempts = 0;
  let errorAttempts = 0;
  while (!signal.aborted) {
    onLoopStart?.();
    const result = await runWorkerLoopOnce(runOne, onError);
    onLoopResult?.(result);
    if (signal.aborted) return;

    if (mode === "on-demand") {
      if (result === "idle") return;
      if (result === "error") {
        throw new Error("The on-demand worker run failed.");
      }
      continue;
    }

    if (result === "worked") {
      idleAttempts = 0;
      errorAttempts = 0;
      continue;
    }
    if (result === "idle") {
      idleAttempts += 1;
      errorAttempts = 0;
      await delay(
        backoffDelayMs(idleAttempts, pollIntervalMs, maxPollIntervalMs),
        signal,
      );
      continue;
    }
    idleAttempts = 0;
    errorAttempts += 1;
    await delay(
      backoffDelayMs(errorAttempts, pollIntervalMs, maxPollIntervalMs),
      signal,
    );
  }
}

async function runWorkerLoopOnce(
  runOne: () => Promise<boolean>,
  onError: ((error: unknown) => void) | undefined,
): Promise<WorkerLoopResult> {
  try {
    return (await runOne()) ? "worked" : "idle";
  } catch (error) {
    onError?.(error);
    return "error";
  }
}

async function main(): Promise<void> {
  const workerExecutionMode = resolveExecutionMode();
  const healthSecret = process.env.WORKER_HEALTH_SECRET?.trim();
  const leaseSeconds = Number(process.env.JOB_LEASE_SECONDS ?? 120);
  const pollIntervalMs = Number(
    process.env.JOB_POLL_INTERVAL_MS ?? WORKER_POLL_MIN_INTERVAL_MS,
  );
  const maxPollIntervalMs = Number(
    process.env.JOB_POLL_MAX_INTERVAL_MS ?? 300_000,
  );
  const workerId = process.env.WORKER_ID?.trim();
  const workerEnabled = workerExecutionMode !== "disabled";

  validateJobLeaseSeconds(leaseSeconds);
  if (workerEnabled) {
    validateWorkerWriteMode();
    if (!isDurableImportConfiguration()) {
      throw new Error("The worker requires a complete durable import configuration.");
    }
    if (!workerId || !healthSecret || healthSecret.length < 32) {
      throw new Error("WORKER_ID and a strong WORKER_HEALTH_SECRET are required.");
    }
    validateWorkerTiming(pollIntervalMs, maxPollIntervalMs);
  }

  const databases = workerEnabled ? createWorkerDatabases() : undefined;
  const jobs = databases ? new DurableJobRepository(databases.workDb) : undefined;
  const leaseJobs = databases
    ? new DurableJobRepository(databases.leaseDb)
    : undefined;
  const scanner = workerEnabled ? new ClamAvScanner() : undefined;
  const worker =
    jobs && leaseJobs && scanner && workerId
      ? new DurableImportWorker(
        jobs,
        leaseJobs,
        getPrivateObjectStorage(),
        scanner,
        workerId,
        leaseSeconds,
      )
      : undefined;
  let shuttingDown = false;
  let lastHeartbeatAt = new Date();
  let activeLoopStartedAt: Date | null = null;
  let lastLoopResult: WorkerLoopResult = "idle";
  const shutdown = new AbortController();
  const checkHealthDependencies = createHealthDependencyCheck({
    // These clients expose no AbortSignal; the shared probe prevents duplicate
    // work while the HTTP deadline bounds every caller's response.
    assertScannerHealthy: async () => {
      if (!scanner) {
        throw new Error("Worker health checks require a scanner client.");
      }
      await scanner.assertHealthy();
    },
    getQueueMetrics: async () => {
      if (!jobs) {
        throw new Error("Worker health checks require a queue client.");
      }
      return jobs.metrics();
    },
  });

  const server = createServer(async (request, response) => {
    if (request.url === "/live") {
      sendJson(response, livenessResponse(workerExecutionMode, shuttingDown));
      return;
    }
    if (
      request.url !== "/health" ||
      !isAuthorizedHealthRequest(request.headers.authorization, healthSecret)
    ) {
      response.writeHead(404).end();
      return;
    }
    const requestAbort = new AbortController();
    const abortHealthRequest = () => requestAbort.abort();
    request.once("aborted", abortHealthRequest);
    response.once("close", abortHealthRequest);
    try {
      const result = await detailedHealthResponse({
        mode: workerExecutionMode,
        shuttingDown,
        loop: lastLoopResult,
        heartbeatAt: lastHeartbeatAt,
        activeLoopStartedAt,
        maxPollIntervalMs,
        leaseSeconds,
        signal: requestAbort.signal,
        checkDependencies: checkHealthDependencies,
      });
      if (!response.destroyed) sendJson(response, result);
    } finally {
      request.removeListener("aborted", abortHealthRequest);
      response.removeListener("close", abortHealthRequest);
    }
  });
  server.listen(Number(process.env.PORT ?? 3001), "0.0.0.0");

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      shuttingDown = true;
      shutdown.abort();
      server.close();
    });
  }

  try {
    await runWorker({
      mode: workerExecutionMode,
      signal: shutdown.signal,
      pollIntervalMs,
      maxPollIntervalMs,
      runOne: worker ? () => worker.runOne() : undefined,
      onLoopStart: () => {
        const startedAt = new Date();
        activeLoopStartedAt = startedAt;
        lastHeartbeatAt = startedAt;
      },
      onLoopResult: (result) => {
        lastLoopResult = result;
        lastHeartbeatAt = new Date();
        activeLoopStartedAt = null;
      },
      onError: (error) => {
        console.error(
          "durable-import-worker-loop-failed",
          workerErrorDetails(error),
        );
      },
    });
  } finally {
    shuttingDown = true;
    shutdown.abort();
    server.close();
    await databases?.close();
  }
}

function sendJson(
  response: ServerResponse,
  result: WorkerHttpResponse,
): void {
  response.writeHead(result.statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(result.body));
}

function waitForShutdown(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveWait) => {
    signal.addEventListener("abort", () => resolveWait(), { once: true });
  });
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const stopWaiting = () => {
      clearTimeout(timer);
      resolveDelay();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stopWaiting);
      resolveDelay();
    }, milliseconds);
    signal.addEventListener("abort", stopWaiting, { once: true });
  });
}

function settleBeforeHealthAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolveOperation, rejectOperation) => {
    const stopWaiting = () => {
      signal.removeEventListener("abort", stopWaiting);
      rejectOperation(new Error("Worker health check was aborted."));
    };
    const finish = () => signal.removeEventListener("abort", stopWaiting);

    void operation.then(
      (value) => {
        finish();
        resolveOperation(value);
      },
      (error: unknown) => {
        finish();
        rejectOperation(error);
      },
    );
    if (signal.aborted) {
      stopWaiting();
      return;
    }
    signal.addEventListener("abort", stopWaiting, { once: true });
  });
}

function throwIfHealthCheckAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Worker health check was aborted.");
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) {
  await main();
}
