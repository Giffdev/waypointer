import { describe, expect, it } from "vitest";
import {
  firebaseAuthProxyRewrites,
  firebaseOAuthDeploymentUrls,
  firebasePublicConfig,
} from "./firebase-config";

describe("Firebase public authentication configuration", () => {
  it("requires the complete public web-app configuration", () => {
    expect(
      firebasePublicConfig({
        NEXT_PUBLIC_FIREBASE_API_KEY: "public-api-key",
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "flight-map.example",
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: "flight-map",
        NEXT_PUBLIC_FIREBASE_APP_ID: "web-app-id",
      }),
    ).toEqual({
      apiKey: "public-api-key",
      authDomain: "flight-map.example",
      projectId: "flight-map",
      appId: "web-app-id",
    });
    expect(
      firebasePublicConfig({
        NEXT_PUBLIC_FIREBASE_API_KEY: "public-api-key",
      }),
    ).toBeNull();
  });

  it("uses the same-origin proxy while retaining the Firebase handler upstream", () => {
    const environment = {
      NEXT_PUBLIC_FIREBASE_API_KEY: "public-api-key",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "project.firebaseapp.com",
      NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN: "flight-map.example",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "flight-map",
      NEXT_PUBLIC_FIREBASE_APP_ID: "web-app-id",
    };
    expect(firebasePublicConfig(environment)?.authDomain).toBe(
      "flight-map.example",
    );
    expect(firebaseAuthProxyRewrites(environment)).toEqual([
      {
        source: "/__/auth/:path*",
        destination: "https://project.firebaseapp.com/__/auth/:path*",
      },
      {
        source: "/__/firebase/init.json",
        destination: "https://project.firebaseapp.com/__/firebase/init.json",
      },
    ]);
  });

  it("derives the exact Firebase-managed Google handler for each host", () => {
    expect(
      firebaseOAuthDeploymentUrls("flight-map.example"),
    ).toEqual({
      authorizedJavaScriptOrigin: "https://flight-map.example",
      authorizedRedirectUri:
        "https://flight-map.example/__/auth/handler",
    });
    expect(() =>
      firebaseOAuthDeploymentUrls("https://flight-map.example/path"),
    ).toThrow(/hostname without a path/i);
  });
});
