import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  createDatabaseSession: vi.fn(),
  requestIp: vi.fn(),
  resolveFirebaseAccount: vi.fn(),
  verifyFirebaseIdToken: vi.fn(),
}));

vi.mock("@/lib/auth/request", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  requestIp: mocks.requestIp,
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  consumeRateLimit: mocks.consumeRateLimit,
}));
vi.mock("@/lib/auth/firebase-bridge", () => ({
  resolveFirebaseAccount: mocks.resolveFirebaseAccount,
  verifyFirebaseIdToken: mocks.verifyFirebaseIdToken,
}));
vi.mock("@/lib/auth/session-cookie", () => ({
  createDatabaseSession: mocks.createDatabaseSession,
}));

import { POST } from "./route";

function request(token = "firebase-id-token") {
  return new Request("http://localhost:3000/api/auth/firebase", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-forwarded-for": "203.0.113.42",
    },
    body: JSON.stringify({ token }),
  });
}

describe("Firebase session exchange", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.assertSameOrigin.mockReset();
    mocks.consumeRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.createDatabaseSession.mockReset().mockResolvedValue(undefined);
    mocks.requestIp.mockReset().mockReturnValue("203.0.113.42");
    mocks.resolveFirebaseAccount.mockReset();
    mocks.verifyFirebaseIdToken.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues the existing revocable database session after verified identity mapping", async () => {
    const claims = { sub: "firebase-user" };
    mocks.verifyFirebaseIdToken.mockResolvedValue(claims);
    mocks.resolveFirebaseAccount.mockResolvedValue("local-user");

    const response = await POST(request());

    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      "firebase-session-ip",
      "203.0.113.42",
      20,
      15 * 60_000,
    );
    expect(mocks.resolveFirebaseAccount).toHaveBeenCalledWith(claims);
    expect(mocks.createDatabaseSession).toHaveBeenCalledWith("local-user");
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toMatch(
      /rate-limit;dur=.*token-verification;dur=.*account-mapping;dur=.*session-issuance;dur=.*total;dur=/,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns the same generic rejection for invalid or inactive identities", async () => {
    mocks.verifyFirebaseIdToken.mockResolvedValue(null);
    mocks.resolveFirebaseAccount.mockResolvedValue(null);

    const response = await POST(request("invalid"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false });
    expect(console.warn).toHaveBeenCalledWith(
      "Firebase session exchange rejected.",
      { stage: "token-verification" },
    );
    expect(mocks.createDatabaseSession).not.toHaveBeenCalled();
  });
});
