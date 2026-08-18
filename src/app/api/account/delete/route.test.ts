import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  requestAccountDeletion: vi.fn(),
  clearDatabaseSessionCookie: vi.fn(),
  isAccountDeletionEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
}));
vi.mock("@/lib/auth/account-deletion", () => ({
  requestAccountDeletion: mocks.requestAccountDeletion,
  DeletionAuthorizationError: class DeletionAuthorizationError extends Error {},
}));
vi.mock("@/lib/auth/session-cookie", () => ({
  clearDatabaseSessionCookie: mocks.clearDatabaseSessionCookie,
}));
vi.mock("@/lib/auth/capabilities", () => ({
  isAccountDeletionEnabled: mocks.isAccountDeletionEnabled,
}));

import { POST } from "./route";

function deletionRequest(body: object) {
  return new Request("http://localhost:3000/api/account/delete", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("account deletion request API", () => {
  beforeEach(() => {
    mocks.isAccountDeletionEnabled.mockReset().mockReturnValue(true);
    mocks.requireAuthenticatedUser.mockReset().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      email: "pilot@example.test",
    });
    mocks.requestAccountDeletion.mockReset().mockResolvedValue({
      status: "pending",
      graceExpiresAt: "2026-08-19T18:00:00.000Z",
    });
    mocks.clearDatabaseSessionCookie.mockReset().mockResolvedValue(undefined);
  });

  it("requires explicit confirmation and clears the compatible session cookie", async () => {
    const response = await POST(
      deletionRequest({ confirmation: "DELETE", password: "correct-password" }),
    );
    expect(response.status).toBe(202);
    expect(mocks.requestAccountDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ password: "correct-password" }),
    );
    expect(mocks.clearDatabaseSessionCookie).toHaveBeenCalledOnce();
  });

  it("returns the same safe validation category without touching deletion state", async () => {
    const response = await POST(deletionRequest({ confirmation: "delete" }));
    expect(response.status).toBe(400);
    expect(mocks.requestAccountDeletion).not.toHaveBeenCalled();
  });

  it("fails before authentication or destructive side effects when email delivery is unavailable", async () => {
    mocks.isAccountDeletionEnabled.mockReturnValue(false);

    const response = await POST(
      deletionRequest({ confirmation: "DELETE", password: "correct-password" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "feature-unavailable",
        message: "Account deletion is temporarily unavailable.",
      },
    });
    expect(mocks.requireAuthenticatedUser).not.toHaveBeenCalled();
    expect(mocks.requestAccountDeletion).not.toHaveBeenCalled();
    expect(mocks.clearDatabaseSessionCookie).not.toHaveBeenCalled();
  });
});
