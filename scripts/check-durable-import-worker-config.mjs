const environment = process.env;
const failures = [];

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
}

if (environment.FLIGHT_MAP_DURABLE_IMPORTS !== "true") {
  failures.push("FLIGHT_MAP_DURABLE_IMPORTS must be true");
}
if (environment.FLIGHT_MAP_MVP_SYNC_IMPORTS === "true") {
  failures.push("FLIGHT_MAP_MVP_SYNC_IMPORTS must be false for durable rollout");
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

boundedInteger("DB_POOL_MAX", 2, 10);
boundedInteger("CLAMAV_PORT", 1, 65535);
boundedInteger("CLAMAV_MAX_SIGNATURE_AGE_HOURS", 1, 168);
boundedInteger("JOB_LEASE_SECONDS", 30, 900);
boundedInteger("JOB_POLL_INTERVAL_MS", 250, 30_000);
boundedInteger("IMPORT_MAX_BYTES", 1024, 10 * 1024 * 1024);
boundedInteger("IMPORT_RETENTION_DAYS", 1, 30);

if (failures.length > 0) {
  console.error("Durable import worker configuration is not ready:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "Durable import worker variable names and bounded values are ready. Verify private network reachability, ClamAV freshness, and clean/EICAR hosted smoke before rollout.",
);
