import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findActiveAccountById: vi.fn(),
}));

vi.mock("@/lib/auth/account-state", () => ({
  findActiveAccountById: mocks.findActiveAccountById,
}));

import { DurableJobRepository } from "./repository";

const claimedRow = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "00000000-0000-4000-8000-000000000002",
  job_type: "scan_import",
  payload: { batchId: "00000000-0000-4000-8000-000000000003" },
  attempts: 1,
  max_attempts: 5,
  lease_owner: "worker-1",
  lease_expires_at: "2026-08-13T21:00:00.000Z",
};

function database() {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([claimedRow]);
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { execute, update } as never, set };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("durable queue account-state race", () => {
  it("returns an active owner-attributed lease", async () => {
    mocks.findActiveAccountById.mockResolvedValue({
      id: claimedRow.user_id,
      email: "synthetic@example.test",
    });
    const { db } = database();

    await expect(
      new DurableJobRepository(db).claim("worker-1", 120),
    ).resolves.toEqual({
      id: claimedRow.id,
      userId: claimedRow.user_id,
      jobType: "scan_import",
      payload: claimedRow.payload,
      attempts: 1,
      maxAttempts: 5,
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(claimedRow.lease_expires_at),
    });
    expect(mocks.findActiveAccountById).toHaveBeenCalledWith(
      claimedRow.user_id,
    );
  });

  it("cancels a lease when the user became disabled or deletion-blocked", async () => {
    mocks.findActiveAccountById.mockResolvedValue(null);
    const { db, set } = database();

    await expect(
      new DurableJobRepository(db).claim("worker-1", 120),
    ).resolves.toBeNull();

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: expect.any(Date),
      }),
    );
  });
});
