import { createHash } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

const ARGON_OPTIONS = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

export function validatePassword(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 128) return "Password must be 128 characters or fewer.";
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTIONS);
}

export function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return verify(passwordHash, password);
}

export async function isPasswordBreached(password: string): Promise<boolean> {
  const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  try {
    const response = await fetch(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      {
        headers: {
          "Add-Padding": "true",
          "User-Agent": "FlightMap-password-screening",
        },
        signal: AbortSignal.timeout(3_000),
        cache: "no-store",
      },
    );
    if (!response.ok) return false;
    const matches = await response.text();
    return matches
      .split(/\r?\n/)
      .some((line) => line.split(":")[0] === suffix);
  } catch {
    return false;
  }
}
