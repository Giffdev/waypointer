import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeUpload, ImportServiceError } from "./service";

function csvFile(content: string, type: string, name = "flights.csv"): File {
  return new File([content], name, { type });
}

const SAMPLE_CSV = "origin,destination\nSEA,LAX\n";

describe("decodeUpload content-type allowlist", () => {
  beforeEach(() => {
    vi.stubEnv("IMPORT_MAX_BYTES", "1048576");
  });

  it.each([
    "text/csv",
    "text/plain",
    // iOS Safari's Files picker reports this MIME type for .csv files
    // (Apple maps the .csv extension to the Excel/Numbers UTI). Regression
    // coverage for the mobile CSV upload bug.
    "application/vnd.ms-excel",
    "APPLICATION/VND.MS-EXCEL",
    "application/octet-stream",
    // Some mobile browsers omit a content type entirely.
    "",
  ])("accepts a real CSV declared as %s", (type) => {
    const file = csvFile(SAMPLE_CSV, type);
    expect(decodeUpload(file, new TextEncoder().encode(SAMPLE_CSV))).toBe(
      SAMPLE_CSV,
    );
  });

  it("rejects a content type unrelated to CSV, even with a .csv name", () => {
    const file = csvFile(SAMPLE_CSV, "application/pdf");
    expect(() =>
      decodeUpload(file, new TextEncoder().encode(SAMPLE_CSV)),
    ).toThrow(ImportServiceError);
    try {
      decodeUpload(file, new TextEncoder().encode(SAMPLE_CSV));
      throw new Error("expected decodeUpload to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "unsupported-content-type",
        status: 415,
      });
    }
  });
});
