import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
  UsernameConflictError,
  updateOwnerProfile,
} from "./service";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_IMPORT_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const cleanupUsers: string[] = [];

postgresDescribe("PostgreSQL owner username updates", () => {
  afterEach(async () => {
    const userIds = cleanupUsers.splice(0);
    if (userIds.length > 0) {
      await getDb().delete(users).where(inArray(users.id, userIds));
    }
  });

  it("normalizes a rename without changing ownership and reports case-insensitive conflicts", async () => {
    const ownerId = await createUser("original_pilot");
    const otherId = await createUser("reserved_pilot");

    await expect(
      updateOwnerProfile(ownerId, {
        username: "  RENAMED_PILOT  ",
        displayName: "Renamed Pilot",
        timeZone: "UTC",
        distanceUnit: "nautical_miles",
      }),
    ).resolves.toMatchObject({
      username: "renamed_pilot",
      displayName: "Renamed Pilot",
    });

    const accounts = await getDb()
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [ownerId, otherId]));
    expect(accounts).toEqual(
      expect.arrayContaining([
        { id: ownerId, username: "renamed_pilot" },
        { id: otherId, username: "reserved_pilot" },
      ]),
    );

    await expect(
      updateOwnerProfile(ownerId, {
        username: "RESERVED_PILOT",
        displayName: "Renamed Pilot",
        timeZone: "UTC",
        distanceUnit: "nautical_miles",
      }),
    ).rejects.toBeInstanceOf(UsernameConflictError);

    const [owner] = await getDb()
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [ownerId]));
    expect(owner).toEqual({ id: ownerId, username: "renamed_pilot" });
  });

  it("allows only one concurrent claimant for the same normalized username", async () => {
    const firstId = await createUser("first_pilot");
    const secondId = await createUser("second_pilot");
    const input = {
      username: "Shared_Pilot",
      displayName: "Test Pilot",
      timeZone: "UTC",
      distanceUnit: "miles" as const,
    };

    const results = await Promise.allSettled([
      updateOwnerProfile(firstId, input),
      updateOwnerProfile(secondId, input),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(UsernameConflictError);
  });
});

async function createUser(username: string): Promise<string> {
  const userId = randomUUID();
  cleanupUsers.push(userId);
  await getDb().insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    username,
    emailVerified: new Date(),
  });
  return userId;
}
