import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

export class RateLimitExceededError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many attempts. Try again later.");
    this.name = "RateLimitExceededError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function consumeRateLimit(
  scope: string,
  identity: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowMs);
  const nowIso = now.toISOString();
  const expiresAtIso = expiresAt.toISOString();
  const key = createHash("sha256")
    .update(`${scope}\u001f${identity.trim().toLowerCase()}`)
    .digest("hex");

  const result = await getDb().execute<{
    count: number;
    expires_at: Date;
  }>(sql`
    insert into rate_limits ("key", "count", "window_started_at", "expires_at")
    values (
      ${key},
      1,
      ${nowIso}::timestamptz,
      ${expiresAtIso}::timestamptz
    )
    on conflict ("key") do update set
      "count" = case
        when rate_limits."expires_at" <= ${nowIso}::timestamptz then 1
        else rate_limits."count" + 1
      end,
      "window_started_at" = case
        when rate_limits."expires_at" <= ${nowIso}::timestamptz
          then ${nowIso}::timestamptz
        else rate_limits."window_started_at"
      end,
      "expires_at" = case
        when rate_limits."expires_at" <= ${nowIso}::timestamptz
          then ${expiresAtIso}::timestamptz
        else rate_limits."expires_at"
      end
    returning "count", "expires_at"
  `);

  const row = result[0];
  if (row && Number(row.count) > limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((new Date(row.expires_at).getTime() - now.getTime()) / 1000),
    );
    throw new RateLimitExceededError(retryAfterSeconds);
  }
}
