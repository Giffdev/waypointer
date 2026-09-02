import { describe, expect, it } from "vitest";
import { CsvDecodeError, decodeCsvBytes } from "./csv-decode";
import { encodeWindows1252 } from "./__fixtures__/encode-windows-1252";

const SAMPLE_CSV = "Date,Tail Number\r\n2026-06-01,N100ZZ\r\n";

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function withBom(bytes: Uint8Array): Uint8Array {
  return new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
}

describe("decodeCsvBytes", () => {
  it("decodes plain UTF-8 with no BOM", () => {
    expect(decodeCsvBytes(utf8Bytes(SAMPLE_CSV))).toEqual({
      content: SAMPLE_CSV,
      encoding: "utf-8",
    });
  });

  it("decodes UTF-8 with a BOM and strips it", () => {
    expect(decodeCsvBytes(withBom(utf8Bytes(SAMPLE_CSV)))).toEqual({
      content: SAMPLE_CSV,
      encoding: "utf-8",
    });
  });

  it("decodes valid multi-byte UTF-8 (accented characters) with no BOM", () => {
    const content = 'Date,Comments\r\n2026-06-01,"Café \u2013 é\xe9"\r\n';
    expect(decodeCsvBytes(utf8Bytes(content))).toEqual({
      content,
      encoding: "utf-8",
    });
  });

  it("falls back to Windows-1252 when the bytes are not valid UTF-8 and have no BOM", () => {
    // Real-world case: a UTF-8 MyFlightbook export re-saved by Excel as
    // "CSV (Comma delimited)" on Windows, which uses Windows-1252 and does
    // not write a BOM.
    const text =
      'Date,Comments\r\n2026-06-01,"Caf\u00e9 \u201cred-eye\u201d \u2014 smooth landing"\r\n';
    const bytes = encodeWindows1252(text);
    // Sanity check: these bytes are not valid UTF-8, so the primary path
    // must actually fail before the fallback is exercised.
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toThrow();
    expect(decodeCsvBytes(bytes)).toEqual({ content: text, encoding: "windows-1252" });
  });

  it("rejects invalid UTF-8 when a UTF-8 BOM is declared (no fallback attempted)", () => {
    const corrupt = withBom(new Uint8Array([0x41, 0xff, 0xfe, 0x42]));
    expect(() => decodeCsvBytes(corrupt)).toThrow(CsvDecodeError);
    try {
      decodeCsvBytes(corrupt);
      throw new Error("expected decodeCsvBytes to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CsvDecodeError);
      expect((error as CsvDecodeError).reason).toBe("invalid-encoding");
    }
  });

  it("rejects bytes that decode to neither valid UTF-8 nor plausible Windows-1252 text", () => {
    // A run of the five Windows-1252-unassigned byte values: not valid
    // UTF-8, and not safely interpretable as Windows-1252 either.
    const garbage = new Uint8Array([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0x81, 0x8d]);
    expect(() => decodeCsvBytes(garbage)).toThrow(CsvDecodeError);
    try {
      decodeCsvBytes(garbage);
      throw new Error("expected decodeCsvBytes to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CsvDecodeError);
      expect((error as CsvDecodeError).reason).toBe("binary-content");
    }
  });

  it("rejects raw NUL bytes as binary content", () => {
    const bytes = utf8Bytes("Date,Tail\r\n2026-06-01,N1\u0000");
    expect(() => decodeCsvBytes(bytes)).toThrow(CsvDecodeError);
    try {
      decodeCsvBytes(bytes);
      throw new Error("expected decodeCsvBytes to throw");
    } catch (error) {
      expect((error as CsvDecodeError).reason).toBe("binary-content");
    }
  });

  it.each([
    ["a ZIP/xlsx/docx file", [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]],
    ["an empty ZIP archive", [0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]],
    [
      "a legacy Office (xls/doc) OLE file",
      [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0],
    ],
    ["a PDF", [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]],
    [
      "a PNG image",
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0],
    ],
    ["a JPEG image", [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]],
    ["a GIF87a image", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
    ["a GIF89a image", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  ])("rejects %s renamed to .csv before attempting to decode it", (_label, bytes) => {
    expect(() => decodeCsvBytes(new Uint8Array(bytes))).toThrow(CsvDecodeError);
    try {
      decodeCsvBytes(new Uint8Array(bytes));
      throw new Error("expected decodeCsvBytes to throw");
    } catch (error) {
      expect((error as CsvDecodeError).reason).toBe("binary-content");
    }
  });

  it("decodes UTF-16LE with a BOM", () => {
    const utf16 = encodeUtf16(SAMPLE_CSV, "LE");
    expect(decodeCsvBytes(utf16)).toEqual({
      content: SAMPLE_CSV,
      encoding: "utf-16le",
    });
  });

  it("decodes UTF-16BE with a BOM", () => {
    const utf16 = encodeUtf16(SAMPLE_CSV, "BE");
    expect(decodeCsvBytes(utf16)).toEqual({
      content: SAMPLE_CSV,
      encoding: "utf-16be",
    });
  });

  it("rejects malformed UTF-16 (unpaired surrogate) even with a valid BOM", () => {
    // BOM (FF FE) + unpaired high surrogate (00 D8) + "A" (41 00)
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]);
    expect(() => decodeCsvBytes(bytes)).toThrow(CsvDecodeError);
    try {
      decodeCsvBytes(bytes);
      throw new Error("expected decodeCsvBytes to throw");
    } catch (error) {
      expect((error as CsvDecodeError).reason).toBe("invalid-encoding");
    }
  });

  it("rejects content with excessive control characters even when it decodes", () => {
    const noisy = "Date,Tail\r\n" + Array.from({ length: 50 }, (_, i) => String.fromCharCode(1 + (i % 20))).join("");
    expect(() => decodeCsvBytes(utf8Bytes(noisy))).toThrow(CsvDecodeError);
  });

  it("encodeWindows1252 test helper round-trips through the real decoder", () => {
    const text = "\u20ac\u2018\u2019\u201c\u201d\u2013\u2014\u00e9\u00fc";
    const bytes = encodeWindows1252(text);
    expect(new TextDecoder("windows-1252").decode(bytes)).toBe(text);
  });
});

function encodeUtf16(text: string, endianness: "LE" | "BE"): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  if (endianness === "LE") {
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
  } else {
    bytes[0] = 0xfe;
    bytes[1] = 0xff;
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const high = (code >> 8) & 0xff;
    const low = code & 0xff;
    const offset = 2 + index * 2;
    if (endianness === "LE") {
      bytes[offset] = low;
      bytes[offset + 1] = high;
    } else {
      bytes[offset] = high;
      bytes[offset + 1] = low;
    }
  }
  return bytes;
}
