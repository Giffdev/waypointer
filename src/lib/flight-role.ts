import type { FlightKind, FlightRole } from "./flight-data";

export type FlightClassification = "personal" | "commercial";
export type FlightRoleOrigin =
  | "source-default"
  | "explicit"
  | "legacy-unresolved";

export type FlightRoleFields = {
  kind: FlightKind;
  role: FlightRole;
};

const PERSONAL: FlightRoleFields = { kind: "private", role: "pilot" };
const COMMERCIAL: FlightRoleFields = {
  kind: "commercial",
  role: "passenger",
};

export function flightRoleFields(
  classification: FlightClassification,
): FlightRoleFields {
  return classification === "personal" ? PERSONAL : COMMERCIAL;
}

export function sourceRoleDefault(input: {
  adapterId: string;
  presetId?: string;
}): FlightRoleFields | null {
  if (input.adapterId === "foreflight-v1") return PERSONAL;
  if (input.adapterId === "myflightradar24-v1") return COMMERCIAL;
  if (
    input.adapterId === "generic-csv-v1" &&
    (input.presetId === "myflightbook-export" ||
      input.presetId === "crewlounge-pilotlog")
  ) {
    return PERSONAL;
  }
  return null;
}
