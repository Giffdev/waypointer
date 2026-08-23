import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Firebase same-origin initialization config", () => {
  it("returns the public client configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "public-api-key");
    vi.stubEnv(
      "NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN",
      "flight-map.example",
    );
    vi.stubEnv(
      "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      "project.firebaseapp.com",
    );
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "flight-map");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "web-app-id");

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300",
    );
    expect(await response.json()).toEqual({
      apiKey: "public-api-key",
      authDomain: "flight-map.example",
      projectId: "flight-map",
      appId: "web-app-id",
    });
  });

  it("fails closed when public Firebase configuration is incomplete", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN", "");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "");

    const response = GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Firebase authentication is unavailable.",
    });
  });
});
