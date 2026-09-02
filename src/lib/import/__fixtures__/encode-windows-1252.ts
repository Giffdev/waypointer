// Test-only helper for constructing genuine Windows-1252 byte fixtures.
// Node/browsers ship a `TextDecoder` for "windows-1252" but no matching
// `TextEncoder` (the WHATWG Encoding Standard only requires decoders for
// legacy encodings), so tests that need real Windows-1252 bytes (e.g. an
// Excel re-save of a UTF-8 MyFlightbook export) build them from a small
// reverse-mapping table instead.
//
// Supports plain ASCII (0x00-0x7F), the Latin-1 supplement range
// (0xA0-0xFF, where Windows-1252 code points equal their byte values), and
// the standard Windows-1252 0x80-0x9F block (smart quotes, dashes, etc.).
// Throws for any character outside that set so a test fixture never
// silently encodes something other than what it says it does.
const WINDOWS_1252_C1_BLOCK: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // ‘
  [0x2019, 0x92], // ’
  [0x201c, 0x93], // “
  [0x201d, 0x94], // ”
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
]);

export function encodeWindows1252(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f || (codePoint >= 0xa0 && codePoint <= 0xff)) {
      bytes.push(codePoint);
      continue;
    }
    const mapped = WINDOWS_1252_C1_BLOCK.get(codePoint);
    if (mapped === undefined) {
      throw new Error(
        `encodeWindows1252: unsupported character U+${codePoint.toString(16)}`,
      );
    }
    bytes.push(mapped);
  }
  return new Uint8Array(bytes);
}
