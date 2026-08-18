import type { NextResponse } from "next/server";

export const BREACHED_PASSWORD_WARNING_COOKIE =
  "flight-map-registration-warning";
export const BREACHED_PASSWORD_WARNING_VALUE = "breached-password";
export const BREACHED_PASSWORD_WARNING_MAX_AGE_SECONDS = 5 * 60;

export function applyBreachedPasswordWarning(
  response: NextResponse,
  breached: boolean,
): NextResponse {
  if (!breached) return response;
  response.cookies.set(
    BREACHED_PASSWORD_WARNING_COOKIE,
    BREACHED_PASSWORD_WARNING_VALUE,
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/auth/verify",
      maxAge: BREACHED_PASSWORD_WARNING_MAX_AGE_SECONDS,
    },
  );
  return response;
}

export function isBreachedPasswordWarning(value: string | undefined): boolean {
  return value === BREACHED_PASSWORD_WARNING_VALUE;
}
