import { describe, expect, it } from "vitest";
import { eligibleFirebaseClaims } from "./firebase-bridge";

const now = 2_000_000_000;

describe("Firebase identity bridge claims", () => {
  it("accepts only recent verified Google or password authentication", () => {
    expect(
      eligibleFirebaseClaims(
        {
          sub: "firebase-user",
          email: "pilot@example.test",
          email_verified: true,
          auth_time: now - 60,
          firebase: { sign_in_provider: "google.com" },
        },
        now,
      ),
    ).toBe(true);
    expect(
      eligibleFirebaseClaims(
        {
          sub: "firebase-user",
          email: "pilot@example.test",
          email_verified: false,
          auth_time: now - 60,
          firebase: { sign_in_provider: "password" },
        },
        now,
      ),
    ).toBe(false);
    expect(
      eligibleFirebaseClaims(
        {
          sub: "firebase-user",
          email: "pilot@example.test",
          email_verified: true,
          auth_time: now - 601,
          firebase: { sign_in_provider: "google.com" },
        },
        now,
      ),
    ).toBe(false);
  });
});

