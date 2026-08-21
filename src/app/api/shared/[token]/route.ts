import { consumeRateLimit, RateLimitExceededError } from "@/lib/auth/rate-limit";
import {
  getPublicMapProjection,
  publicTokenRateLimitKey,
  ShareNotFoundError,
} from "@/lib/sharing/service";
import { SHARING_NO_STORE_HEADERS } from "@/lib/sharing/http";

export const runtime = "nodejs";
const PUBLIC_HEADERS = {
  ...SHARING_NO_STORE_HEADERS,
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
};

export async function GET() {
  return Response.json(
    {
      error: {
        code: "method-not-allowed",
        message: "Use the shared map page to open this capability.",
      },
    },
    {
      status: 405,
      headers: { ...PUBLIC_HEADERS, Allow: "POST" },
    },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token: publicId } = await context.params;
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return Response.json(
        { error: { code: "not-found", message: "Waypointer shared map not found." } },
        { status: 404, headers: PUBLIC_HEADERS },
      );
    }
    if (Number(request.headers.get("content-length") ?? 0) > 1024) {
      throw new ShareNotFoundError();
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw new ShareNotFoundError();
    }
    if (
      Object.keys(body).some((key) => key !== "key") ||
      typeof body.key !== "string"
    ) {
      throw new ShareNotFoundError();
    }
    const ip =
      request.headers.get("x-real-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    await Promise.all([
      consumeRateLimit("public-map-ip", ip, 120, 60_000),
      consumeRateLimit(
        "public-map-token",
        publicTokenRateLimitKey(publicId, body.key),
        60,
        60_000,
      ),
    ]);
    return Response.json(
      { map: await getPublicMapProjection(publicId, body.key) },
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
