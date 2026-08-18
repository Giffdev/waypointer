import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findActiveAccountById: vi.fn(),
  revokeAllUserSessions: vi.fn(),
}));

vi.mock("./index", () => ({ auth: mocks.auth }));
vi.mock("./account-state", () => ({
  findActiveAccountById: mocks.findActiveAccountById,
  revokeAllUserSessions: mocks.revokeAllUserSessions,
}));

import {
  AuthenticationRequiredError,
  requireAuthenticatedUser,
  requireImportUser,
} from "./guards";

describe("active account guards", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.findActiveAccountById.mockReset();
    mocks.revokeAllUserSessions.mockReset().mockResolvedValue(undefined);
  });

  it("returns trusted database identity fields for every owner boundary", async () => {
    mocks.auth.mockResolvedValue({
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "stale@example.test",
        name: "Stale",
      },
    });
    mocks.findActiveAccountById.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      email: "pilot@example.test",
      name: "Pilot",
      image: null,
    });

    await expect(requireAuthenticatedUser()).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      email: "pilot@example.test",
      name: "Pilot",
      image: null,
    });
    await expect(requireImportUser()).resolves.toMatchObject({
      email: "pilot@example.test",
    });
  });

  it("revokes stale sessions and returns one generic authentication error", async () => {
    const userId = "00000000-0000-4000-8000-000000000002";
    mocks.auth.mockResolvedValue({ user: { id: userId } });
    mocks.findActiveAccountById.mockResolvedValue(null);

    await expect(requireAuthenticatedUser()).rejects.toEqual(
      new AuthenticationRequiredError(),
    );
    expect(mocks.revokeAllUserSessions).toHaveBeenCalledWith(userId);
  });
});
