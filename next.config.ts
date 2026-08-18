import type { NextConfig } from "next";
import { firebaseAuthProxyRewrite } from "./src/lib/auth/firebase-config";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    const firebaseAuthRewrite = firebaseAuthProxyRewrite();
    return firebaseAuthRewrite ? [firebaseAuthRewrite] : [];
  },
};

export default nextConfig;
