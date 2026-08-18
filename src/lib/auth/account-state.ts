import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseTransaction } from "@/lib/db";
import {
  accountDeletionRequests,
  sessions,
  users,
} from "@/lib/db/schema";

export type AccountLifecycleState = {
  emailVerified: Date | null;
  disabledAt: Date | null;
  deletionPendingAt?: Date | null;
  purgedAt?: Date | null;
  status?: string | null;
};

const INACTIVE_ACCOUNT_STATUSES = new Set([
  "disabled",
  "deletion_pending",
  "purged",
  "deleted",
]);
const BLOCKING_DELETION_STATUSES = [
  "pending",
  "processing",
  "failed",
] as const;

export function isActiveAccount(
  account: AccountLifecycleState | null | undefined,
): boolean {
  if (
    !account?.emailVerified ||
    account.disabledAt ||
    account.deletionPendingAt ||
    account.purgedAt
  ) {
    return false;
  }
  return !(
    account.status &&
    INACTIVE_ACCOUNT_STATUSES.has(account.status.toLowerCase())
  );
}

export async function findAccountById(userId: string) {
  const [account] = await getDb()
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return account ?? null;
}

export async function findAccountByNormalizedEmail(email: string) {
  const [account] = await getDb()
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return account ?? null;
}

export async function findActiveAccountById(userId: string) {
  return getDb().transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!isActiveAccount(account)) return null;
    return (await hasBlockingAccountDeletionRequest(tx, userId))
      ? null
      : account;
  });
}

export async function findActiveAccountByNormalizedEmail(email: string) {
  return getDb().transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
      .limit(1);
    if (!isActiveAccount(account)) return null;
    return (await hasBlockingAccountDeletionRequest(tx, account.id))
      ? null
      : account;
  });
}

export async function hasBlockingAccountDeletionRequest(
  tx: DatabaseTransaction,
  userId: string,
): Promise<boolean> {
  await tx.execute(
    sql`select set_config('app.current_user_id', ${userId}, true)`,
  );
  const [request] = await tx
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, userId),
        inArray(accountDeletionRequests.status, BLOCKING_DELETION_STATUSES),
      ),
    )
    .limit(1);
  return Boolean(request);
}

export async function revokeUserSessions(
  tx: DatabaseTransaction,
  userId: string,
): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await getDb().transaction((tx) => revokeUserSessions(tx, userId));
}

export async function disableAccountAndRevokeSessions(
  userId: string,
  disabledAt = new Date(),
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [disabled] = await tx
      .update(users)
      .set({ disabledAt, updatedAt: disabledAt })
      .where(
        and(
          eq(users.id, userId),
          isNull(users.disabledAt),
        ),
      )
      .returning({ id: users.id });
    await revokeUserSessions(tx, userId);
    return Boolean(disabled);
  });
}
