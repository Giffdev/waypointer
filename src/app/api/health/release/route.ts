import { getVercelOidcToken } from "@vercel/oidc";
import {
  AuthenticationRequiredError,
  requireAuthenticatedUser,
} from "@/lib/auth/guards";
import { assertSameOrigin, RequestOriginError } from "@/lib/auth/request";
import { verifyRuntimeWritePause } from "@/lib/db";
import { releaseRuntimeClaimsFromEnvironment } from "@/lib/release-attestation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "cache-control": "no-store",
  vary: "Cookie, Origin",
};

export async function GET(request: Request) {
  try {
    await requireAuthenticatedUser();
    assertSameOrigin(request);
    await verifyRuntimeWritePause();
    const challenge = new URL(request.url).searchParams.get("challenge") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new Error("Invalid release health challenge.");
    }
    const oidcToken = await getVercelOidcToken({
      audience: `urn:flight-map:release-health:${challenge}`,
    });
    const runtime = releaseRuntimeClaimsFromEnvironment();
    return Response.json(
      {
        status: "ok",
        runtimeWriteMode: "read-only",
        challenge,
        runtime,
        providerIdentity: { oidcToken },
      },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return Response.json(
        { status: "unavailable" },
        { status: 401, headers: noStoreHeaders },
      );
    }
    if (error instanceof RequestOriginError) {
      return Response.json(
        { status: "unavailable" },
        { status: 403, headers: noStoreHeaders },
      );
    }
    return Response.json(
      { status: "unavailable" },
      {
        status: 503,
        headers: noStoreHeaders,
      },
    );
  }
}
