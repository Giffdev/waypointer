import { describe, expect, it, vi } from "vitest";
import {
  hasBlockingAccountDeletionRequest,
  isActiveAccount,
} from "./account-state";

const active = {
  emailVerified: new Date("2026-08-12T00:00:00Z"),
  disabledAt: null,
};

describe("active account policy", () => {
  it("accepts only verified accounts without an inactive lifecycle state", () => {
    expect(isActiveAccount(active)).toBe(true);
    expect(isActiveAccount({ ...active, emailVerified: null })).toBe(false);
    expect(
      isActiveAccount({
        ...active,
        disabledAt: new Date("2026-08-12T01:00:00Z"),
      }),
    ).toBe(false);
    expect(
      isActiveAccount({
        ...active,
        deletionPendingAt: new Date("2026-08-12T01:00:00Z"),
      }),
    ).toBe(false);
    expect(
      isActiveAccount({
        ...active,
        purgedAt: new Date("2026-08-12T01:00:00Z"),
      }),
    ).toBe(false);
  });

  it("provides a backward-compatible status seam for deletion schema work", () => {
    expect(isActiveAccount({ ...active, status: "active" })).toBe(true);
    expect(isActiveAccount({ ...active, status: "deletion_pending" })).toBe(
      false,
    );
    expect(isActiveAccount({ ...active, status: "purged" })).toBe(false);
  });

  it("checks deletion state inside the owner-scoped RLS transaction", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const tx = {
      execute,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: "deletion-request" }],
          }),
        }),
      }),
    };

    await expect(
      hasBlockingAccountDeletionRequest(
        tx as unknown as Parameters<
          typeof hasBlockingAccountDeletionRequest
        >[0],
        "00000000-0000-4000-8000-000000000001",
      ),
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});
