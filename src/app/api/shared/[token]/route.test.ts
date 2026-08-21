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
  publicTokenRateLimitKey: () => "token-key",
  ShareNotFoundError: class ShareNotFoundError extends Error {},
}));

import { GET, POST } from "./route";
import { ShareNotFoundError } from "@/lib/sharing/service";

const publicId = "00000000-0000-4000-8000-000000000001";
const secretKey = "s".repeat(43);

describe("public shared map API", () => {
  beforeEach(() => {
    mocks.consumeRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.getPublicMapProjection.mockReset().mockResolvedValue({
      owner: { displayName: null },
      summary: { flightCount: 0, routeCount: 0 },
      routes: [],
    });
  });

  it("keeps the secret out of the URL and applies anti-indexing headers", async () => {
    const request = new Request(`https://example.test/api/shared/${publicId}`, {
      method: "POST",
      headers: {
        "x-real-ip": "192.0.2.1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ key: secretKey }),
    });
    expect(request.url).not.toContain(secretKey);
    const response = await POST(request, {
      params: Promise.resolve({ token: publicId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "no-store, max-age=0, s-maxage=0, must-revalidate",
    );
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.getPublicMapProjection).toHaveBeenCalledWith(
      publicId,
      secretKey,
    );
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      map: {
        owner: { displayName: null },
        summary: { flightCount: 0, routeCount: 0 },
        routes: [],
      },
    });
  });

  it("uses the same non-enumerating 404 for disabled and guessed capabilities", async () => {
    mocks.getPublicMapProjection.mockRejectedValueOnce(new ShareNotFoundError());
    const response = await POST(
      new Request(`https://example.test/api/shared/${publicId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: secretKey }),
      }),
      { params: Promise.resolve({ token: publicId }) },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.json()).toEqual({
      error: { code: "not-found", message: "Waypointer shared map not found." },
    });
  });

  it("rejects URL-based capability reads with safe headers", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });
});
