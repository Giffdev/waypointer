import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { users, verificationTokens } from "@/lib/db/schema";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { assertSameOrigin, requestIp } from "@/lib/auth/request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const form = await request.formData();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const rawToken = String(form.get("token") ?? "");
    const token = createHash("sha256").update(rawToken).digest("hex");
    const identifier = `email-verification:${email}`;

    await Promise.all([
      consumeRateLimit("verify-ip", requestIp(request), 20, 15 * 60_000),
      consumeRateLimit("verify-email", email || "invalid", 10, 15 * 60_000),
    ]);

    const verified = await getDb().transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(verificationTokens)
        .where(
          and(
            eq(verificationTokens.identifier, identifier),
            eq(verificationTokens.token, token),
            gt(verificationTokens.expires, new Date()),
          ),
        )
        .limit(1);
      if (!match) return false;

      const [updated] = await tx
        .update(users)
        .set({ emailVerified: new Date(), updatedAt: new Date() })
        .where(sql`lower(${users.email}) = ${email}`)
        .returning({ id: users.id });
      if (!updated) return false;

      await tx
        .delete(verificationTokens)
        .where(eq(verificationTokens.identifier, identifier));
      return true;
    });

    return NextResponse.redirect(
      new URL(
        verified
          ? "/auth/sign-in?verified=true"
          : "/auth/verify?error=invalid-or-expired",
        request.url,
      ),
      303,
    );
  } catch {
    return NextResponse.redirect(
      new URL("/auth/verify?error=verification-unavailable", request.url),
      303,
    );
  }
}
