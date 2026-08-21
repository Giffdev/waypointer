import { requireAuthenticatedUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  regenerateMapShare,
  ShareNotFoundError,
} from "@/lib/sharing/service";
import {
  SHARING_NO_STORE_HEADERS,
  withSharingNoStore,
} from "@/lib/sharing/http";
import { AccountRequestError, accountApiError } from "../../_lib/response";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireAuthenticatedUser();
    assertSameOrigin(request);
    return Response.json(
      { sharing: await regenerateMapShare(user.id) },
      { headers: SHARING_NO_STORE_HEADERS },
    );
  } catch (error) {
    return withSharingNoStore(
      accountApiError(
        error instanceof ShareNotFoundError
          ? new AccountRequestError(
              409,
              "sharing-not-enabled",
              "Enable sharing before regenerating the link.",
            )
          : error,
      ),
    );
  }
}
