import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  getOwnerShareStatus: vi.fn(),
  enableMapSharing: vi.fn(),
  disableMapSharing: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
}));
vi.mock("@/lib/sharing/service", () => ({
  getOwnerShareStatus: mocks.getOwnerShareStatus,
  enableMapSharing: mocks.enableMapSharing,
  disableMapSharing: mocks.disableMapSharing,
}));

import { DELETE, GET, POST } from "./route";

const status = {
  enabled: true,
  sharePath: "/shared/token",
  enabledAt: "2026-08-14T19:00:00.000Z",
  disabledAt: null,
  includeDisplayName: false,
  scope: "selected_flights",
  selectedFlightCount: 0,
  selectedFlightIds: [],
};

describe("owner sharing API", () => {
  beforeEach(() => {
    mocks.requireAuthenticatedUser.mockReset().mockResolvedValue({ id: "owner-a" });
    mocks.getOwnerShareStatus.mockReset().mockResolvedValue(status);
    mocks.enableMapSharing.mockReset().mockResolvedValue(status);
    mocks.disableMapSharing.mockReset().mockResolvedValue({
      ...status,
      enabled: false,
      sharePath: null,
    });
  });

  it("scopes status and enablement to the authenticated owner", async () => {
    const statusResponse = await GET();
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({ sharing: status });
    const response = await POST(
      new Request("https://example.test/api/account/sharing", {
        method: "POST",
        headers: {
          origin: "https://example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          flightIds: [],
          includeDisplayName: false,
          previewId: "a".repeat(64),
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.getOwnerShareStatus).toHaveBeenCalledWith("owner-a");
    expect(mocks.enableMapSharing).toHaveBeenCalledWith("owner-a", {
      flightIds: [],
      includeDisplayName: false,
      previewId: "a".repeat(64),
    });
  });

  it("rejects cross-origin disablement before persistence", async () => {
    const response = await DELETE(
      new Request("https://example.test/api/account/sharing", {
        method: "DELETE",
        headers: { origin: "https://evil.test" },
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.disableMapSharing).not.toHaveBeenCalled();
  });
});
