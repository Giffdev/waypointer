import "server-only";

import type { AuthenticatedUser } from "./auth/guards";
import { DrizzleImportRepository } from "./db/repositories/drizzle-import-repository";
import { getLocalFlightData } from "./local-flight-data";
import { getLocalFlightStatisticsContext } from "./local-flight-statistics";
import {
  buildPersistedFlightData,
  buildPersistedFlightStatisticsContext,
} from "./persisted-flight-data";
import { DEFAULT_DISTANCE_UNIT } from "./distance-unit";
import { getOwnerProfile } from "./profile/service";
import { DEFAULT_MAP_VIEW_MODE } from "./map-view-mode";

export async function getOwnerRouteData(user: AuthenticatedUser | null) {
  if (!user) {
    return {
      flightData: getLocalFlightData(),
      statisticsContext: getLocalFlightStatisticsContext(),
      distanceUnit: DEFAULT_DISTANCE_UNIT,
      mapViewMode: DEFAULT_MAP_VIEW_MODE,
    };
  }

  const [flights, profile] = await Promise.all([
    new DrizzleImportRepository().listFlights(user.id),
    getOwnerProfile(user.id),
  ]);
  return {
    flightData: buildPersistedFlightData(flights),
    statisticsContext: buildPersistedFlightStatisticsContext(flights),
    distanceUnit: profile.distanceUnit,
    mapViewMode: profile.mapViewMode,
  };
}
