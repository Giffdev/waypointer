import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";
import {
  AIRPORT_RELEASE_LOCK_KEYS,
  AirportReleaseWriteBarrierError,
} from "./release-lock";

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "DATABASE_URL is required for authentication and persisted user data.",
    );
  }
  return value;
}

export const RUNTIME_READ_ONLY_POSTGRES_OPTIONS =
  "-c default_transaction_read_only=on";

export function runtimeDatabaseUrl(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.FLIGHT_MAP_RELEASE_WRITES_PAUSED?.trim() !== "true") {
    return value;
  }
  const url = new URL(value);
  if (url.hostname.endsWith(".neon.tech")) {
    url.hostname = url.hostname.replace(/-pooler(?=\.)/u, "");
    return url.toString();
  }
  return value;
}

export function databasePoolMax(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configured = environment.DB_POOL_MAX?.trim();
  if (!configured) return environment.NODE_ENV === "production" ? 1 : 3;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error("DB_POOL_MAX must be an integer from 1 to 20.");
  }
  return parsed;
}

export function runtimeDatabaseConnectionParameters(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return environment.FLIGHT_MAP_RELEASE_WRITES_PAUSED?.trim() === "true"
    ? { options: RUNTIME_READ_ONLY_POSTGRES_OPTIONS }
    : {};
}

export function runtimeDatabaseClientOptions(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return {
    max: databasePoolMax(environment),
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    connection: runtimeDatabaseConnectionParameters(environment),
  } as const;
}

function createDatabase() {
  const client =
    globalDatabase.flightMapSql ??
    postgres(
      runtimeDatabaseUrl(databaseUrl()),
      runtimeDatabaseClientOptions(),
    );
  const db = drizzle(client, { schema });

  if (process.env.NODE_ENV !== "production") {
    globalDatabase.flightMapSql = client;
  }
  return db;
}

type Database = ReturnType<typeof createDatabase>;
export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

const globalDatabase = globalThis as typeof globalThis & {
  flightMapSql?: ReturnType<typeof postgres>;
  flightMapDb?: Database;
};

export function getDb(): Database {
  if (!globalDatabase.flightMapDb) {
    globalDatabase.flightMapDb = createDatabase();
  }
  return globalDatabase.flightMapDb;
}

export async function closeDb(): Promise<void> {
  const client = globalDatabase.flightMapSql;
  globalDatabase.flightMapDb = undefined;
  globalDatabase.flightMapSql = undefined;
  if (client) await client.end({ timeout: 5 });
}

export async function verifyRuntimeWritePause(): Promise<"on"> {
  const rows = await getDb().execute<{
    default_transaction_read_only?: string;
  }>(sql`show default_transaction_read_only`);
  assertRuntimeReadOnlySetting(
    rows as unknown as Array<{
      default_transaction_read_only?: string;
    }>,
  );
  return "on";
}

export function assertRuntimeReadOnlySetting(
  rows: ReadonlyArray<{ default_transaction_read_only?: string }>,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    environment.FLIGHT_MAP_RELEASE_WRITES_PAUSED?.trim() !== "true" ||
    rows[0]?.default_transaction_read_only !== "on"
  ) {
    throw new AirportReleaseWriteBarrierError();
  }
}

export async function withUserDb<T>(
  userId: string,
  work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("A valid immutable user ID is required.");
  }

  return getDb().transaction(async (tx) => {
    const barrier = await tx.execute(
      sql`select pg_try_advisory_xact_lock_shared(
        ${AIRPORT_RELEASE_LOCK_KEYS[0]},
        ${AIRPORT_RELEASE_LOCK_KEYS[1]}
      ) as locked`,
    );
    if (
      !(barrier as unknown as Array<{ locked?: boolean }>)[0]?.locked
    ) {
      throw new AirportReleaseWriteBarrierError();
    }
    await tx.execute(
      sql`select set_config('app.current_user_id', ${userId}, true)`,
    );
    return work(tx);
  });
}
