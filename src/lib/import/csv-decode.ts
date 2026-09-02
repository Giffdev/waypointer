// Single source of truth for turning raw uploaded bytes into CSV text,
// shared by the client preview gate (route-client.tsx), the synchronous
// upload service (src/app/api/import/_lib/service.ts), and the durable
// import worker (src/lib/import/durable-worker.ts).
//
// Real MyFlightbook exports are UTF-8 with a BOM (see
// ericberman/MyFlightbookWeb FlightsController.DownloadCSV ->
// LogbookBackup.WriteLogbookCSVToBytes, which writes via
// `new StreamWriter(..., Encoding.UTF8)`). Reports of "not valid UTF-8
// text" most plausibly come from a spreadsheet re-saving that export as
// Windows-1252 (e.g. Excel's default CSV save on Windows), which drops the
// BOM and replaces multi-byte UTF-8 sequences with single-byte Windows-1252
// ones. This module keeps strict UTF-8 as the primary path and only falls
// back to Windows-1252 when the input has no UTF-8 BOM and cannot be
// decoded as UTF-8 at all, subject to the safeguards below.
//
// Only `TextDecoder`/`Uint8Array` are used so this runs identically in the
// browser and on the server (Node's `TextDecoder` ships with full ICU data
// by default, so "windows-1252" and "utf-16le"/"utf-16be" labels are
// supported there the same as in browsers).
export type CsvEncoding = "utf-8" | "windows-1252" | "utf-16le" | "utf-16be";

export type DecodedCsv = {
  content: string;
  encoding: CsvEncoding;
};

// Kept intentionally small and coarse so every call site can map each
// reason onto whatever user-facing error type/code it already had, rather
// than this module inventing new user-facing error surfaces.
export type CsvDecodeReason = "binary-content" | "invalid-encoding";

export class CsvDecodeError extends Error {
  constructor(
    readonly reason: CsvDecodeReason,
    message: string,
  ) {
    super(message);
    this.name = "CsvDecodeError";
  }
}

// Magic-byte prefixes for formats that are sometimes mistakenly renamed to
// .csv (zipped Office formats, legacy OLE Office formats, PDF, and common
// image formats). These are rejected outright before any text decoding is
// attempted.
const BINARY_SIGNATURES: ReadonlyArray<{
  readonly label: string;
  readonly bytes: readonly number[];
}> = [
  { label: "a ZIP/Office (xlsx/docx/zip)", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { label: "a ZIP/Office (xlsx/docx/zip)", bytes: [0x50, 0x4b, 0x05, 0x06] },
  { label: "a ZIP/Office (xlsx/docx/zip)", bytes: [0x50, 0x4b, 0x07, 0x08] },
  {
    label: "a legacy Office (xls/doc) OLE",
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  },
  { label: "a PDF", bytes: [0x25, 0x50, 0x44, 0x46] },
  {
    label: "a PNG image",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { label: "a JPEG image", bytes: [0xff, 0xd8, 0xff] },
  { label: "a GIF image", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { label: "a GIF image", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
];

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

const CONTROL_CHARACTER_INSPECT_LIMIT = 8192;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function hasExcessiveControlCharacters(content: string): boolean {
  const inspected = content.slice(0, CONTROL_CHARACTER_INSPECT_LIMIT);
  let controlCharacters = 0;
  for (const character of inspected) {
    const code = character.charCodeAt(0);
    if (isControlOrUnmappedCharacter(code)) controlCharacters += 1;
  }
  return (
    controlCharacters > Math.max(2, Math.floor(inspected.length * 0.005))
  );
}

// C0 controls (excluding tab/LF/CR) are a standard binary-content signal.
// The C1 range (U+0080-U+009F) is included too: a spec-compliant decoder
// (browsers) turns the 5 unassigned Windows-1252 byte values into the
// replacement character (caught separately below), but Node's ICU-backed
// TextDecoder instead passes those specific bytes through as literal C1
// control code points. Treating C1 controls as corruption signals makes
// genuinely-unassigned Windows-1252 bytes rejected consistently on both
// runtimes, even though the two runtimes reach that rejection through
// different signals (a replacement character vs. a raw C1 control).
function isControlOrUnmappedCharacter(code: number): boolean {
  if (code < 32) return ![9, 10, 13].includes(code);
  return code >= 0x80 && code <= 0x9f;
}

function stripBom(content: string): string {
  return content.replace(/^\uFEFF/, "");
}

/**
 * Decodes raw uploaded bytes into CSV text.
 *
 * Order of operations:
 * 1. Reject known binary file signatures outright (ZIP/Office, OLE, PDF,
 *    common image formats), regardless of extension/declared MIME type.
 * 2. If the bytes start with a UTF-16 BOM, decode as UTF-16 (LE/BE). This
 *    is the only form of UTF-16 support: detection is BOM-only and
 *    identical in the browser and on the server.
 * 3. Reject raw NUL bytes (a strong binary-content signal for anything
 *    that isn't UTF-16).
 * 4. Attempt strict UTF-8 decoding. If the bytes declare a UTF-8 BOM and
 *    strict decoding still fails, this is a corrupted UTF-8 file and no
 *    fallback is attempted.
 * 5. If strict UTF-8 decoding fails and there is no UTF-8 BOM, fall back to
 *    Windows-1252 (a common Excel re-save encoding), but only when the
 *    decoded text contains no replacement characters (undecodable bytes)
 *    and does not look like binary data (excessive control characters).
 */
export function decodeCsvBytes(bytes: Uint8Array): DecodedCsv {
  for (const signature of BINARY_SIGNATURES) {
    if (startsWith(bytes, signature.bytes)) {
      throw new CsvDecodeError(
        "binary-content",
        `The upload looks like ${signature.label} file, not a CSV.`,
      );
    }
  }

  const isUtf16Le = startsWith(bytes, UTF16LE_BOM);
  const isUtf16Be = !isUtf16Le && startsWith(bytes, UTF16BE_BOM);
  if (isUtf16Le || isUtf16Be) {
    const encoding: CsvEncoding = isUtf16Le ? "utf-16le" : "utf-16be";
    let content: string;
    try {
      content = stripBom(
        new TextDecoder(encoding, { fatal: true }).decode(bytes),
      );
    } catch {
      throw new CsvDecodeError(
        "invalid-encoding",
        "The upload declares UTF-16 but is not valid UTF-16 text.",
      );
    }
    if (content.includes("\u0000") || hasExcessiveControlCharacters(content)) {
      throw new CsvDecodeError(
        "binary-content",
        "The upload appears to contain binary data.",
      );
    }
    return { content, encoding };
  }

  if (bytes.includes(0)) {
    throw new CsvDecodeError(
      "binary-content",
      "Binary upload content is not supported.",
    );
  }

  const hasUtf8Bom = startsWith(bytes, UTF8_BOM);
  try {
    const content = stripBom(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (hasExcessiveControlCharacters(content)) {
      throw new CsvDecodeError(
        "binary-content",
        "The upload appears to contain binary data.",
      );
    }
    return { content, encoding: "utf-8" };
  } catch (error) {
    if (error instanceof CsvDecodeError) throw error;
    if (hasUtf8Bom) {
      throw new CsvDecodeError(
        "invalid-encoding",
        "The upload declares UTF-8 but is not valid UTF-8 text.",
      );
    }
    // Windows-1252 never raises on decode (every byte value maps to some
    // code point or the replacement character), so validate the result
    // explicitly instead of relying on a thrown error.
    const fallback = new TextDecoder("windows-1252").decode(bytes);
    if (fallback.includes("\uFFFD")) {
      throw new CsvDecodeError(
        "invalid-encoding",
        "The upload is not valid UTF-8 or Windows-1252 text.",
      );
    }
    if (hasExcessiveControlCharacters(fallback)) {
      throw new CsvDecodeError(
        "binary-content",
        "The upload appears to contain binary data.",
      );
    }
    return { content: fallback, encoding: "windows-1252" };
  }
}
