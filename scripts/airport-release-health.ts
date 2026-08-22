import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DatabaseTransaction } from "../src/lib/db/index.ts";
import { DrizzleImportRepository } from "../src/lib/db/repositories/drizzle-import-repository.ts";
import * as schema from "../src/lib/db/schema.ts";
import { auditAirportCatalog } from "./airport-release-evidence.ts";
import {
  airportMigrationBoundaryForState,
  airportMigrationStateMatchesBoundary,
  loadAirportReleaseMigrationManifest,
  type UnsafeSqlClient,
  verifyAirportMigrationState,
} from "./airport-release-migrations.ts";
import {
  canonicalJson,
  sha256Bytes,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import {
  requireAirportReleaseTarget,
  requireRepositoryPath,
} from "./airport-release-safety.ts";
import {
  AirportCatalogSafetyError,
  formatSafePostgresError,
  safePostgresClientOptions,
} from "./postgres-diagnostics.ts";
import { runAirportReconciliationForOwners } from "./reconcile-unresolved-imports.ts";
import {
  loadAirportCatalogManifest,
  loadPinnedAirportDataset,
} from "./seed-airports.ts";
import {
  loadProviderReleaseExpectation,
  RELEASE_DEPLOYMENT_TRUST,
  type ProviderReleaseExpectation,
  type ReleaseEndpointEvidence,
  type ReleaseEndpointOptions,
  verifyReleaseEndpoint,
  verifyVercelProductionDeployment,
} from "./vercel-provider-proof.ts";

export {
  loadProviderReleaseExpectation,
  RELEASE_DEPLOYMENT_TRUST,
  verifyReleaseEndpoint,
};
export type {
  ProviderReleaseExpectation,
  ReleaseEndpointEvidence,
};

const EXPECTED_REGIONAL_IDENTITIES = new Map([
  ["00A", "00A"],
  ["K00A", "00A"],
  ["W01", "KW01"],
  ["KW01", "KW01"],
  ["OMK", "KOMK"],
  ["KOMK", "KOMK"],
  ["S18", "S18"],
  ["UIL", "KUIL"],
  ["KUIL", "KUIL"],
]);
const EXPECTED_APPLICATION_AIRPORT_CODES = new Map([
  ["00A", "00A"],
  ["W01", "W01"],
  ["OMK", "OMK"],
  ["S18", "S18"],
  ["DMK", "DMK"],
  ["REP", "REP"],
  ["VDSR", "REP"],
  ["VDSA", "SAI"],
]);

export interface ExistingFlightSnapshot {
  count: number;
  sha256: string;
  ids: string[];
}

export interface ReleaseReconciliationSummary {
  resolved?: number;
  completed?: number;
  conflicts?: number;
  ambiguous?: number;
  unknown?: number;
}

export interface RegionalAirportHealth {
  checkedAliases: number;
  sha256: string;
}

async function relationExists(
  sql: UnsafeSqlClient,
  relation: string,
): Promise<boolean> {
  const [row] = await sql.unsafe(
    "select to_regclass($1) is not null as present",
    [relation],
  );
  return row?.present === true;
}

export async function snapshotExistingFlights(
  sql: UnsafeSqlClient,
  ids?: string[],
  excludeIds = false,
): Promise<ExistingFlightSnapshot> {
  if (!(await relationExists(sql, "public.flights"))) {
    return {
      count: 0,
      sha256: createHash("sha256").update("").digest("hex"),
      ids: [],
    };
  }
  const parameters: unknown[] = [];
  const filter = ids
    ? excludeIds
      ? "where id <> all($1::uuid[])"
      : "where id = any($1::uuid[])"
    : "";
  if (ids) parameters.push(ids);
  const rows = await sql.unsafe(
    `select
       id::text,
       user_id::text,
       origin_airport_id::text,
       destination_airport_id::text,
       fingerprint,
       date
     from flights
     ${filter}
     order by id`,
    parameters,
  );
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return {
    count: rows.length,
    sha256: hash.digest("hex"),
    ids: rows.map((row) => String(row.id)),
  };
}

export async function verifyHistoricalFlightBaseline(
  sql: UnsafeSqlClient,
  before: ExistingFlightSnapshot,
  reconciliation: ReleaseReconciliationSummary | undefined,
): Promise<ExistingFlightSnapshot> {
  const current = await snapshotExistingFlights(sql);
  if (
    current.count === before.count &&
    current.sha256 === before.sha256
  ) {
    return current;
  }
  if (
    reconciliation?.resolved !== 2 ||
    reconciliation.completed !== 1 ||
    reconciliation.conflicts !== 0 ||
    reconciliation.ambiguous !== 0 ||
    reconciliation.unknown !== 0 ||
    current.count !== before.count + reconciliation.resolved
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const reconciledRows = await sql.unsafe(
    `select flights.id::text
     from flights
     join airports origin on origin.id = flights.origin_airport_id
     join airports destination on destination.id = flights.destination_airport_id
     where flights.source_type = 'FlightRadar24'
       and (
         (
           flights.date = '2018-10-23'
           and origin.iata = 'DMK'
           and destination.iata = 'REP'
         )
         or (
           flights.date = '2018-10-26'
           and origin.iata = 'REP'
           and destination.iata = 'SIN'
         )
       )
     order by flights.id`,
  );
  if (reconciledRows.length !== reconciliation.resolved) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const baseline = await snapshotExistingFlights(
    sql,
    reconciledRows.map(({ id }) => String(id)),
    true,
  );
  if (
    baseline.count !== before.count ||
    baseline.sha256 !== before.sha256
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  return current;
}

export async function verifyExistingFlightsUnchanged(
  sql: UnsafeSqlClient,
  before: ExistingFlightSnapshot,
): Promise<ExistingFlightSnapshot> {
  const after = await snapshotExistingFlights(sql, before.ids);
  if (after.count !== before.count || after.sha256 !== before.sha256) {
    throw new AirportCatalogSafetyError("health-check-failed", {
      expectedCount: before.count,
      actualCount: after.count,
    });
  }
  return after;
}

export async function verifyRegionalAirportResolution(
  sql: UnsafeSqlClient,
): Promise<RegionalAirportHealth> {
  const codes = [...EXPECTED_REGIONAL_IDENTITIES.keys()];
  const rows = await sql.unsafe(
    `with ranked as (
       select
         aliases.code,
         airports.source_ident,
         airports.name,
         aliases.priority,
         min(aliases.priority) over (partition by aliases.code) as best_priority
       from airport_aliases aliases
       join airports on airports.id = aliases.airport_id
       where aliases.code = any($1::text[])
     )
     select code, source_ident, name, priority
     from ranked
     where priority = best_priority
     order by code, source_ident`,
    [codes],
  );
  for (const [code, expectedSourceIdent] of EXPECTED_REGIONAL_IDENTITIES) {
    const matches = rows.filter((row) => row.code === code);
    if (
      matches.length !== 1 ||
      matches[0]?.source_ident !== expectedSourceIdent
    ) {
      throw new AirportCatalogSafetyError("health-check-failed", {
        actualCount: matches.length,
        expectedCount: 1,
      });
    }
  }
  const sha256 = createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
  return { checkedAliases: codes.length, sha256 };
}

export interface ApplicationHealthEvidence {
  origin: string;
  deploymentId: string;
  projectId: string;
  orgId: string;
  productionAlias: string;
  expectationSha256: string;
  providerSourceSha256: string;
  oidcIdentitySha256: string;
  providerVerificationSha256: string;
  providerRequestStartedAt: string;
  providerRequestCompletedAt: string;
  routesChecked: number;
  airportQueriesChecked: number;
  responseSha256: string;
  defaultTransactionReadOnly: "on";
}

export async function verifyApplicationHealth(
  expectation: ProviderReleaseExpectation,
  sessionCookie: string,
  options: ReleaseEndpointOptions,
): Promise<ApplicationHealthEvidence> {
  if (
    expectation.releasePhase !== "database-released" ||
    !expectation.catalogChecksum ||
    !expectation.databaseEvidenceSha256
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const releaseEndpoint = await verifyReleaseEndpoint(
    expectation,
    sessionCookie,
    options,
  );
  const verifiedOrigin = new URL(releaseEndpoint.origin);
  const fetchImplementation = options.applicationFetch ?? fetch;
  const observations: unknown[] = [
    {
      route: "/api/health/release",
      status: 200,
      expectationSha256: expectation.expectationSha256,
      oidcIdentitySha256: releaseEndpoint.oidcIdentitySha256,
    },
  ];
  for (const route of [
    "/map",
    "/flights",
    "/import",
    "/settings",
  ]) {
    const response = await fetchImplementation(new URL(route, verifiedOrigin), {
      redirect: "manual",
      headers: { cookie: sessionCookie },
    });
    if (response.status !== 200) {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
    observations.push({ route, status: response.status });
  }
  for (const [query, expectedCode] of EXPECTED_APPLICATION_AIRPORT_CODES) {
    const url = new URL("/api/import/airports", verifiedOrigin);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", "10");
    const response = await fetchImplementation(url, {
      redirect: "manual",
      headers: { cookie: sessionCookie },
    });
    if (response.status !== 200) {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
    const payload = (await response.json()) as {
      airports?: Array<{ icao?: string; code?: string; name?: string }>;
    };
    const matches = payload.airports ?? [];
    if (!matches.some((airport) => airport.code === expectedCode)) {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
    observations.push({ query, count: matches.length });
  }
  const providerAfterHealth = await verifyVercelProductionDeployment(
    expectation,
    options.vercelApiToken,
    options.providerFetch ?? fetch,
  );
  if (
    providerAfterHealth.deploymentId !== releaseEndpoint.deploymentId ||
    providerAfterHealth.providerSourceSha256 !==
      releaseEndpoint.providerSourceSha256
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  return {
    origin: releaseEndpoint.origin,
    deploymentId: expectation.deploymentId,
    projectId: expectation.projectId,
    orgId: expectation.orgId,
    productionAlias: expectation.productionAlias,
    expectationSha256: expectation.expectationSha256,
    providerSourceSha256: releaseEndpoint.providerSourceSha256,
    oidcIdentitySha256: releaseEndpoint.oidcIdentitySha256,
    providerVerificationSha256: sha256Bytes(
      canonicalJson({
        afterHealth: providerAfterHealth.providerVerificationSha256,
        releaseEndpoint: releaseEndpoint.providerVerificationSha256,
      }),
    ),
    providerRequestStartedAt: releaseEndpoint.providerRequestStartedAt,
    providerRequestCompletedAt:
      providerAfterHealth.requestCompletedAt,
    routesChecked: 5,
    airportQueriesChecked: EXPECTED_APPLICATION_AIRPORT_CODES.size,
    responseSha256: createHash("sha256")
      .update(JSON.stringify(observations))
      .digest("hex"),
    defaultTransactionReadOnly:
      releaseEndpoint.defaultTransactionReadOnly,
  };
}

async function verifyReconciliationReadOnly(
  client: ReturnType<typeof postgres>,
) {
  return client.begin(async (transaction) => {
    await transaction.unsafe("set transaction read only");
    Object.defineProperty(transaction, "options", {
      configurable: true,
      value: (client as unknown as { options: unknown }).options,
    });
    const releaseDb = drizzle(
      transaction as unknown as ReturnType<typeof postgres>,
      { schema },
    );
    const repository = new DrizzleImportRepository(
      (async <T>(
        userId: string,
        work: (tx: DatabaseTransaction) => Promise<T>,
      ) => {
        await releaseDb.execute(
          drizzleSql`select set_config('app.current_user_id', ${userId}, true)`,
        );
        return work(releaseDb as unknown as DatabaseTransaction);
      }) as typeof import("../src/lib/db/index.ts").withUserDb,
    );
    const owners = await transaction.unsafe(
      `select id::text
       from users
       where disabled_at is null
       order by id`,
    );
    const result = await runAirportReconciliationForOwners(
      owners.map(({ id }) => String(id)),
      repository,
    );
    if (
      result.resolved !== 0 ||
      result.completed !== 0 ||
      result.conflicts !== 0
    ) {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
    return result;
  });
}

async function main() {
  const databaseEvidencePath =
    process.env.AIRPORT_RELEASE_DATABASE_EVIDENCE_PATH?.trim() ?? "";
  const databaseEvidenceSha256 =
    process.env.AIRPORT_RELEASE_DATABASE_EVIDENCE_SHA256?.trim() ?? "";
  let databaseEvidence: {
    generatedAt?: string;
    status?: string;
    candidate?: {
      manifestSha256?: string;
      sourceManifestSha256?: string;
    };
    target?: {
      approvalSha256?: string;
      fingerprint?: string;
      databaseOid?: number;
    };
    migration?: { manifestSha256?: string };
    catalog?: { identityChecksum?: string };
    historicalFlights?: {
      count?: number;
      afterSha256?: string;
    };
    reconciliation?: ReleaseReconciliationSummary;
  };
  try {
    const permittedEvidenceBase = path.join(
      "artifacts",
      "release-evidence",
      "airport-catalog",
    );
    const permittedEvidenceRoot = requireRepositoryPath(
      process.env.AIRPORT_RELEASE_EVIDENCE_DIRECTORY?.trim() ||
        permittedEvidenceBase,
      permittedEvidenceBase,
      undefined,
    );
    const localEvidencePath = path.resolve(databaseEvidencePath);
    if (
      !localEvidencePath.startsWith(
        `${permittedEvidenceRoot}${path.sep}`,
      ) ||
      path.extname(localEvidencePath).toLowerCase() !== ".json"
    ) {
      throw new Error("path");
    }
    const bytes = await readFile(localEvidencePath);
    if (
      !/^[a-f0-9]{64}$/.test(databaseEvidenceSha256) ||
      sha256Bytes(bytes) !== databaseEvidenceSha256
    ) {
      throw new Error("hash");
    }
    databaseEvidence = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const databaseReleaseTime = Date.parse(
    databaseEvidence.generatedAt ?? "",
  );
  if (
    !Number.isFinite(databaseReleaseTime) ||
    databaseReleaseTime > Date.now()
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const target = requireAirportReleaseTarget(
    process.env,
    databaseReleaseTime,
  );
  if (
    databaseEvidence.status !== "database-release-passed" ||
    databaseEvidence.candidate?.manifestSha256 !==
      target.candidateManifestSha256 ||
    databaseEvidence.target?.approvalSha256 !== target.approvalSha256 ||
    databaseEvidence.target?.fingerprint !== target.fingerprint ||
    databaseEvidence.target?.databaseOid !== target.databaseOid
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const migrationManifest = await loadAirportReleaseMigrationManifest();
  if (
    databaseEvidence.migration?.manifestSha256 !==
    migrationManifest.sha256
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const deployment = await loadProviderReleaseExpectation(process.env);
  if (
    deployment.candidateManifestSha256 !==
      target.candidateManifestSha256 ||
    deployment.approvedAirportCandidateSha256 !==
      target.approvedAirportCandidateSha256 ||
    deployment.sourceManifestSha256 !==
      databaseEvidence.candidate?.sourceManifestSha256 ||
    deployment.migrationManifestSha256 !== migrationManifest.sha256 ||
    deployment.catalogChecksum !==
      databaseEvidence.catalog?.identityChecksum ||
    deployment.databaseEvidenceSha256 !== databaseEvidenceSha256
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const manifest = await loadAirportCatalogManifest();
  const { datasetVersion } = await loadPinnedAirportDataset(manifest);
  const sourceIdentProvenance =
    `ourairports-sha256:${manifest.source.sha256}`;
  const sessionCookie =
    process.env.AIRPORT_RELEASE_HEALTH_SESSION_COOKIE?.trim() ?? "";
  const vercelApiToken =
    process.env.AIRPORT_RELEASE_VERCEL_API_TOKEN?.trim() ?? "";
  const promotionAlias = await verifyReleaseEndpoint(
    deployment,
    sessionCookie,
    { vercelApiToken },
  );
  const client = postgres(target.migrationDatabaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ...safePostgresClientOptions,
  });
  try {
    const [connected] = await client<Array<{
      database_name: string;
      database_oid: number;
    }>>`
      select
        current_database() as database_name,
        (select oid::integer from pg_database where datname = current_database())
          as database_oid
    `;
    if (
      connected.database_name !== target.databaseName ||
      connected.database_oid !== target.databaseOid
    ) {
      throw new AirportCatalogSafetyError("database-target-mismatch");
    }
    const migration = await verifyAirportMigrationState(
      client as unknown as UnsafeSqlClient,
      target.approval.environment,
    );
    const currentMigrationBoundary = airportMigrationBoundaryForState(
      migrationManifest,
      migration,
    );
    if (
      !currentMigrationBoundary ||
      currentMigrationBoundary.appliedCount <
        migrationManifest.expectedAfter.appliedCount ||
      !airportMigrationStateMatchesBoundary(
        migration,
        currentMigrationBoundary,
      ) ||
      migration.migrationManifestSha256 !== migrationManifest.sha256 ||
      migration.appliedCount < migrationManifest.expectedAfter.appliedCount
    ) {
      throw new AirportCatalogSafetyError("migration-ledger-mismatch");
    }
    const catalog = await auditAirportCatalog(
      client,
      datasetVersion,
      sourceIdentProvenance,
    );
    if (
      catalog.activeDatasetAirports !== manifest.expected.airports ||
      catalog.activeDatasetAliases !== manifest.expected.aliases ||
      catalog.distinctSourceIdentifiers !== manifest.expected.airports ||
      catalog.verifiedSourceProvenance !== manifest.expected.airports ||
      catalog.orphanAliases !== 0 ||
      catalog.orphanFlightReferences !== 0 ||
      catalog.identityChecksum !==
        databaseEvidence.catalog?.identityChecksum
    ) {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
    const regional = await verifyRegionalAirportResolution(
      client as unknown as UnsafeSqlClient,
    );
    const historicalFlights = await verifyHistoricalFlightBaseline(
      client as unknown as UnsafeSqlClient,
      {
        count: databaseEvidence.historicalFlights?.count ?? -1,
        sha256:
          databaseEvidence.historicalFlights?.afterSha256 ?? "",
        ids: [],
      },
      databaseEvidence.reconciliation,
    );
    const reconciliation = await verifyReconciliationReadOnly(client);
    const application = await verifyApplicationHealth(
      deployment,
      sessionCookie,
      { vercelApiToken },
    );
    const artifact = await writeContentAddressedJson(
      target.evidenceDirectory,
      "airport-production-health",
      {
        schemaVersion: 4,
        generatedAt: new Date().toISOString(),
        status: "passed",
        candidateManifestSha256: target.candidateManifestSha256,
        targetApprovalSha256: target.approvalSha256,
        databaseEvidenceSha256,
        migration,
        catalog,
        regional,
        historicalFlights: {
          count: historicalFlights.count,
          sha256: historicalFlights.sha256,
        },
        reconciliation,
        providerExpectationSha256:
          process.env.AIRPORT_RELEASE_PROVIDER_EXPECTATION_SHA256,
        promotionAlias,
        application,
      },
    );
    console.log(
      `Airport health passed: aliases=${regional.checkedAliases} ` +
        `routes=${application.routesChecked} apiQueries=${application.airportQueriesChecked}.`,
    );
    console.log(`Health evidence sha256=${artifact.sha256}.`);
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
