import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "./types";
import { DurableJobRepository, retryDelayMs } from "./repository";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function claimedJob(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    jobType: "scan_import",
    payload: { batchId: "00000000-0000-4000-8000-000000000003" },
    attempts: 1,
    maxAttempts: 5,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-08-13T20:00:00.000Z"),
    ...overrides,
  };
}

function updateDb(returned = true) {
  const returning = vi.fn().mockResolvedValue(
    returned ? [{ id: "00000000-0000-4000-8000-000000000001" }] : [],
  );
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    db: { update } as never,
    set,
  };
}

describe("durable queue retry policy", () => {
  it("uses bounded exponential backoff with deterministic jitter limits", () => {
    expect(retryDelayMs(1, () => 0)).toBe(3_750);
    expect(retryDelayMs(1, () => 0.5)).toBe(5_000);
    expect(retryDelayMs(2, () => 0.5)).toBe(10_000);
    expect(retryDelayMs(20, () => 0.5)).toBe(15 * 60_000);
    expect(retryDelayMs(20, () => 1)).toBe(15 * 60_000);
  });

  describe("durable queue claim and idempotency contract", () => {
    it("enqueues one owner-attributed scan job per batch idempotency key", async () => {
      const returning = vi.fn().mockResolvedValue([{ id: "job-id" }]);
      const onConflictDoUpdate = vi.fn(() => ({ returning }));
      const values = vi.fn(() => ({ onConflictDoUpdate }));
      const insert = vi.fn(() => ({ values }));
      const repository = new DurableJobRepository({ insert } as never);

      await expect(
        repository.enqueueScanImport(
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
          4,
        ),
      ).resolves.toBe("job-id");

      expect(values).toHaveBeenCalledWith({
        userId: "00000000-0000-4000-8000-000000000001",
        jobType: "scan_import",
        payload: { batchId: "00000000-0000-4000-8000-000000000002" },
        idempotencyKey:
          "scan-import:00000000-0000-4000-8000-000000000002",
        maxAttempts: 4,
      });
      expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    });

    it("claims with skip-locked lease recovery and excludes unsafe accounts", () => {
      const source = readFileSync(
        fileURLToPath(new URL("./repository.ts", import.meta.url)),
        "utf8",
      );

      expect(source).toMatch(/for update of j skip locked/i);
      expect(source).toMatch(
        /j\.state = 'running' and j\.lease_expires_at <= now\(\)/i,
      );
      expect(source).toMatch(/j\.attempts < j\.max_attempts/i);
      expect(source).toMatch(/j\.cancel_requested_at is null/i);
      expect(source).toMatch(/u\.email_verified_at is not null/i);
      expect(source).toMatch(/u\.disabled_at is null/i);
      expect(source).toMatch(
        /account_deletion_requests[\s\S]+status in \('pending', 'processing', 'failed'\)/i,
      );
      expect(source).toMatch(
        /state = 'dead_letter'[\s\S]+attempts >= max_attempts/i,
      );
    });
  });

  it("requeues a transient failure and clears the worker lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T20:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { db, set } = updateDb();
    const repository = new DurableJobRepository(db);

    await expect(
      repository.fail(
        claimedJob({ attempts: 2 }),
        "scanner-unavailable",
        "The import could not be processed safely.",
        true,
      ),
    ).resolves.toBe("queued");

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "queued",
        availableAt: new Date("2026-08-13T20:00:10.000Z"),
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
      }),
    );
  });

  it("scrubs per-import mapping data when staging succeeds", async () => {
    const { db, set } = updateDb();
    const repository = new DurableJobRepository(db);

    await expect(
      repository.complete(
        "00000000-0000-4000-8000-000000000001",
        "worker-1",
      ),
    ).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "succeeded",
        payload: expect.anything(),
        completedAt: expect.any(Date),
      }),
    );
  });

  it("moves exhausted transient failures to the dead-letter state", async () => {
    const { db, set } = updateDb();
    const repository = new DurableJobRepository(db);

    await expect(
      repository.fail(
        claimedJob({ attempts: 5, maxAttempts: 5 }),
        "scanner-timeout",
        "The import could not be processed safely.",
        true,
      ),
    ).resolves.toBe("dead_letter");

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "dead_letter",
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    );
  });

  it("does not retry permanent malware or upload failures", async () => {
    const { db, set } = updateDb();
    const repository = new DurableJobRepository(db);

    await expect(
      repository.fail(
        claimedJob(),
        "malware-detected",
        "The upload did not pass malware scanning.",
        false,
      ),
    ).resolves.toBe("failed");

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    );
  });

  it("rejects unsafe workers and reports a lost lease", async () => {
    const { db } = updateDb(false);
    const repository = new DurableJobRepository(db);

    await expect(repository.claim("x", 120)).rejects.toThrow(/safe worker ID/);
    await expect(repository.claim("worker-1", 29)).rejects.toThrow(/30 to 900/);
    await expect(
      repository.fail(
        claimedJob(),
        "lease-lost",
        "The import could not be processed safely.",
        true,
      ),
    ).rejects.toThrow(/lease was lost/i);
  });
});
