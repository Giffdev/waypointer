import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DatabaseTransaction } from "../src/lib/db/index.ts";
import { DrizzleImportRepository } from "../src/lib/db/repositories/drizzle-import-repository.ts";
import * as schema from "../src/lib/db/schema.ts";
import {
  auditAirportCatalog,
} from "./airport-release-evidence.ts";
import {
  loadProviderReleaseExpectation,
  type ReleaseEndpointEvidence,
  snapshotExistingFlights,
  verifyReleaseEndpoint,
  verifyExistingFlightsUnchanged,
  verifyRegionalAirportResolution,
} from "./airport-release-health.ts";
import {
  airportMigrationStateMatchesBoundary,
  applyPendingAirportMigrations,
  expectedAirportReleaseMigrationBoundary,
  loadAirportReleaseMigrationManifest,
  type UnsafeSqlClient,
  verifyAirportMigrationState,
} from "./airport-release-migrations.ts";
import {
  verifyCandidateManifest,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import {
  snapshotAirportReleaseState,
} from "./airport-release-rollback.ts";
import {
  AIRPORT_RELEASE_LOCK_KEYS,
  requireAirportReleaseTarget,
  type AirportReleaseTarget,
} from "./airport-release-safety.ts";
import {
  AirportCatalogSafetyError,
  formatSafePostgresError,
  safePostgresClientOptions,
} from "./postgres-diagnostics.ts";
import {
  runAirportReconciliationForOwners,
} from "./reconcile-unresolved-imports.ts";
import {
  applyAirportCatalogRefresh,
  loadAirportCatalogManifest,
  loadPinnedAirportDataset,
} from "./seed-airports.ts";

const root = path.resolve(import.meta.dirname, "..");

export type AirportReleaseFailureStage =
  | "after-lock"
  | "after-migrations"
  | "after-seed"
  | "after-reconciliation"
  | "before-commit";

export interface AirportReleaseOptions {
  environment?: NodeJS.ProcessEnv;
  failAfter?: AirportReleaseFailureStage;
  releaseControlPlaneGate?: () => Promise<ReleaseEndpointEvidence>;
}

function injectFailure(
  configured: AirportReleaseFailureStage | undefined,
  stage: AirportReleaseFailureStage,
) {
  if (configured === stage) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
}

async function verifyConnectedTarget(
  sql: UnsafeSqlClient,
  target: AirportReleaseTarget,
) {
  const [connected] = await sql.unsafe(
    `select
       current_database() as database_name,
       (select oid::integer from pg_database where datname = current_database())
         as database_oid`,
  );
  if (
    connected?.database_name !== target.databaseName ||
    Number(connected?.database_oid) !== target.databaseOid
  ) {
    throw new AirportCatalogSafetyError("database-target-mismatch");
  }
}

function catalogPassed(
  catalog: Awaited<ReturnType<typeof auditAirportCatalog>>,
  expectedAirports: number,
  expectedAliases: number,
) {
  return (
    catalog.activeDatasetAirports === expectedAirports &&
    catalog.distinctSourceIdentifiers === expectedAirports &&
    catalog.verifiedSourceProvenance === expectedAirports &&
    catalog.activeDatasetAliases === expectedAliases &&
    catalog.orphanAliases === 0 &&
    catalog.orphanFlightReferences === 0
  );
}

export async function runAirportCatalogRelease(
  options: AirportReleaseOptions = {},
) {
  const target = requireAirportReleaseTarget(
    options.environment ?? process.env,
  );
  const environment = options.environment ?? process.env;
  const candidate = await verifyCandidateManifest(
    target.candidateManifestPath,
    target.candidateManifestSha256,
  );
  const migrationManifest = await loadAirportReleaseMigrationManifest();
  const manifest = await loadAirportCatalogManifest();
  const { references, datasetVersion } =
    await loadPinnedAirportDataset(manifest);
  const sourceIdentProvenance =
    `ourairports-sha256:${manifest.source.sha256}`;
  const releaseControlPlaneChecks: ReleaseEndpointEvidence[] = [];
  let releaseControlPlaneGate:
    | (() => Promise<ReleaseEndpointEvidence>)
    | undefined;
  if (target.approval.environment === "production") {
    const deployment = await loadProviderReleaseExpectation(
      environment,
      "control-plane",
    );
    if (
      deployment.candidateManifestSha256 !==
        target.candidateManifestSha256 ||
      deployment.sourceManifestSha256 !==
        candidate.source.manifestSha256 ||
      deployment.deploymentSource.manifestSha256 !==
        candidate.deploymentSource.manifestSha256 ||
      deployment.approvedAirportCandidateSha256 !==
        target.approvedAirportCandidateSha256 ||
      deployment.migrationManifestSha256 !== migrationManifest.sha256
    ) {
      throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
    }
    releaseControlPlaneGate =
      options.releaseControlPlaneGate ??
      (() =>
        verifyReleaseEndpoint(
          deployment,
          environment.AIRPORT_RELEASE_HEALTH_SESSION_COOKIE?.trim() ?? "",
          {
            vercelApiToken:
              environment.AIRPORT_RELEASE_VERCEL_API_TOKEN?.trim() ?? "",
          },
        ));
    releaseControlPlaneChecks.push(await releaseControlPlaneGate());
  }
  const client = postgres(target.migrationDatabaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ...safePostgresClientOptions,
  });
  try {
    const transactionResult = await client.begin(async (transaction) => {
      const raw = transaction as unknown as UnsafeSqlClient;
      await transaction.unsafe(
        "set transaction isolation level serializable",
      );
      await verifyConnectedTarget(raw, target);
      const [lock] = await transaction.unsafe(
        "select pg_try_advisory_xact_lock($1, $2) as locked",
        [...AIRPORT_RELEASE_LOCK_KEYS],
      );
      if (lock?.locked !== true) {
        throw new AirportCatalogSafetyError("release-lock-unavailable");
      }
      injectFailure(options.failAfter, "after-lock");

      const beforeMigrations = await verifyAirportMigrationState(
        raw,
        target.approval.environment,
      );
      const preChangeState = await snapshotAirportReleaseState(
        raw,
        target.approval.environment,
      );
      if (
        preChangeState.stateSha256 !==
        target.approval.snapshot.preChangeStateSha256
      ) {
        throw new AirportCatalogSafetyError("snapshot-approval-missing");
      }
      const existingFlights = await snapshotExistingFlights(raw);
      Object.defineProperty(transaction, "options", {
        configurable: true,
        value: (client as unknown as {
          options: unknown;
        }).options,
      });
      const releaseDb = drizzle(
        transaction as unknown as ReturnType<typeof postgres>,
        { schema },
      );
      if (releaseControlPlaneGate) {
        releaseControlPlaneChecks.push(
          await releaseControlPlaneGate(),
        );
      }
      await applyPendingAirportMigrations(raw);
      const afterMigrations = await verifyAirportMigrationState(
        raw,
        target.approval.environment,
      );
      const expectedMigrationBoundary =
        expectedAirportReleaseMigrationBoundary(
          migrationManifest,
          beforeMigrations,
        );
      if (
        !airportMigrationStateMatchesBoundary(
          afterMigrations,
          expectedMigrationBoundary,
        ) ||
        afterMigrations.migrationManifestSha256 !== migrationManifest.sha256
      ) {
        throw new AirportCatalogSafetyError("migration-ledger-mismatch");
      }
      injectFailure(options.failAfter, "after-migrations");

      const assignment = await applyAirportCatalogRefresh(
        releaseDb,
        references,
        datasetVersion,
        {
          withinTransaction: true,
          sourceIdentProvenance,
        },
      );
      injectFailure(options.failAfter, "after-seed");

      const repository = new DrizzleImportRepository(
        (async <T>(
          userId: string,
          work: (tx: DatabaseTransaction) => Promise<T>,
        ) => {
          await releaseDb.execute(
            drizzleSql`select set_config('app.current_user_id', ${userId}, true)`,
          );
          return work(
            releaseDb as unknown as DatabaseTransaction,
          );
        }) as typeof import("../src/lib/db/index.ts").withUserDb,
      );
      const owners = await transaction.unsafe(
        `select id::text
         from users
         where disabled_at is null
         order by id`,
      );
      const ownerIds = owners.map(({ id }) => String(id));
      const reconciliation = await runAirportReconciliationForOwners(
        ownerIds,
        repository,
      );
      const reconciliationVerification =
        await runAirportReconciliationForOwners(ownerIds, repository);
      if (
        reconciliation.conflicts !== 0 ||
        reconciliationVerification.resolved !== 0 ||
        reconciliationVerification.completed !== 0 ||
        reconciliationVerification.conflicts !== 0
      ) {
        throw new AirportCatalogSafetyError("health-check-failed");
      }
      injectFailure(options.failAfter, "after-reconciliation");

      const catalog = await auditAirportCatalog(
        transaction as unknown as ReturnType<typeof postgres>,
        datasetVersion,
        sourceIdentProvenance,
      );
      if (
        !catalogPassed(
          catalog,
          manifest.expected.airports,
          manifest.expected.aliases,
        )
      ) {
        throw new AirportCatalogSafetyError("source-count-mismatch", {
          actualCount: catalog.activeDatasetAirports,
          expectedCount: manifest.expected.airports,
        });
      }
      const regional = await verifyRegionalAirportResolution(raw);
      const flightsAfter = await verifyExistingFlightsUnchanged(
        raw,
        existingFlights,
      );
      injectFailure(options.failAfter, "before-commit");
      if (releaseControlPlaneGate) {
        releaseControlPlaneChecks.push(
          await releaseControlPlaneGate(),
        );
      }

      return {
        beforeMigrations,
        afterMigrations,
        preChangeState,
        assignment,
        reconciliation,
        reconciliationVerification,
        catalog,
        regional,
        existingFlights,
        flightsAfter,
      };
    });
    if (releaseControlPlaneGate) {
      releaseControlPlaneChecks.push(await releaseControlPlaneGate());
    }

    const evidence = {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      status: "database-release-passed",
      productionAuthorization: false,
      source: manifest.source,
      scope: migrationManifest.releaseScope,
      candidate: {
        manifestSha256: target.candidateManifestSha256,
        approvedAirportCandidateSha256:
          target.approvedAirportCandidateSha256,
        sourceManifestSha256: candidate.source.manifestSha256,
        baselineManifestSha256:
          candidate.baseline.sourceManifestSha256,
        diffSha256: candidate.diff.sha256,
      },
      target: {
        fingerprint: target.fingerprint,
        databaseOid: target.databaseOid,
        approvalId: target.approval.approvalId,
        approvalSha256: target.approvalSha256,
        environment: target.approval.environment,
      },
      releaseControlPlane: target.productionPreflight
        ? {
            deploymentId:
              target.productionPreflight.releaseControlPlane.deploymentId,
            commitSha:
              target.productionPreflight.releaseControlPlane.commitSha,
            sourceManifestSha256:
              target.productionPreflight.releaseControlPlane
                .sourceManifestSha256,
            pauseEvidenceSha256: target.approval.changeControl.pauseEvidenceSha256,
            cachedPreflightAuthorization: false,
            freshProviderChecks: releaseControlPlaneChecks,
          }
        : undefined,
      snapshot: {
        id: target.approval.snapshot.id,
        sha256: target.approval.snapshot.sha256,
        preChangeState: transactionResult.preChangeState,
        verifiedAt: target.approval.snapshot.verifiedAt,
        restoreProcedureSha256:
          target.approval.snapshot.restoreProcedureSha256,
      },
      migration: {
        manifestSha256: migrationManifest.sha256,
        before: transactionResult.beforeMigrations,
        after: transactionResult.afterMigrations,
      },
      catalog: transactionResult.catalog,
      identity: transactionResult.assignment.summary,
      reconciliation: transactionResult.reconciliation,
      reconciliationVerification:
        transactionResult.reconciliationVerification,
      regional: transactionResult.regional,
      historicalFlights: {
        count: transactionResult.existingFlights.count,
        beforeSha256: transactionResult.existingFlights.sha256,
        afterSha256: transactionResult.flightsAfter.sha256,
        unchanged: true,
      },
      applicationHealth: {
        requiredBeforeDeploymentPromotion: true,
        status: "not-run-by-database-release",
      },
      rollback: {
        databasePhasesAtomic: true,
        applicationWriteBarrierAcquired: true,
        stagingSemantics:
          target.approval.snapshot.restoreProcedure.stagingSemantics,
        stopConditions:
          target.approval.snapshot.restoreProcedure.stopConditions,
        failureBeforeCommit: "automatic-transaction-rollback",
        failureAfterCommit:
          "deployment-remains-blocked; approved rollback confirmation and restored-state verification are mandatory",
        restoreProcedureSha256:
          target.approval.snapshot.restoreProcedureSha256,
      },
    };
    const artifact = await writeContentAddressedJson(
      target.evidenceDirectory,
      "airport-database-release",
      evidence,
    );
    console.log(
      `Airport database release passed: airports=${transactionResult.catalog.activeDatasetAirports} ` +
        `aliases=${transactionResult.catalog.activeDatasetAliases} ` +
        `checksum=${transactionResult.catalog.identityChecksum}.`,
    );
    console.log(
      `Evidence: ${path.relative(root, artifact.path)} sha256=${artifact.sha256}`,
    );
    return { evidence, artifact };
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main() {
  await runAirportCatalogRelease();
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
