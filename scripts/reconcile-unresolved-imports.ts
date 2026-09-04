import process from "node:process";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { closeDb } from "../src/lib/db/index.ts";
import { DrizzleImportRepository } from "../src/lib/db/repositories/drizzle-import-repository.ts";
import {
  reconcileUnresolvedAirportImports,
  type AirportReconciliationCandidate,
  type AirportReconciliationCounts,
} from "../src/lib/import/airport-reconciliation.ts";
import { requireAirportReleaseTarget } from "./airport-release-safety.ts";
import { writeContentAddressedJson } from "./airport-release-provenance.ts";
import {
  AirportCatalogSafetyError,
  formatSafePostgresError,
  safePostgresClientOptions,
} from "./postgres-diagnostics.ts";

type SqlClient = ReturnType<typeof postgres>;

export async function runAirportReconciliationForOwners(
  ownerIds: string[],
  repository: DrizzleImportRepository,
): Promise<AirportReconciliationCounts> {
  const candidates: AirportReconciliationCandidate[] = [];
  for (const ownerId of ownerIds) {
    // Ids and statuses only. The airport release deliberately runs against a
    // database pinned to an older migration boundary, so this step must not
    // depend on the current row shape: reading the full batch row made every
    // future column addition break the release for databases that had not yet
    // applied it, which is precisely the coupling the pinned boundary exists
    // to avoid.
    const batchIds = await repository.listReviewBatchIds(ownerId);
    candidates.push(
      ...batchIds.map((batchId) => ({ userId: ownerId, batchId })),
    );
  }
  return reconcileUnresolvedAirportImports(candidates, {
    imports: repository,
    flights: repository,
    airports: repository,
  });
}

export async function runDatabaseAirportReconciliation(
  sql: SqlClient,
): Promise<AirportReconciliationCounts> {
  const repository = new DrizzleImportRepository();
  try {
    const owners = await sql<{ id: string }[]>`
      select id
      from users
      where disabled_at is null
      order by id
    `;
    return runAirportReconciliationForOwners(
      owners.map(({ id }) => id),
      repository,
    );
  } finally {
    await closeDb();
  }
}

async function main(): Promise<void> {
  const target = requireAirportReleaseTarget();
  const sql = postgres(target.migrationDatabaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ...safePostgresClientOptions,
  });
  try {
    const [connected] = await sql<Array<{ database_name: string }>>`
      select current_database() as database_name
    `;
    if (connected?.database_name !== target.databaseName) {
      throw new AirportCatalogSafetyError("database-target-mismatch");
    }
    const counts = await runDatabaseAirportReconciliation(sql);
    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      operation: "airport-reconciliation",
      status: counts.conflicts === 0 ? "passed" : "blocked",
      target: {
        fingerprint: target.fingerprint,
        databaseName: target.databaseName,
        confirmationVerified: true,
      },
      reconciliation: counts,
    };
    await writeContentAddressedJson(
      target.evidenceDirectory,
      "airport-reconciliation",
      evidence,
    );
    console.log(
      `Airport reconciliation: scanned=${counts.scanned} resolved=${counts.resolved} ambiguous=${counts.ambiguous} unknown=${counts.unknown} completed=${counts.completed} conflicts=${counts.conflicts}`,
    );
    if (counts.conflicts > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
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
