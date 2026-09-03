import { describe, expect, it } from "vitest";
import { detectCsvDelimiter, parseCsv, CsvSyntaxError } from "./csv";

describe("parseCsv", () => {
  it("defaults to comma-delimited parsing", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      { cells: ["a", "b"], rowNumber: 1 },
      { cells: ["1", "2"], rowNumber: 2 },
    ]);
  });

  it("parses semicolon-delimited records when the delimiter is provided", () => {
    expect(parseCsv('"a";"b"\r\n"1";"2, still one field"\r\n', ";")).toEqual([
      { cells: ["a", "b"], rowNumber: 1 },
      { cells: ["1", "2, still one field"], rowNumber: 2 },
    ]);
  });

  it("still enforces quoting rules with a semicolon delimiter", () => {
    expect(() => parseCsv('a;"unterminated', ";")).toThrow(CsvSyntaxError);
  });
});

describe("detectCsvDelimiter", () => {
  it("defaults to comma when only commas are present", () => {
    expect(detectCsvDelimiter("Date,Tail Number,Total Flight Time\n2026-06-01,N100ZZ,1.5\n")).toBe(",");
  });

  it("detects semicolon when the header line uses more semicolons than commas", () => {
    expect(
      detectCsvDelimiter('"Date";"Tail Number";"Total Flight Time"\r\n"2026-06-01";"N100ZZ";"1.5"\r\n'),
    ).toBe(";");
  });

  it("defaults to comma on a tie between commas and semicolons", () => {
    expect(detectCsvDelimiter("a,b;c\n1,2,3\n")).toBe(",");
  });

  it("ignores commas and semicolons inside quoted header fields", () => {
    // Three real semicolon delimiters, but a quoted field containing a
    // comma and a semicolon should not be counted as a delimiter.
    expect(
      detectCsvDelimiter('"Date";"Comments, or; Notes";"Tail Number"\r\n"2026-06-01";"x";"N1"\r\n'),
    ).toBe(";");
  });

  it("only inspects the first record, respecting embedded newlines in quotes", () => {
    // A quoted field spanning multiple physical lines must not cause the
    // detector to stop scanning before the header record actually ends.
    const input = '"Date";"Notes"\r\n"2026-06-01";"multi\nline"\r\n';
    expect(detectCsvDelimiter(input)).toBe(";");
  });

  it("does not affect comma-delimited ForeFlight/myFlightradar24-style headers", () => {
    const foreflightLike =
      "Date,AircraftID,From,To,Route,TotalTime,PIC,Night,Solo,CrossCountry\n2026-06-01,N1,KSEA,KPDX,,1.5,1.5,,,\n";
    expect(detectCsvDelimiter(foreflightLike)).toBe(",");
  });
});
