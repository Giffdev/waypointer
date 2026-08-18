import { requireAuthenticatedUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  previewMapSharing,
  ShareValidationError,
} from "@/lib/sharing/service";
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
    return Response.json({
      preview: await previewMapSharing(user.id, await request.json()),
    });
  } catch (error) {
    return accountApiError(
      error instanceof ShareValidationError
        ? new AccountRequestError(
            400,
            "invalid-sharing-selection",
            "The sharing selection is invalid.",
          )
        : error,
    );
  }
}
