import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import {
  getDb,
  withUserDb,
  type DatabaseTransaction,
} from "@/lib/db";
import {
  accountDeletionRequests,
  accountDeletionTokens,
  backgroundJobs,
  deletionTombstones,
  importBatches,
  sessions,
  users,
} from "@/lib/db/schema";
import {
  getPrivateObjectStorage,
  type PrivateObjectStorage,
} from "@/lib/storage";
import { sendDeletionCancellationEmail } from "./email";
import { verifyPassword } from "./password";
import { authSessionCookieName } from "./session-cookie";
import { revokeUserSessions } from "./account-state";

const RECENT_AUTH_WINDOW_MS = 15 * 60_000;
const DELETION_GRACE_MS = 7 * 24 * 60 * 60_000;
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60_000;

export class DeletionAuthorizationError extends Error {
  constructor() {
    super("The account deletion request could not be authorized.");
    this.name = "DeletionAuthorizationError";
  }
}

export type AccountDeletionRequestResult = {
  status: "pending";
  graceExpiresAt: string;
  developmentCancellationUrl?: string;
};

async function hasRecentSession(userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(authSessionCookieName())?.value;
  if (!token) return false;
  const cutoff = new Date(Date.now() - RECENT_AUTH_WINDOW_MS);
  const [session] = await getDb()
    .select({ token: sessions.sessionToken })
    .from(sessions)
    .where(
      and(
        eq(sessions.sessionToken, token),
        eq(sessions.userId, userId),
        gt(sessions.expires, new Date()),
        gte(sessions.authenticatedAt, cutoff),
      ),
    )
    .limit(1);
  return Boolean(session);
}

export async function authorizeAccountDeletion(
  userId: string,
  password: string | undefined,
): Promise<void> {
  const [account, recent] = await Promise.all([
    getDb()
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .then(([row]) => row),
    hasRecentSession(userId),
  ]);
  if (!account || !recent) throw new DeletionAuthorizationError();
  if (
    account.passwordHash &&
    (!password || !(await verifyPassword(account.passwordHash, password)))
  ) {
    throw new DeletionAuthorizationError();
  }
}

export async function requestAccountDeletion(input: {
  userId: string;
  password?: string;
  publicOrigin: string;
}): Promise<AccountDeletionRequestResult> {
  await authorizeAccountDeletion(input.userId, input.password);

  const now = new Date();
  const graceExpiresAt = new Date(now.getTime() + DELETION_GRACE_MS);
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const requestId = randomUUID();

  const account = await withUserDb(input.userId, async (tx) => {
    const [lockedAccount] = await tx
      .select({ id: users.id, email: users.email, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!lockedAccount || lockedAccount.disabledAt) {
      throw new DeletionAuthorizationError();
    }

    await tx.insert(accountDeletionRequests).values({
      id: requestId,
      userId: input.userId,
      status: "pending",
      requestedAt: now,
      graceExpiresAt,
      purgeAfter: graceExpiresAt,
    });
    await tx
      .update(users)
      .set({ disabledAt: now, updatedAt: now })
      .where(eq(users.id, input.userId));
    await revokeUserSessions(tx, input.userId);
    await tx
      .update(backgroundJobs)
      .set({
        state: "cancelled",
        cancelRequestedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(backgroundJobs.userId, input.userId),
          eq(backgroundJobs.state, "queued"),
        ),
      );
    await tx
      .update(backgroundJobs)
      .set({ cancelRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(backgroundJobs.userId, input.userId),
          eq(backgroundJobs.state, "running"),
        ),
      );
    await tx.insert(accountDeletionTokens).values({
      requestId,
      userId: input.userId,
      tokenHash,
      expiresAt: graceExpiresAt,
    });
    await tx.insert(backgroundJobs).values({
      userId: input.userId,
      jobType: "purge_account",
      state: "queued",
      payload: { requestId },
      idempotencyKey: `account-deletion:${requestId}`,
      availableAt: graceExpiresAt,
    });
    return lockedAccount;
  });

  const cancellationUrl = new URL("/auth/delete-cancel", input.publicOrigin);
  cancellationUrl.searchParams.set("token", rawToken);
  try {
    const delivery = await sendDeletionCancellationEmail({
      email: account.email,
      cancellationUrl: cancellationUrl.toString(),
      graceExpiresAt,
    });
    return {
      status: "pending",
      graceExpiresAt: graceExpiresAt.toISOString(),
      developmentCancellationUrl: delivery.developmentUrl,
    };
  } catch (error) {
    await compensateFailedDeletionNotification(
      input.userId,
      requestId,
      now,
    );
    throw error;
  }
}

async function compensateFailedDeletionNotification(
  userId: string,
  requestId: string,
  requestedAt: Date,
): Promise<void> {
  await withUserDb(userId, async (tx) => {
    const now = new Date();
    const [cancelled] = await tx
      .update(accountDeletionRequests)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(
        and(
          eq(accountDeletionRequests.id, requestId),
          eq(accountDeletionRequests.userId, userId),
          eq(accountDeletionRequests.status, "pending"),
        ),
      )
      .returning({ id: accountDeletionRequests.id });
    if (!cancelled) return;
    await tx
      .update(users)
      .set({ disabledAt: null, updatedAt: now })
      .where(
        and(
          eq(users.id, userId),
          eq(users.disabledAt, requestedAt),
        ),
      );
    await tx
      .update(accountDeletionTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(accountDeletionTokens.requestId, requestId),
          eq(accountDeletionTokens.userId, userId),
        ),
      );
    await cancelPurgeJob(tx, userId, requestId, now);
  });
}

export async function cancelAccountDeletion(rawToken: string): Promise<void> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await getDb().transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(accountDeletionTokens)
      .where(
        and(
          eq(accountDeletionTokens.tokenHash, tokenHash),
          isNull(accountDeletionTokens.usedAt),
          gt(accountDeletionTokens.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for("update");
    if (!token) return;
    await tx.execute(
      sql`select set_config('app.current_user_id', ${token.userId}, true)`,
    );
    const now = new Date();
    const [request] = await tx
      .update(accountDeletionRequests)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(
        and(
          eq(accountDeletionRequests.id, token.requestId),
          eq(accountDeletionRequests.userId, token.userId),
          eq(accountDeletionRequests.status, "pending"),
          gt(accountDeletionRequests.graceExpiresAt, now),
        ),
      )
      .returning({
        id: accountDeletionRequests.id,
        requestedAt: accountDeletionRequests.requestedAt,
      });
    await tx
      .update(accountDeletionTokens)
      .set({ usedAt: now })
      .where(eq(accountDeletionTokens.id, token.id));
    if (!request) return;
    await tx
      .update(users)
      .set({ disabledAt: null, updatedAt: now })
      .where(
        and(
          eq(users.id, token.userId),
          eq(users.disabledAt, request.requestedAt),
        ),
      );
    await revokeUserSessions(tx, token.userId);
    await cancelPurgeJob(tx, token.userId, token.requestId, now);
  });
}

async function cancelPurgeJob(
  tx: DatabaseTransaction,
  userId: string,
  requestId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(backgroundJobs)
    .set({
      state: "cancelled",
      cancelRequestedAt: now,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(backgroundJobs.userId, userId),
        eq(backgroundJobs.jobType, "purge_account"),
        eq(backgroundJobs.idempotencyKey, `account-deletion:${requestId}`),
        eq(backgroundJobs.state, "queued"),
      ),
    );
  await tx
    .update(backgroundJobs)
    .set({ cancelRequestedAt: now, updatedAt: now })
    .where(
      and(
        eq(backgroundJobs.userId, userId),
        eq(backgroundJobs.jobType, "purge_account"),
        eq(backgroundJobs.idempotencyKey, `account-deletion:${requestId}`),
        eq(backgroundJobs.state, "running"),
      ),
    );
}

function tombstoneHash(userId: string): string {
  const secret =
    process.env.DELETION_TOMBSTONE_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("Deletion tombstone secret is not configured.");
  return createHmac("sha256", secret).update(userId).digest("hex");
}

export async function purgeAccountDeletion(input: {
  userId: string;
  requestId: string;
}): Promise<"purged" | "already-purged" | "not-ready"> {
  const subjectHash = tombstoneHash(input.userId);
  const [existingTombstone] = await getDb()
    .select({ hash: deletionTombstones.subjectHash })
    .from(deletionTombstones)
    .where(eq(deletionTombstones.subjectHash, subjectHash))
    .limit(1);
  if (existingTombstone) return "already-purged";

  const objectKeys = await withUserDb(input.userId, async (tx) => {
    const now = new Date();
    const [claimed] = await tx
      .update(accountDeletionRequests)
      .set({ status: "processing", processingStartedAt: now, updatedAt: now })
      .where(
        and(
          eq(accountDeletionRequests.id, input.requestId),
          eq(accountDeletionRequests.userId, input.userId),
          inArray(accountDeletionRequests.status, [
            "pending",
            "processing",
            "failed",
          ]),
          lte(accountDeletionRequests.graceExpiresAt, now),
        ),
      )
      .returning({ id: accountDeletionRequests.id });
    if (!claimed) return null;
    const batches = await tx
      .select({
        originalKey: importBatches.originalObjectKey,
        quarantineKey: importBatches.quarantineObjectKey,
      })
      .from(importBatches)
      .where(eq(importBatches.userId, input.userId));
    return [
      ...new Set(
        batches
          .flatMap(({ originalKey, quarantineKey }) => [
            originalKey,
            quarantineKey,
          ])
          .filter((key): key is string => Boolean(key)),
      ),
    ];
  });
  if (!objectKeys) return "not-ready";

  try {
    await deleteAccountObjects(objectKeys);
  } catch (error) {
    await markPurgeFailed(input.userId, input.requestId);
    throw error;
  }

  return withUserDb(input.userId, async (tx) => {
    const now = new Date();
    const [request] = await tx
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.id, input.requestId),
          eq(accountDeletionRequests.userId, input.userId),
          eq(accountDeletionRequests.status, "processing"),
        ),
      )
      .limit(1)
      .for("update");
    if (!request) return "not-ready";
    await tx
      .insert(deletionTombstones)
      .values({
        subjectHash,
        deletedAt: now,
        purgeVerifiedAt: now,
        retainUntil: new Date(now.getTime() + TOMBSTONE_RETENTION_MS),
      })
      .onConflictDoNothing();
    await tx.delete(users).where(eq(users.id, input.userId));
    return "purged";
  });
}

export async function deleteAccountObjects(
  objectKeys: string[],
  storage?: PrivateObjectStorage,
): Promise<void> {
  if (objectKeys.length === 0) return;
  const privateStorage = storage ?? getPrivateObjectStorage();
  for (const key of objectKeys) await privateStorage.delete(key);
}

async function markPurgeFailed(userId: string, requestId: string) {
  await withUserDb(userId, (tx) =>
    tx
      .update(accountDeletionRequests)
      .set({
        status: "failed",
        lastErrorCode: "object-delete-failed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(accountDeletionRequests.id, requestId),
          eq(accountDeletionRequests.userId, userId),
          eq(accountDeletionRequests.status, "processing"),
        ),
      ),
  );
}
