import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  regenerateMapShare: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
}));
vi.mock("@/lib/sharing/service", () => ({
  regenerateMapShare: mocks.regenerateMapShare,
  ShareNotFoundError: class ShareNotFoundError extends Error {},
}));

import { POST } from "./route";

const NO_STORE =
  "no-store, max-age=0, s-maxage=0, must-revalidate";
const status = {
  enabled: true,
  sharePath: `/shared/new#key=${"n".repeat(43)}`,
  enabledAt: "2026-08-20T20:00:00.000Z",
  disabledAt: null,
  includeDisplayName: false,
  publishedFlightCount: 3,
};

describe("sharing regeneration API", () => {
  beforeEach(() => {
    mocks.requireAuthenticatedUser.mockReset().mockResolvedValue({ id: "owner-a" });
    mocks.regenerateMapShare.mockReset().mockResolvedValue(status);
  });

  it("marks a replacement capability response as no-store", async () => {
    const response = await POST(
      new Request("https://example.test/api/account/sharing/regenerate", {
        method: "POST",
        headers: { origin: "https://example.test" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(await response.json()).toEqual({ sharing: status });
    expect(mocks.regenerateMapShare).toHaveBeenCalledWith("owner-a");
  });

  it("marks rejected replacement responses as no-store", async () => {
    const response = await POST(
      new Request("https://example.test/api/account/sharing/regenerate", {
        method: "POST",
        headers: { origin: "https://evil.test" },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.regenerateMapShare).not.toHaveBeenCalled();
  });
});
