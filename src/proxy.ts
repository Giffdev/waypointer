import type { NextFetchEvent, NextMiddleware, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const authenticatedProxy = auth((request) => {
  if (!request.auth) {
    const signIn = new URL("/auth/sign-in", request.nextUrl);
    signIn.searchParams.set(
      "callbackUrl",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
}) as unknown as NextMiddleware;

export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.FLIGHT_MAP_DEV_PREVIEW === "true"
  ) {
    return NextResponse.next();
  }
  if (!process.env.DATABASE_URL) {
    return new NextResponse(
      "Authentication is not configured. Set DATABASE_URL or enable the explicit development preview.",
      { status: 503 },
    );
  }
  return authenticatedProxy(request, event);
}

export const config = {
  matcher: ["/map/:path*", "/flights/:path*", "/import/:path*", "/settings/:path*"],
};
