import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { consumeRateLimit, RateLimitExceededError } from "@/lib/auth/rate-limit";
import { POST as readSharedMap } from "@/app/api/shared/[token]/route";
import { getDb, withUserDb } from "@/lib/db";
import {
  flights,
  flightStops,
  mapShareFlights,
  mapShares,
  rateLimits,
} from "@/lib/db/schema";
import {
  disableMapSharing,
  enableMapSharing,
  getPublicMapProjection,
  getOwnerShareStatus,
  previewMapSharing,
  publicTokenRateLimitKey,
  regenerateMapShare,
  ShareFlightLimitError,
  ShareNotFoundError,
  SharePreviewMismatchError,
  ShareValidationError,
} from "./service";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_SCHEMA_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const userIds: string[] = [];
const airportIds: string[] = [];
const rateLimitKeys: string[] = [];
let fixtureAdmin: ReturnType<typeof postgres> | undefined;

postgresDescribe("read-only map sharing PostgreSQL boundary", () => {
  beforeAll(() => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
    fixtureAdmin = postgres(migrationUrl, {
      max: 1,
      onnotice: () => {},
    });
  });

  beforeEach(() => {
    process.env.AUTH_SECRET = "integration-test-map-sharing-secret";
  });

  afterEach(async () => {
    for (const userId of userIds.splice(0)) {
      await withUserDb(userId, async (tx) => {
        await tx.delete(mapShareFlights).where(eq(mapShareFlights.userId, userId));
        await tx.delete(mapShares).where(eq(mapShares.userId, userId));
        await tx.delete(flights).where(eq(flights.userId, userId));
      });
      await requireFixtureAdmin()`delete from users where id = ${userId}::uuid`;
    }
    const ids = airportIds.splice(0);
    if (ids.length) {
      await requireFixtureAdmin()`delete from airports where id = any(${ids}::uuid[])`;
    }
    const keys = rateLimitKeys.splice(0);
    if (keys.length) {
      await requireFixtureAdmin()`delete from rate_limits where key = any(${keys}::text[])`;
    }
  });

  afterAll(async () => {
    await fixtureAdmin?.end();
    fixtureAdmin = undefined;
  });

  it("defaults off and publishes every owner flight from an exact preview", async () => {
    const ownerId = await createOwner("Owner Pilot");
    const [originId, destinationId] = await createAirports();
    const firstFlightId = await createFlight(
      ownerId,
      originId,
      destinationId,
      "Owner secret note",
    );
    const secondFlightId = await createFlight(
      ownerId,
      destinationId,
      originId,
      "Second owner note",
    );

    await expect(
      previewMapSharing(ownerId, {
        flightIds: [],
        includeDisplayName: false,
      }),
    ).rejects.toBeInstanceOf(ShareValidationError);
    await expect(
      previewMapSharing(ownerId, {
        flightIds: [firstFlightId],
        includeDisplayName: false,
      }),
    ).rejects.toBeInstanceOf(ShareValidationError);

    const hiddenPreview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    expect(hiddenPreview).toMatchObject({
      includeDisplayName: false,
      projection: {
        owner: { displayName: null },
        summary: { flightCount: 2, routeCount: 2 },
      },
    });
    expect(hiddenPreview.projection).not.toHaveProperty("flights");
    await expect(
      enableMapSharing(ownerId, {
        includeDisplayName: true,
        previewId: hiddenPreview.previewId,
      }),
    ).rejects.toBeInstanceOf(SharePreviewMismatchError);

    const identityPreview = await previewMapSharing(ownerId, {
      includeDisplayName: true,
    });
    expect(identityPreview.projection.owner.displayName).toBe("Owner Pilot");
    const completeShare = await enableMapSharing(ownerId, {
      includeDisplayName: true,
      previewId: identityPreview.previewId,
    });
    expect(completeShare).toMatchObject({
      enabled: true,
      includeDisplayName: true,
      publishedFlightCount: 2,
    });
    const publishedRows = await withUserDb(ownerId, (tx) =>
      tx
        .select({ flightId: mapShareFlights.flightId })
        .from(mapShareFlights)
        .where(eq(mapShareFlights.userId, ownerId)),
    );
    expect(publishedRows.map(({ flightId }) => flightId).toSorted()).toEqual(
      [firstFlightId, secondFlightId].toSorted(),
    );

    const shareCapability = capability(completeShare.sharePath!);
    const projection = await getPublicMapProjection(
      shareCapability.publicId,
      shareCapability.key,
    );
    expect(projection).toEqual(identityPreview.projection);
    expect(JSON.stringify(projection)).not.toMatch(
      /@example|secret note|registration|flightId|ownerId/i,
    );

    const [publishedUpdate] = await withUserDb(ownerId, (tx) =>
      tx
        .update(flights)
        .set({ kind: "commercial", updatedAt: new Date() })
        .where(eq(flights.id, firstFlightId))
        .returning({ id: flights.id, kind: flights.kind }),
    );
    expect(publishedUpdate).toEqual({
      id: firstFlightId,
      kind: "commercial",
    });
    await expect(
      getPublicMapProjection(shareCapability.publicId, shareCapability.key),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it("includes flights added after page render and rejects additions after preview", async () => {
    const ownerId = await createOwner("Owner");
    const [originId, destinationId] = await createAirports();
    await createFlight(ownerId, originId, destinationId, "at page render");
    await createFlight(
      ownerId,
      destinationId,
      originId,
      "after page render",
    );

    const preview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    expect(preview.projection.summary.flightCount).toBe(2);

    await createFlight(
      ownerId,
      originId,
      destinationId,
      "between preview and enable",
    );
    await expect(
      enableMapSharing(ownerId, {
        includeDisplayName: false,
        previewId: preview.previewId,
      }),
    ).rejects.toBeInstanceOf(SharePreviewMismatchError);

    const refreshedPreview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    expect(refreshedPreview.projection.summary.flightCount).toBe(3);
    const enabledShare = await enableMapSharing(ownerId, {
      includeDisplayName: false,
      previewId: refreshedPreview.previewId,
    });
    await createFlight(ownerId, destinationId, originId, "after enable");

    const selectedRows = await withUserDb(ownerId, (tx) =>
      tx
        .select()
        .from(mapShareFlights)
        .where(eq(mapShareFlights.userId, ownerId)),
    );
    expect(selectedRows).toHaveLength(3);
    const shareCapability = capability(enabledShare.sharePath!);
    expect(
      await getPublicMapProjection(shareCapability.publicId, shareCapability.key),
    ).toMatchObject({ summary: { flightCount: 3 } });
  });

  it("canonicalizes an uppercase owner ID onto the trigger lock during overlap", async () => {
    const canonicalOwnerId = await createOwner("Concurrent Insert Owner");
    const ownerId = canonicalOwnerId.toUpperCase();
    const [originId, destinationId] = await createAirports();
    await createFlight(
      canonicalOwnerId,
      originId,
      destinationId,
      "previewed",
    );
    const [lockKeys] = await requireFixtureAdmin()<{
      service_key: string;
      trigger_key: string;
    }[]>`
      select
        hashtextextended(${ownerId}::uuid::text, 0)::text as service_key,
        hashtextextended(${canonicalOwnerId}, 0)::text as trigger_key
    `;
    expect(lockKeys.service_key).toBe(lockKeys.trigger_key);
    const preview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    const heldMutation = await beginHeldFlightMutation(
      canonicalOwnerId,
      async (tx) => {
      await tx`
        insert into flights (
          user_id, fingerprint, date, origin_airport_id,
          destination_airport_id, kind, role, notes
        )
        values (
          ${ownerId}::uuid,
          ${randomUUID()},
          '2026-08-15',
          ${originId}::uuid,
          ${destinationId}::uuid,
          'private',
          'pilot',
          'overlapping insert'
        )
      `;
      },
    );
    const enableOutcome = captureOutcome(
      enableMapSharing(ownerId, {
        includeDisplayName: false,
        previewId: preview.previewId,
      }),
    );

    try {
      expect(await observeOwnerLockCollision(canonicalOwnerId)).toEqual({
        granted: 1,
        waiting: 1,
      });
    } finally {
      heldMutation.release();
      await heldMutation.done;
    }

    expect(await enableOutcome).toMatchObject({
      error: expect.any(SharePreviewMismatchError),
    });
    expect(await getOwnerShareStatus(ownerId)).toMatchObject({
      enabled: false,
      sharePath: null,
    });
  });

  it("invalidates the whole share for every selected stop membership mutation", async () => {
    const [originId, destinationId] = await createAirports();

    const insertOwner = await createOwner("Stop Insert Owner");
    const insertFlight = await createFlight(
      insertOwner,
      originId,
      destinationId,
      "insert",
    );
    await enableCurrentShare(insertOwner);
    await withUserDb(insertOwner, (tx) =>
      tx.insert(flightStops).values({
        userId: insertOwner,
        flightId: insertFlight,
        stopOrder: 0,
        airportId: originId,
      }),
    );
    expect(await getOwnerShareStatus(insertOwner)).toMatchObject({
      enabled: false,
      publishedFlightCount: 1,
    });

    const updateOwner = await createOwner("Stop Update Owner");
    const updateFlight = await createFlight(
      updateOwner,
      originId,
      destinationId,
      "update",
    );
    await createFlightStopPair(
      updateOwner,
      updateFlight,
      originId,
      destinationId,
    );
    await enableCurrentShare(updateOwner);
    await withUserDb(updateOwner, (tx) =>
      tx
        .update(flightStops)
        .set({ airportId: destinationId })
        .where(
          and(
            eq(flightStops.flightId, updateFlight),
            eq(flightStops.stopOrder, 0),
          ),
        ),
    );
    expect(await getOwnerShareStatus(updateOwner)).toMatchObject({
      enabled: false,
      publishedFlightCount: 1,
    });

    const deleteOwner = await createOwner("Stop Delete Owner");
    const deleteFlight = await createFlight(
      deleteOwner,
      originId,
      destinationId,
      "delete",
    );
    await createFlightStopPair(
      deleteOwner,
      deleteFlight,
      originId,
      destinationId,
    );
    await enableCurrentShare(deleteOwner);
    await withUserDb(deleteOwner, (tx) =>
      tx
        .delete(flightStops)
        .where(
          and(
            eq(flightStops.flightId, deleteFlight),
            eq(flightStops.stopOrder, 0),
          ),
        ),
    );
    expect(await getOwnerShareStatus(deleteOwner)).toMatchObject({
      enabled: false,
      publishedFlightCount: 1,
    });
  });

  it("invalidates OLD and NEW selected memberships when a stop moves", async () => {
    const [originId, destinationId] = await createAirports();
    const oldOwner = await createOwner("Old Stop Owner");
    const newOwner = await createOwner("New Stop Owner");
    const oldFlight = await createFlight(
      oldOwner,
      originId,
      destinationId,
      "old membership",
    );
    await createFlightStopPair(
      oldOwner,
      oldFlight,
      originId,
      destinationId,
    );
    await enableCurrentShare(oldOwner);
    const sameOwnerTarget = await createFlight(
      oldOwner,
      destinationId,
      originId,
      "added after enable",
    );
    await withUserDb(oldOwner, (tx) =>
      tx
        .update(flightStops)
        .set({ flightId: sameOwnerTarget })
        .where(
          and(
            eq(flightStops.flightId, oldFlight),
            eq(flightStops.stopOrder, 0),
          ),
        ),
    );
    expect(await getOwnerShareStatus(oldOwner)).toMatchObject({
      enabled: false,
      publishedFlightCount: 1,
    });

    const ownerMoveOldOwner = await createOwner("Owner Move Source Owner");
    const ownerMoveSource = await createFlight(
      ownerMoveOldOwner,
      originId,
      destinationId,
      "owner move source",
    );
    await createFlightStopPair(
      ownerMoveOldOwner,
      ownerMoveSource,
      originId,
      destinationId,
    );
    const ownerMoveTarget = await createFlight(
      newOwner,
      destinationId,
      originId,
      "owner move target",
    );
    await enableCurrentShare(ownerMoveOldOwner);
    await enableCurrentShare(newOwner);
    await requireFixtureAdmin()`
      update flight_stops
      set user_id = ${newOwner}::uuid,
          flight_id = ${ownerMoveTarget}::uuid
      where flight_id = ${ownerMoveSource}::uuid
        and stop_order = 0
    `;
    expect(await getOwnerShareStatus(ownerMoveOldOwner)).toMatchObject({
      enabled: false,
      publishedFlightCount: 1,
    });
    expect(await getOwnerShareStatus(newOwner)).toMatchObject({
      enabled: false,
      publishedFlightCount: 1,
    });
  });

  it("locks opposite owner moves in deterministic order without deadlock", async () => {
    const [originId, destinationId] = await createAirports();
    const [smallerOwner, largerOwner] = [
      await createOwner("First Move Owner"),
      await createOwner("Second Move Owner"),
    ].toSorted();
    if (!smallerOwner || !largerOwner) {
      throw new Error("Two owner fixtures are required");
    }
    const smallerSource = await createFlight(
      smallerOwner,
      originId,
      destinationId,
      "smaller source",
    );
    const smallerTarget = await createFlight(
      smallerOwner,
      destinationId,
      originId,
      "smaller target",
    );
    const largerSource = await createFlight(
      largerOwner,
      originId,
      destinationId,
      "larger source",
    );
    const largerTarget = await createFlight(
      largerOwner,
      destinationId,
      originId,
      "larger target",
    );
    await createFlightStopPair(
      smallerOwner,
      smallerSource,
      originId,
      destinationId,
    );
    await createFlightStopPair(
      largerOwner,
      largerSource,
      originId,
      destinationId,
    );
    await enableCurrentShare(smallerOwner);
    await enableCurrentShare(largerOwner);

    const heldLock = await holdOwnerShareLock(smallerOwner);
    const firstMove = moveFlightStop(
      smallerSource,
      largerOwner,
      largerTarget,
    );
    void firstMove.catch(() => {});
    try {
      await observeOwnerLockCollision(smallerOwner);
      const secondMove = moveFlightStop(
        largerSource,
        smallerOwner,
        smallerTarget,
      );
      void secondMove.catch(() => {});
      await observeOwnerLockCollision(smallerOwner, 2);
      heldLock.release();
      await Promise.all([firstMove, secondMove]);
    } finally {
      heldLock.release();
      await heldLock.done;
    }

    expect(await getOwnerShareStatus(smallerOwner)).toMatchObject({
      enabled: false,
      publishedFlightCount: 2,
    });
    expect(await getOwnerShareStatus(largerOwner)).toMatchObject({
      enabled: false,
      publishedFlightCount: 2,
    });
  });

  it("keeps a share revoked when an overlapping projected-field update wins", async () => {
    const ownerId = await createOwner("Concurrent Update Owner");
    const [originId, destinationId] = await createAirports();
    const flightId = await createFlight(
      ownerId,
      originId,
      destinationId,
      "previewed",
    );
    const initialPreview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    const initialShare = await enableMapSharing(ownerId, {
      includeDisplayName: false,
      previewId: initialPreview.previewId,
    });
    const initialCapability = capability(initialShare.sharePath!);
    const updatePreview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    const heldMutation = await beginHeldFlightMutation(ownerId, async (tx) => {
      await tx`
        update flights
        set kind = 'commercial', updated_at = now()
        where id = ${flightId}::uuid
      `;
    });
    const enableOutcome = captureOutcome(
      enableMapSharing(ownerId, {
        includeDisplayName: false,
        previewId: updatePreview.previewId,
      }),
    );

    try {
      expect(await observeOwnerLockCollision(ownerId)).toEqual({
        granted: 1,
        waiting: 1,
      });
    } finally {
      heldMutation.release();
      await heldMutation.done;
    }

    expect(await enableOutcome).toMatchObject({
      error: expect.any(SharePreviewMismatchError),
    });
    expect(await getOwnerShareStatus(ownerId)).toMatchObject({
      enabled: false,
      sharePath: null,
    });
    await expect(
      getPublicMapProjection(initialCapability.publicId, initialCapability.key),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it("keeps tenant scope and rejects a 500-to-501 consent transition", async () => {
    const ownerId = await createOwner("Owner");
    const otherId = await createOwner("Other");
    const [originId, destinationId] = await createAirports();
    await createFlights(ownerId, originId, destinationId, 500);
    await createFlight(otherId, originId, destinationId, "other tenant");

    const preview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    expect(preview.projection.summary.flightCount).toBe(500);

    const heldMutation = await beginHeldFlightMutation(ownerId, async (tx) => {
      await tx`
        insert into flights (
          user_id, fingerprint, date, origin_airport_id,
          destination_airport_id, kind, role, notes
        )
        values (
          ${ownerId}::uuid,
          ${randomUUID()},
          '2026-08-15',
          ${originId}::uuid,
          ${destinationId}::uuid,
          'private',
          'pilot',
          'flight 501'
        )
      `;
    });
    const enableOutcome = captureOutcome(
      enableMapSharing(ownerId, {
        includeDisplayName: false,
        previewId: preview.previewId,
      }),
    );
    try {
      expect(await observeOwnerLockCollision(ownerId)).toEqual({
        granted: 1,
        waiting: 1,
      });
    } finally {
      heldMutation.release();
      await heldMutation.done;
    }
    expect(await enableOutcome).toMatchObject({
      error: expect.any(SharePreviewMismatchError),
    });
    await expect(
      previewMapSharing(ownerId, { includeDisplayName: false }),
    ).rejects.toBeInstanceOf(ShareFlightLimitError);

    const otherPreview = await previewMapSharing(otherId, {
      includeDisplayName: false,
    });
    expect(otherPreview.projection.summary.flightCount).toBe(1);
  });

  it("creates a new capability when a disabled share is re-enabled", async () => {
    const ownerId = await createOwner("Revocation Owner");
    const [originId, destinationId] = await createAirports();
    await createFlight(ownerId, originId, destinationId, "shared");
    const firstPreview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    const firstShare = await enableMapSharing(ownerId, {
      includeDisplayName: false,
      previewId: firstPreview.previewId,
    });
    const firstCapability = capability(firstShare.sharePath!);

    await disableMapSharing(ownerId);
    const secondPreview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    const secondShare = await enableMapSharing(ownerId, {
      includeDisplayName: false,
      previewId: secondPreview.previewId,
    });
    const secondCapability = capability(secondShare.sharePath!);

    expect(secondCapability.publicId).not.toBe(firstCapability.publicId);
    expect(secondCapability.key).not.toBe(firstCapability.key);
    const oldResponse = await readPublicCapability(
      firstCapability,
      "192.0.2.10",
    );
    expect(oldResponse.status).toBe(404);
    expect(await oldResponse.json()).toEqual({
      error: {
        code: "not-found",
        message: "Waypointer shared map not found.",
      },
    });
    const newResponse = await readPublicCapability(
      secondCapability,
      "192.0.2.11",
    );
    expect(newResponse.status).toBe(200);
    expect(await newResponse.json()).toMatchObject({
      map: { summary: { flightCount: 1 } },
    });
  });

  it("serializes concurrent enable, rotation, and revocation operations", async () => {
    const ownerId = await createOwner("Concurrent Owner");
    const [originId, destinationId] = await createAirports();
    await createFlight(ownerId, originId, destinationId, "note");
    const preview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    const enableInput = {
      includeDisplayName: false,
      previewId: preview.previewId,
    };
    const enabledShares = await Promise.all(
      Array.from({ length: 4 }, () => enableMapSharing(ownerId, enableInput)),
    );
    expect(enabledShares.every(({ enabled }) => enabled)).toBe(true);
    const initialCapability = capability(enabledShares[0].sharePath!);
    const rotations = await Promise.all(
      Array.from({ length: 4 }, () => regenerateMapShare(ownerId)),
    );
    expect(rotations).toHaveLength(4);
    const latest = capability(
      (await getOwnerShareStatus(ownerId)).sharePath!,
    );
    await expect(
      getPublicMapProjection(initialCapability.publicId, initialCapability.key),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
    await expect(
      getPublicMapProjection(latest.publicId, latest.key),
    ).resolves.toMatchObject({ summary: { flightCount: 1 } });
    const disabled = await Promise.all(
      Array.from({ length: 4 }, () => disableMapSharing(ownerId)),
    );
    expect(disabled.every(({ enabled }) => !enabled)).toBe(true);
    await expect(
      getPublicMapProjection(latest.publicId, latest.key),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it("locks down the definer function, grants only the runtime role, and denies IDOR writes", async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
    const admin = postgres(migrationUrl, {
      max: 1,
      onnotice: () => {},
    });
    try {
      const [functionSecurity] = await admin<{
        owner: string;
        config: string[];
        acl: string;
      }[]>`
        select
          owner.rolname as owner,
          coalesce(proc.proconfig, array[]::text[]) as config,
          coalesce(proc.proacl::text, '') as acl
        from pg_proc proc
        join pg_namespace namespace on namespace.oid = proc.pronamespace
        join pg_roles owner on owner.oid = proc.proowner
        where namespace.nspname = 'public'
          and proc.proname = 'public_map_projection'
          and pg_get_function_identity_arguments(proc.oid) = 'requested_public_id uuid, requested_token_hash text'
      `;
      expect(functionSecurity.owner).not.toBe("flight_map_test_app");
      expect(functionSecurity.config).toContain(
        "search_path=pg_catalog, public",
      );
      expect(functionSecurity.acl).not.toMatch(/(?:^|[{,])=X\//);
      const [triggerSecurity] = await admin<{
        owner: string;
        config: string[];
        acl: string;
      }[]>`
        select
          owner.rolname as owner,
          coalesce(proc.proconfig, array[]::text[]) as config,
          coalesce(proc.proacl::text, '') as acl
        from pg_proc proc
        join pg_namespace namespace on namespace.oid = proc.pronamespace
        join pg_roles owner on owner.oid = proc.proowner
        where namespace.nspname = 'public'
          and proc.proname = 'invalidate_selected_map_share'
      `;
      expect(triggerSecurity.owner).not.toBe("flight_map_test_app");
      expect(triggerSecurity.config).toContain("search_path=pg_catalog, public");
      expect(triggerSecurity.acl).not.toMatch(/(?:^|[{,])=X\//);
      const [runtimeGrant] = await admin<{ allowed: boolean }[]>`
        select has_function_privilege(
          'flight_map_test_app',
          'public.public_map_projection(uuid,text)',
          'EXECUTE'
        ) as allowed
      `;
      expect(runtimeGrant.allowed).toBe(true);
    } finally {
      await admin.end();
    }

    const ownerId = await createOwner("Owner");
    const attackerId = await createOwner("Attacker");
    const [originId, destinationId] = await createAirports();
    await createFlight(
      ownerId,
      originId,
      destinationId,
      "owner",
    );
    const preview = await previewMapSharing(ownerId, {
      includeDisplayName: false,
    });
    await enableMapSharing(ownerId, {
      includeDisplayName: false,
      previewId: preview.previewId,
    });
    const attempted = await withUserDb(attackerId, (tx) =>
      tx
        .update(mapShares)
        .set({ disabledAt: new Date() })
        .where(eq(mapShares.userId, ownerId))
        .returning({ userId: mapShares.userId }),
    );
    expect(attempted).toEqual([]);
  });

  it("persists database rate limits and remains atomic under concurrency", async () => {
    const identity = randomUUID();
    const scope = `sharing-test-${randomUUID()}`;
    rateLimitKeys.push(rateLimitKey(scope, identity));
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        consumeRateLimit(scope, identity, 2, 60_000),
      ),
    );
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      2,
    );
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
      3,
    );
    expect(
      outcomes
        .filter(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        )
        .every(({ reason }) => reason instanceof RateLimitExceededError),
    ).toBe(true);
    const [persisted] = await getDb()
      .select({ count: rateLimits.count })
      .from(rateLimits)
      .where(eq(rateLimits.key, rateLimitKey(scope, identity)));
    expect(persisted.count).toBe(5);
  });
});

function capability(sharePath: string): { publicId: string; key: string } {
  const url = new URL(sharePath, "https://example.test");
  const key = new URLSearchParams(url.hash.slice(1)).get("key");
  if (!key) throw new Error("Share capability key is missing");
  return { publicId: url.pathname.split("/").at(-1)!, key };
}

function rateLimitKey(scope: string, identity: string): string {
  return createHash("sha256")
    .update(`${scope}\u001f${identity.trim().toLowerCase()}`)
    .digest("hex");
}

async function readPublicCapability(
  value: { publicId: string; key: string },
  ip: string,
): Promise<Response> {
  rateLimitKeys.push(
    rateLimitKey("public-map-ip", ip),
    rateLimitKey(
      "public-map-token",
      publicTokenRateLimitKey(value.publicId, value.key),
    ),
  );
  return readSharedMap(
    new Request(`https://example.test/api/shared/${value.publicId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": ip,
      },
      body: JSON.stringify({ key: value.key }),
    }),
    { params: Promise.resolve({ token: value.publicId }) },
  );
}

async function createOwner(displayName: string): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await requireFixtureAdmin()`
    insert into users (id, email, username, name)
    values (
      ${id}::uuid,
      ${`${id}@example.test`},
      ${`pilot-${id.slice(0, 8)}`},
      ${displayName}
    )
  `;
  await requireFixtureAdmin()`
    insert into user_profiles (user_id, display_name)
    values (${id}::uuid, ${displayName})
  `;
  return id;
}

async function createAirports(): Promise<[string, string]> {
  const originId = randomUUID();
  const destinationId = randomUUID();
  airportIds.push(originId, destinationId);
  await requireFixtureAdmin()`
    insert into airports (
      id, icao, name, city, country, latitude, longitude, facility, dataset_version
    )
    values
      (
        ${originId}::uuid,
        ${`K${originId.slice(0, 3).toUpperCase()}`},
        'Private origin',
        'Origin',
        'US',
        47.449,
        -122.309,
        'general-aviation',
        'sharing-test'
      ),
      (
        ${destinationId}::uuid,
        ${`K${destinationId.slice(0, 3).toUpperCase()}`},
        'Private destination',
        'Destination',
        'US',
        40.64,
        -73.779,
        'commercial',
        'sharing-test'
      )
  `;
  return [originId, destinationId];
}

function requireFixtureAdmin(): ReturnType<typeof postgres> {
  if (!fixtureAdmin) throw new Error("PostgreSQL fixture admin is unavailable");
  return fixtureAdmin;
}

async function beginHeldFlightMutation(
  userId: string,
  mutate: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<{ done: Promise<void>; release: () => void }> {
  const connection = postgres(process.env.DATABASE_URL!, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  const reached = deferred<void>();
  const release = deferred<void>();
  const done = connection
    .begin(async (tx) => {
      await tx`select set_config('app.current_user_id', ${userId}, true)`;
      await mutate(tx);
      reached.resolve();
      await release.promise;
    })
    .then(() => undefined)
    .finally(() => connection.end());
  void done.catch(reached.reject);
  await reached.promise;
  return { done, release: () => release.resolve(undefined) };
}

async function observeOwnerLockCollision(
  userId: string,
  expectedWaiting = 1,
): Promise<{ granted: number; waiting: number }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [state] = await requireFixtureAdmin()<{
      granted: number;
      waiting: number;
    }[]>`
      with owner_lock as (
        select hashtextextended(${userId}::uuid::text, 0)::bigint as lock_key
      )
      select
        count(*) filter (where locks.granted)::int as granted,
        count(*) filter (where not locks.granted)::int as waiting
      from pg_locks locks
      cross join owner_lock
      where locks.locktype = 'advisory'
        and locks.objsubid = 1
        and locks.classid::bigint =
          ((owner_lock.lock_key >> 32) & 4294967295::bigint)
        and locks.objid::bigint =
          (owner_lock.lock_key & 4294967295::bigint)
    `;
    if (state.granted === 1 && state.waiting === expectedWaiting) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The owner sharing lock collision was not observed.");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function captureOutcome<T>(
  promise: Promise<T>,
): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

async function createFlights(
  userId: string,
  originAirportId: string,
  destinationAirportId: string,
  count: number,
): Promise<void> {
  await withUserDb(userId, async (tx) => {
    await tx.insert(flights).values(
      Array.from({ length: count }, (_, index) => ({
        userId,
        fingerprint: randomUUID(),
        date: "2026-08-14",
        originAirportId,
        destinationAirportId,
        kind: "private",
        role: "pilot",
        notes: `bulk flight ${index + 1}`,
      })),
    );
  });
}

async function createFlight(
  userId: string,
  originAirportId: string,
  destinationAirportId: string,
  notes: string,
): Promise<string> {
  return withUserDb(userId, async (tx) => {
    const [flight] = await tx
      .insert(flights)
      .values({
        userId,
        fingerprint: randomUUID(),
        date: "2026-08-14",
        originAirportId,
        destinationAirportId,
        kind: "private",
        role: "pilot",
        aircraft: "Sensitive aircraft",
        registration: "N12345",
        notes,
      })
      .returning({ id: flights.id });
    return flight.id;
  });
}

async function createFlightStopPair(
  userId: string,
  flightId: string,
  originAirportId: string,
  destinationAirportId: string,
): Promise<void> {
  await withUserDb(userId, (tx) =>
    tx.insert(flightStops).values([
      {
        userId,
        flightId,
        stopOrder: 0,
        airportId: originAirportId,
      },
      {
        userId,
        flightId,
        stopOrder: 1,
        airportId: destinationAirportId,
      },
    ]),
  );
}

async function enableCurrentShare(userId: string): Promise<void> {
  const preview = await previewMapSharing(userId, {
    includeDisplayName: false,
  });
  await enableMapSharing(userId, {
    includeDisplayName: false,
    previewId: preview.previewId,
  });
}

async function holdOwnerShareLock(
  userId: string,
): Promise<{ done: Promise<void>; release: () => void }> {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
  const connection = postgres(migrationUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  const reached = deferred<void>();
  const release = deferred<void>();
  const done = (async () => {
    await connection`
      select pg_advisory_lock(hashtextextended(${userId}::uuid::text, 0))
    `;
    reached.resolve();
    await release.promise;
    await connection`
      select pg_advisory_unlock(hashtextextended(${userId}::uuid::text, 0))
    `;
  })()
    .then(() => undefined)
    .finally(() => connection.end());
  void done.catch(reached.reject);
  await reached.promise;
  return { done, release: () => release.resolve(undefined) };
}

async function moveFlightStop(
  sourceFlightId: string,
  targetUserId: string,
  targetFlightId: string,
): Promise<void> {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
  const connection = postgres(migrationUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await connection.begin(async (tx) => {
      await tx.unsafe("set local statement_timeout = '10s'");
      await tx`
        update flight_stops
        set user_id = ${targetUserId}::uuid,
            flight_id = ${targetFlightId}::uuid
        where flight_id = ${sourceFlightId}::uuid
          and stop_order = 0
      `;
    });
  } finally {
    await connection.end();
  }
}
