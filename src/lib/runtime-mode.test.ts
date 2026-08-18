import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canExposeDevelopmentVerificationLink,
  getFlightMapRuntimeMode,
  getImportRuntimeCapability,
  isBoundedMvpSyncImportConfiguration,
  isHostedPreviewConfiguration,
  isDurableImportConfiguration,
  isLoopbackLocalConfiguration,
  isMvpProductionConfiguration,
} from "./runtime-mode";

afterEach(() => {
  vi.unstubAllEnvs();
});

function fullLocalEnvironment() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("FLIGHT_MAP_LOCAL_FULL", "true");
  vi.stubEnv("FLIGHT_MAP_DEV_PREVIEW", "false");
  vi.stubEnv("AUTH_URL", "http://localhost:3000");
  vi.stubEnv(
    "DATABASE_URL",
    "postgres://flight_map:local@127.0.0.1:54329/flight_map",
  );
  vi.stubEnv("IMPORT_STORAGE_BACKEND", "local");
  vi.stubEnv("AUTH_DEV_EXPOSE_VERIFICATION_LINK", "true");
}

describe("runtime mode", () => {
  it("recognizes the explicit loopback-only full local stack", () => {
    fullLocalEnvironment();
    expect(isLoopbackLocalConfiguration()).toBe(true);
    expect(canExposeDevelopmentVerificationLink()).toBe(true);
    expect(getFlightMapRuntimeMode().kind).toBe("local-full");
  });

  it("never exposes development verification in production", () => {
    fullLocalEnvironment();
    vi.stubEnv("NODE_ENV", "production");
    expect(canExposeDevelopmentVerificationLink()).toBe(false);
  });

  it("rejects a remote database or auth origin for local-only features", () => {
    fullLocalEnvironment();
    vi.stubEnv("DATABASE_URL", "postgres://flight-map.example/flight_map");
    expect(isLoopbackLocalConfiguration()).toBe(false);
    expect(canExposeDevelopmentVerificationLink()).toBe(false);
  });

  it("labels the browser-only fallback as preview", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FLIGHT_MAP_DEV_PREVIEW", "true");
    expect(getFlightMapRuntimeMode()).toMatchObject({ kind: "preview" });
  });

  it("recognizes a constrained production hosted preview without registration gates", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FLIGHT_MAP_HOSTED_PREVIEW", "true");
    vi.stubEnv("DATABASE_URL", "******preview.example/db");
    vi.stubEnv("AUTH_URL", "https://flight-map-preview.vercel.app");
    vi.stubEnv("AUTH_SECRET", "a-secure-preview-auth-secret");
    vi.stubEnv("IMPORT_STORAGE_BACKEND", "sync-preview");
    vi.stubEnv("IMPORT_MAX_BYTES", "1048576");
    expect(isHostedPreviewConfiguration()).toBe(true);
    expect(getFlightMapRuntimeMode().kind).toBe("hosted-preview");
  });

  it("recognizes bounded Firebase-backed MVP production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FLIGHT_MAP_MVP_SYNC_IMPORTS", "true");
    vi.stubEnv("DATABASE_URL", "******production.example/db");
    vi.stubEnv("DB_POOL_MAX", "1");
    vi.stubEnv("AUTH_URL", "https://flight-map.example");
    vi.stubEnv("AUTH_SECRET", "a-secure-production-auth-secret");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "public-api-key");
    vi.stubEnv(
      "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      "flight-map.firebaseapp.com",
    );
    vi.stubEnv(
      "NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN",
      "flight-map.example",
    );
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "flight-map");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "web-app-id");
    vi.stubEnv("IMPORT_STORAGE_BACKEND", "sync-mvp");
    vi.stubEnv("IMPORT_MAX_BYTES", "1048576");

    expect(isMvpProductionConfiguration()).toBe(true);
    expect(getFlightMapRuntimeMode().kind).toBe("mvp-production");
    expect(getImportRuntimeCapability()).toMatchObject({
      available: true,
      durable: false,
      maxFileBytes: 1048576,
    });

    vi.stubEnv("IMPORT_MAX_BYTES", "1048577");
    expect(isMvpProductionConfiguration()).toBe(false);
  });

  it("keeps bounded sync imports available when unrelated runtime labeling is incomplete", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FLIGHT_MAP_MVP_SYNC_IMPORTS", "true");
    vi.stubEnv("DATABASE_URL", "******production.example/db");
    vi.stubEnv("AUTH_SECRET", "a-secure-production-auth-secret");
    vi.stubEnv("IMPORT_STORAGE_BACKEND", "sync-mvp");
    vi.stubEnv("IMPORT_MAX_BYTES", "1048576");
    vi.stubEnv("DB_POOL_MAX", "4");
    vi.stubEnv("AUTH_URL", "https://flight-map.example");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN", "proxy.example");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "");

    expect(isMvpProductionConfiguration()).toBe(false);
    expect(isBoundedMvpSyncImportConfiguration()).toBe(true);
    expect(getFlightMapRuntimeMode().kind).toBe("unavailable");
    expect(getImportRuntimeCapability()).toMatchObject({
      available: true,
      durable: false,
      maxFileBytes: 1048576,
      unavailableReason: undefined,
    });
  });

  it("does not expose sync controls without the explicit bounded import contract", () => {
    const environment = {
      NODE_ENV: "production",
      FLIGHT_MAP_MVP_SYNC_IMPORTS: "true",
      DATABASE_URL: "******production.example/db",
      AUTH_SECRET: "a-secure-production-auth-secret",
      IMPORT_STORAGE_BACKEND: "sync-mvp",
      IMPORT_MAX_BYTES: "1048577",
    };

    expect(isBoundedMvpSyncImportConfiguration(environment)).toBe(false);
  });

  it("switches from sync MVP to durable imports only with complete private storage", () => {
    const durable = {
      NODE_ENV: "production",
      FLIGHT_MAP_DURABLE_IMPORTS: "true",
      FLIGHT_MAP_MVP_SYNC_IMPORTS: "false",
      IMPORT_STORAGE_BACKEND: "r2",
      IMPORT_MAX_BYTES: "10485760",
      OBJECT_STORAGE_ENDPOINT: "https://objects.example.test",
      OBJECT_STORAGE_REGION: "auto",
      OBJECT_STORAGE_BUCKET: "private-imports",
      OBJECT_STORAGE_ACCESS_KEY_ID: "worker-access",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "worker-secret",
    };

    expect(isDurableImportConfiguration(durable)).toBe(true);
    expect(
      isDurableImportConfiguration({
        ...durable,
        OBJECT_STORAGE_REGION: "",
      }),
    ).toBe(false);
    expect(
      isDurableImportConfiguration({
        ...durable,
        FLIGHT_MAP_DURABLE_IMPORTS: "false",
        FLIGHT_MAP_MVP_SYNC_IMPORTS: "true",
        IMPORT_STORAGE_BACKEND: "sync-mvp",
      }),
    ).toBe(false);

    for (const [name, value] of Object.entries(durable)) {
      vi.stubEnv(name, value);
    }
    expect(getFlightMapRuntimeMode().kind).toBe("durable-production");
    expect(getImportRuntimeCapability()).toMatchObject({
      available: true,
      durable: true,
      maxFileBytes: 10485760,
    });
  });
});
