import { requireAuthenticatedUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  DISTANCE_UNITS,
  getOwnerProfile,
  updateOwnerProfile,
  updateOwnerMapViewMode,
  type DistanceUnit,
} from "@/lib/profile/service";
import { isMapViewMode } from "@/lib/map-view-mode";
import { accountApiError, AccountRequestError } from "../_lib/response";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireAuthenticatedUser();
    return Response.json({ profile: await getOwnerProfile(user.id) });
  } catch (error) {
    return accountApiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireAuthenticatedUser();
    assertSameOrigin(request);
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new AccountRequestError(415, "unsupported-content-type", "JSON is required.");
    }
    const body = (await request.json()) as Record<string, unknown>;
    if (
      Object.keys(body).length === 1 &&
      Object.hasOwn(body, "mapViewMode")
    ) {
      if (!isMapViewMode(body.mapViewMode)) {
        throw new AccountRequestError(400, "invalid-profile", "The profile settings are invalid.");
      }
      return Response.json({
        profile: await updateOwnerMapViewMode(user.id, body.mapViewMode),
      });
    }
    const allowed = new Set([
      "username",
      "displayName",
      "timeZone",
      "distanceUnit",
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      throw new AccountRequestError(400, "invalid-profile", "The profile settings are invalid.");
    }
    const distanceUnit = String(body.distanceUnit ?? "") as DistanceUnit;
    if (!DISTANCE_UNITS.includes(distanceUnit)) {
      throw new AccountRequestError(400, "invalid-profile", "The profile settings are invalid.");
    }
    const profile = await updateOwnerProfile(user.id, {
      username: String(body.username ?? ""),
      displayName: String(body.displayName ?? ""),
      timeZone: String(body.timeZone ?? ""),
      distanceUnit,
    });
    return Response.json({ profile });
  } catch (error) {
    return accountApiError(error);
  }
}
