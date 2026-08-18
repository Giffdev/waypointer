import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { closeDb, getDb } from "./index";

export function createWorkerDatabases(environment: NodeJS.ProcessEnv = process.env) {
  const url = environment.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required by the worker.");
  const common = {
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  } as const;
  const leaseClient = postgres(url, { ...common, max: 1 });
  return {
    workDb: getDb(),
    leaseDb: drizzle(leaseClient, { schema }),
    async close() {
      await Promise.all([closeDb(), leaseClient.end({ timeout: 5 })]);
    },
  };
}
