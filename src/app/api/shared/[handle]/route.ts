import { consumeRateLimit, RateLimitExceededError } from "@/lib/auth/rate-limit";
import {
  getPublicMapProjection,
  publicHandleRateLimitKey,
  ShareNotFoundError,
  ShareValidationError,
  toLegacyPublicMapProjection,
  toV3PublicMapProjection,
} from "@/lib/sharing/service";
import { SHARING_NO_STORE_HEADERS } from "@/lib/sharing/http";

export const runtime = "nodejs";
// A shared map is a live view of the owner's current map, and revoking one
// must take effect on the next request, so this response deliberately stays
// out of browser and CDN caches. Freshness is bounded instead by the viewer's
// 30-second poll, not by a cached copy of a map that has since changed.
const PUBLIC_HEADERS = {
  ...SHARING_NO_STORE_HEADERS,
  "X-Content-Type-Options": "nosniff",
};
// The projection includes one compact filter record per flight. Keep each
// viewer bounded without making one busy public handle deny other viewers.
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
    // contract=4 is the current waypoint-aware wire shape; contract=3 is the
    // frozen pre-waypoint shape already parsed by deployed browser bundles
    // (their exact-key parser rejects any unrecognised field, so `routePath`
    // can never appear here — see `toV3PublicMapProjection`); anything else,
    // including no `contract` param at all, gets the rollback-compatible v2
    // shape, unchanged from before.
    const contract = new URL(request.url).searchParams.get("contract");
    const map =
      contract === "4"
        ? projection
        : contract === "3"
          ? toV3PublicMapProjection(projection)
          : toLegacyPublicMapProjection(projection);
    return Response.json({ map }, { headers: PUBLIC_HEADERS });
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
    // A live map that cannot be projected returns 503 until the offending
    // owner row changes, and no owner action clears it, so the failure has
    // to be visible to an operator. Logged in exactly the shape the owner
    // enable route uses: the validation code, or the error type for anything
    // else. Never the handle, owner id, or any flight or airport value —
    // this is an unauthenticated path, and its log line must stay free of
    // private data.
    if (error instanceof ShareValidationError) {
      console.error("Shared map projection validation failed.", {
        code: error.code,
      });
    } else {
      console.error("Shared map projection failed.", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
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
