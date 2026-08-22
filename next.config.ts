import type { NextConfig } from "next";
import { firebaseAuthProxyRewrite } from "./src/lib/auth/firebase-config";
import { CANONICAL_PUBLIC_ORIGIN } from "./src/lib/public-origin";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  ...(process.env.FLIGHT_MAP_BUILD_ID
    ? {
        generateBuildId: async () => {
          const buildId = process.env.FLIGHT_MAP_BUILD_ID ?? "";
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(buildId)) {
            throw new Error("FLIGHT_MAP_BUILD_ID is invalid");
          }
          return buildId;
        },
      }
    : {}),
  async rewrites() {
    const firebaseAuthRewrite = firebaseAuthProxyRewrite();
    return firebaseAuthRewrite ? [firebaseAuthRewrite] : [];
  },
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "flight-map-one.vercel.app",
          },
        ],
        destination: `${CANONICAL_PUBLIC_ORIGIN}/:path*`,
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
