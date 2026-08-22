import { consumeRateLimit, RateLimitExceededError } from "@/lib/auth/rate-limit";
import {
  getPublicMapProjection,
  publicHandleRateLimitKey,
  ShareNotFoundError,
  ShareRepublishRequiredError,
  toLegacyPublicMapProjection,
} from "@/lib/sharing/service";
import { SHARING_NO_STORE_HEADERS } from "@/lib/sharing/http";

export const runtime = "nodejs";
// Revoking a public share must take effect on the next request, so this
// response deliberately stays out of browser and CDN caches.
const PUBLIC_HEADERS = {
  ...SHARING_NO_STORE_HEADERS,
  "X-Content-Type-Options": "nosniff",
};
// Published projections include one compact filter record per flight. Keep
// each viewer bounded without making one busy public handle deny other viewers.
const PUBLIC_MAP_IP_REQUESTS_PER_MINUTE = 120;
const PUBLIC_MAP_HANDLE_REQUESTS_PER_MINUTE = 10;

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
      consumeRateLimit(
        "public-map-ip",
        ip,
        PUBLIC_MAP_IP_REQUESTS_PER_MINUTE,
        60_000,
      ),
      consumeRateLimit(
        "public-map-handle",
        `${publicHandleRateLimitKey(handle)}:${ip}`,
        PUBLIC_MAP_HANDLE_REQUESTS_PER_MINUTE,
        60_000,
      ),
    ]);
    const projection = await getPublicMapProjection(handle);
    const directionContract =
      new URL(request.url).searchParams.get("contract") === "3";
    return Response.json(
      {
        map: directionContract
          ? projection
          : toLegacyPublicMapProjection(projection),
      },
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
    if (error instanceof ShareRepublishRequiredError) {
      return Response.json(
        {
          error: {
            code: "republish-required",
            message:
              "This shared map must be republished to show real airports.",
          },
        },
        { status: 409, headers: PUBLIC_HEADERS },
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
