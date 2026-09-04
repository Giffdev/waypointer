import type { AirportRepository } from "@/lib/db/repositories/airport-repository";
import type { FlightRepository } from "@/lib/db/repositories/flight-repository";
import type { ImportRepository } from "@/lib/db/repositories/import-repository";
import { applyDuplicateCandidates } from "./dedupe";
import { createRowFingerprint } from "./fingerprint";
import {
  importProposalValidationState,
  isImportProposalCommitReady,
  withDerivedLandingProjection,
} from "./invariants";
import { automaticallyCompleteReviewBatch } from "./service";
import type {
  ImportAirportMatch,
  ImportRouteNode,
  StoredImportRow,
} from "./types";

export type AirportReconciliationCandidate = {
  userId: string;
  batchId: string;
};

export type AirportReconciliationCounts = {
  scanned: number;
  resolved: number;
  ambiguous: number;
  unknown: number;
  completed: number;
  conflicts: number;
};

type ReconciliationRepositories = {
  imports: ImportRepository;
  flights: FlightRepository;
  airports: AirportRepository;
};

export async function reconcileUnresolvedAirportImports(
  candidates: AirportReconciliationCandidate[],
  repositories: ReconciliationRepositories,
): Promise<AirportReconciliationCounts> {
  const counts: AirportReconciliationCounts = {
    scanned: 0,
    resolved: 0,
    ambiguous: 0,
    unknown: 0,
    completed: 0,
    conflicts: 0,
  };
  const uniqueCandidates = new Map(
    candidates.map((candidate) => [
      `${candidate.userId}:${candidate.batchId}`,
      candidate,
    ]),
  );

  for (const { userId, batchId } of uniqueCandidates.values()) {
    // Narrow reads on purpose: the airport catalog release runs this against a
    // database pinned to an older migration boundary, so reading whole rows
    // would couple the release to every column the application later adds.
    const [batch, rows] = await Promise.all([
      repositories.imports.getReviewBatchState(userId, batchId),
      repositories.imports.getRowsForCommit(userId, batchId),
    ]);
    if (!batch || batch.status !== "review" || !rows) continue;

    const changedRows: StoredImportRow[] = [];
    for (const row of rows) {
      if (row.decision !== "pending") continue;
      const reconciled = await reconcileRow(userId, row, repositories.airports);
      counts.scanned += reconciled.scanned;
      counts.resolved += reconciled.resolved;
      counts.ambiguous += reconciled.ambiguous;
      counts.unknown += reconciled.unknown;
      if (reconciled.changed) changedRows.push(reconciled.row);
    }
    if (changedRows.length === 0) continue;

    const existing = await repositories.flights.findDuplicateCandidates(
      userId,
      changedRows,
    );
    const rescored = applyDuplicateCandidates(changedRows, existing);
    const replacements = new Map(rescored.map((row) => [row.id, row]));
    const updatedRows = rows.map((row) => replacements.get(row.id) ?? row);
    try {
      await repositories.imports.replaceReviewRows(
        userId,
        batchId,
        updatedRows,
        batch.updatedAt,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Import batch changed during reconciliation"
      ) {
        counts.conflicts += 1;
        continue;
      }
      throw error;
    }

    const completed = await automaticallyCompleteReviewBatch(
      userId,
      batchId,
      false,
      repositories.imports,
      repositories.flights,
    );
    if (completed.status === "committed") counts.completed += 1;
  }

  return counts;
}

async function reconcileRow(
  userId: string,
  row: StoredImportRow,
  airports: AirportRepository,
): Promise<{
  row: StoredImportRow;
  changed: boolean;
  scanned: number;
  resolved: number;
  ambiguous: number;
  unknown: number;
}> {
  const proposedFlight = structuredClone(row.proposedFlight);
  const correctedFields = new Set(
    (row.corrections ?? []).map((correction) => correction.field),
  );
  let changed = false;
  let scanned = 0;
  let resolved = 0;
  let ambiguous = 0;
  let unknown = 0;

  const retry = async (
    match: ImportAirportMatch | undefined,
    identifier: string | undefined,
    correctionField: `route[${number}]` | "origin" | "destination",
  ): Promise<ImportAirportMatch | undefined> => {
    if (
      !match ||
      match.status !== "not-found" ||
      correctedFields.has(correctionField)
    ) {
      return match;
    }
    scanned += 1;
    const result = await airports.resolveIdentifier(
      userId,
      identifier ?? match.identifier,
    );
    if (result.status === "resolved") resolved += 1;
    else if (result.status === "ambiguous") ambiguous += 1;
    else unknown += 1;
    if (result.status !== match.status) changed = true;
    return result;
  };

  if (proposedFlight.routeNodes?.length) {
    // Route nodes are the canonical path, so reconcile them and derive the
    // legacy `origin`/`destination`/`airportMatches` projection from the
    // result. Patching only the projection would leave the nodes stale, and
    // every commit-readiness check reads the nodes.
    const nodes: ImportRouteNode[] = [];
    for (const [position, node] of proposedFlight.routeNodes.entries()) {
      if (node.kind === "unmatched") {
        nodes.push(node);
        continue;
      }
      const match = await retry(
        node.match,
        node.identifier,
        node.kind === "landing" && node.sourceField === "From"
          ? "origin"
          : node.kind === "landing" && node.sourceField === "To"
            ? "destination"
            : `route[${node.tokenIndex ?? position}]`,
      );
      nodes.push({ ...node, match: match ?? node.match });
    }
    proposedFlight.routeNodes = nodes;
    const reconciled = withDerivedLandingProjection(proposedFlight);
    proposedFlight.origin = reconciled.origin;
    proposedFlight.destination = reconciled.destination;
    proposedFlight.airportMatches = reconciled.airportMatches;
    proposedFlight.airportIdentifiers = reconciled.airportIdentifiers;
  } else if (
    proposedFlight.airportMatches &&
    proposedFlight.airportMatches.length >= 2
  ) {
    const identifiers =
      proposedFlight.airportIdentifiers ??
      proposedFlight.airportMatches.map((match) => match.identifier);
    proposedFlight.airportMatches = await Promise.all(
      proposedFlight.airportMatches.map((match, index) =>
        retry(match, identifiers[index], `route[${index}]`),
      ),
    ) as ImportAirportMatch[];
    proposedFlight.origin = proposedFlight.airportMatches[0];
    proposedFlight.destination = proposedFlight.airportMatches.at(-1);
  } else {
    proposedFlight.origin = await retry(
      proposedFlight.origin,
      proposedFlight.originIdentifier,
      "origin",
    );
    proposedFlight.destination = await retry(
      proposedFlight.destination,
      proposedFlight.destinationIdentifier,
      "destination",
    );
  }

  if (!changed) {
    return { row, changed, scanned, resolved, ambiguous, unknown };
  }
  const commitReady = isImportProposalCommitReady(
    proposedFlight,
    row.issues,
  );
  return {
    row: {
      ...row,
      proposedFlight,
      validationState: importProposalValidationState(
        proposedFlight,
        row.issues,
      ),
      commitReady,
      rowFingerprint: commitReady
        ? createRowFingerprint(userId, proposedFlight)
        : undefined,
      duplicateCandidate: undefined,
    },
    changed,
    scanned,
    resolved,
    ambiguous,
    unknown,
  };
}
