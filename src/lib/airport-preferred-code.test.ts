import { describe, expect, it } from "vitest";
import {
  isPublicAirportCode,
  preferredAirportCode,
  prefersLocalAirportCode,
  type AirportCatalogIdentity,
  type AirportIdentifierFields,
} from "./airport-preferred-code";

const fields = (
  overrides: Partial<AirportIdentifierFields> = {},
): AirportIdentifierFields => ({
  iata: null,
  localCode: null,
  icao: null,
  sourceIdent: null,
  ...overrides,
});

const reference = (
  overrides: Partial<AirportCatalogIdentity> = {},
): AirportCatalogIdentity => ({
  type: "small_airport",
  scheduledService: false,
  ident: "KS05",
  iataCode: "BDY",
  localCode: "S05",
  ...overrides,
});

describe("preferred airport code", () => {
  it("uses the private-map preference order with a safe source fallback", () => {
    expect(
      preferredAirportCode(
        fields({
          iata: "SEA",
          localCode: "SEA-LOCAL",
          icao: "KSEA",
          sourceIdent: "US-0001",
        }),
      ),
    ).toBe("SEA");
    expect(preferredAirportCode(fields({ sourceIdent: "US-0001" }))).toBe(
      "US-0001",
    );
  });

  it("accepts real R-number identifiers but never accepts UUID fallback data", () => {
    expect(isPublicAirportCode("R47")).toBe(true);
    expect(preferredAirportCode(fields())).toBeNull();
  });

  it("falls through to the local code when the catalog withheld IATA", () => {
    // The persisted shape of Bandon State once prefersLocalAirportCode has
    // been applied at catalog-build time.
    expect(
      preferredAirportCode(
        fields({
          iata: null,
          localCode: "S05",
          icao: "KS05",
          sourceIdent: "KS05",
        }),
      ),
    ).toBe("S05");
  });
});

describe("local airport identifier policy", () => {
  it("demotes the unused IATA code of an unscheduled small field", () => {
    expect(prefersLocalAirportCode(reference())).toBe(true);
  });

  it("keeps major airport IATA codes despite a stale scheduled-service flag", () => {
    // Every one of these is marked scheduled_service="no" upstream, which is
    // why the flag can never gate the policy on its own.
    const majors: AirportCatalogIdentity[] = [
      reference({
        type: "large_airport",
        ident: "VDPP",
        iataCode: "PNH",
        localCode: null,
      }),
      reference({
        type: "large_airport",
        ident: "UKOO",
        iataCode: "ODS",
        localCode: null,
      }),
      reference({
        type: "large_airport",
        ident: "ZMUB",
        iataCode: "ULN",
        localCode: null,
      }),
      reference({
        type: "large_airport",
        ident: "LTBA",
        iataCode: "ISL",
        localCode: null,
      }),
      reference({
        type: "large_airport",
        ident: "AU-0539",
        iataCode: "WSI",
        localCode: "YSWS",
      }),
      reference({
        type: "medium_airport",
        ident: "KADH",
        iataCode: "ADT",
        localCode: "ADH",
      }),
      reference({
        type: "medium_airport",
        ident: "07FA",
        iataCode: "OCA",
        localCode: "07FA",
      }),
    ];
    expect(majors.map((airport) => prefersLocalAirportCode(airport))).toEqual(
      majors.map(() => false),
    );
  });

  it("keeps IATA for scheduled small fields and non-airport facilities", () => {
    expect(prefersLocalAirportCode(reference({ scheduledService: true }))).toBe(
      false,
    );
    for (const type of [
      "seaplane_base",
      "heliport",
      "balloonport",
      "closed",
      "medium_airport",
      "large_airport",
    ]) {
      expect(prefersLocalAirportCode(reference({ type })), type).toBe(false);
    }
  });

  it("leaves airports without an IATA code alone", () => {
    expect(
      prefersLocalAirportCode(reference({ iataCode: null })),
    ).toBe(false);
    expect(prefersLocalAirportCode(reference({ iataCode: "" }))).toBe(false);
  });

  it("ignores a local code that only repeats the source identifier", () => {
    expect(
      prefersLocalAirportCode(
        reference({ ident: "PG-0123", localCode: " pg-0123 ", iataCode: "XYZ" }),
      ),
    ).toBe(false);
    expect(prefersLocalAirportCode(reference({ localCode: null }))).toBe(false);
  });

  it("compares the local code to IATA without case or whitespace noise", () => {
    expect(
      prefersLocalAirportCode(
        reference({ ident: "LFBU", localCode: " ang ", iataCode: "ANG" }),
      ),
    ).toBe(false);
    expect(
      prefersLocalAirportCode(reference({ type: " Small_Airport " })),
    ).toBe(true);
  });

  it("keeps an IATA code that is the airport's own source identifier", () => {
    // The guard is symmetric with the local-code check above: when the
    // OurAirports `ident` *is* the IATA code, that code is the field's only
    // real identity and the unrelated local code must not displace it. These
    // are verbatim rows from the pinned catalog (PG, AU and MX strips) and are
    // the 54 airports this rule holds back from the demotion cohort.
    const identIsIata: AirportCatalogIdentity[] = [
      reference({ ident: "ABP", iataCode: "ABP", localCode: "AKA" }),
      reference({ ident: "AGG", iataCode: "AGG", localCode: "ANG" }),
      reference({ ident: "BCZ", iataCode: "BCZ", localCode: "YBIC" }),
      reference({ ident: "BHL", iataCode: "BHL", localCode: "BAX" }),
      // Case and whitespace must not defeat the guard either.
      reference({ ident: " bov ", iataCode: "BOV", localCode: "BOG" }),
    ];
    expect(
      identIsIata.map((airport) => prefersLocalAirportCode(airport)),
    ).toEqual(identIsIata.map(() => false));
    // Bandon State is unaffected: its ident (`KS05`) is not its IATA code.
    expect(prefersLocalAirportCode(reference())).toBe(true);
  });
});
