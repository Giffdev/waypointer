import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  deleteWhere: vi.fn(),
  existing: [] as Array<{ id: string }>,
  hashPassword: vi.fn(),
  isPasswordBreached: vi.fn(),
  requestIp: vi.fn(),
  sendVerificationEmail: vi.fn(),
  verificationValues: vi.fn(),
}));

vi.mock("@/lib/auth/request", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  requestIp: mocks.requestIp,
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  consumeRateLimit: mocks.consumeRateLimit,
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: mocks.hashPassword,
  isPasswordBreached: mocks.isPasswordBreached,
  validatePassword: () => null,
}));

vi.mock("@/lib/auth/email", () => ({
  sendVerificationEmail: mocks.sendVerificationEmail,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => mocks.existing,
        }),
      }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        mocks.verificationValues(values);
        return {
          returning: async () => [
            { id: "11111111-1111-4111-8111-111111111111" },
          ],
        };
      },
    }),
    delete: () => ({ where: mocks.deleteWhere }),
  }),
}));

import { POST } from "./route";

function registrationRequest() {
  const form = new FormData();
  form.set("email", "new.pilot@example.test");
  form.set("username", "new_pilot");
  form.set("password", "correct horse battery staple");
  form.set("confirmPassword", "correct horse battery staple");
  return new Request("http://localhost:3000/api/auth/register", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-forwarded-for": "203.0.113.42",
    },
    body: form,
  });
}

describe("public registration", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FLIGHT_MAP_HOSTED_PREVIEW", "true");
    vi.stubEnv(
      "AUTH_PREVIEW_ACCESS_SECRET",
      "retired-secret-must-not-affect-registration",
    );
    vi.stubEnv(
      "AUTH_PREVIEW_ALLOWED_EMAILS",
      "different.person@example.test",
    );
    mocks.assertSameOrigin.mockReset();
    mocks.consumeRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.deleteWhere.mockReset().mockResolvedValue(undefined);
    mocks.existing = [];
    mocks.hashPassword.mockReset().mockResolvedValue("password-hash");
    mocks.isPasswordBreached.mockReset().mockResolvedValue(false);
    mocks.requestIp.mockReset().mockReturnValue("203.0.113.42");
    mocks.sendVerificationEmail.mockReset().mockResolvedValue({});
    mocks.verificationValues.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers an arbitrary non-allowlisted email without a preview code and requires verification", async () => {
    const response = await POST(registrationRequest());

    expect(mocks.consumeRateLimit.mock.calls).toEqual([
      ["register-ip", "203.0.113.42", 8, 60 * 60_000],
      ["register-email", "new.pilot@example.test", 4, 60 * 60_000],
    ]);
    expect(mocks.sendVerificationEmail).toHaveBeenCalledWith({
      email: "new.pilot@example.test",
      verificationUrl: expect.stringContaining("/auth/verify?"),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/auth/verify?sent=true",
    );
    expect(response.headers.get("location")).not.toContain(
      "preview-access-denied",
    );
  });

  it("returns the same completion destination for an existing account", async () => {
    mocks.existing = [{ id: "existing-user" }];

    const response = await POST(registrationRequest());

    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/auth/verify?sent=true",
    );
  });
});
