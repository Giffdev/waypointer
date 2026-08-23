import { firebasePublicConfig } from "@/lib/auth/firebase-config";

export const dynamic = "force-dynamic";

export function GET() {
  const config = firebasePublicConfig();
  if (!config) {
    return Response.json(
      { error: "Firebase authentication is unavailable." },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return Response.json(config, {
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}
