import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GenericCsvImportError,
  fingerprintGenericCsvMapping as domainFingerprintGenericCsvMapping,
  parseGenericCsvMapping as domainParseGenericCsvMapping,
  serializeGenericCsvMapping,
} from "./generic-csv";
import {
  canonicalGenericCsvMapping,
  fingerprintGenericCsvMapping,
  parseGenericCsvMapping,
} from "./generic-mapping";

describe("generic CSV transport mapping", () => {
  it("delegates every runtime rule and canonical operation to the domain boundary", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./generic-mapping.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("parseGenericCsvMapping");
    expect(source).toContain(
      "serializeGenericCsvMapping as canonicalGenericCsvMapping",
    );
    expect(source).toContain("fingerprintGenericCsvMapping");
    expect(source).not.toMatch(
      /MAX_MAPPING|COLUMN_KEYS|requiredString|enumValue|rejectUnknownKeys/,
    );
    expect(parseGenericCsvMapping).toBe(domainParseGenericCsvMapping);
    expect(canonicalGenericCsvMapping).toBe(serializeGenericCsvMapping);
    expect(fingerprintGenericCsvMapping).toBe(
      domainFingerprintGenericCsvMapping,
    );
  });

  it("normalizes one bounded per-import mapping", () => {
    const mapping = parseGenericCsvMapping({
      presetId: "myflightbook-export",
      columns: {
        date: " Date ",
        origin: "From",
        destination: "To",
        duration: "Total Flight Time",
      },
      defaults: { kind: "private", role: "pilot" },
      dateFormat: "iso",
      durationFormat: "decimal-hours",
    });

    expect(mapping).toEqual({
      version: 1,
      presetId: "myflightbook-export",
      columns: {
        date: "Date",
        origin: "From",
        destination: "To",
        duration: "Total Flight Time",
      },
      defaults: { kind: "private", role: "pilot" },
      dateFormat: "iso",
      durationFormat: "decimal-hours",
    });
    expect(JSON.parse(canonicalGenericCsvMapping(mapping))).toMatchObject({
      columns: {
        date: "date",
        origin: "from",
        destination: "to",
        duration: "total flight time",
      },
    });
  });

  it.each([
    {
      columns: { date: "Date", origin: "From", destination: "From" },
      defaults: { kind: "private", role: "pilot" },
      dateFormat: "iso",
    },
    {
      columns: { date: "Date", origin: "From", destination: "To" },
      defaults: { kind: "private", role: "pilot" },
      dateFormat: "iso",
      unknown: true,
    },
    {
      presetId: "unknown",
      columns: { date: "Date", origin: "From", destination: "To" },
      defaults: { kind: "private", role: "pilot" },
      dateFormat: "iso",
    },
  ])("rejects unsafe or ambiguous mappings", (mapping) => {
    expect(() => parseGenericCsvMapping(mapping)).toThrow(
      GenericCsvImportError,
    );
  });
});
