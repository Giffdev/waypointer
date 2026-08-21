import { describe, expect, it } from "vitest";
import {
  isReservedPublicHandle,
  isValidPublicHandle,
  isUsernameUniqueViolation,
  isValidUsername,
  normalizeUsername,
  RESERVED_PUBLIC_HANDLES,
} from "./username";

describe("username contract", () => {
  it("normalizes case and surrounding whitespace", () => {
    expect(normalizeUsername("  Flight_Pilot-7 ")).toBe("flight_pilot-7");
  });

  it("accepts only the documented 3–30 character format", () => {
    expect(isValidUsername("pilot_7")).toBe(true);
    expect(isValidUsername("7-pilot")).toBe(true);
    expect(isValidUsername("ab")).toBe(false);
    expect(isValidUsername("_pilot")).toBe(false);
    expect(isValidUsername("Pilot")).toBe(false);
    expect(isValidUsername("pilot.name")).toBe(false);
    expect(isValidUsername("a".repeat(31))).toBe(false);
  });

  it("protects application routes from case-insensitive public handles", () => {
    expect(isValidPublicHandle("devsin")).toBe(true);
    expect(isValidPublicHandle("DeVSiN")).toBe(false);
    for (const route of [
      "api",
      "auth",
      "flights",
      "import",
      "map",
      "settings",
      "shared",
      "u",
      "waypointer",
      "official",
      "staff",
      "support",
      "admin",
      "administrator",
      "system",
      "root",
    ]) {
      expect(RESERVED_PUBLIC_HANDLES).toContain(route);
      expect(isReservedPublicHandle(route.toUpperCase())).toBe(true);
      expect(isValidPublicHandle(route)).toBe(false);
    }
  });

  it("recognizes only the PostgreSQL username uniqueness violation", () => {
    expect(
      isUsernameUniqueViolation({
        cause: {
          code: "23505",
          constraint_name: "users_username_unique",
        },
      }),
    ).toBe(true);
    expect(
      isUsernameUniqueViolation({
        code: "23505",
        constraint_name: "users_email_unique",
      }),
    ).toBe(false);
  });
});
