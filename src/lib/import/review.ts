import type {
  ImportIssue,
  ProposedImportFlight,
  StoredImportRow,
} from "./types";

export function isImportProposalCommitReady(
  flight: ProposedImportFlight,
  issues: ImportIssue[],
): boolean {
  const matches =
    flight.airportMatches && flight.airportMatches.length >= 2
      ? flight.airportMatches
      : flight.origin && flight.destination
        ? [flight.origin, flight.destination]
        : [];
  return Boolean(
    flight.date &&
      matches.length >= 2 &&
      matches.every((match) => match.status === "resolved") &&
      issues.every((issue) => issue.severity !== "error"),
  );
}

export function importProposalValidationState(
  flight: ProposedImportFlight,
  issues: ImportIssue[],
): StoredImportRow["validationState"] {
  if (
    issues.some((issue) => issue.severity === "error") ||
    !flight.date ||
    (!flight.airportMatches?.length && (!flight.origin || !flight.destination))
  ) {
    return "invalid";
  }
  const matches =
    flight.airportMatches && flight.airportMatches.length >= 2
      ? flight.airportMatches
      : [flight.origin!, flight.destination!];
  if (matches.some((match) => match.status === "ambiguous")) {
    return "ambiguous";
  }
  if (matches.some((match) => match.status === "not-found")) {
    return "unresolved";
  }
  return issues.some((issue) => issue.severity === "warning")
    ? "warning"
    : "ready";
}
