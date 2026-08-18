import { NextResponse } from "next/server";
import {
  isPasswordBreached,
  validatePassword,
} from "@/lib/auth/password";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { assertSameOrigin, requestIp } from "@/lib/auth/request";
import { isValidUsername, normalizeUsername } from "@/lib/auth/username";

export const runtime = "nodejs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json().catch(() => null);
    const email =
      body && typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : "";
    const username =
      body && typeof body.username === "string"
        ? normalizeUsername(body.username)
        : "";
    const password =
      body && typeof body.password === "string" ? body.password : "";
    await consumeRateLimit(
      "register-ip",
      requestIp(request),
      8,
      60 * 60_000,
    );
    await consumeRateLimit(
      "register-email",
      email || "invalid",
      4,
      60 * 60_000,
    );
    if (
      !EMAIL_PATTERN.test(email) ||
      !isValidUsername(username) ||
      validatePassword(password) ||
      (await isPasswordBreached(password))
    ) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
