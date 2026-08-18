import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  formatSafePostgresError,
  safePostgresClientOptions,
} from "./postgres-diagnostics.ts";

async function main() {
  const databaseUrl =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Migration database is unavailable.");
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ...safePostgresClientOptions,
  });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: path.resolve(
        import.meta.dirname,
        "..",
        "drizzle",
        "migrations",
      ),
    });
    console.log("Database migrations applied.");
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(formatSafePostgresError(error));
    process.exitCode = 1;
  });
}

