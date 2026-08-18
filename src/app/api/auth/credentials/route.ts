import { NextResponse } from "next/server";
import { authenticateCredentials } from "@/lib/auth/credentials";
import { assertSameOrigin, requestIp } from "@/lib/auth/request";
import { createDatabaseSession } from "@/lib/auth/session-cookie";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const form = await request.formData();
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const user = await authenticateCredentials({
      email,
      password,
      ip: requestIp(request),
    });
    if (!user) {
      return NextResponse.redirect(
        new URL("/auth/sign-in?error=invalid-credentials", request.url),
        303,
      );
    }
    await createDatabaseSession(user.id);
    return NextResponse.redirect(new URL("/map", request.url), 303);
  } catch {
    return NextResponse.redirect(
      new URL("/auth/sign-in?error=sign-in-unavailable", request.url),
      303,
    );
  }
}
