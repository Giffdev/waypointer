import MapRouteClient from "./route-client";
import { getOptionalAuthenticatedUser } from "@/lib/auth/guards";
import { getInitialFilters } from "@/components/dashboard-shared";
import { getOwnerRouteData } from "@/lib/owner-route-data";
import { buildMapPageContract } from "@/lib/route-page-data";

export const dynamic = "force-dynamic";

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const routeData = await getOwnerRouteData(
    await getOptionalAuthenticatedUser(),
  );
  return (
    <MapRouteClient
      data={buildMapPageContract(
        getInitialFilters(await searchParams),
        routeData.flightData,
        routeData.statisticsContext,
        routeData.distanceUnit,
        routeData.mapViewMode,
      )}
    />
  );
}
