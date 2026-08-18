import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ transaction: mocks.transaction }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.cookieSet }),
}));

import {
  authSessionCookieName,
  createDatabaseSession,
} from "./session-cookie";

function transactionWithAccount(account: object | undefined) {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  let selectCount = 0;
  const tx = {
    select: () => {
      selectCount += 1;
      return {
        from: () => ({
          where: () => ({
            limit: () =>
              selectCount === 1
                ? {
                    for: async () => (account ? [account] : []),
                  }
                : Promise.resolve([]),
          }),
        }),
      };
    },
    execute: vi.fn().mockResolvedValue(undefined),
    insert: () => ({ values: insertValues }),
  };
  mocks.transaction.mockImplementation(
    (work: (transaction: typeof tx) => Promise<unknown>) => work(tx),
  );
  return insertValues;
}

describe("opaque database session issuance", () => {
  beforeEach(() => {
    mocks.transaction.mockReset();
    mocks.cookieSet.mockReset();
  });

  it("locks and validates the account before issuing the compatible cookie", async () => {
    const insertValues = transactionWithAccount({
      emailVerified: new Date(),
      disabledAt: null,
    });

    await createDatabaseSession("00000000-0000-4000-8000-000000000001");

    expect(insertValues).toHaveBeenCalledOnce();
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      authSessionCookieName(),
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      }),
    );
  });

  it("does not issue a session or cookie for an inactive account", async () => {
    const insertValues = transactionWithAccount({
      emailVerified: null,
      disabledAt: null,
    });

    await expect(
      createDatabaseSession("00000000-0000-4000-8000-000000000002"),
    ).rejects.toThrow("Authentication is unavailable.");
    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
