import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("./check-durable-import-worker-config.mjs", import.meta.url),
);
const complete = {
  FLIGHT_MAP_DURABLE_IMPORTS: "true",
  FLIGHT_MAP_MVP_SYNC_IMPORTS: "false",
  IMPORT_STORAGE_BACKEND: "r2",
  DATABASE_URL: "******worker.example/db",
  DB_POOL_MAX: "5",
  OBJECT_STORAGE_ENDPOINT: "https://objects.example.test",
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_BUCKET: "private-imports",
  OBJECT_STORAGE_ACCESS_KEY_ID: "synthetic-access",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "synthetic-secret",
  WORKER_ID: "worker-test-1",
  WORKER_HEALTH_SECRET: "synthetic-health-secret-at-least-32-characters",
  CLAMAV_HOST: "127.0.0.1",
  CLAMAV_PORT: "3310",
  CLAMAV_SIGNATURE_FILE: "/var/lib/clamav/daily.cvd",
  CLAMAV_MAX_SIGNATURE_AGE_HOURS: "48",
  JOB_LEASE_SECONDS: "120",
  JOB_POLL_INTERVAL_MS: "1000",
  IMPORT_MAX_BYTES: "10485760",
  IMPORT_RETENTION_DAYS: "7",
};

function run(overrides: Record<string, string | undefined> = {}) {
  const env = { ...process.env, ...complete, ...overrides };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
  });
}

describe("durable import worker release gate", () => {
  it("accepts a complete bounded worker configuration without printing secrets", () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bounded values are ready");
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      complete.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      complete.WORKER_HEALTH_SECRET,
    );
  });

  it("fails closed on incomplete storage, scanner, lease, or rollout settings", () => {
    const result = run({
      FLIGHT_MAP_MVP_SYNC_IMPORTS: "true",
      OBJECT_STORAGE_REGION: undefined,
      CLAMAV_MAX_SIGNATURE_AGE_HOURS: "999",
      JOB_LEASE_SECONDS: "5",
      WORKER_HEALTH_SECRET: "short",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FLIGHT_MAP_MVP_SYNC_IMPORTS must be false");
    expect(result.stderr).toContain(
      "missing worker variable: OBJECT_STORAGE_REGION",
    );
    expect(result.stderr).toContain("CLAMAV_MAX_SIGNATURE_AGE_HOURS");
    expect(result.stderr).toContain("JOB_LEASE_SECONDS");
    expect(result.stderr).toContain("WORKER_HEALTH_SECRET");
    expect(result.stderr).not.toContain("synthetic-secret");
  });
});
