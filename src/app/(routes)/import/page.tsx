import ImportRouteClient from "./route-client";
import { getOptionalAuthenticatedUser } from "@/lib/auth/guards";
import { getLocalFlightData } from "@/lib/local-flight-data";
import { buildImportPageContract } from "@/lib/route-page-data";
import { getImportRuntimeCapability } from "@/lib/runtime-mode";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await getOptionalAuthenticatedUser();
  const capability = getImportRuntimeCapability();
  return (
    <ImportRouteClient
      data={buildImportPageContract(getLocalFlightData())}
      apiEnabled={Boolean(user) && capability.available}
      durableImportEnabled={capability.durable}
      maxFileBytes={capability.maxFileBytes}
      unavailableReason={capability.unavailableReason}
      developmentPreviewEnabled={
        !user && process.env.FLIGHT_MAP_DEV_PREVIEW === "true"
      }
    />
  );
}
