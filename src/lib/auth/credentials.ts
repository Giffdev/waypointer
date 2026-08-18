import { findActiveAccountByNormalizedEmail } from "./account-state";
import { verifyPassword } from "./password";
import { consumeRateLimit } from "./rate-limit";

export type CredentialUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export async function authenticateCredentials(input: {
  email: string;
  password: string;
  ip: string;
}): Promise<CredentialUser | null> {
  const email = input.email.trim().toLowerCase();
  await consumeRateLimit(
    "sign-in-ip",
    input.ip || "unknown",
    20,
    15 * 60_000,
  );
  await consumeRateLimit(
    "sign-in-email",
    email || "invalid",
    10,
    15 * 60_000,
  );

  const user = await findActiveAccountByNormalizedEmail(email);
  if (
    !user?.passwordHash ||
    !user.emailVerified ||
    !(await verifyPassword(user.passwordHash, input.password))
  ) {
    return null;
  }
  return {
    id: user.id,
    name: user.name ?? user.username,
    email: user.email,
    image: user.image,
  };
}
