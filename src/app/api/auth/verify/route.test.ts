import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  consumeRateLimit: mocks.consumeRateLimit,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ transaction: mocks.transaction }),
}));

import { POST } from "./route";

function verificationRequest(email = "pilot@example.com", token = "token") {
  const form = new FormData();
  form.set("email", email);
  form.set("token", token);
  return new Request("http://localhost:3000/api/auth/verify", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-forwarded-for": "203.0.113.42",
    },
    body: form,
  });
}

describe("email verification rate limits", () => {
  beforeEach(() => {
    mocks.consumeRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.transaction.mockReset().mockResolvedValue(false);
  });

  it("limits every attempt by IP and normalized email before database lookup", async () => {
    const response = await POST(
      verificationRequest(" Pilot@Example.com ", "unrecognized-token"),
    );

    expect(mocks.consumeRateLimit.mock.calls).toEqual([
      ["verify-ip", "203.0.113.42", 20, 15 * 60_000],
      ["verify-email", "pilot@example.com", 10, 15 * 60_000],
    ]);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/auth/verify?error=invalid-or-expired",
    );
  });

  it("returns the same generic failure without exposing submitted identifiers", async () => {
    mocks.consumeRateLimit.mockRejectedValue(new Error("rate limited"));

    const knownLooking = await POST(
      verificationRequest("pilot@example.com", "known-looking-token"),
    );
    const malformed = await POST(verificationRequest("", ""));

    for (const response of [knownLooking, malformed]) {
      const location = response.headers.get("location");
      expect(location).toBe(
        "http://localhost:3000/auth/verify?error=verification-unavailable",
      );
      expect(location).not.toContain("pilot@example.com");
      expect(location).not.toContain("token");
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
