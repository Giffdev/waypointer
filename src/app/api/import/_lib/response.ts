import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { AuthenticationRequiredError } from "@/lib/auth/guards";
import {
  ImportInvariantError,
  importInvariantStatus,
} from "@/lib/import/errors";
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
  if (error instanceof ImportInvariantError) {
    // A broken invariant is a statement about *this request's data*, not about
    // the service being down. Reporting it as 503 told users to "try again
    // later" for a condition that will never resolve on its own, and hid a
    // real defect behind a transient-looking status.
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: importInvariantStatus(error.code) },
    );
  }
  if (error instanceof ImportServiceError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  // 503 is reserved for genuine unavailability, which the branches above
  // already cover. An unexpected throw is a bug on our side: say 500, and log
  // enough to actually diagnose it. The stack is the whole point — a name
  // alone ("TypeError") is unactionable — while the message and any row
  // content stay out of the log, because logbook contents are the user's.
  const correlationId = randomUUID();
  console.error("import.unhandled-error", {
    correlationId,
    name: error instanceof Error ? error.name : typeof error,
    stack:
      error instanceof Error
        ? redactedStack(error)
        : undefined,
  });
  return NextResponse.json(
    {
      error: {
        code: "internal-error",
        message: "Something went wrong handling this import.",
        correlationId,
      },
    },
    { status: 500 },
  );
}

/**
 * The stack frames only, with the leading `Name: message` line removed.
 *
 * A thrown message routinely quotes the offending value — an airport
 * identifier, an aircraft registration, a whole CSV cell — and those are the
 * user's logbook, not ours to write into a log. The frames are what makes the
 * failure diagnosable and carry no row content.
 */
function redactedStack(error: Error): string | undefined {
  const frames = error.stack
    ?.split("\n")
    .filter((line) => /^\s+at\s/.test(line));
  return frames?.length ? frames.join("\n") : undefined;
}
