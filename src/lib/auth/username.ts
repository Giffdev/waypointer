export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,29}$/;
export const USERNAME_INPUT_PATTERN = "[A-Za-z0-9][A-Za-z0-9_\\x2d]{2,29}";
export const USERNAME_REQUIREMENTS =
  "Use 3–30 letters, numbers, underscores, or hyphens. Start with a letter or number. Usernames are case-insensitive and saved lowercase.";

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}

export function isUsernameUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === "users_username_unique"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : null;
  }
  return false;
}
