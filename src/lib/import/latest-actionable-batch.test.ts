import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DrizzleImportRepository } from "@/lib/db/repositories/drizzle-import-repository";
import type { DatabaseTransaction } from "@/lib/db";
import { flightSources, importBatches, importRows } from "@/lib/db/schema";
import {
  RESUMABLE_IMPORT_BATCH_STATUSES,
  RETRYABLE_IMPORT_FAILURE_CODES,
} from "./resume";
import { InMemoryImportRepository } from "./in-memory-repository";
import { createFileFingerprint } from "./fingerprint";

type RecordedSelect = { table: unknown; limit?: number; where?: unknown };

type RecordingBuilder = {
  from: (table: unknown) => RecordingBuilder;
  where: (condition?: unknown) => RecordingBuilder;
  orderBy: (order?: unknown) => RecordingBuilder;
  limit: (count: number) => RecordingBuilder;
  then: (
    onFulfilled?: (rows: unknown[]) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
};

/**
 * A transaction double that records which tables a repository method reads and
 * whether it bounded the read. It exists so "opening /import must not hydrate
 * the whole import corpus" is asserted on the real Drizzle code path rather
 * than inferred from a Postgres row count.
 */
function recordingTransaction(
  rowsByTable: Map<unknown, unknown[]>,
  recorded: RecordedSelect[],
): DatabaseTransaction {
  const select = (): RecordingBuilder => {
    const entry: RecordedSelect = { table: undefined };
    const builder: RecordingBuilder = {
      from(table) {
        entry.table = table;
        recorded.push(entry);
        return builder;
      },
      where(condition) {
        entry.where = condition;
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit(count) {
        entry.limit = count;
        return builder;
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(rowsByTable.get(entry.table) ?? []).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return builder;
  };
  return { select } as unknown as DatabaseTransaction;
}

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    adapterId: "foreflight",
    adapterVersion: 1,
    importerVersion: 0,
    reprocessedFromBatchId: null,
    status: "review",
    originalObjectKey: "imports/owner/file.csv",
    originalDeletedAt: null,
    originalFileName: "logbook.csv",
    duplicateOfBatchId: null,
    totalRows: 4,
    parsedRows: 4,
    importedRows: 0,
    failureCode: null,
    failureMessage: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:01.000Z"),
    ...overrides,
  };
}

describe("DrizzleImportRepository.findLatestActionableBatch", () => {
  it("reads one bounded batch row and summarizes only that batch", async () => {
    const recorded: RecordedSelect[] = [];
    const repository = new DrizzleImportRepository(async (_userId, work) =>
      work(
        recordingTransaction(
          new Map<unknown, unknown[]>([
            [importBatches, [batchRow()]],
            [importRows, []],
            [flightSources, []],
          ]),
          recorded,
        ),
      ),
    );

    const batch = await repository.findLatestActionableBatch(
      "22222222-2222-4222-8222-222222222222",
    );

    expect(batch?.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(batch?.status).toBe("review");

    const batchSelects = recorded.filter(
      (entry) => entry.table === importBatches,
    );
    // A `LIMIT 1` in the query, not a slice of an unbounded list: the caller
    // never sees more than one batch and the database never builds more.
    expect(batchSelects).toHaveLength(1);
    expect(batchSelects[0].limit).toBe(1);
    // Row and source hydration happens once, for the single returned batch.
    // The history list this replaced did it for every batch ever imported.
    expect(
      recorded.filter((entry) => entry.table === importRows),
    ).toHaveLength(1);
    expect(
      recorded.filter((entry) => entry.table === flightSources),
    ).toHaveLength(1);
  });

  it("filters actionable statuses and retryable failure codes in the SQL predicate, not in memory", async () => {
    // Compile the actual condition object passed to `.where()` through the
    // real Postgres dialect, the same way Drizzle would before sending it to
    // the database. This proves the filter is a real SQL predicate rather
    // than a string convention: it fails if a terminal status is added to
    // the `inArray`, or if the retryable-failure-code condition is dropped
    // or weakened, without needing a live database.
    const recorded: RecordedSelect[] = [];
    const repository = new DrizzleImportRepository(async (_userId, work) =>
      work(
        recordingTransaction(
          new Map<unknown, unknown[]>([
            [importBatches, [batchRow()]],
            [importRows, []],
            [flightSources, []],
          ]),
          recorded,
        ),
      ),
    );

    await repository.findLatestActionableBatch(
      "22222222-2222-4222-8222-222222222222",
    );

    const batchSelect = recorded.find((entry) => entry.table === importBatches);
    const { sql: text, params } = new PgDialect().sqlToQuery(
      batchSelect!.where as SQL,
    );

    expect(text).toContain('"status" in');
    expect(text).toContain('"failure_code" in');

    for (const status of RESUMABLE_IMPORT_BATCH_STATUSES) {
      expect(params, `missing actionable status ${status}`).toContain(status);
    }
    for (const code of RETRYABLE_IMPORT_FAILURE_CODES) {
      expect(params, `missing retryable failure code ${code}`).toContain(
        code,
      );
    }
    // None of these ever belong in the actionable status list: they are
    // finished, and re-surfacing them is the import history this query
    // replaced.
    for (const terminalStatus of [
      "committed",
      "deduplicated",
      "cancelled",
      "quarantined",
      "expired",
    ]) {
      expect(
        params,
        `terminal status ${terminalStatus} leaked into the query`,
      ).not.toContain(terminalStatus);
    }
    // A failure code the retry button does not accept must not make a
    // failed batch actionable.
    expect(params).not.toContain("malware-detected");
  });

  it("hydrates nothing when no batch is actionable", async () => {
    const recorded: RecordedSelect[] = [];
    const repository = new DrizzleImportRepository(async (_userId, work) =>
      work(
        recordingTransaction(
          new Map<unknown, unknown[]>([[importBatches, []]]),
          recorded,
        ),
      ),
    );

    expect(
      await repository.findLatestActionableBatch(
        "22222222-2222-4222-8222-222222222222",
      ),
    ).toBeNull();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe(importBatches);
    expect(recorded[0].limit).toBe(1);
  });
});

describe("InMemoryImportRepository.findLatestActionableBatch", () => {
  const userId = "33333333-3333-4333-8333-333333333333";

  async function stage(
    repository: InMemoryImportRepository,
    id: string,
    fileName: string,
  ) {
    return repository.createBatch(userId, {
      id,
      fileName,
      fileSizeBytes: 32,
      fileFingerprint: createFileFingerprint(userId, `${id}-bytes`),
      status: "processing",
    });
  }

  it("returns the newest unfinished batch and nothing else", async () => {
    const repository = new InMemoryImportRepository();
    await stage(repository, "44444444-4444-4444-8444-444444444444", "old.csv");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await stage(repository, "55555555-5555-4555-8555-555555555555", "new.csv");

    const latest = await repository.findLatestActionableBatch(userId);
    expect(latest?.fileName).toBe("new.csv");
  });

  it("drops an expired batch and a failure the retry path cannot recover", async () => {
    const repository = new InMemoryImportRepository();
    const batchId = "66666666-6666-4666-8666-666666666666";
    await stage(repository, batchId, "quarantined.csv");
    await repository.failBatch(userId, batchId, {
      code: "malware-detected",
      message: "Malware detected.",
    });
    expect(await repository.findLatestActionableBatch(userId)).toBeNull();

    const retryableId = "77777777-7777-4777-8777-777777777777";
    await stage(repository, retryableId, "scanner.csv");
    await repository.failBatch(userId, retryableId, {
      code: "scanner-unavailable",
      message: "The scanner is unavailable.",
    });
    expect((await repository.findLatestActionableBatch(userId))?.id).toBe(
      retryableId,
    );

    await repository.expireBatchAndScrub(userId, retryableId);
    expect(await repository.findLatestActionableBatch(userId)).toBeNull();
  });
});
