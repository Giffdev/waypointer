import type { Airport, AirportFacility } from "../flight-data.ts";
import { parseCsv } from "./csv.ts";

export const OURAIRPORTS_SOURCE_URL =
  "https://davidmegginson.github.io/ourairports-data/airports.csv";

export type AirportReference = {
  ident: string;
  type: string;
  name: string;
  latitude: number;
  longitude: number;
  isoCountry: string;
  municipality: string;
  scheduledService: boolean;
  gpsCode?: string;
  iataCode?: string;
  localCode?: string;
  keywords?: string;
};

export type AirportIdentifierType =
  | "icao"
  | "iata"
  | "faa-lid"
  | "gps"
  | "ident"
  | "local";

export type AirportIdentifierAlias = {
  code: string;
  type: AirportIdentifierType;
  priority: number;
};

type CuratedAirportIdentifierAliases = {
  name: string;
  isoCountry: string;
  type: string;
  aliases: AirportIdentifierAlias[];
};

const CURATED_AIRPORT_IDENTIFIER_ALIASES: Readonly<
  Record<string, CuratedAirportIdentifierAliases>
> = {
  "DE-0440": {
    name: "Berlin-Schönefeld Airport",
    isoCountry: "DE",
    type: "closed",
    aliases: [
      { code: "SXF", type: "iata", priority: 20 },
    ],
  },
  "KH-0003": {
    name: "Siem Reap International Airport",
    isoCountry: "KH",
    type: "closed",
    aliases: [
      { code: "VDSR", type: "icao", priority: 10 },
      { code: "REP", type: "iata", priority: 20 },
    ],
  },
};

export type AirportCatalogAudit = {
  totalAirports: number;
  usFaaLidAirports: number;
  usFaaLidOnlyAirports: number;
  nonIataAirports: number;
  smallAirports: number;
  smallAirportsWithoutIata: number;
  keywordSearchAirports: number;
  legacyIdentifierAliases: number;
  expandedIdentifierAliases: number;
  ambiguousTopPriorityCodes: number;
};

export type AirportResolution =
  | { status: "not-found"; identifier: string }
  | { status: "ambiguous"; identifier: string; candidateIdents: string[] }
  | { status: "resolved"; identifier: string; reference: AirportReference; airport: Airport };

const REQUIRED_COLUMNS = [
  "ident",
  "type",
  "name",
  "latitude_deg",
  "longitude_deg",
  "iso_country",
  "municipality",
  "scheduled_service",
  "gps_code",
  "iata_code",
  "local_code",
] as const;

function facilityFor(reference: AirportReference): AirportFacility {
  if (
    reference.scheduledService &&
    (reference.type === "large_airport" || reference.type === "medium_airport")
  ) {
    return "commercial";
  }
  if (reference.type === "small_airport" && !reference.iataCode) return "airstrip";
  return "general-aviation";
}

function canonicalCode(reference: AirportReference): string {
  return (
    reference.iataCode ||
    reference.localCode ||
    reference.gpsCode ||
    reference.ident
  ).toUpperCase();
}

export function airportIdentifierAliases(
  reference: AirportReference,
): AirportIdentifierAlias[] {
  const curated = CURATED_AIRPORT_IDENTIFIER_ALIASES[reference.ident];
  const curatedAliases =
    curated &&
    reference.name === curated.name &&
    reference.isoCountry === curated.isoCountry &&
    reference.type === curated.type
      ? curated.aliases
      : [];
  const candidates: AirportIdentifierAlias[] = [
    ...(reference.gpsCode
      ? [{ code: reference.gpsCode, type: "icao" as const, priority: 10 }]
      : []),
    ...(reference.iataCode
      ? [{ code: reference.iataCode, type: "iata" as const, priority: 20 }]
      : []),
    ...curatedAliases,
    ...(reference.localCode
      ? [{
          code: reference.localCode,
          type:
            reference.isoCountry === "US"
              ? ("faa-lid" as const)
              : ("local" as const),
          priority: 30,
        }]
      : []),
    { code: reference.ident, type: "ident", priority: 40 },
    ...(reference.gpsCode && reference.gpsCode !== reference.ident
      ? [{ code: reference.gpsCode, type: "gps" as const, priority: 40 }]
      : []),
  ];
  return [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.code.toUpperCase()}:${candidate.type}`,
        { ...candidate, code: candidate.code.toUpperCase() },
      ]),
    ).values(),
  ];
}

export function auditAirportReferences(
  references: AirportReference[],
): AirportCatalogAudit {
  const byCode = new Map<
    string,
    Array<{ ident: string; priority: number }>
  >();
  for (const reference of references) {
    for (const alias of airportIdentifierAliases(reference)) {
      const matches = byCode.get(alias.code) ?? [];
      matches.push({ ident: reference.ident, priority: alias.priority });
      byCode.set(alias.code, matches);
    }
  }
  const ambiguousTopPriorityCodes = [...byCode.values()].filter((matches) => {
    const best = Math.min(...matches.map(({ priority }) => priority));
    return new Set(
      matches
        .filter(({ priority }) => priority === best)
        .map(({ ident }) => ident),
    ).size > 1;
  }).length;
  const legacyIdentifierAliases = references.reduce((total, reference) => {
    const proposedIcao =
      reference.gpsCode ||
      (/^[A-Z]{4}$/.test(reference.ident) ? reference.ident : undefined);
    return (
      total +
      new Set(
        [
          proposedIcao,
          reference.iataCode,
          reference.localCode ||
            (reference.ident !== proposedIcao ? reference.ident : undefined),
        ].filter(Boolean),
      ).size
    );
  }, 0);
  const expandedIdentifierAliases = references.reduce(
    (total, reference) =>
      total +
      new Set(airportIdentifierAliases(reference).map(({ code }) => code)).size,
    0,
  );
  return {
    totalAirports: references.length,
    usFaaLidAirports: references.filter(
      ({ isoCountry, localCode }) => isoCountry === "US" && localCode,
    ).length,
    usFaaLidOnlyAirports: references.filter(
      ({ isoCountry, localCode, gpsCode, iataCode }) =>
        isoCountry === "US" && localCode && !gpsCode && !iataCode,
    ).length,
    nonIataAirports: references.filter(
      ({ iataCode }) => !iataCode,
    ).length,
    smallAirports: references.filter(({ type }) => type === "small_airport")
      .length,
    smallAirportsWithoutIata: references.filter(
      ({ type, iataCode }) => type === "small_airport" && !iataCode,
    ).length,
    keywordSearchAirports: references.filter(({ keywords }) => keywords)
      .length,
    legacyIdentifierAliases,
    expandedIdentifierAliases,
    ambiguousTopPriorityCodes,
  };
}

const SEARCH_STOP_WORDS = new Set([
  "airport",
  "airfield",
  "field",
  "international",
  "municipal",
  "regional",
]);

export function airportSearchPhoneticKeys(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .split(/[^A-Z]+/)
        .filter((token) => token.length >= 4)
        .filter((token) => !SEARCH_STOP_WORDS.has(token.toLowerCase()))
        .map(soundex),
    ),
  ];
}

export function airportSearchKey(reference: AirportReference): string {
  return airportSearchPhoneticKeys(
    [reference.name, reference.municipality, reference.keywords]
      .filter(Boolean)
      .join(" "),
  ).join(" ");
}

function soundex(value: string): string {
  const digits: Record<string, string> = {
    B: "1", F: "1", P: "1", V: "1",
    C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
    D: "3", T: "3",
    L: "4",
    M: "5", N: "5",
    R: "6",
  };
  const first = value[0] ?? "";
  let previous = digits[first] ?? "";
  let encoded = "";
  for (const character of value.slice(1)) {
    const digit = digits[character] ?? "";
    if (digit && digit !== previous) encoded += digit;
    previous = digit;
  }
  return `${first}${encoded}000`.slice(0, 4);
}

export function selectBestAirportAliasMatches<
  T extends { id: string; aliasPriority: number },
>(matches: T[]): T[] {
  const bestPriority = matches.reduce(
    (minimum, match) => Math.min(minimum, match.aliasPriority),
    Number.POSITIVE_INFINITY,
  );
  return [
    ...new Map(
      matches
        .filter(({ aliasPriority }) => aliasPriority === bestPriority)
        .map((match) => [match.id, match]),
    ).values(),
  ];
}

function toAirport(reference: AirportReference): Airport {
  return {
    code: canonicalCode(reference),
    name: reference.name,
    city: reference.municipality || reference.name,
    country: reference.isoCountry,
    lat: reference.latitude,
    lon: reference.longitude,
    facility: facilityFor(reference),
  };
}

export function parseOurAirportsCsv(input: string): AirportReference[] {
  const records = parseCsv(input);
  const header = records[0];
  if (!header) throw new Error("OurAirports CSV is empty");
  const indexes = new Map(header.cells.map((name, index) => [name.trim(), index]));

  for (const column of REQUIRED_COLUMNS) {
    if (!indexes.has(column)) {
      throw new Error(`OurAirports CSV is missing the "${column}" column`);
    }
  }

  const get = (cells: string[], column: string) =>
    (cells[indexes.get(column) ?? -1] ?? "").trim();

  return records.slice(1).flatMap((record) => {
    const latitude = Number(get(record.cells, "latitude_deg"));
    const longitude = Number(get(record.cells, "longitude_deg"));
    const ident = get(record.cells, "ident").toUpperCase();
    if (!ident || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];

    return [{
      ident,
      type: get(record.cells, "type"),
      name: get(record.cells, "name"),
      latitude,
      longitude,
      isoCountry: get(record.cells, "iso_country"),
      municipality: get(record.cells, "municipality"),
      scheduledService: get(record.cells, "scheduled_service").toLowerCase() === "yes",
      gpsCode: get(record.cells, "gps_code").toUpperCase() || undefined,
      iataCode: get(record.cells, "iata_code").toUpperCase() || undefined,
      localCode: get(record.cells, "local_code").toUpperCase() || undefined,
      keywords: indexes.has("keywords")
        ? get(record.cells, "keywords") || undefined
        : undefined,
    }];
  });
}

export function createAirportResolver(references: AirportReference[]) {
  const aliases = new Map<
    string,
    Map<string, { reference: AirportReference; priority: number }>
  >();

  for (const reference of references) {
    for (const { code, priority } of airportIdentifierAliases(reference)) {
      const key = code.toUpperCase();
      const matches =
        aliases.get(key) ??
        new Map<string, { reference: AirportReference; priority: number }>();
      const existing = matches.get(reference.ident);
      if (!existing || priority < existing.priority) {
        matches.set(reference.ident, { reference, priority });
      }
      aliases.set(key, matches);
    }
  }

  return (rawIdentifier: string): AirportResolution => {
    const identifier = rawIdentifier.trim().toUpperCase();
    const candidates = [...(aliases.get(identifier)?.values() ?? [])];
    const bestPriority = candidates.reduce(
      (minimum, candidate) => Math.min(minimum, candidate.priority),
      Number.POSITIVE_INFINITY,
    );
    const matches = candidates
      .filter(({ priority }) => priority === bestPriority)
      .map(({ reference }) => reference);
    if (matches.length === 0) return { status: "not-found", identifier };
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        identifier,
        candidateIdents: matches.map((match) => match.ident).sort(),
      };
    }
    return {
      status: "resolved",
      identifier,
      reference: matches[0],
      airport: toAirport(matches[0]),
    };
  };
}
