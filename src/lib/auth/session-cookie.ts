import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import {
  hasBlockingAccountDeletionRequest,
  isActiveAccount,
} from "./account-state";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function authSessionCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

export async function clearDatabaseSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(authSessionCookieName());
}

export async function createDatabaseSession(userId: string): Promise<void> {
  const sessionToken = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await getDb().transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (
      !isActiveAccount(account) ||
      (await hasBlockingAccountDeletionRequest(tx, userId))
    ) {
      throw new Error("Authentication is unavailable.");
    }
    await tx.insert(sessions).values({ sessionToken, userId, expires });
  });

  const cookieStore = await cookies();
  cookieStore.set(authSessionCookieName(), sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}
