import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  verifyPassword: vi.fn(),
  cookieGet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mocks.selectResults.shift() ?? []),
        }),
      }),
    }),
  }),
  withUserDb: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookieGet }),
}));
vi.mock("./password", () => ({
  verifyPassword: mocks.verifyPassword,
}));

import {
  authorizeAccountDeletion,
  deleteAccountObjects,
} from "./account-deletion";
import type { PrivateObjectStorage } from "@/lib/storage";

describe("account deletion lifecycle seams", () => {
  beforeEach(() => {
    mocks.selectResults.splice(0);
    mocks.verifyPassword.mockReset().mockResolvedValue(true);
    mocks.cookieGet.mockReset().mockReturnValue({ value: "session-token" });
  });

  it("requires both a recent opaque session and password confirmation when present", async () => {
    mocks.selectResults.push(
      [{ passwordHash: "argon-hash" }],
      [{ token: "session-token" }],
    );
    await expect(
      authorizeAccountDeletion(
        "00000000-0000-4000-8000-000000000001",
        "current-password",
      ),
    ).resolves.toBeUndefined();
    expect(mocks.verifyPassword).toHaveBeenCalledWith(
      "argon-hash",
      "current-password",
    );
  });

  it("uses one generic authorization failure", async () => {
    mocks.selectResults.push([{ passwordHash: "argon-hash" }], []);
    await expect(
      authorizeAccountDeletion(
        "00000000-0000-4000-8000-000000000001",
        "current-password",
      ),
    ).rejects.toThrow("could not be authorized");
  });

  it("deletes every private object through the storage seam before relational purge", async () => {
    const deleted: string[] = [];
    const storage = {
      put: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      presignPut: vi.fn(),
      move: vi.fn(),
      copy: vi.fn(),
      delete: vi.fn(async (key: string) => {
        deleted.push(key);
      }),
    } satisfies PrivateObjectStorage;
    await deleteAccountObjects(
      [
        "imports/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.csv",
        "imports/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000003/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.csv",
      ],
      storage,
    );
    expect(deleted).toHaveLength(2);
  });
});
