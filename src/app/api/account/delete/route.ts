import { requireAuthenticatedUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  clearDatabaseSessionCookie,
} from "@/lib/auth/session-cookie";
import { requestAccountDeletion } from "@/lib/auth/account-deletion";
import { accountApiError, AccountRequestError } from "../_lib/response";
import { isAccountDeletionEnabled } from "@/lib/auth/capabilities";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!isAccountDeletionEnabled()) {
      throw new AccountRequestError(
        503,
        "feature-unavailable",
        "Account deletion is temporarily unavailable.",
      );
    }
    const user = await requireAuthenticatedUser();
    assertSameOrigin(request);
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new AccountRequestError(415, "unsupported-content-type", "JSON is required.");
    }
    const body = (await request.json()) as Record<string, unknown>;
    if (
      Object.keys(body).some(
        (key) => !["password", "confirmation"].includes(key),
      ) ||
      body.confirmation !== "DELETE"
    ) {
      throw new AccountRequestError(
        400,
        "invalid-confirmation",
        "Account deletion requires explicit confirmation.",
      );
    }
    const publicOrigin =
      process.env.AUTH_URL?.trim() || new URL(request.url).origin;
    const result = await requestAccountDeletion({
      userId: user.id,
      password:
        typeof body.password === "string" ? body.password : undefined,
      publicOrigin,
    });
    await clearDatabaseSessionCookie();
    return Response.json(result, { status: 202 });
  } catch (error) {
    return accountApiError(error);
  }
}
