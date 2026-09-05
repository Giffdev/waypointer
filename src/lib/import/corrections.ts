import type {
  ImportAirportMatch,
  ImportCorrection,
  ProposedImportFlight,
  StoredImportRow,
  UpdateImportRowRequest,
} from "./types";
import { landingStopsOf, withDerivedLandingProjection } from "./invariants";
import { ImportInvariantError } from "./errors";

const EDITABLE_TEXT_FIELDS = [
  "aircraft",
  "aircraftType",
  "aircraftModel",
  "registration",
  "flightNumber",
  "airline",
] as const;

export type ResolvedProposalPatch = UpdateImportRowRequest["proposal"] & {
  origin?: ImportAirportMatch;
  destination?: ImportAirportMatch;
  resolvedRouteStop?: {
    index: number;
    airport: ImportAirportMatch;
  };
};

export function validateProposalPatch(
  proposal: UpdateImportRowRequest["proposal"],
): UpdateImportRowRequest["proposal"] {
  const keys = Object.keys(proposal);
  if (keys.length === 0) throw new Error("At least one correction is required");
  const allowed = new Set([
    "originAirportId",
    "destinationAirportId",
    "routeStop",
    "date",
    "departureTime",
    "kind",
    "role",
    "distanceMiles",
    "durationHours",
    ...EDITABLE_TEXT_FIELDS,
  ]);
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error("The correction contains an unsupported field");
  }
  const corrected = { ...proposal };
  if (corrected.routeStop !== undefined) {
    if (
      !corrected.routeStop ||
      typeof corrected.routeStop !== "object" ||
      Array.isArray(corrected.routeStop) ||
      Object.keys(corrected.routeStop).some(
        (key) => key !== "index" && key !== "airportId",
      ) ||
      !Number.isSafeInteger(corrected.routeStop.index) ||
      corrected.routeStop.index < 0 ||
      typeof corrected.routeStop.airportId !== "string"
    ) {
      throw new Error("Route stop correction is invalid");
    }
  }
  if (corrected.date !== undefined) {
    if (!isCalendarDate(corrected.date)) {
      throw new Error("Date must be a valid YYYY-MM-DD value");
    }
  }
  if (corrected.departureTime !== undefined) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(
      corrected.departureTime,
    );
    if (!match) throw new Error("Departure time must use HH:MM");
  }
  if (corrected.kind !== undefined && !["private", "commercial"].includes(corrected.kind)) {
    throw new Error("Flight kind is invalid");
  }
  if (corrected.role !== undefined && !["pilot", "passenger"].includes(corrected.role)) {
    throw new Error("Flight role is invalid");
  }
  if (Object.hasOwn(corrected, "distanceMiles")) {
    corrected.distanceMiles = optionalNumber(
      corrected.distanceMiles,
      "Distance",
      0,
      30_000,
    );
  }
  if (Object.hasOwn(corrected, "durationHours")) {
    corrected.durationHours = optionalNumber(
      corrected.durationHours,
      "Duration",
      0,
      72,
    );
  }
  for (const field of EDITABLE_TEXT_FIELDS) {
    if (Object.hasOwn(corrected, field)) {
      corrected[field] = normalizeText(corrected[field], field);
    }
  }
  return corrected;
}

export function applyProposalCorrection(
  row: StoredImportRow,
  patch: ResolvedProposalPatch,
  correctedAt: string,
): StoredImportRow {
  let proposedFlight = structuredClone(row.proposedFlight);
  const corrections = [...(row.corrections ?? [])];
  // `routeNodes` is the canonical ordered path; `origin`/`destination`/
  // `airportMatches` are a derived landings-only projection of it. Patching
  // only the projection leaves the canonical path stale, which is how a
  // corrected row still committed its original airport and stopped matching
  // its own fingerprint. Correct the nodes, then re-derive.
  const usesRouteNodes = Boolean(proposedFlight.routeNodes?.length);

  if (patch.origin) {
    recordCorrection(
      corrections,
      "origin",
      proposedFlight.origin,
      patch.origin,
      correctedAt,
    );
    if (usesRouteNodes) {
      correctLandingNode(proposedFlight, 0, patch.origin);
    } else {
      proposedFlight.origin = patch.origin;
      proposedFlight.originIdentifier = patch.origin.identifier;
      if (proposedFlight.airportMatches?.length) {
        proposedFlight.airportMatches[0] = patch.origin;
        proposedFlight.airportIdentifiers ??= proposedFlight.airportMatches.map(
          ({ identifier }) => identifier,
        );
        proposedFlight.airportIdentifiers[0] = patch.origin.identifier;
      }
    }
  }
  if (patch.destination) {
    recordCorrection(
      corrections,
      "destination",
      proposedFlight.destination,
      patch.destination,
      correctedAt,
    );
    if (usesRouteNodes) {
      correctLandingNode(proposedFlight, -1, patch.destination);
    } else {
      proposedFlight.destination = patch.destination;
      proposedFlight.destinationIdentifier = patch.destination.identifier;
      if (proposedFlight.airportMatches?.length) {
        const last = proposedFlight.airportMatches.length - 1;
        proposedFlight.airportMatches[last] = patch.destination;
        proposedFlight.airportIdentifiers ??= proposedFlight.airportMatches.map(
          ({ identifier }) => identifier,
        );
        proposedFlight.airportIdentifiers[last] = patch.destination.identifier;
      }
    }
  }
  if (patch.resolvedRouteStop) {
    const { index, airport } = patch.resolvedRouteStop;
    // Bounded above *and* below, before anything is applied. The lower bound
    // is not redundant with request validation: a negative index reaching
    // `correctLandingNode` counts from the end, so `-1` would silently
    // rewrite the destination instead of failing. The upper bound is measured
    // against the landing sequence the caller is actually editing — the
    // canonical nodes when they exist, the legacy projection otherwise —
    // because a row carrying waypoints has more nodes than landings.
    const landingCount = usesRouteNodes
      ? landingStopsOf(proposedFlight).length
      : (proposedFlight.airportMatches?.length ??
        (proposedFlight.origin && proposedFlight.destination ? 2 : 0));
    if (!Number.isSafeInteger(index) || index < 0 || index >= landingCount) {
      throw new ImportInvariantError(
        "route-stop-invalid",
        "Route stop index is out of range",
        { index, landingCount },
      );
    }
    const matches =
      proposedFlight.airportMatches ??
      (proposedFlight.origin && proposedFlight.destination
        ? [proposedFlight.origin, proposedFlight.destination]
        : []);
    const identifiers =
      proposedFlight.airportIdentifiers ??
      matches.map(({ identifier }) => identifier);
    if (landingCount < 2) {
      throw new ImportInvariantError(
        "route-stop-invalid",
        "Route stop index is out of range",
        { index, landingCount },
      );
    }
    recordCorrection(
      corrections,
      `route[${index}]`,
      matches[index],
      airport,
      correctedAt,
    );
    if (usesRouteNodes) {
      correctLandingNode(proposedFlight, index, airport);
    } else {
      matches[index] = airport;
      identifiers[index] = airport.identifier;
      proposedFlight.airportMatches = matches;
      proposedFlight.airportIdentifiers = identifiers;
      proposedFlight.origin = matches[0];
      proposedFlight.destination = matches.at(-1);
      proposedFlight.originIdentifier = identifiers[0];
      proposedFlight.destinationIdentifier = identifiers.at(-1);
    }
  }
  if (usesRouteNodes) {
    proposedFlight = withDerivedLandingProjection(proposedFlight);
  }
  for (const [field, value] of Object.entries(patch)) {
    if (
      field === "origin" ||
      field === "destination" ||
      field === "resolvedRouteStop" ||
      field === "routeStop" ||
      field === "originAirportId" ||
      field === "destinationAirportId"
    ) {
      continue;
    }
    const typedField = field as keyof ProposedImportFlight;
    recordCorrection(
      corrections,
      typedField,
      proposedFlight[typedField],
      value,
      correctedAt,
    );
    Object.assign(proposedFlight, { [typedField]: value });
  }

  const changedFields = new Set(corrections.map((correction) => correction.field));
  const issues = row.issues.filter(
    (issue) =>
      !issueFields(issue.field).some((field) => changedFields.has(field)),
  );
  return {
    ...row,
    proposedFlight,
    issues,
    corrections,
    decision: "pending",
    decidedAt: undefined,
    duplicateCandidate: undefined,
  };
}

/**
 * Replaces the resolved airport on the nth landing node (negative index counts
 * from the end). Waypoints are skipped, so a landing index from the review UI
 * always addresses the landing the user is looking at even when the row also
 * carries overflown route waypoints.
 */
function correctLandingNode(
  flight: ProposedImportFlight,
  landingIndex: number,
  airport: ImportAirportMatch,
): void {
  const nodes = flight.routeNodes;
  if (!nodes?.length) return;
  const landingPositions = nodes.flatMap((node, position) =>
    node.kind === "landing" ? [position] : [],
  );
  const position =
    landingIndex < 0
      ? landingPositions.at(landingIndex)
      : landingPositions[landingIndex];
  if (position === undefined) {
    throw new ImportInvariantError(
      "route-stop-invalid",
      "Route stop index is out of range",
      { landingIndex },
    );
  }
  const target = nodes[position];
  if (target.kind !== "landing") return;
  flight.routeNodes = nodes.with(position, {
    ...target,
    identifier: airport.identifier,
    match: airport,
  });
}

function recordCorrection(
  corrections: ImportCorrection[],
  field: ImportCorrection["field"],
  originalValue: unknown,
  correctedValue: unknown,
  correctedAt: string,
): void {
  if (sameValue(originalValue, correctedValue)) return;
  const existing = corrections.find((correction) => correction.field === field);
  if (existing) {
    existing.correctedValue = correctedValue;
    existing.correctedAt = correctedAt;
  } else {
    corrections.push({
      field,
      originalValue,
      correctedValue,
      correctedAt,
    });
  }
}

function issueFields(field: string): ImportCorrection["field"][] {
  if (field === "From" || field === "origin") return ["origin"];
  if (field === "To" || field === "destination") return ["destination"];
  const routeMatch = /^route\[(\d+)\]$/.exec(field);
  if (routeMatch) return [`route[${Number(routeMatch[1])}]`];
  if (field === "Date") return ["date"];
  if (field === "TimeOut" || field === "Dep time") return ["departureTime"];
  if (field === "Duration" || field === "HobbsStart/HobbsEnd") {
    return ["durationHours"];
  }
  if (field === "AircraftID") {
    return ["aircraft", "aircraftType", "aircraftModel", "registration"];
  }
  return [];
}

function optionalNumber(
  value: number | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function normalizeText(
  value: string | undefined,
  field: string,
): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  if (
    normalized.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
