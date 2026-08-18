import type { Flight } from "../flight-data";
import {
  flightRoleFields,
  type FlightClassification,
} from "../flight-role";
import type { AirportRepository } from "../db/repositories/airport-repository";
import type { FlightRepository } from "../db/repositories/flight-repository";
import { DrizzleImportRepository } from "../db/repositories/drizzle-import-repository";
import { createRowFingerprint } from "../import/fingerprint";
import type { ProposedImportFlight } from "../import/types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CreateManualFlightRequest = {
  classification: FlightClassification;
  date: string;
  originAirportId: string;
  destinationAirportId: string;
  intermediateAirportIds?: string[];
  departureTime?: string;
  durationHours?: number;
  distanceMiles?: number;
  aircraft?: string;
  aircraftType?: string;
  aircraftModel?: string;
  registration?: string;
  flightNumber?: string;
  airline?: string;
};

export class FlightServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FlightServiceError";
  }
}

type ManualFlightRepository = FlightRepository & AirportRepository;

export async function createManualFlight(
  userId: string,
  input: unknown,
  repository: ManualFlightRepository = new DrizzleImportRepository(),
): Promise<Flight> {
  const request = validateManualFlightRequest(input);
  const airportIds = [
    request.originAirportId,
    ...(request.intermediateAirportIds ?? []),
    request.destinationAirportId,
  ];
  const airportMatches = await Promise.all(
    airportIds.map((airportId) => repository.findById(userId, airportId)),
  );
  if (airportMatches.some((airport) => !airport)) {
    throw new FlightServiceError(
      400,
      "invalid-airport",
      "Every selected airport must exist.",
    );
  }
  const resolvedAirports = airportMatches.filter(
    (airport): airport is NonNullable<typeof airport> => Boolean(airport),
  );
  const origin = resolvedAirports[0];
  const destination = resolvedAirports.at(-1)!;
  const proposal: ProposedImportFlight = {
    date: request.date,
    departureTime: request.departureTime,
    originIdentifier: origin.identifier,
    destinationIdentifier: destination.identifier,
    origin,
    destination,
    airportIdentifiers: resolvedAirports.map(({ identifier }) => identifier),
    airportMatches: resolvedAirports,
    ...flightRoleFields(request.classification),
    aircraft: request.aircraft,
    aircraftType: request.aircraftType,
    aircraftModel: request.aircraftModel,
    registration: request.registration,
    flightNumber: request.flightNumber,
    airline: request.airline,
    distanceMiles: request.distanceMiles,
    durationHours: request.durationHours,
    source: "Manual",
    classificationOrigin: "explicit",
  };
  const fingerprint = createRowFingerprint(userId, proposal);
  if (!fingerprint) {
    throw new FlightServiceError(
      400,
      "invalid-flight",
      "The manual flight is incomplete.",
    );
  }
  const result = await repository.createManualFlight(userId, {
    proposal,
    fingerprint,
  });
  if (!result.created) {
    throw new FlightServiceError(
      409,
      "duplicate-flight",
      "An equivalent flight already exists.",
    );
  }
  const flight = (await repository.listFlights(userId)).find(
    ({ id }) => id === result.flightId,
  );
  if (!flight) throw new Error("Created manual flight could not be read");
  return flight;
}

export function validateManualFlightRequest(
  input: unknown,
): CreateManualFlightRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidFlight();
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "classification",
    "date",
    "originAirportId",
    "destinationAirportId",
    "intermediateAirportIds",
    "departureTime",
    "durationHours",
    "distanceMiles",
    "aircraft",
    "aircraftType",
    "aircraftModel",
    "registration",
    "flightNumber",
    "airline",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidFlight();
  if (
    value.classification !== "personal" &&
    value.classification !== "commercial"
  ) {
    throw new FlightServiceError(
      400,
      "classification-required",
      "Choose personal or commercial.",
    );
  }
  const date = requiredString(value.date, 10);
  if (!isCivilDate(date)) throw invalidFlight();
  const originAirportId = requiredString(value.originAirportId, 36);
  const destinationAirportId = requiredString(value.destinationAirportId, 36);
  const intermediateAirportIds = optionalUuidArray(
    value.intermediateAirportIds,
  );
  if (
    !UUID_PATTERN.test(originAirportId) ||
    !UUID_PATTERN.test(destinationAirportId)
  ) {
    throw invalidFlight();
  }
  const airportIds = [
    originAirportId,
    ...intermediateAirportIds,
    destinationAirportId,
  ];
  if (
    airportIds.some(
      (airportId, index) => index > 0 && airportId === airportIds[index - 1],
    ) ||
    (originAirportId === destinationAirportId &&
      intermediateAirportIds.length === 0)
  ) {
    throw new FlightServiceError(
      400,
      "invalid-route",
      "A route must contain at least one meaningful leg.",
    );
  }
  const departureTime = optionalTime(value.departureTime);
  const durationHours = optionalNumber(value.durationHours, 0, 10_000);
  const distanceMiles = optionalNumber(value.distanceMiles, 0, 30_000);
  return {
    classification: value.classification,
    date,
    originAirportId,
    destinationAirportId,
    ...(intermediateAirportIds.length ? { intermediateAirportIds } : {}),
    ...(departureTime ? { departureTime } : {}),
    ...(durationHours !== undefined ? { durationHours } : {}),
    ...(distanceMiles !== undefined ? { distanceMiles } : {}),
    ...optionalMetadata(value, "aircraft", 160),
    ...optionalMetadata(value, "aircraftType", 120),
    ...optionalMetadata(value, "aircraftModel", 160),
    ...optionalMetadata(value, "registration", 40, true),
    ...optionalMetadata(value, "flightNumber", 40),
    ...optionalMetadata(value, "airline", 160),
  };
}

function optionalUuidArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw invalidFlight();
  return value.map((entry) => {
    const airportId = requiredString(entry, 36);
    if (!UUID_PATTERN.test(airportId)) throw invalidFlight();
    return airportId;
  });
}

function invalidFlight(): FlightServiceError {
  return new FlightServiceError(
    400,
    "invalid-flight",
    "The manual flight is invalid.",
  );
}

function requiredString(value: unknown, max: number): string {
  if (typeof value !== "string") throw invalidFlight();
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw invalidFlight();
  return normalized;
}

function optionalMetadata(
  input: Record<string, unknown>,
  key: keyof CreateManualFlightRequest,
  max: number,
  uppercase = false,
): Partial<CreateManualFlightRequest> {
  const value = input[key];
  if (value === undefined || value === null || value === "") return {};
  const normalized = requiredString(value, max);
  return { [key]: uppercase ? normalized.toUpperCase() : normalized };
}

function optionalNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidFlight();
  }
  return value;
}

function optionalTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw invalidFlight();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(
    value.trim(),
  );
  if (!match) throw invalidFlight();
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}`;
}

function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
