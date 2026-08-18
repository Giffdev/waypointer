import { getVercelOidcToken } from "@vercel/oidc";
import { assertSameOrigin, RequestOriginError } from "@/lib/auth/request";
import { releaseRuntimeClaimsFromEnvironment } from "@/lib/release-attestation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "cache-control": "no-store",
  vary: "Origin",
};

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const challenge = new URL(request.url).searchParams.get("challenge") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new Error("Invalid deployment attestation challenge.");
    }
    const oidcToken = await getVercelOidcToken({
      audience: `urn:flight-map:deployment-attestation:${challenge}`,
    });
    return Response.json(
      {
        status: "ok",
        challenge,
        runtime: releaseRuntimeClaimsFromEnvironment(),
        providerIdentity: { oidcToken },
      },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    if (error instanceof RequestOriginError) {
      return Response.json(
        { status: "unavailable" },
        { status: 403, headers: noStoreHeaders },
      );
    }
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: noStoreHeaders },
    );
  }
}
