import { requireAuthenticatedUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  disableMapSharing,
  enableMapSharing,
  getOwnerShareStatus,
  ShareEmptyMapError,
} from "@/lib/sharing/service";
import {
  SHARING_NO_STORE_HEADERS,
  withSharingNoStore,
} from "@/lib/sharing/http";
import { AccountRequestError, accountApiError } from "../_lib/response";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireAuthenticatedUser();
    return Response.json(
      { sharing: await getOwnerShareStatus(user.id) },
      { headers: SHARING_NO_STORE_HEADERS },
    );
  } catch (error) {
    return withSharingNoStore(accountApiError(error));
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAuthenticatedUser();
    assertSameOrigin(request);
    return Response.json(
      {
        sharing: await enableMapSharing(user.id),
      },
      { headers: SHARING_NO_STORE_HEADERS },
    );
  } catch (error) {
    return withSharingNoStore(
      accountApiError(
        error instanceof ShareEmptyMapError
          ? new AccountRequestError(
              409,
              "sharing-map-empty",
              "Upload flight data before sharing your map.",
            )
          : error,
      ),
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireAuthenticatedUser();
    assertSameOrigin(request);
    return Response.json(
      { sharing: await disableMapSharing(user.id) },
      { headers: SHARING_NO_STORE_HEADERS },
    );
  } catch (error) {
    return withSharingNoStore(accountApiError(error));
  }
}
