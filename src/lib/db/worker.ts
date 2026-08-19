import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import {
  closeDb,
  getDb,
  runtimeDatabaseConnectionParameters,
} from "./index";
import { AirportReleaseWriteBarrierError } from "./release-lock";

export function workerDatabaseClientOptions(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return {
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    max: 1,
    connection: runtimeDatabaseConnectionParameters(environment),
  } as const;
}

export function createWorkerDatabases(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.FLIGHT_MAP_RELEASE_WRITES_PAUSED?.trim() === "true") {
    throw new AirportReleaseWriteBarrierError();
  }
  const url = environment.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required by the worker.");
  const leaseClient = postgres(url, workerDatabaseClientOptions(environment));
  return {
    workDb: getDb(),
    leaseDb: drizzle(leaseClient, { schema }),
    async close() {
      await Promise.all([closeDb(), leaseClient.end({ timeout: 5 })]);
    },
  };
}
