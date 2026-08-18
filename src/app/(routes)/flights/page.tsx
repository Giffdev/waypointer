import FlightsRouteClient from "./route-client";
import { getOptionalAuthenticatedUser } from "@/lib/auth/guards";
import { getInitialFilters } from "@/components/dashboard-shared";
import { getOwnerRouteData } from "@/lib/owner-route-data";
import { buildFlightsPageContract } from "@/lib/route-page-data";

export const dynamic = "force-dynamic";

export default async function FlightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const routeData = await getOwnerRouteData(
    await getOptionalAuthenticatedUser(),
  );
  return (
    <FlightsRouteClient
      data={buildFlightsPageContract(
        getInitialFilters(await searchParams),
        routeData.flightData,
        routeData.statisticsContext,
        routeData.distanceUnit,
      )}
    />
  );
}
