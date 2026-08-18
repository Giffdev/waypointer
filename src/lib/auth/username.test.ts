import { describe, expect, it } from "vitest";
import {
  isUsernameUniqueViolation,
  isValidUsername,
  normalizeUsername,
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
