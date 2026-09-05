import type {
  ImportDuplicateCandidate,
  ProposedImportFlight,
  StoredImportRow,
  VersionedFingerprint,
} from "./types";
import {
  isAcceptedDuplicateFingerprintVersion,
  ROW_FINGERPRINT_VERSION,
} from "./fingerprint";

export const DUPLICATE_RULE_VERSION = 2 as const;
export const DUPLICATE_SCORE_THRESHOLD = 0.7;

export type ExistingFingerprintCandidate = {
  flightId: string;
  fingerprint: VersionedFingerprint;
  /** Content-addressed identity of the source row this flight came from. */
  sourceRowKey?: string;
  flight?: ProposedImportFlight;
};

type Candidate = {
  scope: ImportDuplicateCandidate["scope"];
  candidateId: string;
  flight: ProposedImportFlight;
  fingerprint?: VersionedFingerprint;
  sourceRowKey?: string;
};

export function applyDuplicateCandidates(
  rows: StoredImportRow[],
  existing: ExistingFingerprintCandidate[],
): StoredImportRow[] {
  const staged: Candidate[] = [];
  return rows.map((row) => {
    if (!row.commitReady) {
      return { ...row, duplicateCandidate: undefined };
    }
    const candidates: Candidate[] = [
      ...existing.flatMap((candidate) =>
        candidate.flight
          ? [{
              scope: "existing-flight" as const,
              candidateId: candidate.flightId,
              flight: candidate.flight,
              fingerprint: candidate.fingerprint,
              sourceRowKey: candidate.sourceRowKey,
            }]
          : identityMatch(row, candidate)
            ? [{
                scope: "existing-flight" as const,
                candidateId: candidate.flightId,
                flight: row.proposedFlight,
                fingerprint: candidate.fingerprint,
                sourceRowKey: candidate.sourceRowKey,
              }]
            : [],
      ),
      ...staged,
    ];
    const duplicateCandidate = bestCandidate(row, candidates);
    staged.push({
      scope: "staged-row",
      candidateId: row.id,
      flight: row.proposedFlight,
      fingerprint: row.rowFingerprint,
    });
    return {
      ...row,
      validationState: duplicateCandidate
        ? "duplicate"
        : baseValidationState(row),
      duplicateCandidate,
    };
  });
}

function isSupersededRowFingerprint(
  fingerprint: VersionedFingerprint | undefined,
): boolean {
  if (!fingerprint) return false;
  // Accepted-duplicate digests live above the reserved base and are *not*
  // superseded row fingerprints. Comparing on `< ROW_FINGERPRINT_VERSION`
  // alone happens to exclude them today only because the base is larger;
  // saying so explicitly keeps that true if either number moves.
  if (isAcceptedDuplicateFingerprintVersion(fingerprint.version)) return false;
  return fingerprint.version < ROW_FINGERPRINT_VERSION;
}

/**
 * The adoption chain, in priority order: current fingerprint, then source-row
 * key, then a superseded fingerprint version. A hit on any key means "this is
 * the same flight" — the import adopts the existing row rather than
 * manufacturing a second one.
 */
function identityMatch(
  row: StoredImportRow,
  candidate: ExistingFingerprintCandidate,
): boolean {
  if (row.rowFingerprint?.value === candidate.fingerprint.value) return true;
  if (
    row.provenance?.sourceRowKey &&
    candidate.sourceRowKey === row.provenance.sourceRowKey
  ) {
    return true;
  }
  return Boolean(
    row.legacyRowFingerprint &&
      isSupersededRowFingerprint(candidate.fingerprint) &&
      candidate.fingerprint.value === row.legacyRowFingerprint.value,
  );
}

function sameSourceRow(row: StoredImportRow, candidate: Candidate): boolean {
  return Boolean(
    row.provenance?.sourceRowKey &&
      candidate.sourceRowKey === row.provenance.sourceRowKey,
  );
}

function bestCandidate(
  row: StoredImportRow,
  candidates: Candidate[],
): ImportDuplicateCandidate | undefined {
  const assessed = candidates
    .map((candidate) => assessCandidate(row, candidate))
    .filter(
      (candidate): candidate is ImportDuplicateCandidate =>
        Boolean(candidate && candidate.score >= DUPLICATE_SCORE_THRESHOLD),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.scope.localeCompare(right.scope),
    );
  const selected = assessed[0];
  if (!selected) return undefined;
  const previous = row.duplicateCandidate;
  return {
    ...selected,
    resolution:
      previous?.candidateId === selected.candidateId &&
      previous.ruleVersion === selected.ruleVersion
        ? previous.resolution
        : "pending",
  };
}

function assessCandidate(
  row: StoredImportRow,
  candidate: Candidate,
): ImportDuplicateCandidate | undefined {
  const signals: ImportDuplicateCandidate["signals"] = [];
  const flight = row.proposedFlight;
  if (
    row.rowFingerprint &&
    candidate.fingerprint?.value === row.rowFingerprint.value
  ) {
    signals.push({
      code: "exact-fingerprint",
      weight: 1,
      detail: "The versioned canonical fingerprint is identical.",
    });
  } else if (sameSourceRow(row, candidate)) {
    // Adoption key 2. A re-export of the same logbook re-emits the same source
    // row; its content-addressed key is unchanged even if its time, its
    // ordinal, or its route text moved. Matching here is what makes the
    // re-import *update* the existing flight instead of adding a second copy.
    signals.push({
      code: "exact-fingerprint",
      weight: 1,
      detail: "This is the same source row as an already-imported flight.",
    });
  } else if (
    row.legacyRowFingerprint &&
    isSupersededRowFingerprint(candidate.fingerprint) &&
    candidate.fingerprint?.value === row.legacyRowFingerprint.value
  ) {
    // Adoption key 3. Flights committed before v3 carry a v1/v2 digest that a
    // v3 row can never equal. Without this branch, the first re-import after
    // the identity fix would duplicate the user's entire history — the fix
    // itself would be the data-loss event.
    signals.push({
      code: "exact-fingerprint",
      weight: 1,
      detail:
        "An earlier fingerprint version of this same flight is already imported.",
    });
  } else {
    // Route agreement is a hard gate, not one weighted signal among many.
    // Temporal and identity similarity alone (same-date .30 + near-time .10 +
    // same-tail .15 + same-aircraft/kind/role .05 x3) reaches the .70
    // duplicate threshold, so sequential same-day, same-tail legs to
    // *different* destinations (an S05 -> KRBG -> ... day) were withheld from
    // commit as ambiguous duplicates. Two flights that did not fly the same
    // ordered sequence of airports are never the same flight.
    //
    // Intended semantics of the gate (see route-dedupe.test.ts):
    // - the ordered stop sequences must match position for position, so a
    //   reversed route (A->B vs B->A) is not a duplicate;
    // - leg counts must match, so A->B is not a duplicate of A->B->C;
    // - a route that cannot be resolved to at least two airports never
    //   matches anything, including another unresolved route.
    if (!sameRoute(flight, candidate.flight)) return undefined;
    signals.push({
      code: "same-route",
      weight: 0.25,
      detail: "Origin and destination match.",
    });
    addSignal(
      signals,
      sameDay(flight.date, candidate.flight.date),
      "same-date",
      0.3,
      "Departure date matches.",
    );
    const timeDifference = minutesApart(
      flight.departureTime,
      candidate.flight.departureTime,
    );
    if (timeDifference === 0) {
      signals.push({
        code: "same-time",
        weight: 0.15,
        detail: "Departure time matches.",
      });
    } else if (timeDifference !== undefined && timeDifference <= 120) {
      signals.push({
        code: "near-time",
        weight: 0.1,
        detail: `Departure times are ${timeDifference} minutes apart.`,
      });
    }
    addSignal(
      signals,
      sameIdentity(flight, candidate.flight),
      "same-flight-identity",
      0.15,
      "Flight number or registration matches.",
    );
    addSignal(
      signals,
      sameText(
        flight.aircraft ?? flight.aircraftModel ?? flight.aircraftType,
        candidate.flight.aircraft ??
          candidate.flight.aircraftModel ??
          candidate.flight.aircraftType,
      ),
      "same-aircraft",
      0.05,
      "Aircraft description matches.",
    );
    addSignal(
      signals,
      flight.kind === candidate.flight.kind,
      "same-kind",
      0.05,
      "Flight kind matches.",
    );
    addSignal(
      signals,
      flight.role === candidate.flight.role,
      "same-role",
      0.05,
      "Traveler role matches.",
    );
  }
  const score = Number(
    Math.min(1, signals.reduce((sum, signal) => sum + signal.weight, 0)).toFixed(
      2,
    ),
  );
  if (score < DUPLICATE_SCORE_THRESHOLD) return undefined;
  return {
    scope: candidate.scope,
    candidateId: candidate.candidateId,
    score,
    ruleVersion: DUPLICATE_RULE_VERSION,
    explanation: signals.map((signal) => signal.detail).join(" "),
    signals,
    resolution: "pending",
  };
}

function addSignal(
  signals: ImportDuplicateCandidate["signals"],
  included: boolean,
  code: string,
  weight: number,
  detail: string,
): void {
  if (included) signals.push({ code, weight, detail });
}

function baseValidationState(
  row: StoredImportRow,
): StoredImportRow["validationState"] {
  return row.issues.some((issue) => issue.severity === "warning")
    ? "warning"
    : "ready";
}

function sameDay(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.slice(0, 10) === right.slice(0, 10));
}

function sameAirport(
  left: ProposedImportFlight["origin"],
  right: ProposedImportFlight["origin"],
): boolean {
  return Boolean(
    left?.status === "resolved" &&
      right?.status === "resolved" &&
      left.airportId === right.airportId,
  );
}

function sameRoute(
  left: ProposedImportFlight,
  right: ProposedImportFlight,
): boolean {
  const leftMatches = routeStops(left);
  const rightMatches = routeStops(right);
  // Fewer than two resolved stops is not a route: without this guard two
  // unresolved flights compare as equal empty sequences and every other
  // signal decides the outcome.
  if (leftMatches.length < 2 || rightMatches.length < 2) return false;
  return (
    leftMatches.length === rightMatches.length &&
    leftMatches.every((match, index) =>
      sameAirport(match, rightMatches[index]),
    )
  );
}

function routeStops(
  flight: ProposedImportFlight,
): Array<ProposedImportFlight["origin"]> {
  return flight.airportMatches && flight.airportMatches.length >= 2
    ? flight.airportMatches
    : flight.origin && flight.destination
      ? [flight.origin, flight.destination]
      : [];
}

function sameIdentity(
  left: ProposedImportFlight,
  right: ProposedImportFlight,
): boolean {
  return (
    sameText(left.flightNumber, right.flightNumber) ||
    sameText(left.registration, right.registration)
  );
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  return Boolean(
    left &&
      right &&
      left.trim().toUpperCase() === right.trim().toUpperCase(),
  );
}

function minutesApart(
  left: string | undefined,
  right: string | undefined,
): number | undefined {
  const leftMinutes = timeMinutes(left);
  const rightMinutes = timeMinutes(right);
  return leftMinutes === undefined || rightMinutes === undefined
    ? undefined
    : Math.abs(leftMinutes - rightMinutes);
}

function timeMinutes(value: string | undefined): number | undefined {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}
