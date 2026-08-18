import { describe, expect, it } from "vitest";
import {
  formatSharePath,
  parseShareSelection,
  publicTokenRateLimitKey,
  ShareValidationError,
} from "./service";

const flightA = "00000000-0000-4000-8000-000000000001";
const flightB = "00000000-0000-4000-8000-000000000002";

describe("map sharing contracts", () => {
  it("requires separate explicit identity consent and an explicit selection", () => {
    expect(() => parseShareSelection({ flightIds: [] })).toThrowError(
      ShareValidationError,
    );
    expect(parseShareSelection({
      flightIds: [],
      includeDisplayName: false,
    })).toEqual({
      flightIds: [],
      includeDisplayName: false,
    });
  });

  it("normalizes, deduplicates, and bounds selected owner flight IDs", () => {
    expect(parseShareSelection({
      flightIds: [flightB, flightA, flightB],
      includeDisplayName: true,
    })).toEqual({
      flightIds: [flightA, flightB],
      includeDisplayName: true,
    });
    expect(() =>
      parseShareSelection({
        flightIds: ["not-a-flight"],
        includeDisplayName: false,
      }),
    ).toThrowError(ShareValidationError);
  });

  it("uses a redacted operational rate-limit key", () => {
    const secret = "s".repeat(43);
    const key = publicTokenRateLimitKey(
      "00000000-0000-4000-8000-000000000010",
      secret,
    );
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(key).not.toContain(secret);
  });

  it("places the capability secret only in the non-transmitted URL fragment", () => {
    const publicId = "00000000-0000-4000-8000-000000000010";
    const secret = "s".repeat(43);
    const url = new URL(formatSharePath(publicId, secret), "https://example.test");
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(secret);
    expect(url.hash).toBe(`#key=${secret}`);
  });
});
