import { consumeRateLimit, RateLimitExceededError } from "@/lib/auth/rate-limit";
import {
  getPublicMapProjection,
  publicHandleRateLimitKey,
  ShareNotFoundError,
} from "@/lib/sharing/service";
import { SHARING_NO_STORE_HEADERS } from "@/lib/sharing/http";

export const runtime = "nodejs";
const PUBLIC_HEADERS = {
  ...SHARING_NO_STORE_HEADERS,
  "X-Content-Type-Options": "nosniff",
};

export async function GET(
  request: Request,
  context: { params: Promise<{ handle: string }> },
) {
  try {
    const { handle } = await context.params;
    const ip =
      request.headers.get("x-real-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    await Promise.all([
      consumeRateLimit("public-map-ip", ip, 120, 60_000),
      consumeRateLimit(
        "public-map-handle",
        publicHandleRateLimitKey(handle),
        60,
        60_000,
      ),
    ]);
    return Response.json(
      { map: await getPublicMapProjection(handle) },
      { headers: PUBLIC_HEADERS },
    );
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return Response.json(
        { error: { code: "rate-limited", message: "Try again later." } },
        {
          status: 429,
          headers: {
            ...PUBLIC_HEADERS,
            "Retry-After": String(error.retryAfterSeconds),
          },
        },
      );
    }
    if (error instanceof ShareNotFoundError) {
      return Response.json(
        { error: { code: "not-found", message: "Waypointer shared map not found." } },
        { status: 404, headers: PUBLIC_HEADERS },
      );
    }
    return Response.json(
      {
        error: {
          code: "shared-map-unavailable",
          message: "The Waypointer shared map is temporarily unavailable.",
        },
      },
      { status: 503, headers: PUBLIC_HEADERS },
    );
  }
}

export async function POST() {
  return Response.json(
    {
      error: {
        code: "method-not-allowed",
        message: "Use GET to load this public map.",
      },
    },
    {
      status: 405,
      headers: { ...PUBLIC_HEADERS, Allow: "GET" },
    },
  );
}
