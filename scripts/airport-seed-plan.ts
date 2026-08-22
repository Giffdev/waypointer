import { randomUUID } from "node:crypto";
import {
  airportIdentifierAliases,
  type AirportReference,
} from "../src/lib/import/airport-resolution.ts";
import { AirportCatalogSafetyError } from "./postgres-diagnostics.ts";

export interface ExistingAirportIdentity {
  id: string;
  sourceIdent: string | null;
  sourceIdentProvenance: string | null;
  icao: string | null;
  iata: string | null;
  localCode: string | null;
  name: string;
  latitude: number;
  longitude: number;
}

export interface AirportSeedIdentitySummary {
  incomingCount: number;
  matchedBySourceIdent: number;
  matchedLegacy: number;
  created: number;
  collisions: number;
  ambiguities: number;
}

export interface AirportSeedAssignment {
  ids: string[];
  sourceIdentReassignments: string[];
  matchedExisting: number;
  created: number;
  summary: AirportSeedIdentitySummary;
}

function groupedIds(
  airports: ExistingAirportIdentity[],
  select: (airport: ExistingAirportIdentity) => string | undefined,
) {
  const groups = new Map<string, Set<string>>();
  for (const airport of airports) {
    const key = select(airport);
    if (!key) continue;
    const ids = groups.get(key) ?? new Set<string>();
    ids.add(airport.id);
    groups.set(key, ids);
  }
  return groups;
}

function coordinateNameKey(
  latitude: number,
  longitude: number,
  name: string,
) {
  return `${latitude}|${longitude}|${name}`;
}

function compatibleLegacySourceIdentifiers(reference: AirportReference) {
  return new Set(
    [
      reference.ident,
      reference.gpsCode,
      reference.iataCode,
      reference.localCode,
      ...airportIdentifierAliases(reference).map(({ code }) => code),
    ].filter((value): value is string => Boolean(value)),
  );
}

function isVerifiedSourceIdentity(airport: ExistingAirportIdentity) {
  return airport.sourceIdentProvenance?.startsWith(
    "ourairports-sha256:",
  ) ?? false;
}

function requireExactLegacyMatch(
  airport: ExistingAirportIdentity,
  reference: AirportReference,
  exactMatches: Set<string>,
  referenceIndex: number,
) {
  if (
    isVerifiedSourceIdentity(airport) ||
    !airport.sourceIdent ||
    !compatibleLegacySourceIdentifiers(reference).has(airport.sourceIdent)
  ) {
    throw new AirportCatalogSafetyError("identity-reassignment", {
      candidateCount: 1,
      referenceIndex,
    });
  }
  if (!exactMatches.has(airport.id)) {
    throw new AirportCatalogSafetyError("identity-reassignment", {
      candidateCount: 1,
      referenceIndex,
    });
  }
}

function requireUnambiguous(
  ids: Set<string>,
  referenceIndex: number,
): string | undefined {
  if (ids.size > 1) {
    throw new AirportCatalogSafetyError("ambiguous-existing-identity", {
      candidateCount: ids.size,
      referenceIndex,
    });
  }
  return [...ids][0];
}

export function assignAirportSeedIds(
  references: AirportReference[],
  existingAirports: ExistingAirportIdentity[],
  proposedIcao: (reference: AirportReference) => string | undefined,
  proposedIata: (reference: AirportReference) => string | undefined,
  createId: () => string = randomUUID,
): AirportSeedAssignment {
  const incomingSourceCounts = new Map<string, number>();
  for (const reference of references) {
    incomingSourceCounts.set(
      reference.ident,
      (incomingSourceCounts.get(reference.ident) ?? 0) + 1,
    );
  }
  const duplicateIncoming = [...incomingSourceCounts.values()].filter(
    (count) => count > 1,
  );
  if (duplicateIncoming.length) {
    throw new AirportCatalogSafetyError("duplicate-incoming-source-ident", {
      duplicateCount: duplicateIncoming.length,
      incomingCount: references.length,
    });
  }

  const referenceExactMatches = new Map<string, AirportReference[]>();
  for (const reference of references) {
    const key = coordinateNameKey(
      reference.latitude,
      reference.longitude,
      reference.name,
    );
    referenceExactMatches.set(key, [
      ...(referenceExactMatches.get(key) ?? []),
      reference,
    ]);
  }
  const sourceIdentReassignments = new Set<string>();
  const normalizedExistingAirports = existingAirports.map((airport) => {
    if (isVerifiedSourceIdentity(airport) || !airport.sourceIdent) {
      return airport;
    }
    const exactReferences =
      referenceExactMatches.get(
        coordinateNameKey(
          airport.latitude,
          airport.longitude,
          airport.name,
        ),
      ) ?? [];
    const compatibleReferences = exactReferences.filter((reference) =>
      compatibleLegacySourceIdentifiers(reference).has(
        airport.sourceIdent!,
      ),
    );
    if (
      compatibleReferences.length === 1 &&
      compatibleReferences[0].ident !== airport.sourceIdent
    ) {
      sourceIdentReassignments.add(airport.id);
      return {
        ...airport,
        sourceIdent: compatibleReferences[0].ident,
      };
    }
    return airport;
  });
  const existingById = new Map(
    normalizedExistingAirports.map((airport) => [airport.id, airport]),
  );
  const sourceIds = groupedIds(
    normalizedExistingAirports,
    (airport) => airport.sourceIdent ?? undefined,
  );
  const icaoIds = groupedIds(
    normalizedExistingAirports,
    (airport) => airport.icao ?? undefined,
  );
  const iataIds = groupedIds(
    normalizedExistingAirports,
    (airport) => airport.iata ?? undefined,
  );
  const exactIdentityIds = groupedIds(
    normalizedExistingAirports,
    (airport) =>
      coordinateNameKey(airport.latitude, airport.longitude, airport.name),
  );
  const exactUnclaimedLegacyIds = groupedIds(
    normalizedExistingAirports.filter((airport) => !airport.sourceIdent),
    (airport) =>
      coordinateNameKey(airport.latitude, airport.longitude, airport.name),
  );

  const ids: string[] = [];
  const claimed = new Set<string>();
  let matchedBySourceIdent = 0;
  let matchedLegacy = 0;

  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const sourceMatches = sourceIds.get(reference.ident) ?? new Set<string>();
    const icao = proposedIcao(reference);
    const iata = proposedIata(reference);
    const icaoMatches = icao
      ? (icaoIds.get(icao) ?? new Set<string>())
      : new Set<string>();
    const iataMatches = iata
      ? (iataIds.get(iata) ?? new Set<string>())
      : new Set<string>();

    const sourceId = requireUnambiguous(sourceMatches, index);
    const icaoId = requireUnambiguous(icaoMatches, index);
    const iataId = requireUnambiguous(iataMatches, index);
    const identifierCandidates = new Set(
      [sourceId, icaoId, iataId].filter(
        (candidate): candidate is string => Boolean(candidate),
      ),
    );
    if (identifierCandidates.size > 1) {
      throw new AirportCatalogSafetyError("crossed-identifiers", {
        candidateCount: identifierCandidates.size,
        referenceIndex: index,
      });
    }

    const exactMatches =
      exactIdentityIds.get(
        coordinateNameKey(
          reference.latitude,
          reference.longitude,
          reference.name,
        ),
      ) ?? new Set<string>();
    let id: string | undefined = [...identifierCandidates][0];
    if (sourceId) {
      const existing = existingById.get(sourceId)!;
      if (isVerifiedSourceIdentity(existing)) {
        matchedBySourceIdent += 1;
      } else {
        requireExactLegacyMatch(existing, reference, exactMatches, index);
        matchedLegacy += 1;
      }
    } else if (id) {
      const existing = existingById.get(id)!;
      if (existing.sourceIdent) {
        requireExactLegacyMatch(existing, reference, exactMatches, index);
      } else {
        requireUnambiguous(exactMatches, index);
        if (!exactMatches.has(id)) {
          throw new AirportCatalogSafetyError("identity-reassignment", {
            candidateCount: 1,
            referenceIndex: index,
          });
        }
      }
      matchedLegacy += 1;
    } else {
      const unclaimedExactMatches =
        exactUnclaimedLegacyIds.get(
          coordinateNameKey(
            reference.latitude,
            reference.longitude,
            reference.name,
          ),
        ) ?? new Set<string>();
      id = requireUnambiguous(unclaimedExactMatches, index);
      if (id) matchedLegacy += 1;
    }

    if (id) {
      if (claimed.has(id)) {
        throw new AirportCatalogSafetyError("ambiguous-existing-identity", {
          candidateCount: 1,
          claimedCount: claimed.size,
          referenceIndex: index,
        });
      }
      claimed.add(id);
      ids.push(id);
    } else {
      ids.push(createId());
    }
  }

  if (new Set(ids).size !== ids.length) {
    throw new AirportCatalogSafetyError("ambiguous-existing-identity", {
      candidateCount: ids.length - new Set(ids).size,
      claimedCount: claimed.size,
    });
  }

  const created = ids.length - claimed.size;
  return {
    ids,
    sourceIdentReassignments: [...sourceIdentReassignments].sort(),
    matchedExisting: claimed.size,
    created,
    summary: {
      incomingCount: references.length,
      matchedBySourceIdent,
      matchedLegacy,
      created,
      collisions: 0,
      ambiguities: 0,
    },
  };
}
