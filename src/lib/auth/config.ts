import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter, AdapterUser } from "@auth/core/adapters";
import { randomUUID } from "node:crypto";
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { getDb } from "@/lib/db";
import {
  accounts,
  authenticators,
  sessions,
  users,
  verificationTokens,
} from "@/lib/db/schema";
import { withoutOAuthBearerTokens } from "./account-persistence";
import {
  findAccountById,
  findAccountByNormalizedEmail,
  findActiveAccountById,
  isActiveAccount,
  revokeAllUserSessions,
} from "./account-state";
import {
  configuredOAuthProviderIds,
  isVerifiedOAuthEmail,
} from "./oauth-providers";
import { isUsernameUniqueViolation } from "./username";

function assertProductionAuthConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;
  const required = [
    "DATABASE_URL",
    "AUTH_SECRET",
    "AUTH_URL",
  ] as const;
  const missing = required.filter(
    (name) => !process.env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required production authentication configuration: ${missing.join(", ")}.`,
    );
  }
}

assertProductionAuthConfiguration();

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function createOAuthUser(data: AdapterUser): Promise<AdapterUser> {
  const email = normalizeEmail(data.email);
  if (!email || !data.emailVerified) {
    throw new Error("Authentication is unavailable.");
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const username = `pilot-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      const [created] = await getDb()
        .insert(users)
        .values({
          name: data.name,
          email,
          emailVerified: data.emailVerified,
          image: data.image,
          username,
        })
        .returning();
      return created;
    } catch (error) {
      if (!isUsernameUniqueViolation(error)) {
        throw error;
      }
      if (attempt === 19) throw error;
    }
  }
  throw new Error("Could not allocate a unique username.");
}

function authAdapter(): Adapter | undefined {
  if (!process.env.DATABASE_URL?.trim()) return undefined;
  const adapter = DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
    authenticatorsTable: authenticators,
  });
  const linkAccount = adapter.linkAccount;
  const createSession = adapter.createSession;
  const getSessionAndUser = adapter.getSessionAndUser;
  return {
    ...adapter,
    createUser: createOAuthUser,
    linkAccount: linkAccount
      ? async (account) => {
          if (!(await findActiveAccountById(account.userId))) {
            throw new Error("Authentication is unavailable.");
          }
          await linkAccount(withoutOAuthBearerTokens(account));
        }
      : undefined,
    createSession: createSession
      ? async (session) => {
          if (!(await findActiveAccountById(session.userId))) {
            throw new Error("Authentication is unavailable.");
          }
          return createSession(session);
        }
      : undefined,
    getSessionAndUser: getSessionAndUser
      ? async (sessionToken) => {
          const result = await getSessionAndUser(sessionToken);
          if (!result) return null;
          if (!(await findActiveAccountById(result.user.id))) {
            await revokeAllUserSessions(result.user.id).catch(() => undefined);
            return null;
          }
          return result;
        }
      : undefined,
  };
}

const providers: NextAuthConfig["providers"] = [];

for (const providerId of configuredOAuthProviderIds()) {
  if (providerId === "google") {
    providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: normalizeEmail(profile.email),
          image: profile.picture,
          emailVerified: profile.email_verified ? new Date() : null,
        };
      },
    }),
    );
  }
  if (providerId === "microsoft-entra-id") {
    providers.push(
      MicrosoftEntraID({
        clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
        clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
        issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER?.trim() || undefined,
        authorization: { params: { scope: "openid profile email" } },
        profile(profile) {
          const email = normalizeEmail(profile.email);
          return {
            id: profile.sub,
            name: profile.name,
            email,
            image: null,
            emailVerified: isVerifiedOAuthEmail(
              "microsoft-entra-id",
              profile as unknown as Record<string, unknown>,
              email,
            )
              ? new Date()
              : null,
          };
        },
      }),
    );
  }
}

export const authConfig: NextAuthConfig = {
  adapter: authAdapter(),
  providers,
  secret: process.env.AUTH_SECRET,
  session: {
    strategy: "database",
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  pages: {
    signIn: "/auth/sign-in",
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (
        account?.provider === "google" ||
        account?.provider === "microsoft-entra-id"
      ) {
        const email = normalizeEmail(user.email);
        if (
          !email ||
          !isVerifiedOAuthEmail(
            account.provider,
            profile as Record<string, unknown> | undefined,
            email,
          )
        ) {
          return false;
        }
        const existingById = user.id
          ? await findAccountById(user.id).catch(() => null)
          : null;
        const existing =
          existingById ?? (await findAccountByNormalizedEmail(email));
        return existing
          ? Boolean(
              isActiveAccount(existing) &&
                (await findActiveAccountById(existing.id)),
            )
          : true;
      }
      return false;
    },
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  trustHost: true,
};
