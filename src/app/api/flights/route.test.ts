import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  createManualFlight: vi.fn(),
  revalidateOwnerFlightViews: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}));
vi.mock("@/lib/flights/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flights/service")>();
  return { ...actual, createManualFlight: mocks.createManualFlight };
});
vi.mock("@/app/api/import/_lib/revalidate", () => ({
  revalidateOwnerFlightViews: mocks.revalidateOwnerFlightViews,
}));

import { POST } from "./route";

describe("POST /api/flights", () => {
  beforeEach(() => {
    mocks.requireAuthenticatedUser.mockReset().mockResolvedValue({ id: "user-a" });
    mocks.createManualFlight.mockReset().mockResolvedValue({ id: "flight-a" });
    mocks.revalidateOwnerFlightViews.mockReset();
  });

  it("uses the authenticated tenant and returns the created manual flight", async () => {
    const body = {
      classification: "commercial",
      date: "2026-08-14",
      originAirportId: "00000000-0000-4000-8000-000000000001",
      intermediateAirportIds: [
        "00000000-0000-4000-8000-000000000003",
      ],
      destinationAirportId: "00000000-0000-4000-8000-000000000002",
    };
    const response = await POST(new Request("https://example.test/api/flights", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, userId: "attacker" }),
    }));
    expect(response.status).toBe(201);
    expect(mocks.createManualFlight).toHaveBeenCalledWith("user-a", {
      ...body,
      userId: "attacker",
    });
    expect(mocks.revalidateOwnerFlightViews).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin writes before persistence", async () => {
    const response = await POST(new Request("https://example.test/api/flights", {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        "content-type": "application/json",
      },
      body: "{}",
    }));
    expect(response.status).toBe(403);
    expect(mocks.createManualFlight).not.toHaveBeenCalled();
  });
});
