import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  WORKER_HEALTH_DEADLINE_MS,
  WORKER_POLL_MAX_BACKOFF_MS,
  WORKER_HEALTH_FRESHNESS_GRACE_MS,
  WORKER_POLL_MIN_INTERVAL_MS,
  backoffDelayMs,
  createHealthDependencyCheck,
  detailedHealthResponse,
  isAuthorizedHealthRequest,
  livenessResponse,
  resolveExecutionMode,
  runWorker,
  validateJobLeaseSeconds,
  validateWorkerTiming,
  validateWorkerWriteMode,
  workerProgressFreshness,
  workerErrorDetails,
} from "./worker";

const queueMetrics = {
  queued: 1,
  running: 2,
  deadLetter: 3,
  oldestQueuedAt: new Date("2026-08-19T00:00:00.000Z"),
};

describe("durable worker operational contract", () => {
  it("defaults production to safe-off and requires known explicit modes", () => {
    expect(resolveExecutionMode({ NODE_ENV: "production" })).toBe("disabled");
    expect(resolveExecutionMode({ NODE_ENV: "development" })).toBe("continuous");
    expect(resolveExecutionMode({ WORKER_EXECUTION_MODE: " ON-DEMAND " })).toBe(
      "on-demand",
    );
    expect(() =>
      resolveExecutionMode({ WORKER_EXECUTION_MODE: "always-on" }),
    ).toThrow(
      "WORKER_EXECUTION_MODE must be one of: disabled, on-demand, continuous.",
    );
  });

  it("enforces the release polling floor and bounded exponential backoff", () => {
    expect(() => validateWorkerTiming(29_999, 900_000)).toThrow(
      "JOB_POLL_INTERVAL_MS must be from 30000 to 30000.",
    );
    expect(() => validateWorkerTiming(30_000, 29_999)).toThrow(
      "JOB_POLL_MAX_INTERVAL_MS must be from JOB_POLL_INTERVAL_MS",
    );
    expect(() =>
      validateWorkerTiming(30_000, WORKER_POLL_MAX_BACKOFF_MS + 1),
    ).toThrow("JOB_POLL_MAX_INTERVAL_MS");
    expect(() => validateWorkerTiming(30_000, 900_000)).not.toThrow();
    expect(
      backoffDelayMs(1, WORKER_POLL_MIN_INTERVAL_MS, 900_000),
    ).toBe(30_000);
    expect(
      backoffDelayMs(4, WORKER_POLL_MIN_INTERVAL_MS, 900_000),
    ).toBe(240_000);
    expect(
      backoffDelayMs(99, WORKER_POLL_MIN_INTERVAL_MS, 900_000),
    ).toBe(900_000);
    expect(backoffDelayMs(99, 30_000, 30_000)).toBe(30_000);
    expect(backoffDelayMs(5, 30_000, 900_000)).toBe(480_000);
    expect(backoffDelayMs(6, 30_000, 900_000)).toBe(900_000);
    expect(backoffDelayMs(99, 30_000, 900_000)).toBe(900_000);
  });

  it.each([
    { value: Number.NaN, valid: false },
    { value: 29, valid: false },
    { value: 30, valid: true },
    { value: 900, valid: true },
    { value: 901, valid: false },
  ])("validates JOB_LEASE_SECONDS value $value", ({ value, valid }) => {
    if (valid) {
      expect(() => validateJobLeaseSeconds(value)).not.toThrow();
    } else {
      expect(() => validateJobLeaseSeconds(value)).toThrow(
        "JOB_LEASE_SECONDS must be from 30 to 900.",
      );
    }
  });

  it("validates the job lease before constructing worker clients", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./worker.ts", import.meta.url)),
      "utf8",
    );
    const startupValidation = source.indexOf(
      "validateJobLeaseSeconds(leaseSeconds);",
      source.indexOf("async function main()"),
    );
    const clientConstruction = source.indexOf(
      "createWorkerDatabases()",
      source.indexOf("async function main()"),
    );

    expect(startupValidation).toBeGreaterThan(-1);
    expect(clientConstruction).toBeGreaterThan(startupValidation);
  });

  it("requires an explicitly writable runtime before starting worker clients", () => {
    expect(() =>
      validateWorkerWriteMode({
        FLIGHT_MAP_RELEASE_WRITES_PAUSED: "false",
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerWriteMode({
        FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
      }),
    ).toThrow("FLIGHT_MAP_RELEASE_WRITES_PAUSED must be exactly false.");
    expect(() => validateWorkerWriteMode({})).toThrow(
      "FLIGHT_MAP_RELEASE_WRITES_PAUSED must be exactly false.",
    );
  });

  it("keeps disabled liveness explicit while failing processing health", async () => {
    const assertScannerHealthy = vi.fn(async () => undefined);
    const getQueueMetrics = vi.fn(async () => queueMetrics);
    const checkDependencies = createHealthDependencyCheck({
      assertScannerHealthy,
      getQueueMetrics,
    });

    expect(livenessResponse("disabled", false)).toEqual({
      statusCode: 200,
      body: {
        ok: true,
        mode: "disabled",
        processingEnabled: false,
      },
    });
    expect(
      await detailedHealthResponse({
        mode: "disabled",
        shuttingDown: false,
        loop: "idle",
        heartbeatAt: new Date("2026-08-19T00:00:00.000Z"),
        activeLoopStartedAt: null,
        maxPollIntervalMs: 300_000,
        leaseSeconds: 120,
        now: new Date("2026-08-19T00:00:01.000Z"),
        checkDependencies,
      }),
    ).toEqual({
      statusCode: 503,
      body: {
        ok: false,
        ready: false,
        mode: "disabled",
        processingEnabled: false,
        loop: "idle",
        heartbeatAt: "2026-08-19T00:00:00.000Z",
        activeLoopStartedAt: null,
        fresh: false,
        queue: null,
      },
    });
    expect(assertScannerHealthy).not.toHaveBeenCalled();
    expect(getQueueMetrics).not.toHaveBeenCalled();
  });

  it("reports enabled health only after scanner and queue checks succeed", async () => {
    const heartbeatAt = new Date("2026-08-19T00:00:00.000Z");
    const assertScannerHealthy = vi.fn(async () => undefined);
    const getQueueMetrics = vi.fn(async () => queueMetrics);
    const checkDependencies = createHealthDependencyCheck({
      assertScannerHealthy,
      getQueueMetrics,
    });

    const healthy = await detailedHealthResponse({
      mode: "continuous",
      shuttingDown: false,
      loop: "worked",
      heartbeatAt,
      activeLoopStartedAt: null,
      maxPollIntervalMs: 300_000,
      leaseSeconds: 120,
      now: new Date("2026-08-19T00:00:01.000Z"),
      checkDependencies,
    });
    const unhealthy = await detailedHealthResponse({
      mode: "continuous",
      shuttingDown: false,
      loop: "error",
      heartbeatAt,
      activeLoopStartedAt: null,
      maxPollIntervalMs: 300_000,
      leaseSeconds: 120,
      now: new Date("2026-08-19T00:00:01.000Z"),
      checkDependencies: createHealthDependencyCheck({
        assertScannerHealthy: vi.fn(async () => {
          throw new Error("scanner unavailable");
        }),
        getQueueMetrics: vi.fn(async () => queueMetrics),
      }),
    });

    expect(assertScannerHealthy).toHaveBeenCalledOnce();
    expect(getQueueMetrics).toHaveBeenCalledOnce();
    expect(healthy.statusCode).toBe(200);
    expect(healthy.body).toMatchObject({
      ok: true,
      ready: true,
      mode: "continuous",
      processingEnabled: true,
      queue: queueMetrics,
    });
    expect(unhealthy).toEqual({
      statusCode: 503,
      body: {
        ok: false,
        ready: false,
        mode: "continuous",
        processingEnabled: true,
        loop: "error",
        heartbeatAt: "2026-08-19T00:00:00.000Z",
        activeLoopStartedAt: null,
        fresh: true,
      },
    });
  });

  it("propagates an already-aborted request without starting dependencies", async () => {
    const requestAbort = new AbortController();
    const assertScannerHealthy = vi.fn(async () => undefined);
    const getQueueMetrics = vi.fn(async () => queueMetrics);
    const checkDependencies = createHealthDependencyCheck({
      assertScannerHealthy,
      getQueueMetrics,
    });
    requestAbort.abort();

    await expect(
      detailedHealthResponse({
        mode: "continuous",
        shuttingDown: false,
        loop: "idle",
        heartbeatAt: new Date("2026-08-19T00:00:00.000Z"),
        activeLoopStartedAt: null,
        maxPollIntervalMs: 300_000,
        leaseSeconds: 120,
        now: new Date("2026-08-19T00:00:01.000Z"),
        signal: requestAbort.signal,
        checkDependencies,
      }),
    ).resolves.toMatchObject({
      statusCode: 503,
      body: { ok: false, ready: false },
    });
    expect(assertScannerHealthy).not.toHaveBeenCalled();
    expect(getQueueMetrics).not.toHaveBeenCalled();
  });

  it("returns 503 at the overall deadline without accumulating stalled scanner probes", async () => {
    vi.useFakeTimers();
    try {
      let scannerSignal: AbortSignal | undefined;
      const assertScannerHealthy = vi.fn((signal: AbortSignal) => {
        scannerSignal = signal;
        return new Promise<void>(() => undefined);
      });
      const getQueueMetrics = vi.fn(async () => queueMetrics);
      const checkDependencies = createHealthDependencyCheck({
        assertScannerHealthy,
        getQueueMetrics,
      });
      const healthOptions = {
        mode: "continuous" as const,
        shuttingDown: false,
        loop: "idle" as const,
        heartbeatAt: new Date("2026-08-19T00:00:00.000Z"),
        activeLoopStartedAt: null,
        maxPollIntervalMs: 300_000,
        leaseSeconds: 120,
        now: new Date("2026-08-19T00:00:01.000Z"),
        healthDeadlineMs: WORKER_HEALTH_DEADLINE_MS,
        checkDependencies,
      };

      const firstResponse = detailedHealthResponse(healthOptions);
      const firstSettlement = vi.fn();
      void firstResponse.then(firstSettlement);

      await vi.advanceTimersByTimeAsync(WORKER_HEALTH_DEADLINE_MS - 1);
      expect(firstSettlement).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(firstResponse).resolves.toMatchObject({
        statusCode: 503,
        body: { ok: false, ready: false },
      });
      expect(scannerSignal?.aborted).toBe(true);

      const secondResponse = detailedHealthResponse(healthOptions);
      await vi.advanceTimersByTimeAsync(WORKER_HEALTH_DEADLINE_MS);
      await expect(secondResponse).resolves.toMatchObject({
        statusCode: 503,
        body: { ok: false, ready: false },
      });
      expect(assertScannerHealthy).toHaveBeenCalledOnce();
      expect(getQueueMetrics).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled queue, observes late rejection, and recovers on the next probe", async () => {
    vi.useFakeTimers();
    try {
      let rejectFirstQueue!: (reason: unknown) => void;
      const assertScannerHealthy = vi
        .fn<(signal: AbortSignal) => Promise<void>>()
        .mockImplementationOnce(
          () =>
            new Promise((resolveScanner) => {
              setTimeout(resolveScanner, 4_000);
            }),
        )
        .mockResolvedValue(undefined);
      const getQueueMetrics = vi
        .fn<(signal: AbortSignal) => Promise<typeof queueMetrics>>()
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectFirstQueue = reject;
            }),
        )
        .mockResolvedValue(queueMetrics);
      const checkDependencies = createHealthDependencyCheck({
        assertScannerHealthy,
        getQueueMetrics,
      });
      const healthOptions = {
        mode: "continuous" as const,
        shuttingDown: false,
        loop: "idle" as const,
        heartbeatAt: new Date("2026-08-19T00:00:00.000Z"),
        activeLoopStartedAt: null,
        maxPollIntervalMs: 300_000,
        leaseSeconds: 120,
        now: new Date("2026-08-19T00:00:01.000Z"),
        healthDeadlineMs: WORKER_HEALTH_DEADLINE_MS,
        checkDependencies,
      };

      const firstResponse = detailedHealthResponse(healthOptions);
      const firstSettlement = vi.fn();
      void firstResponse.then(firstSettlement);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(getQueueMetrics).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(
        WORKER_HEALTH_DEADLINE_MS - 4_000 - 1,
      );
      expect(firstSettlement).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const timedOut = await firstResponse;
      expect(timedOut).toMatchObject({
        statusCode: 503,
        body: { ok: false, ready: false },
      });
      expect(getQueueMetrics.mock.calls[0]?.[0].aborted).toBe(true);

      const repeatedResponse = detailedHealthResponse(healthOptions);
      await vi.advanceTimersByTimeAsync(WORKER_HEALTH_DEADLINE_MS);
      await expect(repeatedResponse).resolves.toMatchObject({
        statusCode: 503,
        body: { ok: false, ready: false },
      });
      expect(assertScannerHealthy).toHaveBeenCalledOnce();
      expect(getQueueMetrics).toHaveBeenCalledOnce();

      rejectFirstQueue(new Error("late queue failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(timedOut).toMatchObject({
        statusCode: 503,
        body: { ok: false, ready: false },
      });

      await expect(detailedHealthResponse(healthOptions)).resolves.toMatchObject({
        statusCode: 200,
        body: {
          ok: true,
          ready: true,
          queue: queueMetrics,
        },
      });
      expect(assertScannerHealthy).toHaveBeenCalledTimes(2);
      expect(getQueueMetrics).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails stale idle progress independently of scanner and queue dependencies", async () => {
    const heartbeatAt = new Date("2026-08-19T00:00:00.000Z");
    const assertScannerHealthy = vi.fn(async () => undefined);
    const getQueueMetrics = vi.fn(async () => queueMetrics);
    const checkDependencies = createHealthDependencyCheck({
      assertScannerHealthy,
      getQueueMetrics,
    });
    const now = new Date(
      heartbeatAt.getTime() +
        300_000 +
        WORKER_HEALTH_FRESHNESS_GRACE_MS +
        1,
    );

    const response = await detailedHealthResponse({
      mode: "continuous",
      shuttingDown: false,
      loop: "idle",
      heartbeatAt,
      activeLoopStartedAt: null,
      maxPollIntervalMs: 300_000,
      leaseSeconds: 120,
      now,
      checkDependencies,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      ready: false,
      fresh: false,
      queue: null,
    });
    expect(assertScannerHealthy).not.toHaveBeenCalled();
    expect(getQueueMetrics).not.toHaveBeenCalled();
  });

  it.each([
    { maxPollIntervalMs: 30_000, maximumAgeMs: 60_000 },
    { maxPollIntervalMs: 900_000, maximumAgeMs: 930_000 },
  ])(
    "uses effective $maxPollIntervalMs ms backoff for idle freshness",
    ({ maxPollIntervalMs, maximumAgeMs }) => {
      const heartbeatAt = new Date("2026-08-19T00:00:00.000Z");

      expect(
        workerProgressFreshness({
          heartbeatAt,
          activeLoopStartedAt: null,
          maxPollIntervalMs,
          leaseSeconds: 120,
          now: new Date(heartbeatAt.getTime() + maximumAgeMs),
        }),
      ).toEqual({ fresh: true, maximumAgeMs });
      expect(
        workerProgressFreshness({
          heartbeatAt,
          activeLoopStartedAt: null,
          maxPollIntervalMs,
          leaseSeconds: 120,
          now: new Date(heartbeatAt.getTime() + maximumAgeMs + 1),
        }),
      ).toEqual({ fresh: false, maximumAgeMs });
    },
  );

  it("uses the larger max-poll allowance for active work at the 900000 millisecond ceiling", () => {
    const activeLoopStartedAt = new Date("2026-08-19T00:00:00.000Z");

    expect(
      workerProgressFreshness({
        heartbeatAt: activeLoopStartedAt,
        activeLoopStartedAt,
        maxPollIntervalMs: 900_000,
        leaseSeconds: 120,
        now: new Date(activeLoopStartedAt.getTime() + 930_000),
      }),
    ).toEqual({ fresh: true, maximumAgeMs: 930_000 });
    expect(
      workerProgressFreshness({
        heartbeatAt: activeLoopStartedAt,
        activeLoopStartedAt,
        maxPollIntervalMs: 900_000,
        leaseSeconds: 120,
        now: new Date(activeLoopStartedAt.getTime() + 930_001),
      }),
    ).toEqual({ fresh: false, maximumAgeMs: 930_000 });
  });

  it("allows long active work within lease-derived progress bounds and rejects a wedged loop", async () => {
    const activeLoopStartedAt = new Date("2026-08-19T00:00:00.000Z");
    const heartbeatAt = activeLoopStartedAt;
    const leaseSeconds = 120;
    const activeBound = workerProgressFreshness({
      heartbeatAt,
      activeLoopStartedAt,
      maxPollIntervalMs: 300_000,
      leaseSeconds,
      now: activeLoopStartedAt,
    }).maximumAgeMs;
    const dependencies = createHealthDependencyCheck({
      assertScannerHealthy: vi.fn(async () => undefined),
      getQueueMetrics: vi.fn(async () => queueMetrics),
    });

    const active = await detailedHealthResponse({
      mode: "continuous",
      shuttingDown: false,
      loop: "idle",
      heartbeatAt,
      activeLoopStartedAt,
      maxPollIntervalMs: 300_000,
      leaseSeconds,
      now: new Date(activeLoopStartedAt.getTime() + activeBound),
      checkDependencies: dependencies,
    });
    const wedged = await detailedHealthResponse({
      mode: "continuous",
      shuttingDown: false,
      loop: "idle",
      heartbeatAt,
      activeLoopStartedAt,
      maxPollIntervalMs: 300_000,
      leaseSeconds,
      now: new Date(activeLoopStartedAt.getTime() + activeBound + 1),
      checkDependencies: dependencies,
    });

    expect(active.statusCode).toBe(200);
    expect(active.body).toMatchObject({
      ready: true,
      fresh: true,
      activeLoopStartedAt: activeLoopStartedAt.toISOString(),
    });
    expect(wedged.statusCode).toBe(503);
    expect(wedged.body).toMatchObject({
      ready: false,
      fresh: false,
      activeLoopStartedAt: activeLoopStartedAt.toISOString(),
    });
  });

  it("fails health after a loop error and recovers after a successful idle result", async () => {
    const heartbeatAt = new Date("2026-08-19T00:00:00.000Z");
    const assertScannerHealthy = vi.fn(async () => undefined);
    const getQueueMetrics = vi.fn(async () => queueMetrics);
    const checkDependencies = createHealthDependencyCheck({
      assertScannerHealthy,
      getQueueMetrics,
    });

    const failed = await detailedHealthResponse({
      mode: "continuous",
      shuttingDown: false,
      loop: "error",
      heartbeatAt,
      activeLoopStartedAt: null,
      maxPollIntervalMs: 300_000,
      leaseSeconds: 120,
      now: new Date("2026-08-19T00:00:01.000Z"),
      checkDependencies,
    });
    const recovered = await detailedHealthResponse({
      mode: "continuous",
      shuttingDown: false,
      loop: "idle",
      heartbeatAt,
      activeLoopStartedAt: null,
      maxPollIntervalMs: 300_000,
      leaseSeconds: 120,
      now: new Date("2026-08-19T00:00:01.000Z"),
      checkDependencies,
    });

    expect(failed).toMatchObject({
      statusCode: 503,
      body: {
        ok: false,
        ready: false,
        loop: "error",
      },
    });
    expect(recovered).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        ready: true,
        loop: "idle",
      },
    });
    expect(assertScannerHealthy).toHaveBeenCalledOnce();
    expect(getQueueMetrics).toHaveBeenCalledOnce();
  });

  it("drains on-demand work to idle and fails closed on processing errors", async () => {
    const runOne = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const onError = vi.fn();

    await runWorker({
      mode: "on-demand",
      signal: new AbortController().signal,
      pollIntervalMs: 30_000,
      maxPollIntervalMs: 300_000,
      runOne,
      onError,
    });

    expect(runOne).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();

    const failure = new TypeError("sensitive failure detail");
    await expect(
      runWorker({
        mode: "on-demand",
        signal: new AbortController().signal,
        pollIntervalMs: 30_000,
        maxPollIntervalMs: 300_000,
        runOne: vi.fn(async () => {
          throw failure;
        }),
        onError,
      }),
    ).rejects.toThrow("The on-demand worker run failed.");
    expect(onError).toHaveBeenLastCalledWith(failure);
    expect(workerErrorDetails(failure)).toEqual({ code: "TypeError" });
    expect(JSON.stringify(workerErrorDetails(failure))).not.toContain(
      failure.message,
    );
  });

  it("backs off continuous idle polling and resets after completed work", async () => {
    const shutdown = new AbortController();
    const delays: number[] = [];
    const starts: number[] = [];
    const runOne = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    await runWorker({
      mode: "continuous",
      signal: shutdown.signal,
      pollIntervalMs: 30_000,
      maxPollIntervalMs: 900_000,
      runOne,
      onLoopStart: () => starts.push(runOne.mock.calls.length),
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 3) shutdown.abort();
      },
    });

    expect(delays).toEqual([30_000, 60_000, 30_000]);
    expect(starts).toEqual([0, 1, 2, 3]);
    expect(runOne).toHaveBeenCalledTimes(4);
  });

  it("never runs jobs in disabled mode and protects detailed health", async () => {
    const shutdown = new AbortController();
    const runOne = vi.fn(async () => true);
    shutdown.abort();

    await runWorker({
      mode: "disabled",
      signal: shutdown.signal,
      pollIntervalMs: 30_000,
      maxPollIntervalMs: 300_000,
      runOne,
    });

    expect(runOne).not.toHaveBeenCalled();
    expect(isAuthorizedHealthRequest("Bearer secret", "secret")).toBe(true);
    expect(isAuthorizedHealthRequest("Bearer wrong", "secret")).toBe(false);
    expect(isAuthorizedHealthRequest(undefined, "secret")).toBe(false);
    expect(isAuthorizedHealthRequest("Bearer secret", undefined)).toBe(false);
  });
});
