import type {
  AirportSearchResult,
  ImportAirportMatch,
} from "@/lib/import/types";

export interface AirportRepository {
  resolveIdentifier(
    userId: string,
    identifier: string,
  ): Promise<ImportAirportMatch>;
  findById(userId: string, airportId: string): Promise<ImportAirportMatch | null>;
  search(
    userId: string,
    query: string,
    limit: number,
  ): Promise<AirportSearchResult[]>;
}
