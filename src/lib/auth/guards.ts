import { auth } from "./index";
import {
  findActiveAccountById,
  revokeAllUserSessions,
} from "./account-state";

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
};

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Authentication is required.");
    this.name = "AuthenticationRequiredError";
  }
}

export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new AuthenticationRequiredError();
  const account = await findActiveAccountById(id);
  if (!account) {
    await revokeAllUserSessions(id).catch(() => undefined);
    throw new AuthenticationRequiredError();
  }
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    image: account.image,
  };
}

export async function requireImportUser(): Promise<AuthenticatedUser> {
  return requireAuthenticatedUser();
}

export async function getOptionalAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  if (
    !process.env.DATABASE_URL &&
    process.env.NODE_ENV !== "production" &&
    process.env.FLIGHT_MAP_DEV_PREVIEW === "true"
  ) {
    return null;
  }
  try {
    return await requireAuthenticatedUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return null;
    throw error;
  }
}
