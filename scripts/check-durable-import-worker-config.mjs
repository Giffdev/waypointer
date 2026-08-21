const environment = process.env;
const failures = [];
const minimumPollIntervalMs = 30_000;
const productionPollMaxIntervalMs = 900_000;

function required(name) {
  const value = environment[name]?.trim();
  if (!value) failures.push(`missing worker variable: ${name}`);
  return value ?? "";
}

function boundedInteger(name, minimum, maximum) {
  const raw = required(name);
  const value = Number(raw);
  if (
    raw &&
    (!Number.isSafeInteger(value) || value < minimum || value > maximum)
  ) {
    failures.push(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number.isSafeInteger(value) ? value : null;
}

if (environment.FLIGHT_MAP_DURABLE_IMPORTS !== "true") {
  failures.push("FLIGHT_MAP_DURABLE_IMPORTS must be true");
}
if (environment.FLIGHT_MAP_MVP_SYNC_IMPORTS === "true") {
  failures.push("FLIGHT_MAP_MVP_SYNC_IMPORTS must be false for durable rollout");
}
if (environment.FLIGHT_MAP_RELEASE_WRITES_PAUSED !== "false") {
  failures.push("FLIGHT_MAP_RELEASE_WRITES_PAUSED must be exactly false");
}
if (environment.IMPORT_STORAGE_BACKEND !== "r2") {
  failures.push("IMPORT_STORAGE_BACKEND must be r2");
}

for (const name of [
  "DATABASE_URL",
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "WORKER_HEALTH_SECRET",
  "CLAMAV_HOST",
  "CLAMAV_SIGNATURE_FILE",
]) {
  required(name);
}

const workerId = required("WORKER_ID");
if (workerId && !/^[a-zA-Z0-9._:-]{3,100}$/.test(workerId)) {
  failures.push("WORKER_ID must use only safe worker identifier characters");
}
if ((environment.WORKER_HEALTH_SECRET?.trim().length ?? 0) < 32) {
  failures.push("WORKER_HEALTH_SECRET must be at least 32 characters");
}
const executionMode = required("WORKER_EXECUTION_MODE");
if (
  executionMode &&
  !["disabled", "on-demand", "continuous"].includes(executionMode)
) {
  failures.push(
    "WORKER_EXECUTION_MODE must be one of: disabled, on-demand, continuous",
  );
}
if (executionMode === "disabled") {
  failures.push(
    "WORKER_EXECUTION_MODE=disabled is safe-off only and is not a runnable worker deployment",
  );
}

boundedInteger("DB_POOL_MAX", 2, 10);
boundedInteger("CLAMAV_PORT", 1, 65535);
boundedInteger("CLAMAV_MAX_SIGNATURE_AGE_HOURS", 1, 168);
boundedInteger("JOB_LEASE_SECONDS", 30, 900);
const pollInterval = boundedInteger(
  "JOB_POLL_INTERVAL_MS",
  minimumPollIntervalMs,
  30_000,
);
const pollMaxInterval = boundedInteger(
  "JOB_POLL_MAX_INTERVAL_MS",
  productionPollMaxIntervalMs,
  productionPollMaxIntervalMs,
);
if (
  Number.isSafeInteger(pollInterval) &&
  Number.isSafeInteger(pollMaxInterval) &&
  pollMaxInterval < pollInterval
) {
  failures.push(
    "JOB_POLL_MAX_INTERVAL_MS must be greater than or equal to JOB_POLL_INTERVAL_MS",
  );
}
boundedInteger("IMPORT_MAX_BYTES", 1024, 10 * 1024 * 1024);
boundedInteger("IMPORT_RETENTION_DAYS", 1, 30);

if (failures.length > 0) {
  console.error("Durable import worker configuration is not ready:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Durable import worker configuration is ready for ${executionMode} execution. Verify private network reachability, ClamAV freshness, and clean/EICAR hosted smoke before rollout.`,
);
