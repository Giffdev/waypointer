import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  previewMapSharing: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
}));
vi.mock("@/lib/sharing/service", () => ({
  previewMapSharing: mocks.previewMapSharing,
  ShareValidationError: class ShareValidationError extends Error {},
}));

import { POST } from "./route";

describe("sharing preview API", () => {
  beforeEach(() => {
    mocks.requireAuthenticatedUser.mockReset().mockResolvedValue({ id: "owner-a" });
    mocks.previewMapSharing.mockReset().mockResolvedValue({
      previewId: "a".repeat(64),
      selection: {
        flightIds: [],
        includeDisplayName: false,
        selectedFlightCount: 0,
      },
      projection: {
        owner: { displayName: null },
        summary: { flightCount: 0, routeCount: 0 },
        routes: [],
      },
    });
  });

  it("requires an exact owner-scoped preview before enablement", async () => {
    const input = { flightIds: [], includeDisplayName: false };
    const response = await POST(
      new Request("https://example.test/api/account/sharing/preview", {
        method: "POST",
        headers: {
          origin: "https://example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.previewMapSharing).toHaveBeenCalledWith("owner-a", input);
  });
});
