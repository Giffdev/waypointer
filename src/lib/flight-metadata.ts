const SENTINEL_KEYS = new Set([
  "0",
  "na",
  "nil",
  "none",
  "null",
  "notapplicable",
  "notavailable",
  "notknown",
  "notspecified",
  "empty",
  "tbd",
  "unknown",
  "unspecified",
]);

const HUMAN_CHARACTER = new RegExp("[\\p{L}\\p{N}]", "u");

export type AircraftMetadataSource =
  | "explicit-model"
  | "explicit-type"
  | "source-identifier"
  | "untrusted";

function normalizeMetadataText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    normalized.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    !HUMAN_CHARACTER.test(normalized) ||
    /^0+(?:[.,]0+)?$/.test(normalized)
  ) {
    return undefined;
  }
  const sentinelKey = normalized
    .toLocaleLowerCase("en-US")
    .replace(/[\s./_()-]+/g, "");
  return SENTINEL_KEYS.has(sentinelKey) ? undefined : normalized;
}

export function normalizeAircraftMetadata(
  value: string | null | undefined,
  source: AircraftMetadataSource = "untrusted",
): string | undefined {
  if (source === "source-identifier") return undefined;
  return normalizeMetadataText(value);
}

export function normalizeRegistrationMetadata(
  value: string | null | undefined,
): string | undefined {
  return normalizeMetadataText(value);
}
