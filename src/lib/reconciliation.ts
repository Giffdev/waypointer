import type { FlightKind, FlightRole } from "./flight-data";

export type NormalizedFlight = {
  userId: string;
  departureDate: string;
  departureTime?: string;
  originCode: string;
  destinationCode: string;
  kind: FlightKind;
  role: FlightRole;
  aircraft?: string;
  flightNumber?: string;
  sourceRecordId?: string;
};

export type DuplicateAssessment = {
  index: number;
  candidateOfIndex: number;
  confidence: "exact" | "ambiguous";
  rule: "same-source-record" | "same-departure-time" | "same-day-route";
};

export type RoleDistinctOverlap = {
  index: number;
  candidateOfIndex: number;
  rule: "same-day-route-role-distinct";
};

const normalizeCode = (value: string) => value.trim().toUpperCase();
const normalizeText = (value?: string) => value?.trim().toUpperCase() || "";

export function flightFingerprint(flight: NormalizedFlight): string {
  return [
    flight.userId,
    flight.departureDate.slice(0, 10),
    normalizeCode(flight.originCode),
    normalizeCode(flight.destinationCode),
    flight.kind,
    flight.role,
    normalizeText(flight.flightNumber),
    normalizeText(flight.aircraft),
  ].join("|");
}

export function findDuplicateIndexes(flights: NormalizedFlight[]): number[] {
  const seen = new Set<string>();

  return flights.flatMap((flight, index) => {
    const fingerprint = flightFingerprint(flight);
    if (seen.has(fingerprint)) return [index];
    seen.add(fingerprint);
    return [];
  });
}

export function assessDuplicateCandidates(
  flights: NormalizedFlight[],
): DuplicateAssessment[] {
  const sourceRecords = new Map<string, number>();
  const preciseFlights = new Map<string, number>();
  const dayFlights = new Map<string, number>();
  const assessments: DuplicateAssessment[] = [];

  flights.forEach((flight, index) => {
    const sourceKey = flight.sourceRecordId
      ? `${flight.userId}|${normalizeText(flight.sourceRecordId)}`
      : undefined;
    const dayKey = flightFingerprint(flight);
    const time = normalizeText(flight.departureTime);
    const preciseKey = time ? `${dayKey}|${time}` : undefined;
    const sourceMatch = sourceKey === undefined ? undefined : sourceRecords.get(sourceKey);
    const preciseMatch = preciseKey === undefined ? undefined : preciseFlights.get(preciseKey);
    const dayMatch = dayFlights.get(dayKey);

    if (sourceMatch !== undefined) {
      assessments.push({
        index,
        candidateOfIndex: sourceMatch,
        confidence: "exact",
        rule: "same-source-record",
      });
    } else if (preciseMatch !== undefined) {
      assessments.push({
        index,
        candidateOfIndex: preciseMatch,
        confidence: "exact",
        rule: "same-departure-time",
      });
    } else if (dayMatch !== undefined) {
      assessments.push({
        index,
        candidateOfIndex: dayMatch,
        confidence: "ambiguous",
        rule: "same-day-route",
      });
    }

    if (sourceKey && !sourceRecords.has(sourceKey)) sourceRecords.set(sourceKey, index);
    if (preciseKey && !preciseFlights.has(preciseKey)) preciseFlights.set(preciseKey, index);
    if (!dayFlights.has(dayKey)) dayFlights.set(dayKey, index);
  });

  return assessments;
}

export function findRoleDistinctOverlaps(
  flights: NormalizedFlight[],
): RoleDistinctOverlap[] {
  const firstByRoute = new Map<string, number[]>();
  const overlaps: RoleDistinctOverlap[] = [];

  flights.forEach((flight, index) => {
    const routeKey = [
      flight.userId,
      flight.departureDate.slice(0, 10),
      normalizeCode(flight.originCode),
      normalizeCode(flight.destinationCode),
    ].join("|");
    const candidates = firstByRoute.get(routeKey) ?? [];
    const distinctRoleCandidate = candidates.find(
      (candidateIndex) => flights[candidateIndex].role !== flight.role,
    );
    if (distinctRoleCandidate !== undefined) {
      overlaps.push({
        index,
        candidateOfIndex: distinctRoleCandidate,
        rule: "same-day-route-role-distinct",
      });
    }
    candidates.push(index);
    firstByRoute.set(routeKey, candidates);
  });

  return overlaps;
}
