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
  ShareEmptyMapError: class ShareEmptyMapError extends Error {},
  ShareValidationError: class ShareValidationError extends Error {},
}));

import { POST } from "./route";

const NO_STORE =
  "no-store, max-age=0, s-maxage=0, must-revalidate";

describe("sharing preview API", () => {
  beforeEach(() => {
    mocks.requireAuthenticatedUser.mockReset().mockResolvedValue({ id: "owner-a" });
    mocks.previewMapSharing.mockReset().mockResolvedValue({
      previewId: "a".repeat(64),
      includeDisplayName: false,
      projection: {
        owner: { displayName: null },
        summary: { flightCount: 1, routeCount: 1 },
        routes: [
          {
            id: "route-a",
            kind: "private",
            flightCount: 1,
            origin: { lat: 47.4, lon: -122.3, country: "US" },
            destination: { lat: 40.6, lon: -73.8, country: "US" },
          },
        ],
      },
    });
  });

  it("requests an authoritative complete-map preview without flight IDs", async () => {
    const input = { includeDisplayName: false };
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
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.previewMapSharing).toHaveBeenCalledWith("owner-a", input);
  });

  it("marks rejected preview responses as no-store", async () => {
    const response = await POST(
      new Request("https://example.test/api/account/sharing/preview", {
        method: "POST",
        headers: {
          origin: "https://evil.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ includeDisplayName: false }),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.previewMapSharing).not.toHaveBeenCalled();
  });

  it("surfaces operational projection failures without reporting a flight cap", async () => {
    mocks.previewMapSharing.mockRejectedValueOnce(
      new Error("database resources unavailable"),
    );
    const response = await POST(
      new Request("https://example.test/api/account/sharing/preview", {
        method: "POST",
        headers: {
          origin: "https://example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ includeDisplayName: false }),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(await response.json()).toEqual({
      error: {
        code: "account-service-unavailable",
        message: "Account settings are temporarily unavailable.",
      },
    });
  });
});
