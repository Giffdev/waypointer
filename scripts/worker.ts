import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createWorkerDatabases } from "../src/lib/db/worker";
import { DurableImportWorker } from "../src/lib/import/durable-worker";
import { DurableJobRepository } from "../src/lib/jobs/repository";
import { ClamAvScanner } from "../src/lib/scanner/clamav";
import { getPrivateObjectStorage } from "../src/lib/storage";
import { isDurableImportConfiguration } from "../src/lib/runtime-mode";

if (!isDurableImportConfiguration()) {
  throw new Error("The worker requires a complete durable import configuration.");
}
const workerId = process.env.WORKER_ID?.trim();
const healthSecret = process.env.WORKER_HEALTH_SECRET?.trim();
const leaseSeconds = Number(process.env.JOB_LEASE_SECONDS ?? 120);
const pollIntervalMs = Number(process.env.JOB_POLL_INTERVAL_MS ?? 1000);
if (!workerId || !healthSecret || healthSecret.length < 32) {
  throw new Error("WORKER_ID and a strong WORKER_HEALTH_SECRET are required.");
}
if (
  !Number.isSafeInteger(pollIntervalMs) ||
  pollIntervalMs < 250 ||
  pollIntervalMs > 30_000
) {
  throw new Error("JOB_POLL_INTERVAL_MS must be from 250 to 30000.");
}

const databases = createWorkerDatabases();
const jobs = new DurableJobRepository(databases.workDb);
const leaseJobs = new DurableJobRepository(databases.leaseDb);
const scanner = new ClamAvScanner();
const worker = new DurableImportWorker(
  jobs,
  leaseJobs,
  getPrivateObjectStorage(),
  scanner,
  workerId,
  leaseSeconds,
);
let shuttingDown = false;
let lastHeartbeatAt = new Date();

const server = createServer(async (request, response) => {
  if (request.url === "/live") {
    response.writeHead(shuttingDown ? 503 : 200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ ok: !shuttingDown }));
    return;
  }
  if (request.url !== "/health" || !authorized(request.headers.authorization)) {
    response.writeHead(404).end();
    return;
  }
  try {
    await scanner.assertHealthy();
    const metrics = await jobs.metrics();
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        ok: true,
        heartbeatAt: lastHeartbeatAt.toISOString(),
        queue: metrics,
      }),
    );
  } catch {
    response.writeHead(503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ ok: false }));
  }
});
server.listen(Number(process.env.PORT ?? 3001), "0.0.0.0");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    server.close();
  });
}

while (!shuttingDown) {
  const worked = await worker.runOne().catch((error) => {
    console.error("durable-import-worker-loop-failed", {
      code: error instanceof Error ? error.name : "unknown",
    });
    return false;
  });
  lastHeartbeatAt = new Date();
  if (!worked) await delay(pollIntervalMs);
}
await databases.close();

function authorized(header: string | undefined): boolean {
  const value = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = Buffer.from(healthSecret!);
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
