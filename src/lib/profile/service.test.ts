import { describe, expect, it } from "vitest";
import {
  normalizeOwnerProfile,
  shouldCreateOwnerProfile,
} from "./service";

describe("private profile allowlist", () => {
  it("normalizes the approved mutable profile fields", () => {
    expect(
      normalizeOwnerProfile({
        username: "  Flight_Pilot  ",
        displayName: "  Test Pilot  ",
        timeZone: "America/Los_Angeles",
        distanceUnit: "nautical_miles",
      }),
    ).toEqual({
      username: "flight_pilot",
      displayName: "Test Pilot",
      timeZone: "America/Los_Angeles",
      distanceUnit: "nautical_miles",
    });
  });

  it("rejects invalid names, time zones, and units", () => {
    expect(() =>
      normalizeOwnerProfile({
        username: "pilot",
        displayName: "",
        timeZone: "UTC",
        distanceUnit: "miles",
      }),
    ).toThrow(/invalid/i);
    expect(() =>
      normalizeOwnerProfile({
        username: "pilot",
        displayName: "Pilot",
        timeZone: "not/a-zone",
        distanceUnit: "miles",
      }),
    ).toThrow(/invalid/i);
  });

  it("rejects usernames outside the shared registration rules", () => {
    expect(() =>
      normalizeOwnerProfile({
        username: "not valid",
        displayName: "Pilot",
        timeZone: "UTC",
        distanceUnit: "miles",
      }),
    ).toThrow(/3–30 letters/i);
  });

  it("rejects root application routes as public handles", () => {
    for (const username of ["api", "auth", "map", "settings", "shared"]) {
      expect(() =>
        normalizeOwnerProfile({
          username,
          displayName: "Pilot",
          timeZone: "UTC",
          distanceUnit: "miles",
        }),
      ).toThrow(/reserved Waypointer route/i);
    }
  });

  it("does not lazily create profiles while release writes are paused", () => {
    expect(
      shouldCreateOwnerProfile({
        FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
      }),
    ).toBe(false);
    expect(
      shouldCreateOwnerProfile({
        FLIGHT_MAP_RELEASE_WRITES_PAUSED: "false",
      }),
    ).toBe(true);
  });
});
