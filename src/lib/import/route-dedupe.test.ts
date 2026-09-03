import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { applyDuplicateCandidates } from "./dedupe";
import { createRowFingerprint } from "./fingerprint";
import type {
  ImportAirportMatch,
  ProposedImportFlight,
  StoredImportRow,
} from "./types";

const airport = (code: string): Airport => ({
  code,
  name: code,
  city: code,
  country: "US",
  lat: 0,
  lon: 0,
  facility: "airstrip",
});

const stop = (code: string): ImportAirportMatch => ({
  status: "resolved",
  identifier: code,
  airportId: `airport-${code.toLowerCase()}`,
  airport: airport(code),
});

const unresolved = (identifier: string): ImportAirportMatch => ({
  status: "not-found",
  identifier,
});

function leg(
  stops: ImportAirportMatch[],
  overrides: Partial<ProposedImportFlight> = {},
): ProposedImportFlight {
  return {
    date: "2026-08-01",
    departureTime: "09:00",
    origin: stops[0],
    destination: stops.at(-1),
    airportMatches: stops.length > 2 ? stops : undefined,
    kind: "private",
    role: "pilot",
    registration: "N12345",
    aircraft: "Cessna 172",
    source: "CSV",
    ...overrides,
  };
}

function row(id: string, flight: ProposedImportFlight): StoredImportRow {
  return {
    id,
    batchId: "batch",
    rowNumber: 2,
    rawSnapshot: ["source truth"],
    proposedFlight: flight,
    issues: [],
    validationState: "ready",
    commitReady: true,
    decision: "pending",
    rowFingerprint: createRowFingerprint("user-a", flight),
    provenance: {
      adapterId: "generic-csv-v1",
      adapterLabel: "Generic mapped CSV",
      adapterVersion: 1,
      source: "CSV",
      sourceRowNumber: 2,
    },
  };
}

describe("route-gated duplicate detection", () => {
  it("commits every leg of a same-day, same-tail multi-leg day", () => {
    const staged = applyDuplicateCandidates(
      [
        row("row-1", leg([stop("KEUG"), stop("S05")])),
        row("row-2", leg([stop("S05"), stop("KRBG")], {
          departureTime: "10:15",
        })),
        row("row-3", leg([stop("KRBG"), stop("KEUG")], {
          departureTime: "11:20",
        })),
      ],
      [],
    );

    expect(staged.map(({ duplicateCandidate }) => duplicateCandidate)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(staged.map(({ validationState }) => validationState)).toEqual([
      "ready",
      "ready",
      "ready",
    ]);
  });

  it("still flags a genuine same-route re-import of one leg", () => {
    const [, second] = applyDuplicateCandidates(
      [
        row("row-1", leg([stop("S05"), stop("KRBG")])),
        row("row-2", leg([stop("S05"), stop("KRBG")], {
          departureTime: "09:30",
        })),
      ],
      [],
    );

    expect(second.validationState).toBe("duplicate");
    expect(second.duplicateCandidate).toMatchObject({
      scope: "staged-row",
      candidateId: "row-1",
    });
    expect(
      second.duplicateCandidate?.signals.map(({ code }) => code),
    ).toContain("same-route");
  });

  it("treats a reversed route as a different flight, not a duplicate", () => {
    const [, returnLeg] = applyDuplicateCandidates(
      [
        row("row-1", leg([stop("S05"), stop("KRBG")])),
        row("row-2", leg([stop("KRBG"), stop("S05")], {
          departureTime: "09:30",
        })),
      ],
      [],
    );

    expect(returnLeg.duplicateCandidate).toBeUndefined();
    expect(returnLeg.validationState).toBe("ready");
  });

  it("treats a longer multi-stop route as a different flight", () => {
    const [, threeStop] = applyDuplicateCandidates(
      [
        row("row-1", leg([stop("S05"), stop("KRBG")])),
        row(
          "row-2",
          leg([stop("S05"), stop("KRBG"), stop("KEUG")], {
            departureTime: "09:30",
          }),
        ),
      ],
      [],
    );

    expect(threeStop.duplicateCandidate).toBeUndefined();
    expect(threeStop.validationState).toBe("ready");
  });

  it("never treats two unresolved routes as the same route", () => {
    const [, second] = applyDuplicateCandidates(
      [
        row("row-1", leg([unresolved("???"), unresolved("???")])),
        row("row-2", leg([unresolved("???"), unresolved("???")], {
          departureTime: "09:30",
        })),
      ],
      [],
    );

    expect(second.duplicateCandidate).toBeUndefined();
  });

  it("never matches two flights that carry no route at all", () => {
    // Built without `leg()` on purpose: `leg()` always populates origin and
    // destination, so it cannot reach the case where a flight resolves to zero
    // stops. Every other signal agrees here (same date, minutes apart, same
    // tail, same aircraft/kind/role), which sums past the duplicate threshold,
    // so only the fewer-than-two-stops guard in `sameRoute` keeps these apart.
    const routeless = (
      overrides: Partial<ProposedImportFlight> = {},
    ): ProposedImportFlight => ({
      date: "2026-08-01",
      departureTime: "09:00",
      kind: "private",
      role: "pilot",
      registration: "N12345",
      aircraft: "Cessna 172",
      source: "CSV",
      ...overrides,
    });

    const first = routeless();
    const second = routeless({ departureTime: "09:30" });
    expect(first.origin).toBeUndefined();
    expect(first.destination).toBeUndefined();
    expect(first.airportMatches).toBeUndefined();

    const staged = applyDuplicateCandidates(
      [row("row-1", first), row("row-2", second)],
      [],
    );

    expect(staged.map(({ duplicateCandidate }) => duplicateCandidate)).toEqual([
      undefined,
      undefined,
    ]);
    expect(staged.map(({ validationState }) => validationState)).toEqual([
      "ready",
      "ready",
    ]);

    // `createRowFingerprint` is `VersionedFingerprint | undefined` and returns
    // undefined for a routeless flight, while an existing candidate always
    // carries a fingerprint. A literal non-matching stub keeps the assertion on
    // the scoring path: the staged row has no fingerprint of its own, so the
    // exact-fingerprint branch cannot fire and the route gate decides.
    const [againstExisting] = applyDuplicateCandidates(
      [row("row-3", first)],
      [
        {
          flightId: "flight-a",
          fingerprint: {
            algorithm: "sha256",
            version: 1,
            value: "existing-routeless",
          },
          flight: second,
        },
      ],
    );

    expect(againstExisting.duplicateCandidate).toBeUndefined();
    expect(againstExisting.validationState).toBe("ready");
  });

  it("keeps an identical fingerprint a duplicate without consulting the route", () => {
    const staged = row("row-1", leg([stop("KEUG"), stop("KRBG")]));
    const [assessed] = applyDuplicateCandidates(
      [staged],
      [
        {
          flightId: "flight-a",
          fingerprint: staged.rowFingerprint!,
          flight: leg([stop("S05"), stop("KRBG")]),
        },
      ],
    );

    expect(assessed.duplicateCandidate).toMatchObject({
      scope: "existing-flight",
      candidateId: "flight-a",
      score: 1,
    });
    expect(
      assessed.duplicateCandidate?.signals.map(({ code }) => code),
    ).toEqual(["exact-fingerprint"]);
  });
});
