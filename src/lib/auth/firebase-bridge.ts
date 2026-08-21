import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getDb } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import {
  hasBlockingAccountDeletionRequest,
  isActiveAccount,
} from "./account-state";

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);
const MAX_AUTH_AGE_SECONDS = 10 * 60;

type FirebaseClaims = JWTPayload & {
  email?: string;
  email_verified?: boolean;
  name?: string;
  auth_time?: number;
  firebase?: { sign_in_provider?: string };
};

export function eligibleFirebaseClaims(
  claims: FirebaseClaims,
  nowSeconds = Math.floor(Date.now() / 1000),
): claims is FirebaseClaims & {
  sub: string;
  email: string;
  email_verified: true;
  auth_time: number;
} {
  const provider = claims.firebase?.sign_in_provider;
  return (
    typeof claims.sub === "string" &&
    claims.sub.length > 0 &&
    typeof claims.email === "string" &&
    claims.email_verified === true &&
    typeof claims.auth_time === "number" &&
    claims.auth_time <= nowSeconds &&
    nowSeconds - claims.auth_time <= MAX_AUTH_AGE_SECONDS &&
    (provider === "google.com" || provider === "password")
  );
}

function derivedUsername(claims: FirebaseClaims & { sub: string; email: string }) {
  const suffix = createHash("sha256").update(claims.sub).digest("hex").slice(0, 8);
  return `pilot_${suffix}`;
}

export async function verifyFirebaseIdToken(token: string) {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  if (!projectId || !token) return null;
  try {
    const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
      algorithms: ["RS256"],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
    });
    return eligibleFirebaseClaims(payload as FirebaseClaims) ? payload as FirebaseClaims & {
      sub: string;
      email: string;
      email_verified: true;
      auth_time: number;
    } : null;
  } catch {
    return null;
  }
}

export async function resolveFirebaseAccount(claims: Awaited<ReturnType<typeof verifyFirebaseIdToken>>) {
  if (!claims) return null;
  const email = claims.email.trim().toLowerCase();
  return getDb().transaction(async (tx) => {
    const [linked] = await tx
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, "firebase"),
          eq(accounts.providerAccountId, claims.sub),
        ),
      )
      .limit(1);

    if (linked) {
      const [account] = await tx
        .select()
        .from(users)
        .where(eq(users.id, linked.userId))
        .limit(1)
        .for("update");
      if (
        !isActiveAccount(account) ||
        (await hasBlockingAccountDeletionRequest(tx, linked.userId))
      ) {
        return null;
      }
      return linked.userId;
    }

    const [existing] = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1)
      .for("update");
    let userId: string;
    if (existing) {
      if (
        !isActiveAccount(existing) ||
        (await hasBlockingAccountDeletionRequest(tx, existing.id))
      ) {
        return null;
      }
      userId = existing.id;
    } else {
      const [created] = await tx
        .insert(users)
        .values({
          email,
          emailVerified: new Date(),
          name: claims.name?.trim() || null,
          username: derivedUsername(claims),
        })
        .returning({ id: users.id });
      userId = created.id;
    }
    await tx.insert(accounts).values({
      userId,
      type: "oidc",
      provider: "firebase",
      providerAccountId: claims.sub,
    });
    return userId;
  });
}
