import { requireAuthenticatedUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  previewMapSharing,
  ShareEmptyMapError,
  ShareFlightLimitError,
  ShareValidationError,
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
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new AccountRequestError(
        415,
        "unsupported-content-type",
        "JSON is required.",
      );
    }
    return Response.json(
      {
        preview: await previewMapSharing(user.id, await request.json()),
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
              "Your map does not have any flights to share yet.",
            )
          : error instanceof ShareFlightLimitError
            ? new AccountRequestError(
                409,
                "sharing-flight-limit",
                "Waypointer supports complete shared maps with up to 500 flights.",
              )
            : error instanceof ShareValidationError
              ? new AccountRequestError(
                  400,
                  "invalid-sharing-request",
                  "Choose whether to include your display name.",
                )
              : error,
      ),
    );
  }
}
