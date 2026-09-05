import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Version-aware reprocessing, against a real database.
 *
 * The unique indexes are the whole subject here — `(user_id, file_sha256,
 * importer_version)` and `(user_id, source_row_key)` — so these cannot be
 * meaningfully faked. Object storage *is* faked, but with a store that
 * enforces the properties that matter: `copy` leaves the source in place,
 * `move` does not, and deleting one key never touches another.
 */

const store = new Map<string, Uint8Array>();

const storage = {
  async put(key: string, bytes: Uint8Array) {
    store.set(key, bytes);
  },
  async get(key: string) {
    const bytes = store.get(key);
    if (!bytes) throw new Error("missing object");
    return { key, bytes };
  },
  async head(key: string) {
    const bytes = store.get(key);
    return bytes
      ? { key, sizeBytes: bytes.length, contentType: "text/csv" }
      : null;
  },
  async presignPut(key: string) {
    return {
      url: `https://objects.invalid/${key}`,
      expiresAt: new Date(Date.now() + 600_000),
      headers: { "content-type": "text/csv" },
    };
  },
  async move(source: string, destination: string) {
    const bytes = store.get(source);
    if (!bytes) throw new Error("missing object");
    store.set(destination, bytes);
    store.delete(source);
  },
  async copy(source: string, destination: string) {
    const bytes = store.get(source);
    if (!bytes) throw new Error("missing object");
    store.set(destination, new Uint8Array(bytes));
  },
  async delete(key: string) {
    store.delete(key);
  },
};

vi.mock("@/lib/runtime-mode", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/runtime-mode")>();
  return { ...original, isDurableImportConfiguration: () => true };
});

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return { ...original, getPrivateObjectStorage: () => storage };
});

const { getDb, withUserDb } = await import("@/lib/db");
const { backgroundJobs, importBatches, users } = await import(
  "@/lib/db/schema"
);
const { canonicalImportObjectKey } = await import("@/lib/storage/presign");
const { reprocessDurableImport, initiateDurableImport } = await import(
  "./durable-service"
);
const { IMPORTER_PIPELINE_VERSION } = await import("./version");
const { ImportServiceError } = await import("@/app/api/import/_lib/service");

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_IMPORT_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;

const cleanupUsers: string[] = [];

async function createUser(label: string): Promise<string> {
  const userId = randomUUID();
  cleanupUsers.push(userId);
  await getDb().insert(users).values({
    id: userId,
    email: `${label}-${userId}@example.test`,
    username: `mal${userId.replaceAll("-", "").slice(0, 12)}`,
    emailVerified: new Date(),
  });
  return userId;
}

function sha(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64).replaceAll(/[^0-9a-f]/g, "a");
}

async function seedLegacyBatch(
  userId: string,
  options: {
    fileSha256: string;
    status?: "committed" | "review";
    importerVersion?: number;
  },
): Promise<{ batchId: string; objectKey: string }> {
  const batchId = randomUUID();
  const objectKey = canonicalImportObjectKey(
    userId,
    batchId,
    options.fileSha256,
  );
  await storage.put(objectKey, new TextEncoder().encode("Date,From,To\n"));
  await withUserDb(userId, (tx) =>
    tx.insert(importBatches).values({
      id: batchId,
      userId,
      adapterId: "foreflight-v1",
      adapterVersion: 1,
      importerVersion: options.importerVersion ?? 0,
      status: options.status ?? "committed",
      originalObjectKey: objectKey,
      originalFileName: "legacy.csv",
      declaredContentType: "text/csv",
      fileSha256: options.fileSha256,
      fileSizeBytes: 13,
      idempotencyKey: `legacy:${batchId}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      uploadCompletedAt: new Date(),
      scanStatus: "clean",
    }),
  );
  return { batchId, objectKey };
}

postgresDescribe("PostgreSQL version-aware reprocessing", () => {
  beforeEach(() => {
    store.clear();
    vi.stubEnv("IMPORT_MAX_BYTES", String(10 * 1024 * 1024));
    vi.stubEnv("IMPORT_RETENTION_DAYS", "7");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const userId of cleanupUsers.splice(0)) {
      await withUserDb(userId, async (tx) => {
        await tx
          .delete(backgroundJobs)
          .where(eq(backgroundJobs.userId, userId));
        await tx
          .update(importBatches)
          .set({ reprocessedFromBatchId: null })
          .where(eq(importBatches.userId, userId));
        await tx.delete(importBatches).where(eq(importBatches.userId, userId));
      });
      await getDb().delete(users).where(eq(users.id, userId));
    }
  });

  it("stamps the importer version at upload start so a legacy re-upload recovers", async () => {
    // The failure this defends against: the durable start insert left
    // `importer_version` on its column default (0), the worker later stamped
    // the real hash, and the partial unique index on
    // `(user_id, file_sha256, importer_version)` collided with the legacy
    // committed batch holding the same bytes at version 0. The user's attempt
    // to re-upload the file the old importer mangled returned a 500 — the one
    // recovery path, broken by the fix meant to enable it.
    const userId = await createUser("legacy-reupload");
    const fileSha256 = sha("1a2b3c");
    const legacy = await seedLegacyBatch(userId, {
      fileSha256,
      status: "committed",
      importerVersion: 0,
    });

    const initiated = await initiateDurableImport(userId, {
      fileName: "logbook.csv",
      contentType: "text/csv",
      sizeBytes: 13,
    });
    expect(initiated.batchId).not.toBe(legacy.batchId);

    const [pending] = await withUserDb(userId, (tx) =>
      tx
        .select({
          id: importBatches.id,
          importerVersion: importBatches.importerVersion,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.id, initiated.batchId),
          ),
        ),
    );
    expect(pending.importerVersion).toBe(IMPORTER_PIPELINE_VERSION);
    expect(pending.importerVersion).not.toBe(0);

    // The worker's SHA stamp is where the collision used to happen. With the
    // version stamped at insert, the two rows differ on the third index
    // column and both survive.
    await expect(
      withUserDb(userId, (tx) =>
        tx
          .update(importBatches)
          .set({ fileSha256, status: "processing" })
          .where(
            and(
              eq(importBatches.userId, userId),
              eq(importBatches.id, pending.id),
            ),
          ),
      ),
    ).resolves.not.toThrow();

    const [{ total }] = await withUserDb(userId, (tx) =>
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.fileSha256, fileSha256),
          ),
        ),
    );
    expect(total).toBe(2);
  });

  it("copies the original object so the source batch keeps its own file", async () => {
    // Moving would have handed the source batch's only object to the new
    // batch. Retention cleanup deletes by key, so the first sweep to fire
    // would destroy the other batch's source file — and a second reprocess
    // would find nothing to read.
    const userId = await createUser("reprocess-copy");
    const fileSha256 = sha("beef01");
    const source = await seedLegacyBatch(userId, { fileSha256 });

    const result = await reprocessDurableImport(userId, source.batchId);

    expect(result.reused).toBe(false);
    expect(result.reprocessedFromBatchId).toBe(source.batchId);
    expect(result.batchId).not.toBe(source.batchId);

    const [created] = await withUserDb(userId, (tx) =>
      tx
        .select({
          objectKey: importBatches.originalObjectKey,
          importerVersion: importBatches.importerVersion,
          expiresAt: importBatches.expiresAt,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.id, result.batchId),
          ),
        ),
    );
    expect(created.importerVersion).toBe(IMPORTER_PIPELINE_VERSION);
    // Distinct keys, both present: neither batch can delete the other's file.
    expect(created.objectKey).not.toBe(source.objectKey);
    expect(store.has(source.objectKey)).toBe(true);
    expect(store.has(created.objectKey)).toBe(true);

    // Deleting the source batch's object leaves the reprocessed one readable.
    await storage.delete(source.objectKey);
    expect(store.has(created.objectKey)).toBe(true);
  });

  it("returns the existing reprocessed batch instead of colliding on a second call", async () => {
    // Two clicks, a retried request, or a second reprocess of the same source
    // all hit `(user_id, file_sha256, importer_version)`. Failing there would
    // leave the caller unable to tell "already done" from "broken".
    const userId = await createUser("reprocess-idempotent");
    const fileSha256 = sha("cafe02");
    const source = await seedLegacyBatch(userId, { fileSha256 });

    const first = await reprocessDurableImport(userId, source.batchId);
    const second = await reprocessDurableImport(userId, source.batchId);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.batchId).toBe(first.batchId);

    const [{ total }] = await withUserDb(userId, (tx) =>
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.reprocessedFromBatchId, source.batchId),
          ),
        ),
    );
    expect(total).toBe(1);

    // The source batch is untouched and still reprocessable-looking; nothing
    // about the second call degraded it.
    const [sourceRow] = await withUserDb(userId, (tx) =>
      tx
        .select({
          status: importBatches.status,
          importerVersion: importBatches.importerVersion,
          objectKey: importBatches.originalObjectKey,
          deletedAt: importBatches.originalDeletedAt,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.id, source.batchId),
          ),
        ),
    );
    expect(sourceRow.status).toBe("committed");
    expect(sourceRow.importerVersion).toBe(0);
    expect(sourceRow.deletedAt).toBeNull();
    expect(store.has(sourceRow.objectKey)).toBe(true);

    // And exactly one scan job was queued, so the copy is parsed once.
    const scanJobs = await withUserDb(userId, (tx) =>
      tx
        .select({ key: backgroundJobs.idempotencyKey })
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.userId, userId),
            eq(backgroundJobs.jobType, "scan_import"),
          ),
        ),
    );
    expect(scanJobs).toEqual([{ key: `scan-import:${first.batchId}` }]);
  });

  it("refuses to reprocess a batch that already ran on the current importer", async () => {
    const userId = await createUser("reprocess-current");
    const current = await seedLegacyBatch(userId, {
      fileSha256: sha("d0d0d0"),
      importerVersion: IMPORTER_PIPELINE_VERSION,
    });
    await expect(
      reprocessDurableImport(userId, current.batchId),
    ).rejects.toMatchObject({ status: 409, code: "reprocess-not-required" });
  });

  it("tells the user to re-upload once retention has removed the original", async () => {
    const userId = await createUser("reprocess-gone");
    const gone = await seedLegacyBatch(userId, { fileSha256: sha("0ff0ff") });
    await storage.delete(gone.objectKey);

    await expect(
      reprocessDurableImport(userId, gone.batchId),
    ).rejects.toBeInstanceOf(ImportServiceError);
    await expect(
      reprocessDurableImport(userId, gone.batchId),
    ).rejects.toMatchObject({
      status: 410,
      code: "original-file-unavailable",
    });
    // No half-built batch left behind for the user to trip over.
    const [{ total }] = await withUserDb(userId, (tx) =>
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(importBatches)
        .where(eq(importBatches.userId, userId)),
    );
    expect(total).toBe(1);
  });

  it("refuses to reprocess another user's batch", async () => {
    const owner = await createUser("reprocess-owner");
    const stranger = await createUser("reprocess-stranger");
    const source = await seedLegacyBatch(owner, { fileSha256: sha("aa11bb") });
    await expect(
      reprocessDurableImport(stranger, source.batchId),
    ).rejects.toMatchObject({ status: 404, code: "batch-not-found" });
  });

  it("recovers after the previous reprocess result expired", async () => {
    // `import_batches_user_idempotency_unique` is not scoped by status, so an
    // expired earlier attempt keeps owning a fixed idempotency key forever.
    // With a fixed key the insert conflicts, the conflict lookup skips the
    // expired row (an expired batch has had its rows and object removed, so
    // it is not a usable result), and the user is left with a permanent 409
    // for a recovery that is entirely legitimate.
    const userId = await createUser("reprocess-expired");
    const source = await seedLegacyBatch(userId, { fileSha256: sha("ee11ee") });

    const first = await reprocessDurableImport(userId, source.batchId);
    await withUserDb(userId, (tx) =>
      tx
        .update(importBatches)
        .set({ status: "expired" })
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.id, first.batchId),
          ),
        ),
    );

    const second = await reprocessDurableImport(userId, source.batchId);
    expect(second.reused).toBe(false);
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.reprocessedFromBatchId).toBe(source.batchId);

    // Repeat reprocess is still idempotent against the *live* result, so the
    // recovery did not trade one defect for unbounded batch creation.
    const third = await reprocessDurableImport(userId, source.batchId);
    expect(third.reused).toBe(true);
    expect(third.batchId).toBe(second.batchId);

    const live = await withUserDb(userId, (tx) =>
      tx
        .select({ id: importBatches.id, status: importBatches.status })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.reprocessedFromBatchId, source.batchId),
          ),
        ),
    );
    expect(live).toHaveLength(2);
    expect(
      live.filter(({ status }) => status !== "expired").map(({ id }) => id),
    ).toEqual([second.batchId]);
  });

  it("creates a new result for a future importer version instead of returning the old one", async () => {
    // Keyed on the source batch alone, the first reprocess would be handed
    // back forever and the *next* importer fix could never reach this file —
    // the same "a deployed fix cannot reach the data it fixes" defect that
    // version stamping exists to remove, moved one level up.
    const userId = await createUser("reprocess-next-version");
    const source = await seedLegacyBatch(userId, { fileSha256: sha("f00d11") });

    // A result left behind by an earlier importer. Its `file_sha256` differs
    // from the source's only so the fixture can hold two live rows while
    // `IMPORTER_PIPELINE_VERSION` is still 1: a real timeline (source at 0,
    // old result at 1, new result at 2) never puts two rows on the same
    // version, and the hash plays no part in the lookup under test.
    const staleId = randomUUID();
    await withUserDb(userId, (tx) =>
      tx.insert(importBatches).values({
        id: staleId,
        userId,
        adapterId: "foreflight-v1",
        adapterVersion: 1,
        importerVersion: IMPORTER_PIPELINE_VERSION - 1,
        reprocessedFromBatchId: source.batchId,
        status: "review",
        originalObjectKey: canonicalImportObjectKey(
          userId,
          staleId,
          sha("f00d12"),
        ),
        originalFileName: "legacy.csv",
        declaredContentType: "text/csv",
        fileSha256: sha("f00d12"),
        fileSizeBytes: 13,
        idempotencyKey: `reprocess:${source.batchId}:v${IMPORTER_PIPELINE_VERSION - 1}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
        uploadCompletedAt: new Date(),
        scanStatus: "clean",
      }),
    );

    const result = await reprocessDurableImport(userId, source.batchId);
    expect(result.reused).toBe(false);
    expect(result.batchId).not.toBe(staleId);

    const [created] = await withUserDb(userId, (tx) =>
      tx
        .select({ importerVersion: importBatches.importerVersion })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.id, result.batchId),
          ),
        ),
    );
    expect(created.importerVersion).toBe(IMPORTER_PIPELINE_VERSION);

    // The stale result is left exactly as it was: reprocessing is additive,
    // and rewriting somebody's earlier batch is not this call's business.
    const [stale] = await withUserDb(userId, (tx) =>
      tx
        .select({
          status: importBatches.status,
          importerVersion: importBatches.importerVersion,
        })
        .from(importBatches)
        .where(
          and(eq(importBatches.userId, userId), eq(importBatches.id, staleId)),
        ),
    );
    expect(stale).toMatchObject({
      status: "review",
      importerVersion: IMPORTER_PIPELINE_VERSION - 1,
    });
  });

  it("elects one winner when two reprocess calls race, and orphans no object", async () => {
    const userId = await createUser("reprocess-race");
    const source = await seedLegacyBatch(userId, { fileSha256: sha("ba5eba") });

    const [left, right] = await Promise.all([
      reprocessDurableImport(userId, source.batchId),
      reprocessDurableImport(userId, source.batchId),
    ]);
    expect(left.batchId).toBe(right.batchId);
    expect([left.reused, right.reused].filter(Boolean)).toHaveLength(1);

    const created = await withUserDb(userId, (tx) =>
      tx
        .select({
          id: importBatches.id,
          objectKey: importBatches.originalObjectKey,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.reprocessedFromBatchId, source.batchId),
          ),
        ),
    );
    expect(created).toHaveLength(1);
    // The loser deletes its copy: an orphaned object is a retained copy of
    // the user's logbook that no batch will ever clean up.
    expect([...store.keys()].toSorted()).toEqual(
      [source.objectKey, created[0].objectKey].toSorted(),
    );
  });
});
