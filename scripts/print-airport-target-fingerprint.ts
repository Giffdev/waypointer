import process from "node:process";
import {
  airportDatabaseTargetFingerprint,
} from "./airport-release-safety.ts";
import { formatSafePostgresError } from "./postgres-diagnostics.ts";

try {
  const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL?.trim();
  if (!migrationDatabaseUrl) {
    throw new Error("The session migration database target is required.");
  }
  const migrationFingerprint = airportDatabaseTargetFingerprint(
    migrationDatabaseUrl,
  );
  console.log(migrationFingerprint);
} catch (error) {
  console.error(formatSafePostgresError(error));
  process.exitCode = 1;
}
