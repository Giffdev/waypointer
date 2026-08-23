import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "./next.config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Firebase authentication proxy", () => {
  it("proxies the Firebase-managed authentication handler", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN",
      "flight-map.example",
    );
    vi.stubEnv(
      "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      "project.firebaseapp.com",
    );
    const rewrites = nextConfig.rewrites as () => Promise<unknown>;

    await expect(rewrites()).resolves.toEqual([
      {
        source: "/__/auth/:path*",
        destination: "https://project.firebaseapp.com/__/auth/:path*",
      },
      {
        source: "/__/firebase/init.json",
        destination: "/api/auth/firebase/init",
      },
    ]);
  });
});

describe("production host redirects", () => {
  it("redirects the legacy production host to the canonical origin", async () => {
    const redirects = nextConfig.redirects as () => Promise<unknown>;
    await expect(redirects()).resolves.toEqual([
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "flight-map-one.vercel.app",
          },
        ],
        destination: "https://waypointer-app.vercel.app/:path*",
        permanent: true,
      },
    ]);
  });
});
