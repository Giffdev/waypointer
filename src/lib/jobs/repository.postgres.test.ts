import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { backgroundJobs, users } from "@/lib/db/schema";
import { DurableJobRepository } from "./repository";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_IMPORT_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const cleanupUsers: string[] = [];

postgresDescribe("PostgreSQL durable queue claims", () => {
  afterEach(async () => {
    for (const userId of cleanupUsers.splice(0)) {
      await getDb()
        .delete(backgroundJobs)
        .where(eq(backgroundJobs.userId, userId));
      await getDb().delete(users).where(eq(users.id, userId));
    }
  });

  it("deduplicates enqueue, permits one concurrent lease, and recovers expiry", async () => {
    const userId = await createUser();
    const batchId = randomUUID();
    const first = new DurableJobRepository(getDb());
    const second = new DurableJobRepository(getDb());

    const jobIds = await Promise.all([
      first.enqueueScanImport(userId, batchId, 4),
      second.enqueueScanImport(userId, batchId, 4),
    ]);
    expect(new Set(jobIds).size).toBe(1);

    const claims = await Promise.all([
      first.claim("worker-concurrent-a", 120),
      second.claim("worker-concurrent-b", 120),
    ]);
    const claimed = claims.filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: jobIds[0],
      userId,
      attempts: 1,
    });

    await getDb()
      .update(backgroundJobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(backgroundJobs.id, jobIds[0]));

    const recovered = await second.claim("worker-recovery", 120);
    expect(recovered).toMatchObject({
      id: jobIds[0],
      userId,
      attempts: 2,
      leaseOwner: "worker-recovery",
    });
    await expect(
      second.complete(jobIds[0], "worker-recovery"),
    ).resolves.toBe(true);
  });

  it("never claims work for a disabled user", async () => {
    const userId = await createUser({ disabled: true });
    const repository = new DurableJobRepository(getDb());
    const jobId = await repository.enqueueScanImport(
      userId,
      randomUUID(),
      3,
    );

    await expect(
      repository.claim("worker-disabled-check", 120),
    ).resolves.toBeNull();
    const [job] = await getDb()
      .select({ state: backgroundJobs.state, attempts: backgroundJobs.attempts })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, jobId));
    expect(job).toEqual({ state: "queued", attempts: 0 });
  });
});

async function createUser(options: { disabled?: boolean } = {}) {
  const userId = randomUUID();
  cleanupUsers.push(userId);
  await getDb().insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    username: `durable-${userId.slice(0, 8)}`,
    emailVerified: new Date(),
    disabledAt: options.disabled ? new Date() : null,
  });
  return userId;
}
