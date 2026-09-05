import { ImportInvariantError } from "./errors";
import type {
  ImportIssue,
  ImportRouteNode,
  ProposedImportFlight,
  StoredImportRow,
} from "./types";

/**
 * The one definition of a flight's route.
 *
 * "Which airports does this row commit?" used to be re-implemented in
 * `review.ts`, `dedupe.ts`, `service.ts`, and `drizzle-import-repository.ts`.
 * Four implementations meant four chances to drift, and one of them
 * (`resolvedAirportIds`) silently dropped unresolved stops so a flight could
 * commit with a leg missing. Everything now funnels through this module.
 *
 * The landing/waypoint boundary is enforced here, once:
 *
 * - `landingStopsOf` is the ONLY input to identity, statistics, and every
 *   airport-visit aggregate.
 * - `waypointStopsOf` is presentation-only and must never be imported by
 *   `flight-statistics.ts`, `route-aggregation.ts`, or the sharing snapshot.
 */

/** Maximum nodes on one flight's path, raw route text is never truncated. */
export const MAX_ROUTE_PATH_NODES = 32;

/**
 * Every ordered node, including tokens that are not airports.
 *
 * Rows persisted before `routeNodes` existed upgrade lazily: their stored
 * `airportMatches` (or `origin`/`destination`) are all landings by
 * construction, because nothing before this release could produce a waypoint.
 */
export function routeNodesOf(flight: ProposedImportFlight): ImportRouteNode[] {
  if (flight.routeNodes?.length) return flight.routeNodes;
  return legacyLandingNodes(flight);
}

/** `kind === "landing"` — the only input to identity and statistics. */
export function landingStopsOf(
  flight: ProposedImportFlight,
): Array<Extract<ImportRouteNode, { kind: "landing" }>> {
  return routeNodesOf(flight).filter(
    (node): node is Extract<ImportRouteNode, { kind: "landing" }> =>
      node.kind === "landing",
  );
}

/** `kind === "waypoint"` — presentation only. Never a statistic input. */
export function waypointStopsOf(
  flight: ProposedImportFlight,
): Array<Extract<ImportRouteNode, { kind: "waypoint" }>> {
  return routeNodesOf(flight).filter(
    (node): node is Extract<ImportRouteNode, { kind: "waypoint" }> =>
      node.kind === "waypoint",
  );
}

/** Ordered landing + waypoint nodes that carry a resolved airport. */
export function placedRouteNodesOf(
  flight: ProposedImportFlight,
): Array<Extract<ImportRouteNode, { kind: "landing" | "waypoint" }>> {
  return routeNodesOf(flight).filter(
    (
      node,
    ): node is Extract<ImportRouteNode, { kind: "landing" | "waypoint" }> =>
      node.kind !== "unmatched",
  );
}

/** Ordered landing airport ids, or `[]` when any landing is unresolved. */
export function landingAirportIdsOf(flight: ProposedImportFlight): string[] {
  const landings = landingStopsOf(flight);
  if (landings.some((node) => node.match.status !== "resolved")) return [];
  return landings.flatMap((node) =>
    node.match.status === "resolved" ? [node.match.airportId] : [],
  );
}

export type CommittableRoute = {
  landingIds: string[];
  pathNodes: Array<Extract<ImportRouteNode, { kind: "landing" | "waypoint" }>>;
  waypointIds: string[];
};

/**
 * Asserts the route a row is about to commit is complete.
 *
 * The predecessor (`resolvedAirportIds`) `flatMap`ped unresolved matches away
 * and the caller only checked `length >= 2`, so a dropped middle stop
 * committed silently and the pilot lost a leg. This throws instead: drift
 * becomes impossible rather than tolerated.
 */
export function assertCommittableRoute(
  flight: ProposedImportFlight,
): CommittableRoute {
  const landings = landingStopsOf(flight);
  const unresolved = landings.filter(
    (node) => node.match.status !== "resolved",
  );
  if (unresolved.length > 0) {
    throw new ImportInvariantError(
      "route-stop-unresolved",
      "Every landing airport must be resolved before a flight is committed.",
      { identifiers: unresolved.map((node) => node.identifier) },
    );
  }
  const landingIds = landings.flatMap((node) =>
    node.match.status === "resolved" ? [node.match.airportId] : [],
  );
  if (landingIds.length !== landings.length) {
    throw new ImportInvariantError(
      "route-stop-unresolved",
      "A landing stop was dropped while deriving the committed route.",
    );
  }
  if (landingIds.length < 2) {
    throw new ImportInvariantError(
      "route-stop-unresolved",
      "A committed flight requires at least two landing airports.",
    );
  }
  const pathNodes = placedRouteNodesOf(flight).filter(
    (node) => node.match.status === "resolved",
  );
  if (pathNodes.length > MAX_ROUTE_PATH_NODES) {
    throw new ImportInvariantError(
      "route-stop-invalid",
      `A flight path may contain at most ${MAX_ROUTE_PATH_NODES} airports.`,
    );
  }
  return {
    landingIds,
    pathNodes,
    waypointIds: pathNodes.flatMap((node) =>
      node.kind === "waypoint" && node.match.status === "resolved"
        ? [node.match.airportId]
        : [],
    ),
  };
}

/**
 * One node of a path offered for enrichment, already narrowed to a resolved
 * airport so callers cannot accidentally persist an unplaced token.
 */
export type EnrichableRouteStop = {
  identifier: string;
  airportId: string;
  kind: "landing" | "waypoint";
  sourceField: ImportRouteNode["sourceField"];
};

/**
 * The ordered path a staged row would persist, when — and only when — it adds
 * an overflown waypoint to a flight that already exists.
 *
 * Non-throwing on purpose. `assertCommittableRoute` is the commit path and is
 * allowed to fail an import; enrichment is an opportunistic repair of a flight
 * the user already has, so anything it cannot describe with total confidence
 * it declines to touch. Returns `undefined` unless every landing resolves,
 * the path is within `MAX_ROUTE_PATH_NODES`, and at least one resolved
 * waypoint is actually being contributed.
 */
export function enrichableRoutePath(
  flight: ProposedImportFlight,
): EnrichableRouteStop[] | undefined {
  const landings = landingStopsOf(flight);
  if (landings.length < 2) return undefined;
  if (landings.some((node) => node.match.status !== "resolved")) {
    return undefined;
  }
  const pathNodes = placedRouteNodesOf(flight).filter(
    (node) => node.match.status === "resolved",
  );
  if (pathNodes.length > MAX_ROUTE_PATH_NODES) return undefined;
  const path = pathNodes.flatMap((node) =>
    node.match.status === "resolved"
      ? [
          {
            identifier: node.identifier,
            airportId: node.match.airportId,
            kind: node.kind,
            sourceField: node.sourceField,
          },
        ]
      : [],
  );
  // A dropped landing would mean enriching a shorter route than the row
  // describes, so the path is only offered when it still carries every one.
  if (path.filter((stop) => stop.kind === "landing").length !== landings.length) {
    return undefined;
  }
  return path.some((stop) => stop.kind === "waypoint") ? path : undefined;
}

/**
 * The safety gate on enrichment: the path being offered must land at exactly
 * the same airports, in exactly the same order, as the flight already on
 * record.
 *
 * Identity, statistics, and every airport aggregate read the landing spine.
 * Requiring it to match position-for-position is what makes adding a waypoint
 * provably unable to move a single count — and what stops a near-miss
 * candidate from rewriting a different flight's route.
 */
export function matchesLandingSpine(
  path: readonly EnrichableRouteStop[],
  landingAirportIds: readonly string[],
): boolean {
  const offered = path.flatMap((stop) =>
    stop.kind === "landing" ? [stop.airportId] : [],
  );
  return (
    offered.length >= 2 &&
    offered.length === landingAirportIds.length &&
    offered.every((airportId, index) => airportId === landingAirportIds[index])
  );
}

/**
 * A row is committable when it has a date, at least two resolved **landing**
 * airports, and no error-severity issue. Unresolved *route* tokens are
 * warnings by construction, so they never block a commit.
 */
export function isImportProposalCommitReady(
  flight: ProposedImportFlight,
  issues: ImportIssue[],
): boolean {
  const landings = landingStopsOf(flight);
  return Boolean(
    flight.date &&
      landings.length >= 2 &&
      landings.every((node) => node.match.status === "resolved") &&
      issues.every((issue) => issue.severity !== "error"),
  );
}

export function importProposalValidationState(
  flight: ProposedImportFlight,
  issues: ImportIssue[],
): StoredImportRow["validationState"] {
  const landings = landingStopsOf(flight);
  if (
    issues.some((issue) => issue.severity === "error") ||
    !flight.date ||
    landings.length < 2
  ) {
    return "invalid";
  }
  if (landings.some((node) => node.match.status === "ambiguous")) {
    return "ambiguous";
  }
  if (landings.some((node) => node.match.status === "not-found")) {
    return "unresolved";
  }
  return issues.some((issue) => issue.severity === "warning")
    ? "warning"
    : "ready";
}

/**
 * Landings-only projection of the canonical path. `origin`, `destination`,
 * `airportIdentifiers`, and `airportMatches` are derived from this, so every
 * legacy consumer stays landings-only by construction.
 */
export function withDerivedLandingProjection(
  flight: ProposedImportFlight,
): ProposedImportFlight {
  const nodes = flight.routeNodes;
  if (!nodes?.length) return flight;
  const landings = nodes.filter((node) => node.kind === "landing");
  if (landings.length === 0) return flight;
  const matches = landings.map((node) => node.match);
  return {
    ...flight,
    origin: matches[0],
    destination: matches.at(-1),
    originIdentifier: matches[0]?.identifier,
    destinationIdentifier: matches.at(-1)?.identifier,
    airportIdentifiers: matches.map(({ identifier }) => identifier),
    airportMatches: matches,
  };
}

function legacyLandingNodes(
  flight: ProposedImportFlight,
): ImportRouteNode[] {
  const matches =
    flight.airportMatches && flight.airportMatches.length >= 2
      ? flight.airportMatches
      : flight.origin && flight.destination
        ? [flight.origin, flight.destination]
        : [];
  return matches.map((match, index) => ({
    kind: "landing" as const,
    identifier: match.identifier,
    match,
    // Intermediates are `endpoint`, not `route`. They came from an explicit
    // airport-sequence column, and migration 0018 backfills every pre-existing
    // stop as `endpoint`; calling them `route` here would make the same stop
    // read differently before and after a reimport, and would imply a landing
    // was inferred from route text — which is precisely what this design
    // forbids.
    sourceField:
      index === 0
        ? ("From" as const)
        : index === matches.length - 1
          ? ("To" as const)
          : ("endpoint" as const),
    tokenIndex: index,
  }));
}
