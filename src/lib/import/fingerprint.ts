import { createHash } from "node:crypto";
import { landingAirportIdsOf } from "./invariants";
import type { ProposedImportFlight, VersionedFingerprint } from "./types";

export const FILE_FINGERPRINT_VERSION = 1 as const;
export const ROW_FINGERPRINT_VERSION = 3 as const;
export const SOURCE_ROW_KEY_VERSION = 1 as const;

/**
 * Accepted-duplicate digests are versioned in a reserved high range.
 *
 * `flights.fingerprint_version` has exactly one job: say which algorithm
 * produced the digest stored beside it. A deliberately-accepted duplicate's
 * digest is **not** a row fingerprint — it is derived from one, keyed by the
 * import row id — so stamping it with the row-fingerprint version made the
 * column state something false, and the adoption chain (which reads
 * `version < ROW_FINGERPRINT_VERSION` as "superseded row algorithm") had no
 * way to tell the two apart.
 *
 * Reserving 1000+ keeps a single integer column honest for both families:
 * an accepted-duplicate version can never be mistaken for a row version, and
 * can never drift into the range as row versions increment.
 */
export const ACCEPTED_DUPLICATE_FINGERPRINT_VERSION_BASE = 1000 as const;
const ACCEPTED_DUPLICATE_FINGERPRINT_ALGORITHM_VERSION = 1 as const;
export const ACCEPTED_DUPLICATE_FINGERPRINT_VERSION =
  (ACCEPTED_DUPLICATE_FINGERPRINT_VERSION_BASE +
    ACCEPTED_DUPLICATE_FINGERPRINT_ALGORITHM_VERSION) as 1001;

export function isAcceptedDuplicateFingerprintVersion(
  version: number,
): boolean {
  return version >= ACCEPTED_DUPLICATE_FINGERPRINT_VERSION_BASE;
}

function digest(parts: Array<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u001f");
  }
  return hash.digest("hex");
}

function normalize(value: string | undefined): string {
  return value?.trim().toUpperCase().replace(/\s+/g, " ") ?? "";
}

export function createFileFingerprint(
  userId: string,
  content: string | Uint8Array,
): VersionedFingerprint {
  return {
    algorithm: "sha256",
    version: FILE_FINGERPRINT_VERSION,
    value: digest([
      `flight-map:file:v${FILE_FINGERPRINT_VERSION}`,
      userId,
      content,
    ]),
  };
}

/**
 * The identity-defining fields of one source record.
 *
 * Deliberately a *projection*, not the raw cells. Hashing every cell made the
 * key depend on columns that have nothing to do with which flight the row is:
 * a provider adding a `Route` or `PIC` column, or the pilot fixing a typo in
 * `Remarks`, changed the digest, and a blank-departure-time row whose v3
 * fingerprint embeds that digest then looked like a brand-new flight on the
 * next import. The projection is the answer to "which flight does this row
 * describe", and nothing else.
 */
export type SourceRowIdentityProjection = {
  date?: string;
  departureTime?: string;
  arrivalTime?: string;
  originIdentifier?: string;
  destinationIdentifier?: string;
  /** Ordered explicit stop identifiers when the source supplies a sequence. */
  airportIdentifiers?: readonly string[];
  flightNumber?: string;
  registration?: string;
  /**
   * The source's own verbatim aircraft cell (ForeFlight `AircraftID`,
   * FR24 model, generic mapped column) — never a value resolved out of a
   * secondary lookup table in the same export.
   *
   * ForeFlight's flight rows carry an `AircraftID`; the human-readable name
   * and type code live in a separate Aircraft Table earlier in the file.
   * Projecting the *resolved* display name made a type-code edit in that
   * table change the identity of every flight flown in that aircraft, so the
   * next import of the same logbook recognised none of its own rows and
   * committed a duplicate of each one.
   */
  aircraft?: string;
};

const SOURCE_ROW_IDENTITY_FIELDS = [
  "date",
  "departureTime",
  "arrivalTime",
  "originIdentifier",
  "destinationIdentifier",
  "flightNumber",
  "registration",
  "aircraft",
] as const;

function normalizeIdentityCell(value: string | undefined): string {
  return value?.trim().toUpperCase().replace(/\s+/g, " ") ?? "";
}

/** Content hash of one source record's identity projection, position-independent. */
export function createSourceRowIdentity(
  projection: SourceRowIdentityProjection,
): string {
  return createHash("sha256")
    .update(
      [
        ...SOURCE_ROW_IDENTITY_FIELDS.map((field) =>
          normalizeIdentityCell(projection[field]),
        ),
        (projection.airportIdentifiers ?? [])
          .map(normalizeIdentityCell)
          .join(">"),
      ].join("\u001f"),
    )
    .digest("hex");
}

/**
 * Stable identity for one source row.
 *
 * The predecessor was `` `${adapterVersion}:${sourceRowNumber}` `` — an
 * ordinal, which shifts the moment a re-export inserts a row above it, so a
 * re-export of the same logbook looked like an entirely new set of rows.
 * This is projection-addressed plus a 1-based occurrence counter among rows
 * that share the same projection within the same file, so it:
 *
 * - is identical when the same file is imported again,
 * - is identical when an unrelated row is inserted above it,
 * - is identical when a non-identity cell or column changes, and
 * - still distinguishes two otherwise-identical rows deterministically.
 */
export function createSourceRowKey(input: {
  userId: string;
  adapterId: string;
  rowIdentity: string;
  occurrence: number;
}): string {
  return digest([
    `flight-map:srk:v${SOURCE_ROW_KEY_VERSION}`,
    input.userId,
    input.adapterId,
    input.rowIdentity,
    String(input.occurrence),
  ]);
}

/**
 * Assigns a `sourceRowKey` to every record of a file in one pass, keyed by
 * source row number so callers never depend on iteration order.
 *
 * Occurrence numbering follows source order, so it must be given every record
 * in the file — handing it a filtered subset would renumber the survivors.
 */
export function assignSourceRowKeys(
  userId: string,
  adapterId: string,
  records: ReadonlyArray<{
    rowNumber: number;
    projection: SourceRowIdentityProjection;
  }>,
): Map<number, string> {
  const occurrences = new Map<string, number>();
  const byRowNumber = new Map<number, string>();
  for (const record of [...records].sort(
    (left, right) => left.rowNumber - right.rowNumber,
  )) {
    const rowIdentity = createSourceRowIdentity(record.projection);
    const occurrence = (occurrences.get(rowIdentity) ?? 0) + 1;
    occurrences.set(rowIdentity, occurrence);
    byRowNumber.set(
      record.rowNumber,
      createSourceRowKey({ userId, adapterId, rowIdentity, occurrence }),
    );
  }
  return byRowNumber;
}

/**
 * Row fingerprint v3 — the dedupe key written to `flights.fingerprint`.
 *
 * Two rules carry the whole design:
 *
 * 1. **`sourceRowKey` is appended if and only if `departureTime` is blank.**
 *    Blank-time rows are exactly the collision class: several same-day legs
 *    over the same route with no departure time produced one digest, the
 *    unique index on `(user_id, fingerprint)` enforced the collapse
 *    physically, and the extra flights vanished with no user-visible notice.
 *    Including the source-row key makes distinct source rows distinct while
 *    keeping the value *identical* on reimport of that same row, so
 *    cross-batch exact reimport detection is preserved. Timed rows keep a
 *    content-only key, so the same flight logged in two providers still
 *    collapses.
 *
 * 2. **Only landing stops feed identity.** Route waypoints are excluded, so
 *    the classifier is not identity-affecting: adding, removing, or
 *    re-resolving waypoints on thousands of flights can never manufacture or
 *    collapse one. The only route operation that moves identity is an
 *    explicit user `mark-landing`.
 */
export function createRowFingerprint(
  userId: string,
  flight: ProposedImportFlight,
  sourceRowKey?: string,
): VersionedFingerprint | undefined {
  const landingIds = landingAirportIdsOf(flight);
  if (!flight.date || landingIds.length < 2) return undefined;

  const identity =
    normalize(flight.flightNumber) || normalize(flight.registration);
  const departureTime = normalize(flight.departureTime);
  const blankTime = departureTime === "";
  const version = ROW_FINGERPRINT_VERSION;
  return {
    algorithm: "sha256",
    version,
    value: digest([
      `flight-map:row:v${version}`,
      userId,
      flight.date.slice(0, 10),
      blankTime ? "\u2205" : departureTime,
      landingIds.join(">"),
      identity,
      flight.kind,
      ...(blankTime && sourceRowKey ? [sourceRowKey] : []),
    ]),
  };
}

export function createAcceptedDuplicateFingerprint(
  userId: string,
  rowId: string,
  fingerprint: VersionedFingerprint,
): VersionedFingerprint {
  return {
    algorithm: "sha256",
    version: ACCEPTED_DUPLICATE_FINGERPRINT_VERSION,
    value: digest([
      `flight-map:accepted-duplicate:v${ACCEPTED_DUPLICATE_FINGERPRINT_ALGORITHM_VERSION}`,
      userId,
      rowId,
      fingerprint.value,
    ]),
  };
}

export {
  createLegacyRowFingerprint,
  LEGACY_ROW_FINGERPRINT_VERSION,
} from "./fingerprint-legacy";
