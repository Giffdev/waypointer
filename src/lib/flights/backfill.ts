import { sql } from "drizzle-orm";
import { withUserDb } from "../db";

export async function backfillFlightRoleDefaults(userId: string): Promise<void> {
  await withUserDb(userId, (tx) =>
    tx.execute(sql`
      with classified_sources as (
        select
          fs.flight_id,
          case
            when ib.adapter_id = 'foreflight-v1' then 'private'
            when ib.adapter_id = 'myflightradar24-v1' then 'commercial'
            when ib.adapter_id = 'generic-csv-v1'
              and ir.parsed -> 'provenance' ->> 'adapterLabel'
                in ('MyFlightbook CSV', 'CrewLounge PILOTLOG compatible CSV')
              then 'private'
            else null
          end as expected_kind,
          case
            when ib.adapter_id = 'foreflight-v1' then 'pilot'
            when ib.adapter_id = 'myflightradar24-v1' then 'passenger'
            when ib.adapter_id = 'generic-csv-v1'
              and ir.parsed -> 'provenance' ->> 'adapterLabel'
                in ('MyFlightbook CSV', 'CrewLounge PILOTLOG compatible CSV')
              then 'pilot'
            else null
          end as expected_role
        from flight_sources fs
        join import_batches ib
          on ib.id = fs.batch_id and ib.user_id = fs.user_id
        join import_rows ir
          on ir.id = fs.import_row_id and ir.user_id = fs.user_id
        where fs.user_id = ${userId}
      ),
      safe_defaults as (
        select
          flight_id,
          min(expected_kind) as expected_kind,
          min(expected_role) as expected_role
        from classified_sources
        group by flight_id
        having count(*) filter (
            where expected_kind is null or expected_role is null
          ) = 0
          and count(distinct expected_kind) = 1
          and count(distinct expected_role) = 1
      )
      update flights f
      set
        kind = safe_defaults.expected_kind,
        role = safe_defaults.expected_role,
        role_origin = 'source-default',
        updated_at = now()
      from safe_defaults
      where f.user_id = ${userId}
        and f.id = safe_defaults.flight_id
        and not exists (
          select 1
          from flight_overrides overrides
          where overrides.user_id = f.user_id
            and overrides.flight_id = f.id
            and overrides.field in ('kind', 'role')
        )
        and (
          f.kind is distinct from safe_defaults.expected_kind
          or f.role is distinct from safe_defaults.expected_role
          or f.role_origin = 'legacy-unresolved'
        )
    `),
  );
}
