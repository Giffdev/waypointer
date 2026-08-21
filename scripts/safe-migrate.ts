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

export function runtimeDatabaseRole(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const runtimeDatabaseUrl = environment.DATABASE_URL?.trim();
  if (!runtimeDatabaseUrl) {
    throw new Error(
      "DATABASE_URL is required to provision the runtime projection grant.",
    );
  }
  const role = decodeURIComponent(new URL(runtimeDatabaseUrl).username);
  if (!role) throw new Error("DATABASE_URL does not identify a runtime role.");
  return role;
}

export function quotedPostgresIdentifier(value: string): string {
  if (value.includes("\0")) {
    throw new Error("The runtime database role is invalid.");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function runtimeProjectionGrantStatements(role: string): string[] {
  const identifier = quotedPostgresIdentifier(role);
  return [
    `GRANT EXECUTE ON FUNCTION public_map_projection_by_handle(text) TO ${identifier}`,
  ];
}

async function main() {
  const databaseUrl =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Migration database is unavailable.");
  const runtimeRole = runtimeDatabaseRole();
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
    for (const statement of runtimeProjectionGrantStatements(runtimeRole)) {
      await client.unsafe(statement);
    }
    console.log("Database migrations and runtime grants applied.");
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
