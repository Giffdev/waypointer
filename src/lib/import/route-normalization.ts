import {
  AIRPORT_ROUTE_NAMESPACE_TYPES,
  type ImportAirportMatch,
  type ImportIssue,
  type ImportRouteNode,
  type ImportRouteRejection,
  type ImportRouteRejectionReason,
} from "./types";
import { MAX_ROUTE_PATH_NODES } from "./invariants";
import { ImportInvariantError } from "./errors";

/**
 * The route classifier.
 *
 * **Scope, stated exactly.** Only the ForeFlight adapter calls this today,
 * because ForeFlight is the only supported source with a free-text `Route`
 * column. Generic/mapped CSV imports are untouched: their multi-airport
 * columns are explicit airport-sequence fields, they continue to produce
 * *landings*, and nothing here reclassifies them. Silently promoting existing
 * generic route tokens to waypoints would change the meaning of stops already
 * committed — and therefore statistics and shares — with no migration and no
 * preview, so it does not happen. Extending this to another provider is a
 * deliberate migration, not a side effect of adding a call site.
 *
 * It answers exactly one question — *is this token an airport we can place on
 * a map?* — and its answer is **never** consulted for landing semantics. A
 * classifier can be confident that `KRBG` is an airport. Nothing in a route
 * string can tell it whether the aircraft touched down there, so the system
 * never guesses: only an explicit source endpoint/landing field, or a
 * deliberate user action, produces a landing.
 *
 * Nothing is discarded. Tokens that are not airports survive as
 * `kind: "unmatched"` nodes in their original position and verbatim in the
 * stored raw route text, with no marker, no geocoding, and no claim about
 * what they are.
 */

/** Tokenizer separators; `/` appears in ForeFlight route text. */
export const ROUTE_TOKEN_SEPARATOR = /\s*(?:->|→|>|,|;|\||\/)\s*|\s+/;

const STRUCTURAL_TOKENS = new Set([
  "DCT",
  "GPS",
  "VFR",
  "IFR",
  "SID",
  "STAR",
  "RNAV",
  "ETA",
  "TBD",
]);

const AIRWAY = /^[VJQTAB]\d{1,3}$/;
/**
 * Five-character idents are safe to reject outright: ICAO is a four-character
 * namespace and `resolveIdentifier` never reaches an airport through a
 * name/keyword path, so a five-letter token can only be an RNAV fix.
 */
const NAV_FIX_SHAPE = /^[A-Z]{5}$/;
const BEARING_DISTANCE = /^[A-Z]{2,3}\d{6}$/;
const LATLON_SHAPE = /^\d{2,4}[NS]\d{3,5}[EW]$/;

export type RouteEndpointInput = {
  identifier?: string;
  match?: ImportAirportMatch;
  field: "From" | "To";
};

export type RouteResolver = (
  identifier: string,
) => Promise<ImportAirportMatch> | ImportAirportMatch;

export type NormalizeRouteInput = {
  /** Verbatim source route text; may be blank or absent. */
  routeRaw?: string;
  origin: RouteEndpointInput;
  destination: RouteEndpointInput;
  resolve: RouteResolver;
  maxNodes?: number;
};

export type NormalizedRoute = {
  nodes: ImportRouteNode[];
  rejections: ImportRouteRejection[];
  issues: ImportIssue[];
  routeRaw?: string;
};

export function tokenizeRoute(routeRaw: string | undefined): string[] {
  if (!routeRaw) return [];
  return routeRaw
    .trim()
    .toUpperCase()
    .split(ROUTE_TOKEN_SEPARATOR)
    .filter(Boolean);
}

/**
 * Stage 2 — shape rejection, run **before** any catalog lookup so a bad token
 * can never get a lucky hit.
 */
export function rejectRouteTokenShape(
  token: string,
): ImportRouteRejectionReason | undefined {
  if (STRUCTURAL_TOKENS.has(token)) return "structural-token";
  if (token.includes(".")) return "airway-or-procedure";
  if (AIRWAY.test(token)) return "airway-or-procedure";
  if (token.length < 2 || token.length > 8) return "nav-fix-shape";
  if (NAV_FIX_SHAPE.test(token)) return "nav-fix-shape";
  if (BEARING_DISTANCE.test(token)) return "nav-fix-shape";
  if (LATLON_SHAPE.test(token)) return "nav-fix-shape";
  return undefined;
}

/**
 * Stage 4 — the load-bearing rule. Accept a token only when the airport it
 * resolved to can be named by that token through an *airport* namespace.
 *
 * The set matters, not the winner. Alias priority ranks ICAO above IATA above
 * FAA-LID, so Boeing Field's `BFI` resolves through its IATA row even though
 * the identical code is also its FAA-LID. Judging the winning row alone
 * rejected that airport. Judging the whole set accepts `BFI` (IATA + FAA-LID)
 * and still rejects `OED` (Medford VOR's IATA code, IATA-only), which is the
 * collision the guard exists for.
 *
 * **Fails closed.** A resolved match with no namespaces is not evidence that
 * the token names an airport, it is evidence that the resolver did not say.
 * Treating that as "airport" turned the guard off for every token the moment
 * any resolver forgot to propagate the set — which is exactly the failure a
 * guard must not have. Legacy persisted matches are unaffected: this runs
 * only on freshly resolved staging output, never on stored rows.
 */
export function isAirportNamespaceMatch(match: ImportAirportMatch): boolean {
  if (match.status !== "resolved") return false;
  if (!match.matchedCodeTypes?.length) return false;
  return match.matchedCodeTypes.some((type) =>
    AIRPORT_ROUTE_NAMESPACE_TYPES.includes(type),
  );
}

export async function normalizeFlightRoute(
  input: NormalizeRouteInput,
): Promise<NormalizedRoute> {
  const maxNodes = input.maxNodes ?? MAX_ROUTE_PATH_NODES;
  const rejections: ImportRouteRejection[] = [];
  const issues: ImportIssue[] = [];
  const tokens = tokenizeRoute(input.routeRaw);

  const originNode = endpointNode(input.origin);
  const destinationNode = endpointNode(input.destination);

  const reject = (
    identifier: string,
    tokenIndex: number,
    reason: ImportRouteRejectionReason,
    candidates?: ImportRouteRejection["candidates"],
  ): Extract<ImportRouteNode, { kind: "unmatched" }> => {
    rejections.push({ identifier, tokenIndex, reason, ...(candidates ? { candidates } : {}) });
    // Every rejection the user could act on is disclosed. A namespace
    // rejection especially: silently discarding a token that *did* resolve to
    // an airport is indistinguishable, from the outside, from the classifier
    // never having seen it.
    const disclosure = {
      ambiguous: {
        code: "route-token-ambiguous" as const,
        message: `Route point "${identifier}" matches more than one airport, so it was kept as text instead of being placed on the map.`,
      },
      "not-found": {
        code: "route-token-unmatched" as const,
        message: `Route point "${identifier}" did not match an airport, so it was kept as text instead of being placed on the map.`,
      },
      "navaid-or-iata-collision": {
        code: "route-token-navaid-collision" as const,
        message: `Route point "${identifier}" looks like a navaid or airline code rather than an airport identifier, so it was kept as text instead of being placed on the map.`,
      },
    }[reason as string];
    if (disclosure) {
      issues.push({
        code: disclosure.code,
        field: `route[${tokenIndex}]`,
        message: disclosure.message,
        severity: "warning",
      });
    }
    return {
      kind: "unmatched",
      identifier,
      sourceField: "Route",
      tokenIndex,
      reason,
    };
  };

  // Stage 1-4: classify every token, in source order, keeping the ones we
  // cannot place as `unmatched` nodes rather than dropping them.
  const classified: ImportRouteNode[] = [];
  for (const [tokenIndex, token] of tokens.entries()) {
    const shapeRejection = rejectRouteTokenShape(token);
    if (shapeRejection) {
      classified.push(reject(token, tokenIndex, shapeRejection));
      continue;
    }
    const match = await input.resolve(token);
    if (match.status === "not-found") {
      classified.push(reject(token, tokenIndex, "not-found"));
      continue;
    }
    if (match.status === "ambiguous") {
      classified.push(
        reject(token, tokenIndex, "ambiguous", match.candidates),
      );
      continue;
    }
    if (!isAirportNamespaceMatch(match)) {
      classified.push(reject(token, tokenIndex, "navaid-or-iata-collision"));
      continue;
    }
    classified.push({
      kind: "waypoint",
      identifier: token,
      match,
      sourceField: "Route",
      tokenIndex,
    });
  }

  // Stage 5.1 — endpoint dedupe. Accepted airport tokens equal to `From`
  // while they lead, and equal to `To` while they trail, are dropped from the
  // path so a KMFR->KMFR round trip does not draw a doubled node on one
  // coordinate. The tokens stay in the raw text either way.
  const accepted = classified.filter(
    (node): node is Extract<ImportRouteNode, { kind: "waypoint" }> =>
      node.kind === "waypoint",
  );
  let lead = 0;
  while (
    lead < accepted.length &&
    sameAirport(accepted[lead].match, originNode?.match)
  ) {
    lead += 1;
  }
  let trail = accepted.length;
  while (
    trail > lead &&
    sameAirport(accepted[trail - 1].match, destinationNode?.match)
  ) {
    trail -= 1;
  }
  const boundaryDropped = new Set(
    [...accepted.slice(0, lead), ...accepted.slice(trail)].map(
      (node) => node.tokenIndex,
    ),
  );
  // Recorded as rejections in their own right, with their own reason. They
  // were previously reported as `adjacent-duplicate`, which is a different
  // fact about a different pair of tokens.
  for (const node of [...accepted.slice(0, lead), ...accepted.slice(trail)]) {
    rejections.push({
      identifier: node.identifier,
      tokenIndex: node.tokenIndex,
      reason: "endpoint-duplicate",
    });
  }
  let interior = accepted.slice(lead, trail);

  // Stage 5.3 — adjacent duplicates collapse with a warning rather than
  // voiding the route. A repeated point is a formatting artefact, not a
  // reason to lose a leg. Non-adjacent repeats are legal and preserved:
  // KMFR KRBG KMFR is a real out-and-back.
  const collapsed = new Set<number>();
  const endpointDropped = new Set<number>(boundaryDropped);
  const deduped: typeof interior = [];
  let previous: ImportAirportMatch | undefined = originNode?.match;
  for (const node of interior) {
    if (sameAirport(node.match, previous)) {
      collapsed.add(node.tokenIndex);
      rejections.push({
        identifier: node.identifier,
        tokenIndex: node.tokenIndex,
        reason: "adjacent-duplicate",
      });
      issues.push({
        code: "route-token-unmatched",
        field: `route[${node.tokenIndex}]`,
        message: `Route point "${node.identifier}" repeats the previous point, so it was drawn once.`,
        severity: "warning",
      });
      continue;
    }
    deduped.push(node);
    previous = node.match;
  }
  interior = deduped;
  if (sameAirport(interior.at(-1)?.match, destinationNode?.match)) {
    const last = interior.at(-1)!;
    // Also an endpoint restatement, not an adjacent duplicate: the token
    // matches `To`, which is a different node from the one before it.
    endpointDropped.add(last.tokenIndex);
    rejections.push({
      identifier: last.identifier,
      tokenIndex: last.tokenIndex,
      reason: "endpoint-duplicate",
    });
    interior = interior.slice(0, -1);
  }

  // Stage 5.5 — cap. Guards against a filed IFR route that slipped every
  // earlier filter. The raw text is still stored in full.
  const endpointCount = [originNode, destinationNode].filter(Boolean).length;
  const capacity = Math.max(0, maxNodes - endpointCount);
  const overflow = new Set<number>();
  if (interior.length > capacity) {
    for (const node of interior.slice(capacity)) {
      overflow.add(node.tokenIndex);
      rejections.push({
        identifier: node.identifier,
        tokenIndex: node.tokenIndex,
        reason: "route-too-long",
      });
    }
    issues.push({
      code: "route-token-unmatched",
      field: `route[${interior[capacity].tokenIndex}]`,
      message: `This route has more than ${maxNodes} airports; the extra points were kept as text.`,
      severity: "warning",
    });
    interior = interior.slice(0, capacity);
  }

  // Stage 5.6 — compose. `nodes` covers every source token in order: the
  // endpoints as landings, the kept route airports as waypoints, and every
  // other token as an `unmatched` node at its original index, so the flight's
  // route display can render the source string with matched airports
  // highlighted in place. The drawable path is `nodes` filtered to
  // landing/waypoint; nothing is ever removed.
  const keptWaypointIndexes = new Set(interior.map((node) => node.tokenIndex));
  const droppedReasonByIndex = new Map<number, ImportRouteRejectionReason>([
    ...[...endpointDropped].map(
      (index) => [index, "endpoint-duplicate"] as const,
    ),
    ...[...collapsed].map((index) => [index, "adjacent-duplicate"] as const),
    ...[...overflow].map((index) => [index, "route-too-long"] as const),
  ]);
  const tokenNodes: ImportRouteNode[] = classified.map((node) => {
    if (node.kind !== "waypoint") return node;
    if (keptWaypointIndexes.has(node.tokenIndex)) return node;
    const reason = droppedReasonByIndex.get(node.tokenIndex);
    if (!reason) {
      // Every drop above records its own reason. Reaching here would mean a
      // token vanished from the path with no recorded cause, which is exactly
      // the kind of silent loss this module exists to prevent.
      throw new ImportInvariantError(
        "route-stop-invalid",
        "A route token was dropped without a recorded reason.",
        { identifier: node.identifier, tokenIndex: node.tokenIndex },
      );
    }
    return {
      kind: "unmatched",
      identifier: node.identifier,
      sourceField: "Route",
      tokenIndex: node.tokenIndex,
      reason,
    };
  });

  const nodes: ImportRouteNode[] = [
    ...(originNode ? [originNode] : []),
    ...tokenNodes,
    ...(destinationNode ? [destinationNode] : []),
  ];

  return {
    nodes,
    rejections,
    issues,
    routeRaw: input.routeRaw?.trim() || undefined,
  };
}

function endpointNode(
  endpoint: RouteEndpointInput,
): Extract<ImportRouteNode, { kind: "landing" }> | undefined {
  if (!endpoint.match || !endpoint.identifier) return undefined;
  return {
    kind: "landing",
    identifier: endpoint.identifier,
    match: endpoint.match,
    sourceField: endpoint.field,
  };
}

function sameAirport(
  left: ImportAirportMatch | undefined,
  right: ImportAirportMatch | undefined,
): boolean {
  if (!left || !right) return false;
  if (left.status === "resolved" && right.status === "resolved") {
    return left.airportId === right.airportId;
  }
  return false;
}
