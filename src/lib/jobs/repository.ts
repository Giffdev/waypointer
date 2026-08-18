import { and, eq, sql } from "drizzle-orm";
import { getDb, withUserDb } from "@/lib/db";
import { findActiveAccountById } from "@/lib/auth/account-state";
import { backgroundJobs, importBatches } from "@/lib/db/schema";
import type { ClaimedJob, QueueMetrics } from "./types";
import type { JobErrorCode } from "./errors";

type Database = ReturnType<typeof getDb>;

export function retryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  return Math.min(
    15 * 60_000,
    Math.round(exponential * (0.75 + random() * 0.5)),
  );
}

export class DurableJobRepository {
  constructor(private readonly db: Database = getDb()) {}

  async enqueueScanImport(
    userId: string,
    batchId: string,
    maxAttempts = 5,
  ): Promise<string> {
    const [job] = await this.db
      .insert(backgroundJobs)
      .values({
        userId,
        jobType: "scan_import",
        payload: { batchId },
        idempotencyKey: `scan-import:${batchId}`,
        maxAttempts,
      })
      .onConflictDoUpdate({
        target: [
          backgroundJobs.userId,
          backgroundJobs.jobType,
          backgroundJobs.idempotencyKey,
        ],
        targetWhere: sql`${backgroundJobs.idempotencyKey} is not null`,
        set: { updatedAt: new Date() },
      })
      .returning({ id: backgroundJobs.id });
    if (!job) throw new Error("The import job could not be queued.");
    return job.id;
  }

  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
    assertWorker(workerId, leaseSeconds);
    await this.db.execute(sql`
      update background_jobs
      set state = 'dead_letter',
          lease_owner = null,
          lease_expires_at = null,
          completed_at = now(),
          last_error_code = 'attempts-exhausted',
          last_error_message = 'The job exhausted its retry budget.',
          updated_at = now()
      where state = 'running'
        and lease_expires_at <= now()
        and attempts >= max_attempts
    `);
    const rows = await this.db.execute(sql`
      with candidate as (
        select j.id
        from background_jobs j
        join users u on u.id = j.user_id
        where (
          (j.state = 'queued' and j.available_at <= now())
          or (j.state = 'running' and j.lease_expires_at <= now())
        )
          and j.attempts < j.max_attempts
          and j.cancel_requested_at is null
          and (
            j.job_type in ('purge_account', 'cleanup_import_upload', 'cleanup_import_retention')
            or (
              u.email_verified_at is not null
              and u.disabled_at is null
              and not exists (
                select 1
                from account_deletion_requests d
                where d.user_id = j.user_id
                  and d.status in ('pending', 'processing', 'failed')
              )
            )
          )
        order by j.priority asc, j.available_at asc, j.created_at asc
        for update of j skip locked
        limit 1
      )
      update background_jobs j
      set state = 'running',
          attempts = j.attempts + 1,
          lease_owner = ${workerId},
          lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
          started_at = coalesce(j.started_at, now()),
          updated_at = now()
      from candidate
      where j.id = candidate.id
      returning j.id, j.user_id, j.job_type, j.payload, j.attempts,
                j.max_attempts, j.lease_owner, j.lease_expires_at
    `);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    const jobType = String(row.job_type) as ClaimedJob["jobType"];
    const active =
      ["purge_account", "cleanup_import_upload", "cleanup_import_retention"].includes(
        jobType,
      )
        ? true
        : Boolean(await findActiveAccountById(String(row.user_id)));
    if (!active) {
      await this.cancelClaim(String(row.id), workerId);
      return null;
    }
    return {
      id: String(row.id),
      userId: String(row.user_id),
      jobType,
      payload: row.payload,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      leaseOwner: String(row.lease_owner),
      leaseExpiresAt: new Date(String(row.lease_expires_at)),
    };
  }

  async renew(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    assertWorker(workerId, leaseSeconds);
    const [renewed] = await this.db
      .update(backgroundJobs)
      .set({
        leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          eq(backgroundJobs.state, "running"),
          eq(backgroundJobs.leaseOwner, workerId),
        ),
      )
      .returning({ id: backgroundJobs.id });
    return Boolean(renewed);
  }

  async isCancellationRequested(jobId: string, workerId: string): Promise<boolean> {
    const [job] = await this.db
      .select({ cancelRequestedAt: backgroundJobs.cancelRequestedAt })
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          eq(backgroundJobs.state, "running"),
          eq(backgroundJobs.leaseOwner, workerId),
        ),
      )
      .limit(1);
    return !job || Boolean(job.cancelRequestedAt);
  }

  async complete(jobId: string, workerId: string): Promise<boolean> {
    const [completed] = await this.db
      .update(backgroundJobs)
      .set({
        state: "succeeded",
        payload: sql`${backgroundJobs.payload} - 'mapping'`,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          eq(backgroundJobs.state, "running"),
          eq(backgroundJobs.leaseOwner, workerId),
        ),
      )
      .returning({ id: backgroundJobs.id });
    return Boolean(completed);
  }

  async cancel(jobId: string, workerId: string): Promise<boolean> {
    const [cancelled] = await this.db
      .update(backgroundJobs)
      .set({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          eq(backgroundJobs.state, "running"),
          eq(backgroundJobs.leaseOwner, workerId),
        ),
      )
      .returning({ id: backgroundJobs.id });
    return Boolean(cancelled);
  }

  async fail(
    job: ClaimedJob,
    code: JobErrorCode,
    message: string,
    retryable: boolean,
  ): Promise<"queued" | "failed" | "dead_letter"> {
    const exhausted = job.attempts >= job.maxAttempts;
    const state = retryable ? (exhausted ? "dead_letter" : "queued") : "failed";
    const [updated] = await this.db
      .update(backgroundJobs)
      .set({
        state,
        availableAt:
          state === "queued"
            ? job.scheduledRetryAt ??
              new Date(Date.now() + retryDelayMs(job.attempts))
            : new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: state === "queued" ? null : new Date(),
        lastErrorCode: code,
        lastErrorMessage: message.slice(0, 240),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobs.id, job.id),
          eq(backgroundJobs.state, "running"),
          eq(backgroundJobs.leaseOwner, job.leaseOwner),
        ),
      )
      .returning({ id: backgroundJobs.id });
    if (!updated) throw new Error("The job lease was lost.");
    return state;
  }

  async requestImportCancellation(userId: string, batchId: string): Promise<boolean> {
    return withUserDb(userId, async (tx) => {
      const now = new Date();
      const [batch] = await tx
        .update(importBatches)
        .set({
          cancelRequestedAt: now,
          cancellationReason: "user-requested",
          status: sql`case when ${importBatches.status} in ('pending','queued','retrying') then 'cancelled'::import_batch_status else ${importBatches.status} end`,
          cancelledAt: sql`case when ${importBatches.status} in ('pending','queued','retrying') then ${now} else ${importBatches.cancelledAt} end`,
          updatedAt: now,
        })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
            sql`${importBatches.status} in ('pending','queued','scanning','processing','retrying')`,
          ),
        )
        .returning({ id: importBatches.id });
      if (!batch) return false;
      await tx
        .update(backgroundJobs)
        .set({
          state: sql`case when ${backgroundJobs.state} = 'queued' then 'cancelled'::background_job_state else ${backgroundJobs.state} end`,
          cancelRequestedAt: now,
          completedAt: sql`case when ${backgroundJobs.state} = 'queued' then ${now} else ${backgroundJobs.completedAt} end`,
          updatedAt: now,
        })
        .where(
          and(
            eq(backgroundJobs.userId, userId),
            eq(backgroundJobs.jobType, "scan_import"),
            eq(backgroundJobs.idempotencyKey, `scan-import:${batchId}`),
            sql`${backgroundJobs.state} in ('queued','running')`,
          ),
        );
      return true;
    });
  }

  async retryImport(userId: string, batchId: string): Promise<boolean> {
    return withUserDb(userId, async (tx) => {
      const now = new Date();
      const [batch] = await tx
        .update(importBatches)
        .set({
          status: "queued",
          failureCode: null,
          failureMessage: null,
          nextRetryAt: null,
          cancelRequestedAt: null,
          cancelledAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
            sql`${importBatches.status} in ('failed','cancelled')`,
            sql`${importBatches.originalDeletedAt} is null`,
          ),
        )
        .returning({ id: importBatches.id });
      if (!batch) return false;
      await tx
        .update(backgroundJobs)
        .set({
          state: "queued",
          attempts: 0,
          availableAt: now,
          cancelRequestedAt: null,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(backgroundJobs.userId, userId),
            eq(backgroundJobs.jobType, "scan_import"),
            eq(backgroundJobs.idempotencyKey, `scan-import:${batchId}`),
          ),
        );
      return true;
    });
  }

  async metrics(): Promise<QueueMetrics> {
    const rows = await this.db.execute(sql`
      select
        count(*) filter (where state = 'queued')::int as queued,
        count(*) filter (where state = 'running')::int as running,
        count(*) filter (where state = 'dead_letter')::int as dead_letter,
        min(created_at) filter (where state = 'queued') as oldest_queued_at
      from background_jobs
    `);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
    return {
      queued: Number(row.queued ?? 0),
      running: Number(row.running ?? 0),
      deadLetter: Number(row.dead_letter ?? 0),
      oldestQueuedAt: row.oldest_queued_at
        ? new Date(String(row.oldest_queued_at))
        : null,
    };
  }

  private async cancelClaim(jobId: string, workerId: string): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          eq(backgroundJobs.leaseOwner, workerId),
        ),
      );
  }
}

function assertWorker(workerId: string, leaseSeconds: number): void {
  if (!/^[a-zA-Z0-9._:-]{3,100}$/.test(workerId)) {
    throw new Error("A safe worker ID is required.");
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
    throw new Error("JOB_LEASE_SECONDS must be from 30 to 900.");
  }
}
