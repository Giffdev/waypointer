import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  requireAuthenticatedUser,
} from "@/lib/auth/guards";
import { assertSameOrigin, RequestOriginError } from "@/lib/auth/request";
import {
  createManualFlight,
  FlightServiceError,
} from "@/lib/flights/service";
import { revalidateOwnerFlightViews } from "@/app/api/import/_lib/revalidate";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireAuthenticatedUser();
    assertSameOrigin(request);
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new FlightServiceError(
        415,
        "unsupported-content-type",
        "JSON is required.",
      );
    }
    const flight = await createManualFlight(user.id, await request.json());
    revalidateOwnerFlightViews();
    return NextResponse.json({ flight }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json(
        { error: { code: "unauthorized", message: "Authentication is required." } },
        { status: 401 },
      );
    }
    if (error instanceof RequestOriginError) {
      return NextResponse.json(
        { error: { code: "forbidden", message: "The request is not allowed." } },
        { status: 403 },
      );
    }
    if (error instanceof FlightServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        error: {
          code: "flight-service-unavailable",
          message: "The flight could not be saved.",
        },
      },
      { status: 503 },
    );
  }
}
