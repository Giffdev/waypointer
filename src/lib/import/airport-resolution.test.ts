import { describe, expect, it } from "vitest";
import { importProposalValidationState } from "./review";
import {
  auditAirportReferences,
  airportSearchKey,
  airportSearchPhoneticKeys,
  createAirportResolver,
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
