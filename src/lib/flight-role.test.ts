import { describe, expect, it } from "vitest";
import { sourceRoleDefault } from "./flight-role";

describe("flight role source defaults", () => {
  it("classifies logbooks as personal and travel history as commercial", () => {
    expect(sourceRoleDefault({ adapterId: "foreflight-v1" })).toEqual({
      kind: "private",
      role: "pilot",
    });
    expect(
      sourceRoleDefault({
        adapterId: "generic-csv-v1",
        presetId: "myflightbook-export",
      }),
    ).toEqual({ kind: "private", role: "pilot" });
    expect(
      sourceRoleDefault({
        adapterId: "generic-csv-v1",
        presetId: "crewlounge-pilotlog",
      }),
    ).toEqual({ kind: "private", role: "pilot" });
    expect(sourceRoleDefault({ adapterId: "myflightradar24-v1" })).toEqual({
      kind: "commercial",
      role: "passenger",
    });
  });

  it("does not guess for an unprofiled generic CSV", () => {
    expect(sourceRoleDefault({ adapterId: "generic-csv-v1" })).toBeNull();
  });
});
