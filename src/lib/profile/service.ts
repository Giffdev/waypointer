import { eq, sql } from "drizzle-orm";
import {
  isUsernameUniqueViolation,
  isValidPublicHandle,
  normalizeUsername,
  USERNAME_REQUIREMENTS,
} from "@/lib/auth/username";
import { withUserDb } from "@/lib/db";
import { areReleaseWritesPaused } from "@/lib/runtime-mode";
import { mapShares, userProfiles, users } from "@/lib/db/schema";
import {
  DEFAULT_DISTANCE_UNIT,
  DISTANCE_UNITS,
  type DistanceUnit,
} from "@/lib/distance-unit";
import {
  DEFAULT_MAP_VIEW_MODE,
  isMapViewMode,
  type MapViewMode,
} from "@/lib/map-view-mode";

export { DEFAULT_DISTANCE_UNIT, DISTANCE_UNITS };
export type { DistanceUnit };

export type OwnerProfile = {
  email: string;
  username: string;
  displayName: string;
  timeZone: string;
  distanceUnit: DistanceUnit;
  mapViewMode: MapViewMode;
  hasPassword: boolean;
};

export type UpdateOwnerProfileInput = {
  username: string;
  displayName: string;
  timeZone: string;
  distanceUnit: DistanceUnit;
};

export class ProfileValidationError extends Error {
  constructor(message = "The profile settings are invalid.") {
    super(message);
    this.name = "ProfileValidationError";
  }
}

export class UsernameValidationError extends Error {
  constructor(message = USERNAME_REQUIREMENTS) {
    super(message);
    this.name = "UsernameValidationError";
  }
}

export class UsernameConflictError extends Error {
  constructor(message = "That username is already taken. Try another.") {
    super(message);
    this.name = "UsernameConflictError";
  }
}

export function shouldCreateOwnerProfile(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return !areReleaseWritesPaused(environment);
}

export function normalizeOwnerProfile(
  input: UpdateOwnerProfileInput,
): UpdateOwnerProfileInput {
  const username = normalizeUsername(input.username);
  const displayName = input.displayName.trim();
  const timeZone = input.timeZone.trim();
  if (!isValidPublicHandle(username)) {
    throw new UsernameValidationError();
  }
  if (displayName.length < 1 || displayName.length > 100) {
    throw new ProfileValidationError();
  }
  if (!DISTANCE_UNITS.includes(input.distanceUnit)) {
    throw new ProfileValidationError();
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new ProfileValidationError();
  }
  return {
    username,
    displayName,
    timeZone,
    distanceUnit: input.distanceUnit,
  };
}

export async function getOwnerProfile(userId: string): Promise<OwnerProfile> {
  return withUserDb(userId, async (tx) => {
    const [account] = await tx
      .select({
        email: users.email,
        username: users.username,
        name: users.name,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!account) throw new Error("Authentication is required.");

    if (shouldCreateOwnerProfile()) {
      await tx
        .insert(userProfiles)
        .values({
          userId,
          displayName: account.name ?? account.username,
        })
        .onConflictDoNothing();
    }
    const [profile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    if (!profile) throw new Error("Profile is unavailable.");
    return {
      email: account.email,
      username: account.username,
      displayName: profile.displayName ?? account.name ?? account.username,
      timeZone: profile.timeZone,
      distanceUnit:
        (profile.distanceUnit as DistanceUnit | null) ?? DEFAULT_DISTANCE_UNIT,
      mapViewMode: isMapViewMode(profile.mapViewMode)
        ? profile.mapViewMode
        : DEFAULT_MAP_VIEW_MODE,
      hasPassword: Boolean(account.passwordHash),
    };
  });
}

export async function updateOwnerMapViewMode(
  userId: string,
  mapViewMode: MapViewMode,
): Promise<OwnerProfile> {
  if (!isMapViewMode(mapViewMode)) throw new ProfileValidationError();
  await withUserDb(userId, async (tx) => {
    await tx
      .insert(userProfiles)
      .values({ userId, mapViewMode })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: { mapViewMode, updatedAt: new Date() },
      });
  });
  return getOwnerProfile(userId);
}

export async function updateOwnerProfile(
  userId: string,
  input: UpdateOwnerProfileInput,
): Promise<OwnerProfile> {
  const normalized = normalizeOwnerProfile(input);
  try {
    await withUserDb(userId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${userId}::uuid::text, 0))`,
      );
      const [current] = await tx
        .select({
          username: users.username,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!current) throw new Error("Authentication is required.");
      const handleChanged = current.username !== normalized.username;
      const now = new Date();

      await tx
        .insert(userProfiles)
        .values({
          userId,
          displayName: normalized.displayName,
          timeZone: normalized.timeZone,
          distanceUnit: normalized.distanceUnit,
        })
        .onConflictDoUpdate({
          target: userProfiles.userId,
          set: {
            displayName: normalized.displayName,
            timeZone: normalized.timeZone,
            distanceUnit: normalized.distanceUnit,
            updatedAt: now,
          },
        });
      await tx
        .update(users)
        .set({
          username: normalized.username,
          name: normalized.displayName,
          updatedAt: now,
        })
        .where(eq(users.id, userId));
      if (handleChanged) {
        await tx
          .update(mapShares)
          .set({
            disabledAt: now,
            updatedAt: now,
          })
          .where(eq(mapShares.userId, userId));
      }
    });
  } catch (error) {
    if (isUsernameUniqueViolation(error)) {
      throw new UsernameConflictError();
    }
    throw error;
  }
  return getOwnerProfile(userId);
}
