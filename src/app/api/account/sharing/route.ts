import { requireAuthenticatedUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  disableMapSharing,
  enableMapSharing,
  getOwnerShareStatus,
  SharePreviewMismatchError,
  ShareValidationError,
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
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new AccountRequestError(
        415,
        "unsupported-content-type",
        "JSON is required.",
      );
    }
    return Response.json(
      {
        sharing: await enableMapSharing(user.id, await request.json()),
      },
      { headers: SHARING_NO_STORE_HEADERS },
    );
  } catch (error) {
    return withSharingNoStore(
      accountApiError(
        error instanceof SharePreviewMismatchError
          ? new AccountRequestError(
              409,
              "sharing-preview-stale",
              "The sharing preview changed. Review it again before enabling.",
            )
          : error instanceof ShareValidationError
            ? new AccountRequestError(
                400,
                "invalid-sharing-request",
                "Submit the display-name choice and its exact preview.",
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
