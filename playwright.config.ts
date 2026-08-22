import { defineConfig } from "@playwright/test";

const baseURL =
  process.env.FLIGHT_MAP_E2E_BASE_URL ?? "http://127.0.0.1:3100";
const externalBaseURL = Boolean(process.env.FLIGHT_MAP_E2E_BASE_URL);
const googleStorageState =
  process.env.FLIGHT_MAP_E2E_GOOGLE_STORAGE_STATE;
const persistedImportE2e =
  process.env.FLIGHT_MAP_E2E_PERSISTED === "true";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    channel: "chrome",
    storageState: googleStorageState || undefined,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chrome",
      use: { viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-chrome",
      use: {
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: externalBaseURL ? undefined : {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: persistedImportE2e
        ? (process.env.DATABASE_URL ?? "")
        : "",
      NEXT_DIST_DIR: ".next-e2e",
      FLIGHT_MAP_LOCAL_FULL: persistedImportE2e ? "true" : "false",
      FLIGHT_MAP_DEV_PREVIEW: persistedImportE2e ? "false" : "true",
      AUTH_DEV_EXPOSE_VERIFICATION_LINK: persistedImportE2e ? "true" : "false",
      IMPORT_STORAGE_BACKEND: "local",
      FLIGHT_MAP_E2E_ACCOUNT_SETTINGS: "true",
      AUTH_EMAIL_FROM: "Flight Map E2E <noreply@example.test>",
      RESEND_API_KEY: "e2e-placeholder-not-a-secret",
    },
  },
});
