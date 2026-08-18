import { NextResponse } from "next/server";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { assertSameOrigin, requestIp } from "@/lib/auth/request";
import {
  resolveFirebaseAccount,
  verifyFirebaseIdToken,
} from "@/lib/auth/firebase-bridge";
import { createDatabaseSession } from "@/lib/auth/session-cookie";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let stage = "request";
  try {
    assertSameOrigin(request);
    stage = "rate-limit";
    await consumeRateLimit(
      "firebase-session-ip",
      requestIp(request),
      20,
      15 * 60_000,
    );
    const body = await request.json().catch(() => null);
    const token =
      body && typeof body.token === "string" && body.token.length <= 8192
        ? body.token
        : "";
    stage = "token-verification";
    const claims = await verifyFirebaseIdToken(token);
    if (!claims) {
      console.warn("Firebase session exchange rejected.", { stage });
      return NextResponse.json({ ok: false }, { status: 401 });
    }
    stage = "account-mapping";
    const userId = await resolveFirebaseAccount(claims);
    if (!userId) {
      console.warn("Firebase session exchange rejected.", { stage });
      return NextResponse.json({ ok: false }, { status: 401 });
    }
    stage = "session-issuance";
    await createDatabaseSession(userId);
    return NextResponse.json({ ok: true });
  } catch {
    console.warn("Firebase session exchange rejected.", { stage });
    return NextResponse.json({ ok: false }, { status: 401 });
  }
}
