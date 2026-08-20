import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("./check-durable-import-worker-config.mjs", import.meta.url),
);
const complete = {
  FLIGHT_MAP_DURABLE_IMPORTS: "true",
  FLIGHT_MAP_MVP_SYNC_IMPORTS: "false",
  FLIGHT_MAP_RELEASE_WRITES_PAUSED: "false",
  IMPORT_STORAGE_BACKEND: "r2",
  DATABASE_URL: "******worker.example/db",
  DB_POOL_MAX: "5",
  OBJECT_STORAGE_ENDPOINT: "https://objects.example.test",
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_BUCKET: "private-imports",
  OBJECT_STORAGE_ACCESS_KEY_ID: "synthetic-access",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "synthetic-secret",
  WORKER_ID: "worker-test-1",
  WORKER_EXECUTION_MODE: "continuous",
  WORKER_HEALTH_SECRET: "synthetic-health-secret-at-least-32-characters",
  CLAMAV_HOST: "127.0.0.1",
  CLAMAV_PORT: "3310",
  CLAMAV_SIGNATURE_FILE: "/var/lib/clamav/daily.cvd",
  CLAMAV_MAX_SIGNATURE_AGE_HOURS: "48",
  JOB_LEASE_SECONDS: "120",
  JOB_POLL_INTERVAL_MS: "5000",
  JOB_POLL_MAX_INTERVAL_MS: "300000",
  IMPORT_MAX_BYTES: "10485760",
  IMPORT_RETENTION_DAYS: "7",
};

function run(overrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...complete, ...overrides };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
  });
}

describe("durable import worker release gate", () => {
  it.each(["continuous", "on-demand"])(
    "accepts a complete bounded %s configuration without printing secrets",
    (mode) => {
      const result = run({ WORKER_EXECUTION_MODE: mode });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `configuration is ready for ${mode} execution`,
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        complete.OBJECT_STORAGE_SECRET_ACCESS_KEY,
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        complete.WORKER_HEALTH_SECRET,
      );
    },
  );

  it("uses the same 5000 millisecond polling floor as the worker runtime", () => {
    const result = run();
    const tooFast = run({ JOB_POLL_INTERVAL_MS: "4999" });

    expect(result.status).toBe(0);
    expect(tooFast.status).toBe(1);
    expect(tooFast.stderr).toContain(
      "JOB_POLL_INTERVAL_MS must be an integer from 5000 to 30000",
    );
  });

  it.each(["5000", "900000"])(
    "accepts configured polling maximum %s used by runtime backoff",
    (maximum) => {
      const result = run({
        JOB_POLL_INTERVAL_MS: "5000",
        JOB_POLL_MAX_INTERVAL_MS: maximum,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    },
  );

  it("requires the worker runtime write mode to be exactly false", () => {
    expect(run().status).toBe(0);

    for (const value of ["true", "FALSE", "", undefined]) {
      const result = run({ FLIGHT_MAP_RELEASE_WRITES_PAUSED: value });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "FLIGHT_MAP_RELEASE_WRITES_PAUSED must be exactly false",
      );
    }
  });

  it("fails closed on incomplete storage, scanner, lease, or rollout settings", () => {
    const result = run({
      FLIGHT_MAP_MVP_SYNC_IMPORTS: "true",
      OBJECT_STORAGE_REGION: undefined,
      CLAMAV_MAX_SIGNATURE_AGE_HOURS: "999",
      JOB_LEASE_SECONDS: "5",
      JOB_POLL_MAX_INTERVAL_MS: "1000",
      WORKER_HEALTH_SECRET: "short",
      WORKER_EXECUTION_MODE: "always-on",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FLIGHT_MAP_MVP_SYNC_IMPORTS must be false");
    expect(result.stderr).toContain(
      "missing worker variable: OBJECT_STORAGE_REGION",
    );
    expect(result.stderr).toContain("CLAMAV_MAX_SIGNATURE_AGE_HOURS");
    expect(result.stderr).toContain("JOB_LEASE_SECONDS");
    expect(result.stderr).toContain("WORKER_EXECUTION_MODE");
    expect(result.stderr).toContain("JOB_POLL_MAX_INTERVAL_MS");
    expect(result.stderr).toContain("WORKER_HEALTH_SECRET");
    expect(result.stderr).not.toContain("synthetic-secret");
  });

  it("rejects disabled mode as safe-off rather than deployment-ready", () => {
    const result = run({ WORKER_EXECUTION_MODE: "disabled" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "WORKER_EXECUTION_MODE=disabled is safe-off only",
    );
  });
});
