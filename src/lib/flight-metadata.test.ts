import { describe, expect, it } from "vitest";
import {
  normalizeAircraftMetadata,
  normalizeRegistrationMetadata,
} from "./flight-metadata";

describe("flight metadata normalization", () => {
  it("preserves explicit numeric aircraft model and type designations", () => {
    expect(normalizeAircraftMetadata("172", "explicit-model")).toBe("172");
    expect(normalizeAircraftMetadata(" 182 ", "explicit-model")).toBe("182");
    expect(normalizeAircraftMetadata("206", "explicit-type")).toBe("206");
    expect(normalizeAircraftMetadata("150")).toBe("150");
    expect(normalizeAircraftMetadata("Boeing 737-800", "explicit-model")).toBe(
      "Boeing 737-800",
    );
  });

  it("rejects identifier-field values by provenance rather than numeric shape", () => {
    expect(normalizeAircraftMetadata("172", "source-identifier")).toBeUndefined();
    expect(
      normalizeAircraftMetadata("FR24-AIRCRAFT-172", "source-identifier"),
    ).toBeUndefined();
  });

  it("removes missing, sentinel, and punctuation-only metadata", () => {
    expect(normalizeAircraftMetadata(undefined)).toBeUndefined();
    expect(normalizeAircraftMetadata("0")).toBeUndefined();
    expect(normalizeAircraftMetadata("()")).toBeUndefined();
    expect(normalizeAircraftMetadata("---")).toBeUndefined();
    expect(normalizeAircraftMetadata("N/A")).toBeUndefined();
  });

  it("keeps explicit registrations separate while cleaning placeholders", () => {
    expect(normalizeRegistrationMetadata(" N172EX ")).toBe("N172EX");
    expect(normalizeRegistrationMetadata("0")).toBeUndefined();
    expect(normalizeRegistrationMetadata("()")).toBeUndefined();
    expect(normalizeRegistrationMetadata(undefined)).toBeUndefined();
  });
});
