import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  isPasswordBreached: vi.fn(),
  requestIp: vi.fn(),
}));

vi.mock("@/lib/auth/request", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  requestIp: mocks.requestIp,
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  consumeRateLimit: mocks.consumeRateLimit,
}));
vi.mock("@/lib/auth/password", () => ({
  isPasswordBreached: mocks.isPasswordBreached,
  validatePassword: (password: string) =>
    password.length >= 12 && password.length <= 128 ? null : "invalid",
}));

import { POST } from "./route";

function request(
  password = "correct horse battery staple",
  username = "pilot_name",
) {
  return new Request(
    "http://localhost:3000/api/auth/firebase/register-check",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        email: "pilot@example.test",
        username,
        password,
      }),
    },
  );
}

describe("Firebase registration screening", () => {
  beforeEach(() => {
    mocks.assertSameOrigin.mockReset();
    mocks.consumeRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.isPasswordBreached.mockReset().mockResolvedValue(false);
    mocks.requestIp.mockReset().mockReturnValue("203.0.113.42");
  });

  it("preserves registration rate limits and password screening", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.consumeRateLimit.mock.calls).toEqual([
      ["register-ip", "203.0.113.42", 8, 60 * 60_000],
      ["register-email", "pilot@example.test", 4, 60 * 60_000],
    ]);
    expect(mocks.isPasswordBreached).toHaveBeenCalledWith(
      "correct horse battery staple",
    );
  });

  it("rejects weak or breached passwords without detailed errors", async () => {
    mocks.isPasswordBreached.mockResolvedValue(true);
    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it("rejects reserved public handles without detailed errors", async () => {
    const response = await POST(
      request("correct horse battery staple", "settings"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });
});
