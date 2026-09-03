import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeUpload, ImportServiceError } from "./service";

function csvFile(content: string, type: string, name = "flights.csv"): File {
  return new File([content], name, { type });
}

function bytesFile(bytes: Uint8Array, type: string, name = "flights.csv"): File {
  return new File([bytes], name, { type });
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

describe("decodeUpload byte decoding", () => {
  beforeEach(() => {
    vi.stubEnv("IMPORT_MAX_BYTES", "1048576");
  });

  it("strips a UTF-8 BOM (real MyFlightbook exports are UTF-8 with a BOM)", () => {
    const withBom = new Uint8Array([
      0xef, 0xbb, 0xbf,
      ...new TextEncoder().encode(SAMPLE_CSV),
    ]);
    const file = bytesFile(withBom, "text/csv");
    expect(decodeUpload(file, withBom)).toBe(SAMPLE_CSV);
  });

  it("falls back to Windows-1252 for a no-BOM file re-saved by a spreadsheet", () => {
    // 0xE9 is "é" in Windows-1252 but is not valid standalone UTF-8.
    const windows1252 = new Uint8Array([
      ...new TextEncoder().encode("origin,destination,notes\nSEA,LAX,Caf"),
      0xe9,
      ...new TextEncoder().encode("\n"),
    ]);
    const file = bytesFile(windows1252, "text/csv");
    expect(decodeUpload(file, windows1252)).toBe(
      "origin,destination,notes\nSEA,LAX,Café\n",
    );
  });

  it("rejects a binary file (e.g. a renamed .xlsx) as binary-content, not invalid-utf8", () => {
    const zipSignature = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const file = bytesFile(zipSignature, "text/csv");
    try {
      decodeUpload(file, zipSignature);
      throw new Error("expected decodeUpload to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "binary-content", status: 415 });
    }
  });

  it("rejects bytes that are neither valid UTF-8 nor plausible Windows-1252 text", () => {
    const garbage = new Uint8Array([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0x81, 0x8d]);
    const file = bytesFile(garbage, "text/csv");
    try {
      decodeUpload(file, garbage);
      throw new Error("expected decodeUpload to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "binary-content", status: 415 });
    }
  });
});
