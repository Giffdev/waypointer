import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { withUserDb } from "../src/lib/db/index.ts";
import { DrizzleImportRepository } from "../src/lib/db/repositories/drizzle-import-repository.ts";
import { users } from "../src/lib/db/schema.ts";
import {
  LocalArtifactValidationError,
  planLocalArtifactMigration,
  stageLocalArtifactMigration,
  validateLocalArtifact,
} from "../src/lib/import/migration.ts";
import {
  commitImportBatch,
  decideImportRows,
  getUserImportBatch,
} from "../src/lib/import/service.ts";
import type { ImportWorkerRepositories } from "../src/lib/import/worker.ts";
import type { StoredImportRow } from "../src/lib/import/types.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export type ArtifactMigrationMode = "dry-run" | "apply" | "commit";

export type ArtifactMigrationReport = {
  ok: true;
  mode: ArtifactMigrationMode;
  artifactType: "foreflight" | "fr24";
  reused: boolean;
  status: "dry-run" | "processing" | "review" | "failed" | "committed";
  counts: {
    totalRows: number;
    commitReadyRows: number;
    duplicateRows: number;
    unresolvedRows: number;
    ambiguousRows: number;
    acceptedRows: number;
    skippedRows: number;
    committedFlights: number;
  };
  issueCodes: string[];
};

export type ArtifactMigrationCliDependencies = {
  repositories: ImportWorkerRepositories;
  assertDestinationUser(userId: string): Promise<void>;
  readArtifact(sourcePath: string): Promise<string>;
  artifactStat(sourcePath: string): Promise<{ size: number; isFile(): boolean }>;
};

export async function runArtifactMigrationCli(
  argv: string[],
  dependencies: ArtifactMigrationCliDependencies = defaultDependencies(),
): Promise<ArtifactMigrationReport> {
  const options = parseArguments(argv);
  await dependencies.assertDestinationUser(options.userId);
  const sourcePath = path.resolve(options.sourcePath);
  const before = await dependencies.artifactStat(sourcePath);
  if (!before.isFile() || before.size < 2 || before.size > MAX_ARTIFACT_BYTES) {
    throw new MigrationCliError("invalid-source-file");
  }
  const sourceText = await dependencies.readArtifact(sourcePath);
  const sourceHash = sha256(sourceText);
  try {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    throw new MigrationCliError("invalid-json");
  }
  const artifact = validateLocalArtifact(parsed);
  const plan = await planLocalArtifactMigration(
    options.userId,
    artifact,
    dependencies.repositories,
  );
  const initialRows = plan.rows;
  const issueCodes = [...plan.issueCodes];
  let report = reportFor(
    options.mode,
    plan.artifactType,
    Boolean(plan.existingBatch),
    options.mode === "dry-run"
      ? "dry-run"
      : plan.existingBatch?.status ?? "processing",
    initialRows,
    issueCodes,
  );

  if (options.mode !== "dry-run") {
    const staged = await stageLocalArtifactMigration(
      options.userId,
      artifact,
      dependencies.repositories,
    );
    const detailPage = await getCompleteBatch(
      options.userId,
      staged.batchId,
      dependencies.repositories.imports,
    );
    if (!detailPage) throw new MigrationCliError("staged-batch-unavailable");
    const { detail, rows } = detailPage;
    report = reportFor(
      options.mode,
      plan.artifactType,
      staged.reused,
      detail.status,
      rows,
      issueCodes,
    );

    if (options.mode === "commit" && detail.status !== "committed") {
      const decisions = rows.map((row) => ({
        rowId: row.id,
        action:
          row.commitReady && !row.duplicateCandidate
            ? ("accepted" as const)
            : ("skipped" as const),
      }));
      const acceptedRows = decisions.filter(
        (decision) => decision.action === "accepted",
      ).length;
      await decideImportRows(
        options.userId,
        staged.batchId,
        { decisions },
        dependencies.repositories.imports,
      );
      if (acceptedRows === 0) {
        issueCodes.push("no-committable-rows");
      } else {
        await commitImportBatch(
          options.userId,
          staged.batchId,
          dependencies.repositories.imports,
          dependencies.repositories.flights,
        );
      }
      const committedPage = await getCompleteBatch(
        options.userId,
        staged.batchId,
        dependencies.repositories.imports,
      );
      if (!committedPage) {
        throw new MigrationCliError("committed-batch-unavailable");
      }
      const { detail: committed, rows: committedRows } = committedPage;
      report = reportFor(
        options.mode,
        plan.artifactType,
        staged.reused,
        committed.status,
        committedRows,
        issueCodes,
        committed.counts.committedFlights,
      );
    }
  }

  const afterText = await dependencies.readArtifact(sourcePath);
  if (sha256(afterText) !== sourceHash) {
    throw new MigrationCliError("source-artifact-changed");
  }
  return report;
  } catch (error) {
    const afterText = await dependencies.readArtifact(sourcePath);
    if (sha256(afterText) !== sourceHash) {
      throw new MigrationCliError("source-artifact-changed");
    }
    throw error;
  }
}

async function getCompleteBatch(
  userId: string,
  batchId: string,
  repository: ImportWorkerRepositories["imports"],
) {
  const pageSize = 100;
  const detail = await getUserImportBatch(
    userId,
    batchId,
    1,
    pageSize,
    repository,
  );
  if (!detail) return null;
  const rows = [...detail.rows.rows];
  const pageCount = detail.rows.totalPages;
  for (let page = 2; page <= pageCount; page += 1) {
    const next = await getUserImportBatch(
      userId,
      batchId,
      page,
      pageSize,
      repository,
    );
    if (!next) throw new MigrationCliError("staged-batch-unavailable");
    rows.push(...next.rows.rows);
  }
  return { detail, rows };
}

function parseArguments(argv: string[]): {
  userId: string;
  sourcePath: string;
  mode: ArtifactMigrationMode;
} {
  let userId: string | undefined;
  let sourcePath: string | undefined;
  let mode: ArtifactMigrationMode = "dry-run";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--user-id") {
      userId = argv[++index];
    } else if (argument === "--source") {
      sourcePath = argv[++index];
    } else if (argument === "--apply") {
      if (mode === "commit") throw new MigrationCliError("conflicting-mode");
      mode = "apply";
    } else if (argument === "--commit") {
      if (mode === "apply") throw new MigrationCliError("conflicting-mode");
      mode = "commit";
    } else if (argument === "--dry-run") {
      if (mode !== "dry-run") throw new MigrationCliError("conflicting-mode");
    } else {
      throw new MigrationCliError("unknown-argument");
    }
  }
  if (!userId || !UUID_PATTERN.test(userId)) {
    throw new MigrationCliError("invalid-user-id");
  }
  if (!sourcePath?.trim()) throw new MigrationCliError("missing-source");
  return { userId, sourcePath, mode };
}

function reportFor(
  mode: ArtifactMigrationMode,
  artifactType: ArtifactMigrationReport["artifactType"],
  reused: boolean,
  status: string,
  rows: StoredImportRow[],
  issueCodes: string[],
  committedFlights = 0,
): ArtifactMigrationReport {
  return {
    ok: true,
    mode,
    artifactType,
    reused,
    status: safeStatus(mode, status),
    counts: {
      totalRows: rows.length,
      commitReadyRows: rows.filter((row) => row.commitReady).length,
      duplicateRows: rows.filter((row) => row.duplicateCandidate).length,
      unresolvedRows: rows.filter(
        (row) => row.validationState === "unresolved",
      ).length,
      ambiguousRows: rows.filter(
        (row) => row.validationState === "ambiguous",
      ).length,
      acceptedRows: rows.filter((row) => row.decision === "accepted").length,
      skippedRows: rows.filter((row) => row.decision === "skipped").length,
      committedFlights,
    },
    issueCodes: [...new Set(issueCodes)].sort(),
  };
}

function safeStatus(
  mode: ArtifactMigrationMode,
  status: string,
): ArtifactMigrationReport["status"] {
  if (mode === "dry-run") return "dry-run";
  if (
    status === "review" ||
    status === "failed" ||
    status === "committed" ||
    status === "processing"
  ) {
    return status;
  }
  return "processing";
}

function defaultDependencies(): ArtifactMigrationCliDependencies {
  const repository = new DrizzleImportRepository();
  return {
    repositories: {
      imports: repository,
      flights: repository,
      airports: repository,
    },
    async assertDestinationUser(userId) {
      const [user] = await withUserDb(userId, (tx) =>
        tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1),
      );
      if (!user) throw new MigrationCliError("destination-user-not-found");
    },
    readArtifact: (sourcePath) => readFile(sourcePath, "utf8"),
    artifactStat: (sourcePath) => stat(sourcePath),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class MigrationCliError extends Error {
  constructor(readonly code: string) {
    super("Local artifact migration could not run.");
    this.name = "MigrationCliError";
  }
}

async function main(): Promise<void> {
  try {
    const report = await runArtifactMigrationCli(process.argv.slice(2));
    console.log(JSON.stringify(report));
  } catch (error) {
    const errorCode =
      error instanceof MigrationCliError ||
      error instanceof LocalArtifactValidationError
        ? error.code
        : "migration-failed";
    console.error(JSON.stringify({ ok: false, errorCode }));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  void main();
}
