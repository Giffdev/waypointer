import { createHash } from "node:crypto";
import type { ProposedImportFlight, VersionedFingerprint } from "./types";

/**
 * The pre-v3 row fingerprint, frozen verbatim.
 *
 * Flights committed before the identity fix carry a v1 or v2 digest. The
 * adoption chain (`findDuplicateCandidates`) recognises them by recomputing
 * this exact function, so a reimport after deploy **adopts** the existing
 * flight instead of inserting a duplicate. It is snapshot-tested against
 * fixed digests and must never be modified again — any change here silently
 * duplicates every historical flight on the next reimport.
 *
 * @see fingerprint.ts for the current version.
 */

export const LEGACY_ROW_FINGERPRINT_VERSION = 2 as const;

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

export function createLegacyRowFingerprint(
  userId: string,
  flight: ProposedImportFlight,
): VersionedFingerprint | undefined {
  const matches =
    flight.airportMatches && flight.airportMatches.length >= 2
      ? flight.airportMatches
      : flight.origin && flight.destination
        ? [flight.origin, flight.destination]
        : [];
  if (
    !flight.date ||
    matches.length < 2 ||
    matches.some((match) => match.status !== "resolved")
  ) {
    return undefined;
  }

  const identity =
    normalize(flight.flightNumber) || normalize(flight.registration);
  const version = matches.length === 2 ? 1 : LEGACY_ROW_FINGERPRINT_VERSION;
  const routeParts =
    matches.length === 2
      ? matches.map((match) =>
          match.status === "resolved" ? match.airportId : "",
        )
      : [
          matches
            .map((match) =>
              match.status === "resolved" ? match.airportId : "",
            )
            .join(">"),
        ];
  return {
    algorithm: "sha256",
    version,
    value: digest([
      `flight-map:row:v${version}`,
      userId,
      flight.date.slice(0, 10),
      normalize(flight.departureTime),
      ...routeParts,
      identity,
      flight.kind,
    ]),
  };
}
