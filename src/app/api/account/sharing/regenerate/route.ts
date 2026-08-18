import { requireAuthenticatedUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  regenerateMapShare,
  ShareNotFoundError,
} from "@/lib/sharing/service";
import { AccountRequestError, accountApiError } from "../../_lib/response";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireAuthenticatedUser();
    assertSameOrigin(request);
    return Response.json({ sharing: await regenerateMapShare(user.id) });
  } catch (error) {
    return accountApiError(
      error instanceof ShareNotFoundError
        ? new AccountRequestError(
            409,
            "sharing-not-enabled",
            "Enable sharing before regenerating the link.",
          )
        : error,
    );
  }
}
