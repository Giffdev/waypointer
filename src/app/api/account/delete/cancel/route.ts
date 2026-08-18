import { NextResponse } from "next/server";
import { cancelAccountDeletion } from "@/lib/auth/account-deletion";
import { assertSameOrigin } from "@/lib/auth/request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const destination = new URL(
    "/auth/delete-cancel?result=processed",
    request.url,
  );
  try {
    assertSameOrigin(request);
    const form = await request.formData();
    const token = String(form.get("token") ?? "");
    await cancelAccountDeletion(token);
  } catch {
    // The response is intentionally identical for invalid, expired, and used links.
  }
  return NextResponse.redirect(destination, 303);
}
