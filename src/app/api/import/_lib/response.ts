import { NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/lib/auth/guards";
import { RateLimitExceededError } from "@/lib/auth/rate-limit";
import { RequestOriginError } from "@/lib/auth/request";
import { ImportServiceError } from "./service";

export function importApiError(error: unknown): NextResponse {
  if (error instanceof AuthenticationRequiredError) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Authentication is required." } },
      { status: 401 },
    );
  }
  if (error instanceof RateLimitExceededError) {
    return NextResponse.json(
      {
        error: {
          code: "rate-limited",
          message: "Too many requests. Try again later.",
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(error.retryAfterSeconds) },
      },
    );
  }
  if (error instanceof RequestOriginError) {
    return NextResponse.json(
      {
        error: {
          code: "forbidden-origin",
          message: "The request origin is not allowed.",
        },
      },
      { status: 403 },
    );
  }
  if (error instanceof ImportServiceError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      error: {
        code: "service-unavailable",
        message: "The import service is not configured or temporarily unavailable.",
      },
    },
    { status: 503 },
  );
}
