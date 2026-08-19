import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { inArray, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { airportAliases, airports } from "../src/lib/db/schema.ts";
import {
  airportIdentifierAliases,
  airportSearchKey,
  createAirportResolver,
  parseOurAirportsCsv,
  type AirportReference,
} from "../src/lib/import/airport-resolution.ts";
import {
  assignAirportSeedIds,
  type AirportSeedAssignment,
} from "./airport-seed-plan.ts";
import {
  auditAirportCatalog,
  writeAirportReleaseEvidence,
  type AirportReleaseEvidence,
} from "./airport-release-evidence.ts";
import { requireAirportReleaseTarget } from "./airport-release-safety.ts";
import {
  AirportCatalogSafetyError,
  formatSafePostgresError,
  safePostgresClientOptions,
} from "./postgres-diagnostics.ts";
import { runDatabaseAirportReconciliation } from "./reconcile-unresolved-imports.ts";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(
  root,
  "config",
  "airport-catalog-release.json",
);

export interface AirportCatalogManifest {
  schemaVersion: 2;
  source: {
    provider: string;
    url: string;
    relativePath: string;
    sha256: string;
    bytes: number;
  };
  expected: {
    airports: number;
    aliases: number;
  };
}

type SqlClient = ReturnType<typeof postgres>;

function createAirportDatabase(sql: SqlClient) {
  return drizzle(sql, { schema: { airports, airportAliases } });
}

export type AirportDatabase = ReturnType<typeof createAirportDatabase>;

export interface AirportCatalogRefreshOptions {
  withinTransaction?: boolean;
  sourceIdentProvenance?: string;
}

export async function loadAirportCatalogManifest(): Promise<AirportCatalogManifest> {
  const parsed = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as AirportCatalogManifest;
  if (
    parsed.schemaVersion !== 2 ||
    !/^[a-f0-9]{64}$/.test(parsed.source.sha256) ||
    !Number.isSafeInteger(parsed.source.bytes) ||
    !Number.isSafeInteger(parsed.expected.airports) ||
    !Number.isSafeInteger(parsed.expected.aliases)
  ) {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  return parsed;
}

export async function loadPinnedAirportDataset(
  manifest: AirportCatalogManifest,
) {
  const sourcePath = path.resolve(root, manifest.source.relativePath);
  const [csv, sourceStat] = await Promise.all([
    readFile(sourcePath, "utf8"),
    stat(sourcePath),
  ]);
  const sha256 = createHash("sha256").update(csv).digest("hex");
  if (
    sha256 !== manifest.source.sha256 ||
    sourceStat.size !== manifest.source.bytes
  ) {
    throw new AirportCatalogSafetyError("source-checksum-mismatch");
  }
  const references = parseOurAirportsCsv(csv);
  const aliasCount = references.flatMap(airportIdentifierAliases).length;
  if (
    references.length !== manifest.expected.airports ||
    aliasCount !== manifest.expected.aliases
  ) {
    throw new AirportCatalogSafetyError("source-count-mismatch", {
      incomingCount: references.length,
    });
  }
  return {
    references,
    datasetVersion: `ourairports:${sha256.slice(0, 16)}`,
  };
}

function frequencies(
  references: AirportReference[],
  select: (reference: AirportReference) => string | undefined,
) {
  const values = new Map<string, number>();
  for (const reference of references) {
    const value = select(reference);
    if (value) values.set(value, (values.get(value) ?? 0) + 1);
  }
  return values;
}

function proposedIcaoCode(reference: AirportReference) {
  return (
    reference.gpsCode ||
    (/^[A-Z]{4}$/.test(reference.ident) ? reference.ident : undefined)
  );
}

export async function applyAirportCatalogRefresh(
  db: AirportDatabase,
  references: AirportReference[],
  datasetVersion: string,
  options: AirportCatalogRefreshOptions = {},
): Promise<AirportSeedAssignment> {
  const sourceIdentProvenance =
    options.sourceIdentProvenance ??
    `ourairports-sha256:${createHash("sha256")
      .update(datasetVersion)
      .digest("hex")}`;
  const refresh = async (tx: AirportDatabase) => {
    const existingAirports = await tx.select().from(airports);
    const icaoFrequency = frequencies(references, proposedIcaoCode);
    const iataFrequency = frequencies(
      references,
      (reference) => reference.iataCode,
    );
    const proposedIcao = (reference: AirportReference) => {
      const code = proposedIcaoCode(reference);
      return code && icaoFrequency.get(code) === 1 ? code : undefined;
    };
    const proposedIata = (reference: AirportReference) =>
      reference.iataCode && iataFrequency.get(reference.iataCode) === 1
        ? reference.iataCode
        : undefined;
    const assignment = assignAirportSeedIds(
      references,
      existingAirports,
      proposedIcao,
      proposedIata,
    );
    const values = references.map((reference, index) => {
      const resolution = createAirportResolver([reference])(reference.ident);
      if (resolution.status !== "resolved") {
        throw new AirportCatalogSafetyError("ambiguous-existing-identity", {
          referenceIndex: index,
        });
      }
      const icao = proposedIcao(reference) ?? null;
      const iata = proposedIata(reference) ?? null;
      return {
        id: assignment.ids[index],
        sourceIdent: reference.ident,
        sourceIdentProvenance,
        icao,
        iata,
        localCode:
          reference.localCode ||
          (reference.ident !== icao ? reference.ident : null),
        searchKeywords: reference.keywords ?? null,
        searchKey: airportSearchKey(reference),
        name: reference.name,
        city: reference.municipality || null,
        country: reference.isoCountry || "Unknown",
        region: null,
        latitude: reference.latitude,
        longitude: reference.longitude,
        facility: resolution.airport.facility,
        scheduledService: reference.scheduledService,
        datasetVersion,
      };
    });
    const aliases = references.flatMap((reference, index) =>
      airportIdentifierAliases(reference).map((alias) => ({
        airportId: assignment.ids[index],
        code: alias.code,
        codeType: alias.type,
        priority: alias.priority,
      })),
    );

    for (
      let index = 0;
      index < assignment.sourceIdentReassignments.length;
      index += 500
    ) {
      await tx
        .update(airports)
        .set({
          sourceIdent: null,
          sourceIdentProvenance: null,
        })
        .where(
          inArray(
            airports.id,
            assignment.sourceIdentReassignments.slice(
              index,
              index + 500,
            ),
          ),
        );
    }
    for (let index = 0; index < values.length; index += 500) {
      await tx
        .insert(airports)
        .values(values.slice(index, index + 500))
        .onConflictDoUpdate({
          target: airports.id,
          set: {
            sourceIdent: drizzleSql`excluded.source_ident`,
            sourceIdentProvenance:
              drizzleSql`excluded.source_ident_provenance`,
            icao: drizzleSql`excluded.icao`,
            iata: drizzleSql`excluded.iata`,
            localCode: drizzleSql`excluded.local_code`,
            searchKeywords: drizzleSql`excluded.search_keywords`,
            searchKey: drizzleSql`excluded.search_key`,
            name: drizzleSql`excluded.name`,
            city: drizzleSql`excluded.city`,
            country: drizzleSql`excluded.country`,
            region: drizzleSql`excluded.region`,
            latitude: drizzleSql`excluded.latitude`,
            longitude: drizzleSql`excluded.longitude`,
            facility: drizzleSql`excluded.facility`,
            scheduledService: drizzleSql`excluded.scheduled_service`,
            datasetVersion: drizzleSql`excluded.dataset_version`,
            updatedAt: new Date(),
          },
        });
    }
    for (let index = 0; index < assignment.ids.length; index += 500) {
      await tx
        .delete(airportAliases)
        .where(inArray(airportAliases.airportId, assignment.ids.slice(index, index + 500)));
    }
    for (let index = 0; index < aliases.length; index += 1000) {
      await tx
        .insert(airportAliases)
        .values(aliases.slice(index, index + 1000))
        .onConflictDoNothing();
    }
    return assignment;
  };

  if (options.withinTransaction) return refresh(db);
  return db.transaction((tx) => refresh(tx as unknown as AirportDatabase));
}

async function main() {
  const target = requireAirportReleaseTarget();
  const manifest = await loadAirportCatalogManifest();
  const { references, datasetVersion } =
    await loadPinnedAirportDataset(manifest);
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
    if (connected.database_name !== target.databaseName) {
      throw new AirportCatalogSafetyError("database-target-mismatch");
    }
    const assignment = await applyAirportCatalogRefresh(
      createAirportDatabase(sql),
      references,
      datasetVersion,
      {
        sourceIdentProvenance:
          `ourairports-sha256:${manifest.source.sha256}`,
      },
    );
    const reconciliation = await runDatabaseAirportReconciliation(sql);
    const catalog = await auditAirportCatalog(
      sql,
      datasetVersion,
      `ourairports-sha256:${manifest.source.sha256}`,
    );
    const passed =
      catalog.activeDatasetAirports === manifest.expected.airports &&
      catalog.distinctSourceIdentifiers === manifest.expected.airports &&
      catalog.verifiedSourceProvenance === manifest.expected.airports &&
      catalog.activeDatasetAliases === manifest.expected.aliases &&
      catalog.orphanAliases === 0 &&
      catalog.orphanFlightReferences === 0 &&
      reconciliation.conflicts === 0;
    const evidence: AirportReleaseEvidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: passed ? "passed" : "blocked",
      source: manifest.source,
      target: {
        fingerprint: target.fingerprint,
        databaseName: target.databaseName,
        confirmationVerified: true,
      },
      catalog,
      identity: assignment.summary,
      reconciliation,
      tests: [],
    };
    const evidenceArtifact = await writeAirportReleaseEvidence(
      target.evidenceDirectory,
      evidence,
    );
    if (!passed) {
      throw new AirportCatalogSafetyError("source-count-mismatch", {
        incomingCount: catalog.activeDatasetAirports,
      });
    }
    console.log(
      `Airport catalog refresh passed: airports=${catalog.activeDatasetAirports} aliases=${catalog.activeDatasetAliases} checksum=${catalog.identityChecksum}.`,
    );
    console.log(
      `Airport reconciliation: scanned=${reconciliation.scanned} resolved=${reconciliation.resolved} ambiguous=${reconciliation.ambiguous} unknown=${reconciliation.unknown} completed=${reconciliation.completed} conflicts=${reconciliation.conflicts}`,
    );
    console.log(`Evidence: ${path.relative(root, evidenceArtifact.path)}`);
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
