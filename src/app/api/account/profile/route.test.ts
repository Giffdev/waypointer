import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  getOwnerProfile: vi.fn(),
  updateOwnerProfile: vi.fn(),
  updateOwnerMapViewMode: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
}));
vi.mock("@/lib/profile/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/profile/service")>();
  return {
    ...original,
    getOwnerProfile: mocks.getOwnerProfile,
    updateOwnerProfile: mocks.updateOwnerProfile,
    updateOwnerMapViewMode: mocks.updateOwnerMapViewMode,
  };
});

import { GET, PATCH } from "./route";
import { UsernameConflictError } from "@/lib/profile/service";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "pilot@example.test",
};
const profile = {
  email: user.email,
  username: "pilot",
  displayName: "Test Pilot",
  timeZone: "UTC",
  distanceUnit: "miles",
  mapViewMode: "globe",
  hasPassword: true,
};

describe("owner profile API", () => {
  beforeEach(() => {
    mocks.requireAuthenticatedUser.mockReset().mockResolvedValue(user);
    mocks.getOwnerProfile.mockReset().mockResolvedValue(profile);
    mocks.updateOwnerProfile.mockReset().mockResolvedValue(profile);
    mocks.updateOwnerMapViewMode.mockReset().mockResolvedValue({
      ...profile,
      mapViewMode: "flat",
    });
  });

  it("reads only the authenticated owner's profile", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.getOwnerProfile).toHaveBeenCalledWith(user.id);
    await expect(response.json()).resolves.toEqual({ profile });
  });

  it("rejects non-allowlisted profile fields without calling persistence", async () => {
    const response = await PATCH(
      new Request("http://localhost:3000/api/account/profile", {
        method: "PATCH",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ displayName: "Pilot", visibility: "public" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.updateOwnerProfile).not.toHaveBeenCalled();
  });

  it("updates the authenticated owner's username with the profile", async () => {
    const response = await PATCH(
      new Request("http://localhost:3000/api/account/profile", {
        method: "PATCH",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: "new_pilot",
          displayName: "Pilot",
          timeZone: "UTC",
          distanceUnit: "miles",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateOwnerProfile).toHaveBeenCalledWith(user.id, {
      username: "new_pilot",
      displayName: "Pilot",
      timeZone: "UTC",
      distanceUnit: "miles",
    });

  });

  it("updates only the explicit map-view preference", async () => {
    const response = await PATCH(
      new Request("http://localhost:3000/api/account/profile", {
        method: "PATCH",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ mapViewMode: "flat" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateOwnerMapViewMode).toHaveBeenCalledWith(user.id, "flat");
    expect(mocks.updateOwnerProfile).not.toHaveBeenCalled();
  });

  it("returns a specific conflict when the database rejects a taken username", async () => {
    mocks.updateOwnerProfile.mockRejectedValueOnce(
      new UsernameConflictError(),
    );

    const response = await PATCH(
      new Request("http://localhost:3000/api/account/profile", {
        method: "PATCH",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: "taken_pilot",
          displayName: "Pilot",
          timeZone: "UTC",
          distanceUnit: "miles",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "username-taken",
        message: "That username is already taken. Try another.",
      },
    });
  });
});
