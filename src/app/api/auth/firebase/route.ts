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
  const startedAt = performance.now();
  let checkpoint = startedAt;
  const timings: Array<[string, number]> = [];
  const mark = (name: string) => {
    const now = performance.now();
    timings.push([name, now - checkpoint]);
    checkpoint = now;
  };
  const response = (status: 200 | 401, ok: boolean) => {
    const completedTimings = [
      ...timings,
      ["total", performance.now() - startedAt] as [string, number],
    ];
    const result = NextResponse.json({ ok }, { status });
    result.headers.set(
      "Server-Timing",
      completedTimings
        .map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`)
        .join(", "),
    );
    result.headers.set("Cache-Control", "private, no-store");
    return result;
  };
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
    mark("rate-limit");
    const body = await request.json().catch(() => null);
    const token =
      body && typeof body.token === "string" && body.token.length <= 8192
        ? body.token
        : "";
    mark("request-body");
    stage = "token-verification";
    const claims = await verifyFirebaseIdToken(token);
    mark("token-verification");
    if (!claims) {
      console.warn("Firebase session exchange rejected.", { stage });
      return response(401, false);
    }
    stage = "account-mapping";
    const userId = await resolveFirebaseAccount(claims);
    mark("account-mapping");
    if (!userId) {
      console.warn("Firebase session exchange rejected.", { stage });
      return response(401, false);
    }
    stage = "session-issuance";
    await createDatabaseSession(userId);
    mark("session-issuance");
    return response(200, true);
  } catch {
    console.warn("Firebase session exchange rejected.", { stage });
    return response(401, false);
  }
}
