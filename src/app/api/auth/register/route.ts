import { createHash, randomBytes } from "node:crypto";
import { eq, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { users, verificationTokens } from "@/lib/db/schema";
import { sendVerificationEmail } from "@/lib/auth/email";
import {
  hashPassword,
  isPasswordBreached,
  validatePassword,
} from "@/lib/auth/password";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { applyBreachedPasswordWarning } from "@/lib/auth/registration-warning";
import { assertSameOrigin, requestIp } from "@/lib/auth/request";
import { isValidPublicHandle, normalizeUsername } from "@/lib/auth/username";

export const runtime = "nodejs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorRedirect(request: Request, code: string) {
  return NextResponse.redirect(
    new URL(`/auth/register?error=${encodeURIComponent(code)}`, request.url),
    303,
  );
}

export async function POST(request: Request) {
  let stage = "request";
  try {
    assertSameOrigin(request);
    const form = await request.formData();
    stage = "validation";
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const username = normalizeUsername(String(form.get("username") ?? ""));
    const password = String(form.get("password") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");

    stage = "rate-limit";
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

    if (!EMAIL_PATTERN.test(email)) return errorRedirect(request, "invalid-email");
    if (!isValidPublicHandle(username)) {
      return errorRedirect(request, "invalid-username");
    }
    const passwordError = validatePassword(password);
    if (passwordError || password !== confirmPassword) {
      return errorRedirect(request, "invalid-password");
    }

    stage = "account-lookup";
    const [existing] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          sql`lower(${users.email}) = ${email}`,
          sql`lower(${users.username}) = ${username}`,
        ),
      )
      .limit(1);
    if (existing) {
      return NextResponse.redirect(new URL("/auth/verify?sent=true", request.url), 303);
    }

    stage = "password-screening";
    const [passwordHash, breached] = await Promise.all([
      hashPassword(password),
      isPasswordBreached(password),
    ]);
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const identifier = `email-verification:${email}`;
    const expires = new Date(Date.now() + 24 * 60 * 60_000);

    stage = "account-persistence";
    const [created] = await getDb()
      .insert(users)
      .values({
        email,
        username,
        name: username,
        passwordHash,
      })
      .returning({ id: users.id });
    await getDb()
      .delete(verificationTokens)
      .where(eq(verificationTokens.identifier, identifier));
    await getDb().insert(verificationTokens).values({
      identifier,
      token: tokenHash,
      expires,
    });

    const publicOrigin = process.env.AUTH_URL?.trim() || new URL(request.url).origin;
    const verificationUrl = new URL("/auth/verify", publicOrigin);
    verificationUrl.searchParams.set("email", email);
    verificationUrl.searchParams.set("token", rawToken);
    stage = "verification-delivery";
    const delivery = await sendVerificationEmail({
      email,
      verificationUrl: verificationUrl.toString(),
    }).catch(async (error) => {
      await getDb()
        .delete(verificationTokens)
        .where(eq(verificationTokens.identifier, identifier));
      await getDb().delete(users).where(eq(users.id, created.id));
      throw error;
    });

    if (delivery.developmentUrl) {
      const developmentUrl = new URL(delivery.developmentUrl);
      developmentUrl.searchParams.set("development", "true");
      return applyBreachedPasswordWarning(
        NextResponse.redirect(developmentUrl, 303),
        breached,
      );
    }

    const destination = new URL("/auth/verify", request.url);
    destination.searchParams.set("sent", "true");
    return applyBreachedPasswordWarning(
      NextResponse.redirect(destination, 303),
      breached,
    );
  } catch (error) {
    const safeError =
      typeof error === "object" && error !== null
        ? {
            name:
              "name" in error && typeof error.name === "string"
                ? error.name
                : "Error",
            code:
              "code" in error && typeof error.code === "string"
                ? error.code
                : undefined,
            causeName:
              "cause" in error &&
              typeof error.cause === "object" &&
              error.cause !== null &&
              "name" in error.cause &&
              typeof error.cause.name === "string"
                ? error.cause.name
                : undefined,
            causeCode:
              "cause" in error &&
              typeof error.cause === "object" &&
              error.cause !== null &&
              "code" in error.cause &&
              typeof error.cause.code === "string"
                ? error.cause.code
                : undefined,
          }
        : { name: "Error", code: undefined };
    console.error("Registration unavailable.", { stage, ...safeError });
    return errorRedirect(request, "registration-unavailable");
  }
}
