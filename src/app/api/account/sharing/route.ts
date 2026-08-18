import { requireAuthenticatedUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  disableMapSharing,
  enableMapSharing,
  getOwnerShareStatus,
  SharePreviewMismatchError,
  ShareValidationError,
} from "@/lib/sharing/service";
import { AccountRequestError, accountApiError } from "../_lib/response";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireAuthenticatedUser();
    return Response.json({ sharing: await getOwnerShareStatus(user.id) });
  } catch (error) {
    return accountApiError(error);
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
    return Response.json({
      sharing: await enableMapSharing(user.id, await request.json()),
    });
  } catch (error) {
    return accountApiError(
      error instanceof SharePreviewMismatchError
        ? new AccountRequestError(
            409,
            "sharing-preview-stale",
            "The sharing preview changed. Review it again before enabling.",
          )
        : error instanceof ShareValidationError
          ? new AccountRequestError(
              400,
              "invalid-sharing-selection",
              "Choose a valid sharing scope and preview it first.",
            )
          : error,
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireAuthenticatedUser();
    assertSameOrigin(request);
    return Response.json({ sharing: await disableMapSharing(user.id) });
  } catch (error) {
    return accountApiError(error);
  }
}
