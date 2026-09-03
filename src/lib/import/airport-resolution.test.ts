import { describe, expect, it } from "vitest";
import { preferredAirportCode } from "../airport-preferred-code";
import { importProposalValidationState } from "./review";
import {
  auditAirportReferences,
  airportIdentifierAliases,
  airportSearchKey,
  airportSearchPhoneticKeys,
  assertHistoricalAirportReplacementSeparation,
  canonicalAirportIdentifierFields,
  createAirportResolver,
  preferredAirportIataCode,
  selectBestAirportAliasMatches,
  type AirportReference,
} from "./airport-resolution";

const reference = (
  ident: string,
  overrides: Partial<AirportReference> = {},
): AirportReference => ({
  ident,
  type: "small_airport",
  name: `Airport ${ident}`,
  latitude: 48,
  longitude: -119,
  isoCountry: "US",
  municipality: "Test",
  scheduledService: false,
  ...overrides,
});

const tonasket = reference("KW01", {
  name: "Tonasket Municipal Airport",
  municipality: "Tonasket",
  localCode: "W01",
});
const omak = reference("KOMK", {
  name: "Omak Airport",
  municipality: "Omak",
  gpsCode: "KOMK",
  iataCode: "OMK",
  localCode: "OMK",
});
const forks = reference("S18", {
  name: "Forks Airport",
  municipality: "Forks",
  localCode: "S18",
});
const quillayute = reference("KUIL", {
  name: "Quillayute Airport",
  municipality: "Quillayute",
  gpsCode: "KUIL",
  iataCode: "UIL",
  localCode: "UIL",
});
const formerSiemReap = reference("KH-0003", {
  type: "closed",
  name: "Siem Reap International Airport",
  isoCountry: "KH",
  municipality: "Siem Reap",
  latitude: 13.410676,
  longitude: 103.812074,
  keywords: "REP, VDSR",
});
const siemReapAngkor = reference("VDSA", {
  type: "large_airport",
  name: "Siem Reap-Angkor International Airport",
  isoCountry: "KH",
  municipality: "Siem Reap",
  latitude: 13.36974,
  longitude: 104.223831,
  scheduledService: true,
  gpsCode: "VDSA",
  iataCode: "SAI",
  localCode: "VDSA",
});
const formerSchonefeld = reference("DE-0440", {
  type: "closed",
  name: "Berlin-Schönefeld Airport",
  isoCountry: "DE",
  municipality: "Berlin",
  latitude: 52.380001,
  longitude: 13.5225,
  keywords: "BER, EDDB, ETBS, Schoenefeld, Terminal 5, SXF",
});
const berlinBrandenburg = reference("EDDB", {
  type: "large_airport",
  name: "Berlin Brandenburg Airport",
  isoCountry: "DE",
  municipality: "Berlin",
  latitude: 52.361738,
  longitude: 13.502341,
  scheduledService: true,
  gpsCode: "EDDB",
  iataCode: "BER",
  localCode: "EDDB",
});

describe("airport identifier resolution", () => {
  it("resolves W01 as an FAA LID and preserves OMK IATA/ICAO resolution", () => {
    const resolve = createAirportResolver([tonasket, omak]);
    expect(resolve(" w01 ")).toMatchObject({
      status: "resolved",
      reference: { ident: "KW01", name: "Tonasket Municipal Airport" },
      airport: { code: "W01" },
    });
    expect(resolve("OMK")).toMatchObject({
      status: "resolved",
      reference: { ident: "KOMK", name: "Omak Airport" },
    });
    expect(resolve("komk")).toMatchObject({
      status: "resolved",
      reference: { ident: "KOMK" },
    });
  });

  it("supports mixed FAA LID, ICAO, IATA, and regional identifiers", () => {
    const regional = reference("US-TEST", {
      isoCountry: "US",
      localCode: "0S7",
    });

    const resolve = createAirportResolver([tonasket, omak, regional]);
    expect(resolve("W01").status).toBe("resolved");
    expect(resolve("KOMK").status).toBe("resolved");
    expect(resolve("OMK").status).toBe("resolved");
    expect(resolve("0s7").status).toBe("resolved");
    expect(resolve("US-TEST").status).toBe("resolved");
  });

  it("keeps Forks and Quillayute as distinct exact airport identities", () => {
    const resolve = createAirportResolver([forks, quillayute]);
    expect(resolve("S18")).toMatchObject({
      status: "resolved",
      reference: {
        ident: "S18",
        name: "Forks Airport",
        localCode: "S18",
      },
    });
    expect(resolve("S18")).not.toHaveProperty("reference.gpsCode");
    expect(resolve("S18")).not.toHaveProperty("reference.iataCode");
    expect(resolve("UIL")).toMatchObject({
      status: "resolved",
      reference: {
        ident: "KUIL",
        name: "Quillayute Airport",
        gpsCode: "KUIL",
        iataCode: "UIL",
        localCode: "UIL",
      },
    });
    expect(resolve("KUIL")).toMatchObject({
      status: "resolved",
      reference: { ident: "KUIL", name: "Quillayute Airport" },
    });
    expect(resolve("Forks")).toEqual({
      status: "not-found",
      identifier: "FORKS",
    });
  });

  it("preserves former Siem Reap codes without aliasing them to Siem Reap-Angkor", () => {
    const resolve = createAirportResolver([formerSiemReap, siemReapAngkor]);

    expect(airportIdentifierAliases(formerSiemReap)).toEqual(
      expect.arrayContaining([
        { code: "REP", type: "iata", priority: 20 },
        { code: "VDSR", type: "icao", priority: 10 },
      ]),
    );
    const historicalAliasCodes = airportIdentifierAliases(
      formerSiemReap,
    ).map(({ code }) => code);
    expect(historicalAliasCodes).not.toContain("SAI");
    expect(historicalAliasCodes).not.toContain("VDSA");
    expect(resolve("rep")).toMatchObject({
      status: "resolved",
      reference: {
        ident: "KH-0003",
        name: "Siem Reap International Airport",
        type: "closed",
      },
      airport: {
        code: "REP",
        name: "Siem Reap International Airport",
        lat: 13.410676,
        lon: 103.812074,
      },
    });
    expect(resolve("VDSR")).toMatchObject({
      status: "resolved",
      reference: { ident: "KH-0003" },
    });
    expect(resolve("SAI")).toMatchObject({
      status: "resolved",
      reference: {
        ident: "VDSA",
        name: "Siem Reap-Angkor International Airport",
      },
      airport: {
        code: "SAI",
        lat: 13.36974,
        lon: 104.223831,
      },
    });
    expect(resolve("VDSA")).toMatchObject({
      status: "resolved",
      reference: { ident: "VDSA" },
    });
  });

  it("rejects replacement identifiers as historical aliases", () => {
    expect(() =>
      assertHistoricalAirportReplacementSeparation(
        "KH-0003",
        [{ code: "sai", type: "iata", priority: 20 }],
        {
          ident: "VDSA",
          iataCode: "SAI",
          icaoCode: "VDSA",
        },
      ),
    ).toThrow(
      "Historical airport KH-0003 cannot alias replacement code SAI.",
    );
  });

  it("keeps reassigned Berlin codes on distinct historical and current records", () => {
    const resolve = createAirportResolver([
      formerSchonefeld,
      berlinBrandenburg,
    ]);

    expect(resolve("SXF")).toMatchObject({
      status: "resolved",
      reference: {
        ident: "DE-0440",
        name: "Berlin-Schönefeld Airport",
        type: "closed",
      },
    });
    expect(resolve("BER")).toMatchObject({
      status: "resolved",
      reference: {
        ident: "EDDB",
        name: "Berlin Brandenburg Airport",
      },
    });
    expect(resolve("EDDB")).toMatchObject({
      status: "resolved",
      reference: { ident: "EDDB" },
    });
  });

  it("does not apply curated aliases when a source identity no longer matches", () => {
    const changedIdentity = {
      ...formerSiemReap,
      name: "Different Airport",
    };
    expect(preferredAirportIataCode(changedIdentity)).toBeUndefined();
    expect(
      createAirportResolver([changedIdentity])("REP"),
    ).toEqual({
      status: "not-found",
      identifier: "REP",
    });
    expect(createAirportResolver([changedIdentity])("KH-0003")).toMatchObject({
      status: "resolved",
      airport: { code: "KH-0003" },
    });
  });

  it("supports bounded phonetic correction search without changing code resolution", () => {
    expect(airportSearchPhoneticKeys("Quileute")).toEqual(["Q430"]);
    expect(airportSearchPhoneticKeys("Quillayute")).toEqual(["Q430"]);
    expect(airportSearchKey(quillayute)).toContain("Q430");
    expect(airportSearchPhoneticKeys("Forks Airport")).toContain("F620");
  });

  it("prefers IATA/ICAO over lower-priority aliases", () => {
    const iata = reference("KAAA", {
      gpsCode: "KAAA",
      iataCode: "DUP",
    });
    const local = reference("US-DUP", { localCode: "DUP" });
    expect(createAirportResolver([iata, local])("DUP")).toMatchObject({
      status: "resolved",
      reference: { ident: "KAAA" },
    });
  });

  it("returns same-priority alias collisions as ambiguous", () => {
    const resolve = createAirportResolver([
      reference("US-A", { localCode: "DUP" }),
      reference("US-B", { localCode: "DUP" }),
    ]);
    expect(resolve("dup")).toEqual({
      status: "ambiguous",
      identifier: "DUP",
      candidateIdents: ["US-A", "US-B"],
    });
  });

  it("deduplicates one airport's aliases while retaining equal-priority collisions", () => {
    expect(
      selectBestAirportAliasMatches([
        { id: "iata", aliasPriority: 20 },
        { id: "local", aliasPriority: 30 },
        { id: "iata", aliasPriority: 20 },
      ]),
    ).toEqual([{ id: "iata", aliasPriority: 20 }]);
    expect(
      selectBestAirportAliasMatches([
        { id: "a", aliasPriority: 30 },
        { id: "b", aliasPriority: 30 },
      ]),
    ).toHaveLength(2);
  });

  it("keeps unknown codes unresolved and reviewable", () => {
    const resolution = createAirportResolver([tonasket, omak])("ZZZZ");
    expect(resolution).toEqual({
      status: "not-found",
      identifier: "ZZZZ",
    });
    expect(
      importProposalValidationState(
        {
          date: "2026-08-14",
          origin: { status: "not-found", identifier: "ZZZZ" },
          destination: {
            status: "resolved",
            identifier: "OMK",
            airportId: "airport-omk",
            airport: {
              code: "OMK",
              name: "Omak Airport",
              city: "Omak",
              country: "US",
              lat: 48,
              lon: -119,
              facility: "general-aviation",
            },
          },
          kind: "private",
          role: "pilot",
          source: "ForeFlight",
        },
        [],
      ),
    ).toBe("unresolved");
  });

  it("quantifies non-IATA coverage and top-priority collisions", () => {
    expect(
      auditAirportReferences([
        tonasket,
        omak,
        reference("US-A", { localCode: "DUP" }),
        reference("US-B", { localCode: "DUP" }),
      ]),
    ).toEqual({
      totalAirports: 4,
      usFaaLidAirports: 4,
      usFaaLidOnlyAirports: 3,
      nonIataAirports: 3,
      smallAirports: 4,
      smallAirportsWithoutIata: 3,
      keywordSearchAirports: 0,
      legacyIdentifierAliases: 5,
      expandedIdentifierAliases: 8,
      ambiguousTopPriorityCodes: 1,
    });
  });
});

/**
 * Mirrors the row `scripts/seed-airports.ts` writes for one reference, so the
 * parity checks below compare the code chosen at import/seed time with the code
 * a later database read of that same persisted row produces.
 */
function seededAirportRow(source: AirportReference) {
  const proposedIcao =
    source.gpsCode ?? (/^[A-Z]{4}$/.test(source.ident) ? source.ident : null);
  const canonical = canonicalAirportIdentifierFields(source);
  return {
    ...canonical,
    icao: proposedIcao,
    localCode:
      source.localCode ??
      (source.ident !== proposedIcao ? source.ident : null),
  };
}

describe("airport display code policy", () => {
  const bandonState = reference("KS05", {
    name: "Bandon State Airport",
    municipality: "Bandon",
    latitude: 43.084499,
    longitude: -124.408997,
    gpsCode: "S05",
    iataCode: "BDY",
    localCode: "S05",
  });
  const scheduledBushField = reference("PAKI", {
    name: "Kipnuk Airport",
    municipality: "Kipnuk",
    scheduledService: true,
    gpsCode: "PAKI",
    iataCode: "KPN",
    localCode: "IIK",
  });
  const staleMediumAirport = reference("KADH", {
    type: "medium_airport",
    name: "Ada Regional Airport",
    municipality: "Ada",
    gpsCode: "KADH",
    iataCode: "ADT",
    localCode: "ADH",
  });
  const stalePhnomPenh = reference("VDPP", {
    type: "large_airport",
    name: "Phnom Penh International Airport",
    isoCountry: "KH",
    municipality: "Phnom Penh",
    gpsCode: "VDPP",
    iataCode: "PNH",
  });
  const identOnlyLocalCode = reference("PG-0123", {
    name: "Unnamed Strip",
    isoCountry: "PG",
    municipality: "Nowhere",
    iataCode: "XYZ",
  });

  it("labels an unscheduled small field with its local code, not its IATA code", () => {
    const resolve = createAirportResolver([bandonState]);
    for (const identifier of ["BDY", "S05", "KS05"]) {
      expect(resolve(identifier)).toMatchObject({
        status: "resolved",
        reference: { ident: "KS05" },
        airport: { code: "S05", name: "Bandon State Airport" },
      });
    }
  });

  it("keeps IATA codes for scheduled fields and for medium/large airports", () => {
    expect(
      createAirportResolver([scheduledBushField])("PAKI"),
    ).toMatchObject({ airport: { code: "KPN" } });
    expect(createAirportResolver([staleMediumAirport])("KADH")).toMatchObject({
      airport: { code: "ADT" },
    });
    expect(createAirportResolver([stalePhnomPenh])("VDPP")).toMatchObject({
      airport: { code: "PNH" },
    });
    expect(createAirportResolver([formerSiemReap])("REP")).toMatchObject({
      airport: { code: "REP" },
    });
  });

  it("does not let an ident-shaped local code preempt a real IATA code", () => {
    expect(
      createAirportResolver([identOnlyLocalCode])("PG-0123"),
    ).toMatchObject({ airport: { code: "XYZ" } });
  });

  it("resolves the same code at import time and from the persisted row", () => {
    const catalog = [
      bandonState,
      scheduledBushField,
      staleMediumAirport,
      stalePhnomPenh,
      identOnlyLocalCode,
      formerSiemReap,
      formerSchonefeld,
      berlinBrandenburg,
      siemReapAngkor,
      tonasket,
      omak,
      forks,
      quillayute,
    ];
    for (const source of catalog) {
      const resolution = createAirportResolver([source])(source.ident);
      expect(resolution.status).toBe("resolved");
      expect({
        ident: source.ident,
        code: preferredAirportCode(seededAirportRow(source)),
      }).toEqual({
        ident: source.ident,
        code:
          resolution.status === "resolved" ? resolution.airport.code : null,
      });
    }
  });

  it("keeps every alias resolvable after a code is demoted", () => {
    expect(
      airportIdentifierAliases(bandonState).map(({ code }) => code),
    ).toEqual(expect.arrayContaining(["BDY", "S05", "KS05"]));
  });
});
