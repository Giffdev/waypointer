import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  getPublicMapProjection: vi.fn(),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  RateLimitExceededError: class RateLimitExceededError extends Error {
    retryAfterSeconds = 30;
  },
}));
vi.mock("@/lib/sharing/service", () => ({
  getPublicMapProjection: mocks.getPublicMapProjection,
  publicHandleRateLimitKey: (handle: string) => handle.toLowerCase(),
  ShareNotFoundError: class ShareNotFoundError extends Error {},
}));

import { GET, POST } from "./route";
import { ShareNotFoundError } from "@/lib/sharing/service";

describe("public shared map API", () => {
  beforeEach(() => {
    mocks.consumeRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.getPublicMapProjection.mockReset().mockResolvedValue({
      owner: { displayName: null },
      summary: { flightCount: 0, routeCount: 0 },
      routes: [],
    });
  });

  it("reads a public username with no token and no-store caching", async () => {
    const response = await GET(
      new Request("https://example.test/api/shared/DeVSiN", {
        headers: { "x-real-ip": "192.0.2.1" },
      }),
      { params: Promise.resolve({ handle: "DeVSiN" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "no-store, max-age=0, s-maxage=0, must-revalidate",
    );
    expect(mocks.getPublicMapProjection).toHaveBeenCalledWith("DeVSiN");
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(2);
  });

  it("returns the same generic 404 for disabled and unknown handles", async () => {
    mocks.getPublicMapProjection.mockRejectedValueOnce(new ShareNotFoundError());
    const response = await GET(
      new Request("https://example.test/api/shared/unknown"),
      { params: Promise.resolve({ handle: "unknown" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      error: { code: "not-found", message: "Waypointer shared map not found." },
    });
  });

  it("does not accept a legacy POST capability body", async () => {
    const response = await POST();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});
