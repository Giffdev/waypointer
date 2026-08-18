import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateCredentials: vi.fn(),
  assertSameOrigin: vi.fn(),
  createDatabaseSession: vi.fn(),
  requestIp: vi.fn(),
}));

vi.mock("@/lib/auth/credentials", () => ({
  authenticateCredentials: mocks.authenticateCredentials,
}));

vi.mock("@/lib/auth/request", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  requestIp: mocks.requestIp,
}));

vi.mock("@/lib/auth/session-cookie", () => ({
  createDatabaseSession: mocks.createDatabaseSession,
}));

import { POST } from "./route";

function credentialsRequest(
  email = "synthetic.pilot@example.test",
  password = "synthetic-passphrase",
) {
  const form = new FormData();
  form.set("email", email);
  form.set("password", password);
  return new Request("http://localhost:3000/api/auth/credentials", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
    body: form,
  });
}

describe("credentials sign-in journey", () => {
  beforeEach(() => {
    mocks.authenticateCredentials.mockReset();
    mocks.assertSameOrigin.mockReset();
    mocks.createDatabaseSession.mockReset().mockResolvedValue(undefined);
    mocks.requestIp.mockReset().mockReturnValue("203.0.113.42");
  });

  it("creates a revocable database session and redirects successful credentials to the map", async () => {
    mocks.authenticateCredentials.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      email: "synthetic.pilot@example.test",
      name: "Synthetic Pilot",
    });

    const response = await POST(credentialsRequest());

    expect(mocks.assertSameOrigin).toHaveBeenCalledOnce();
    expect(mocks.authenticateCredentials).toHaveBeenCalledWith({
      email: "synthetic.pilot@example.test",
      password: "synthetic-passphrase",
      ip: "203.0.113.42",
    });
    expect(mocks.createDatabaseSession).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/map",
    );
  });

  it("does not create a session and returns generic guidance for rejected credentials", async () => {
    mocks.authenticateCredentials.mockResolvedValue(null);

    const response = await POST(
      credentialsRequest("unknown@example.test", "incorrect-passphrase"),
    );

    expect(mocks.createDatabaseSession).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/auth/sign-in?error=invalid-credentials",
    );
    expect(response.headers.get("location")).not.toContain("unknown");
  });

  it("does not create a session when same-origin or authentication processing fails", async () => {
    mocks.assertSameOrigin.mockImplementation(() => {
      throw new Error("cross-origin");
    });

    const response = await POST(credentialsRequest());

    expect(mocks.authenticateCredentials).not.toHaveBeenCalled();
    expect(mocks.createDatabaseSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/auth/sign-in?error=sign-in-unavailable",
    );
  });
});
