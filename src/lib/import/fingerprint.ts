import { createHash } from "node:crypto";
import type { ProposedImportFlight, VersionedFingerprint } from "./types";

export const FILE_FINGERPRINT_VERSION = 1 as const;
export const ROW_FINGERPRINT_VERSION = 2 as const;
export const ACCEPTED_DUPLICATE_FINGERPRINT_VERSION = 1 as const;

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

export function createRowFingerprint(
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

  const identity = normalize(flight.flightNumber) || normalize(flight.registration);
  const version = matches.length === 2 ? 1 : ROW_FINGERPRINT_VERSION;
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

export function createAcceptedDuplicateFingerprint(
  userId: string,
  rowId: string,
  fingerprint: VersionedFingerprint,
): VersionedFingerprint {
  return {
    algorithm: "sha256",
    version: ACCEPTED_DUPLICATE_FINGERPRINT_VERSION,
    value: digest([
      `flight-map:accepted-duplicate:v${ACCEPTED_DUPLICATE_FINGERPRINT_VERSION}`,
      userId,
      rowId,
      fingerprint.value,
    ]),
  };
}
