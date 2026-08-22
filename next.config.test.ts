import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

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
