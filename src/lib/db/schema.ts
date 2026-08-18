import type { AdapterAccountType } from "@auth/core/adapters";
import { sql } from "drizzle-orm";
import {
  bigint,
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const importBatchStatus = pgEnum("import_batch_status", [
  "pending",
  "queued",
  "scanning",
  "processing",
  "retrying",
  "review",
  "committing",
  "committed",
  "deduplicated",
  "cancelled",
  "quarantined",
  "failed",
  "expired",
]);

export const importScanStatus = pgEnum("import_scan_status", [
  "pending",
  "scanning",
  "clean",
  "infected",
  "failed",
  "legacy_unscanned",
]);

export const backgroundJobState = pgEnum("background_job_state", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "dead_letter",
]);

export const accountDeletionStatus = pgEnum("account_deletion_status", [
  "pending",
  "cancelled",
  "processing",
  "completed",
  "failed",
]);

export const importValidationState = pgEnum("import_validation_state", [
  "valid",
  "warning",
  "invalid",
  "duplicate",
]);

export const importUserDecision = pgEnum("import_user_decision", [
  "pending",
  "accepted",
  "skipped",
  "duplicate",
]);

export const duplicateResolution = pgEnum("duplicate_resolution", [
  "pending",
  "accept_new",
  "skip_as_duplicate",
  "kept_both",
  "merged",
  "dismissed",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name"),
    email: text("email").notNull(),
    emailVerified: timestamp("email_verified_at", { withTimezone: true }),
    image: text("image"),
    username: text("username").notNull(),
    passwordHash: text("password_hash"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_unique").on(sql`lower(${table.email})`),
    uniqueIndex("users_username_unique").on(sql`lower(${table.username})`),
    check(
      "users_username_format",
      sql`${table.username} ~ '^[a-z0-9][a-z0-9_-]{2,29}$'`,
    ),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (table) => [
    primaryKey({
      name: "accounts_provider_account_pk",
      columns: [table.provider, table.providerAccountId],
    }),
    index("accounts_user_id_idx").on(table.userId),
    check("accounts_refresh_token_null", sql`${table.refresh_token} is null`),
    check("accounts_access_token_null", sql`${table.access_token} is null`),
    check("accounts_id_token_null", sql`${table.id_token} is null`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "verification_tokens_identifier_token_pk",
      columns: [table.identifier, table.token],
    }),
  ],
);

export const authenticators = pgTable(
  "authenticators",
  {
    credentialID: text("credential_id").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerAccountId: text("provider_account_id").notNull(),
    credentialPublicKey: text("credential_public_key").notNull(),
    counter: integer("counter").notNull(),
    credentialDeviceType: text("credential_device_type").notNull(),
    credentialBackedUp: boolean("credential_backed_up").notNull(),
    transports: text("transports"),
  },
  (table) => [
    primaryKey({
      name: "authenticators_user_credential_pk",
      columns: [table.userId, table.credentialID],
    }),
  ],
);

export const airports = pgTable(
  "airports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceIdent: text("source_ident"),
    sourceIdentProvenance: text("source_ident_provenance"),
    icao: text("icao"),
    iata: text("iata"),
    localCode: text("local_code"),
    searchKeywords: text("search_keywords"),
    searchKey: text("search_key"),
    name: text("name").notNull(),
    city: text("city"),
    country: text("country").notNull(),
    region: text("region"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    facility: text("facility").notNull(),
    scheduledService: boolean("scheduled_service").notNull().default(false),
    datasetVersion: text("dataset_version").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("airports_icao_unique").on(table.icao),
    uniqueIndex("airports_iata_unique").on(table.iata),
    uniqueIndex("airports_source_ident_unique").on(table.sourceIdent),
    index("airports_local_code_idx").on(table.localCode),
    index("airports_search_key_idx").on(table.searchKey),
    check(
      "airports_source_ident_provenance_valid",
      sql`(
        (${table.sourceIdent} is null and ${table.sourceIdentProvenance} is null)
        or (
          ${table.sourceIdent} is not null
          and (
            ${table.sourceIdentProvenance} = 'legacy-code-backfill'
            or ${table.sourceIdentProvenance} ~ '^ourairports-sha256:[a-f0-9]{64}$'
          )
        )
      )`,
    ),
  ],
);

export const airportAliases = pgTable(
  "airport_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    airportId: uuid("airport_id")
      .notNull()
      .references(() => airports.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    codeType: text("code_type").notNull(),
    priority: integer("priority").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("airport_aliases_airport_code_type_unique").on(
      table.airportId,
      table.code,
      table.codeType,
    ),
    index("airport_aliases_code_priority_idx").on(table.code, table.priority),
    check(
      "airport_aliases_type_valid",
      sql`${table.codeType} in ('icao', 'iata', 'faa-lid', 'gps', 'ident', 'local')`,
    ),
    check(
      "airport_aliases_priority_positive",
      sql`${table.priority} > 0`,
    ),
  ],
);

export const flights = pgTable(
  "flights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    date: text("date").notNull(),
    originAirportId: uuid("origin_airport_id")
      .notNull()
      .references(() => airports.id),
    destinationAirportId: uuid("destination_airport_id")
      .notNull()
      .references(() => airports.id),
    kind: text("kind").notNull(),
    role: text("role").notNull(),
    roleOrigin: text("role_origin").notNull().default("legacy-unresolved"),
    sourceType: text("source_type").notNull().default("CSV"),
    aircraft: text("aircraft"),
    aircraftType: text("aircraft_type"),
    registration: text("registration"),
    flightNumber: text("flight_number"),
    airline: text("airline"),
    departureTime: text("departure_time"),
    distanceMiles: doublePrecision("distance_miles"),
    durationHours: doublePrecision("duration_hours"),
    notes: text("notes"),
    visibility: text("visibility").notNull().default("private"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("flights_id_user_unique").on(table.id, table.userId),
    uniqueIndex("flights_user_fingerprint_unique").on(
      table.userId,
      table.fingerprint,
    ),
    index("flights_user_date_idx").on(table.userId, table.date),
    check(
      "flights_role_origin_valid",
      sql`${table.roleOrigin} in ('source-default', 'explicit', 'legacy-unresolved')`,
    ),
    check(
      "flights_source_type_valid",
      sql`${table.sourceType} in ('ForeFlight', 'FlightRadar24', 'CSV', 'Manual')`,
    ),
  ],
);

export const flightStops = pgTable(
  "flight_stops",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flightId: uuid("flight_id")
      .notNull()
      .references(() => flights.id, { onDelete: "cascade" }),
    stopOrder: integer("stop_order").notNull(),
    airportId: uuid("airport_id")
      .notNull()
      .references(() => airports.id),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: "flight_stops_flight_order_pk",
      columns: [table.flightId, table.stopOrder],
    }),
    foreignKey({
      name: "flight_stops_flight_owner_fk",
      columns: [table.flightId, table.userId],
      foreignColumns: [flights.id, flights.userId],
    }).onDelete("cascade"),
    index("flight_stops_user_flight_idx").on(table.userId, table.flightId),
    check("flight_stops_order_nonnegative", sql`${table.stopOrder} >= 0`),
  ],
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    adapterId: text("adapter_id").notNull(),
    adapterVersion: integer("adapter_version").notNull(),
    status: importBatchStatus("status").notNull().default("pending"),
    originalObjectKey: text("original_object_key").notNull(),
    quarantineObjectKey: text("quarantine_object_key"),
    originalFileName: text("original_file_name").notNull(),
    declaredContentType: text("declared_content_type"),
    objectEtag: text("object_etag"),
    uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }),
    fileSha256: text("file_sha256").notNull(),
    duplicateOfBatchId: uuid("duplicate_of_batch_id").references(
      (): AnyPgColumn => importBatches.id,
      { onDelete: "set null" },
    ),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    totalRows: integer("total_rows").notNull().default(0),
    parsedRows: integer("parsed_rows").notNull().default(0),
    acceptedRows: integer("accepted_rows").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    idempotencyKey: text("idempotency_key"),
    uploadCompletedAt: timestamp("upload_completed_at", {
      withTimezone: true,
    }),
    scanStatus: importScanStatus("scan_status").notNull().default("pending"),
    scanProvider: text("scan_provider"),
    scanStartedAt: timestamp("scan_started_at", { withTimezone: true }),
    scanCompletedAt: timestamp("scan_completed_at", { withTimezone: true }),
    scanAttempts: integer("scan_attempts").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
    }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    originalDeletedAt: timestamp("original_deleted_at", {
      withTimezone: true,
    }),
    snapshotsScrubbedAt: timestamp("snapshots_scrubbed_at", {
      withTimezone: true,
    }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("import_batches_id_user_unique").on(table.id, table.userId),
    uniqueIndex("import_batches_user_hash_active_unique")
      .on(table.userId, table.fileSha256)
      .where(sql`${table.status} <> 'expired'`),
    uniqueIndex("import_batches_user_idempotency_unique")
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("import_batches_user_created_idx").on(table.userId, table.createdAt),
    index("import_batches_retry_ready_idx")
      .on(table.nextRetryAt, table.createdAt)
      .where(sql`${table.status} = 'retrying'`),
    index("import_batches_retention_due_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} <> 'expired'`),
    index("import_batches_purge_due_idx")
      .on(table.purgeAfter)
      .where(sql`${table.purgedAt} is null and ${table.purgeAfter} is not null`),
    check(
      "import_batches_scan_attempts_nonnegative",
      sql`${table.scanAttempts} >= 0`,
    ),
    check(
      "import_batches_retry_count_nonnegative",
      sql`${table.retryCount} >= 0`,
    ),
    check(
      "import_batches_scan_window_valid",
      sql`${table.scanCompletedAt} is null or ${table.scanStartedAt} is not null`,
    ),
    check(
      "import_batches_cancel_window_valid",
      sql`${table.cancelledAt} is null or ${table.cancelRequestedAt} is not null`,
    ),
    check(
      "import_batches_purge_window_valid",
      sql`${table.purgedAt} is null or ${table.purgeAfter} is not null`,
    ),
  ],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    rawSnapshot: jsonb("raw_snapshot"),
    parsed: jsonb("parsed").notNull(),
    validationState: importValidationState("validation_state").notNull(),
    matchConfidence: doublePrecision("match_confidence"),
    proposedFlight: jsonb("proposed_flight"),
    userDecision: importUserDecision("user_decision")
      .notNull()
      .default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "import_rows_batch_owner_fk",
      columns: [table.batchId, table.userId],
      foreignColumns: [importBatches.id, importBatches.userId],
    }).onDelete("cascade"),
    uniqueIndex("import_rows_id_user_unique").on(table.id, table.userId),
    uniqueIndex("import_rows_id_user_batch_unique").on(
      table.id,
      table.userId,
      table.batchId,
    ),
    uniqueIndex("import_rows_batch_row_unique").on(
      table.batchId,
      table.rowNumber,
    ),
    index("import_rows_user_batch_idx").on(table.userId, table.batchId),
  ],
);

export const flightSources = pgTable(
  "flight_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flightId: uuid("flight_id")
      .notNull()
      .references(() => flights.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "restrict" }),
    importRowId: uuid("import_row_id")
      .notNull()
      .references(() => importRows.id, { onDelete: "restrict" }),
    sourceType: text("source_type").notNull(),
    externalStableId: text("external_stable_id"),
    sourceTimestamps: jsonb("source_timestamps"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "flight_sources_flight_owner_fk",
      columns: [table.flightId, table.userId],
      foreignColumns: [flights.id, flights.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "flight_sources_batch_owner_fk",
      columns: [table.batchId, table.userId],
      foreignColumns: [importBatches.id, importBatches.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "flight_sources_row_owner_fk",
      columns: [table.importRowId, table.userId],
      foreignColumns: [importRows.id, importRows.userId],
    }).onDelete("restrict"),
    uniqueIndex("flight_sources_user_row_unique").on(
      table.userId,
      table.importRowId,
    ),
    index("flight_sources_user_flight_idx").on(table.userId, table.flightId),
  ],
);

export const flightOverrides = pgTable(
  "flight_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flightId: uuid("flight_id")
      .notNull()
      .references(() => flights.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    originalValue: jsonb("original_value"),
    correctedValue: jsonb("corrected_value").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "flight_overrides_flight_owner_fk",
      columns: [table.flightId, table.userId],
      foreignColumns: [flights.id, flights.userId],
    }).onDelete("cascade"),
    index("flight_overrides_user_flight_idx").on(table.userId, table.flightId),
  ],
);

export const duplicateCandidates = pgTable(
  "duplicate_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flightAId: uuid("flight_a_id")
      .references(() => flights.id, { onDelete: "cascade" }),
    flightBId: uuid("flight_b_id")
      .references(() => flights.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").references(() => importBatches.id, {
      onDelete: "cascade",
    }),
    importRowId: uuid("import_row_id").references(() => importRows.id, {
      onDelete: "cascade",
    }),
    candidateImportRowId: uuid("candidate_import_row_id").references(
      () => importRows.id,
      { onDelete: "cascade" },
    ),
    candidateFlightId: uuid("candidate_flight_id").references(
      () => flights.id,
      { onDelete: "cascade" },
    ),
    candidateScope: text("candidate_scope"),
    ruleVersion: integer("rule_version").notNull(),
    score: doublePrecision("score").notNull(),
    explanation: jsonb("explanation").notNull(),
    resolution: duplicateResolution("resolution").notNull().default("pending"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "duplicate_candidates_flight_a_owner_fk",
      columns: [table.flightAId, table.userId],
      foreignColumns: [flights.id, flights.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "duplicate_candidates_batch_owner_fk",
      columns: [table.batchId, table.userId],
      foreignColumns: [importBatches.id, importBatches.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "duplicate_candidates_row_owner_batch_fk",
      columns: [table.importRowId, table.userId, table.batchId],
      foreignColumns: [importRows.id, importRows.userId, importRows.batchId],
    }).onDelete("cascade"),
    foreignKey({
      name: "duplicate_candidates_candidate_row_owner_batch_fk",
      columns: [table.candidateImportRowId, table.userId, table.batchId],
      foreignColumns: [importRows.id, importRows.userId, importRows.batchId],
    }).onDelete("cascade"),
    foreignKey({
      name: "duplicate_candidates_candidate_flight_owner_fk",
      columns: [table.candidateFlightId, table.userId],
      foreignColumns: [flights.id, flights.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "duplicate_candidates_flight_b_owner_fk",
      columns: [table.flightBId, table.userId],
      foreignColumns: [flights.id, flights.userId],
    }).onDelete("cascade"),
    uniqueIndex("duplicate_candidates_user_pair_rule_unique").on(
      table.userId,
      table.flightAId,
      table.flightBId,
      table.ruleVersion,
    ),
    uniqueIndex("duplicate_candidates_user_row_rule_unique")
      .on(table.userId, table.importRowId, table.ruleVersion)
      .where(sql`${table.importRowId} is not null`),
    index("duplicate_candidates_user_batch_idx").on(
      table.userId,
      table.batchId,
    ),
    check(
      "duplicate_candidates_score_range",
      sql`${table.score} >= 0 and ${table.score} <= 1`,
    ),
    check(
      "duplicate_candidates_import_shape",
      sql`(
        (${table.importRowId} is null and ${table.flightAId} is not null and ${table.flightBId} is not null)
        or
        (
          ${table.importRowId} is not null
          and ${table.batchId} is not null
          and (
            (${table.candidateScope} = 'existing-flight' and ${table.candidateFlightId} is not null and ${table.candidateImportRowId} is null)
            or
            (${table.candidateScope} = 'staged-row' and ${table.candidateImportRowId} is not null and ${table.candidateFlightId} is null)
          )
        )
      )`,
    ),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("rate_limits_expires_idx").on(table.expiresAt)],
);

export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    timeZone: text("time_zone").notNull().default("UTC"),
    distanceUnit: text("distance_unit").notNull().default("nautical_miles"),
    mapViewMode: text("map_view_mode").notNull().default("globe"),
    ...timestamps,
  },
  (table) => [
    check(
      "user_profiles_distance_unit_valid",
      sql`${table.distanceUnit} in ('miles', 'kilometers', 'nautical_miles')`,
    ),
    check(
      "user_profiles_map_view_mode_valid",
      sql`${table.mapViewMode} in ('globe', 'flat')`,
    ),
    check(
      "user_profiles_display_name_length",
      sql`${table.displayName} is null or char_length(${table.displayName}) between 1 and 100`,
    ),
  ],
);

export const mapShares = pgTable(
  "map_shares",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    publicId: uuid("public_id").notNull().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    tokenVersion: integer("token_version").notNull().default(1),
    includeDisplayName: boolean("include_display_name").notNull().default(false),
    scopeType: text("scope_type").notNull().default("selected_flights"),
    projection: jsonb("projection").notNull().default({
      owner: { displayName: null },
      summary: { flightCount: 0, routeCount: 0 },
      routes: [],
      flights: [],
    }),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("map_shares_public_id_unique").on(table.publicId),
    uniqueIndex("map_shares_token_hash_unique").on(table.tokenHash),
    check(
      "map_shares_token_hash_length",
      sql`char_length(${table.tokenHash}) = 64`,
    ),
    check(
      "map_shares_token_version_positive",
      sql`${table.tokenVersion} > 0`,
    ),
    check(
      "map_shares_scope_type_valid",
      sql`${table.scopeType} = 'selected_flights'`,
    ),
  ],
);

export const mapShareFlights = pgTable(
  "map_share_flights",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flightId: uuid("flight_id")
      .notNull()
      .references(() => flights.id, { onDelete: "cascade" }),
    selectedAt: timestamp("selected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "map_share_flights_user_flight_pk",
      columns: [table.userId, table.flightId],
    }),
    foreignKey({
      name: "map_share_flights_owner_fk",
      columns: [table.flightId, table.userId],
      foreignColumns: [flights.id, flights.userId],
    }).onDelete("cascade"),
    index("map_share_flights_user_idx").on(table.userId),
  ],
);

export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    state: backgroundJobState("state").notNull().default("queued"),
    payload: jsonb("payload").notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    priority: integer("priority").notNull().default(100),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("background_jobs_user_type_idempotency_unique")
      .on(table.userId, table.jobType, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("background_jobs_ready_idx")
      .on(table.priority, table.availableAt, table.createdAt)
      .where(sql`${table.state} = 'queued'`),
    index("background_jobs_lease_expiry_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'running'`),
    index("background_jobs_user_state_idx").on(table.userId, table.state),
    check("background_jobs_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "background_jobs_max_attempts_positive",
      sql`${table.maxAttempts} between 1 and 25`,
    ),
    check(
      "background_jobs_attempts_bounded",
      sql`${table.attempts} <= ${table.maxAttempts}`,
    ),
    check(
      "background_jobs_lease_pair",
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`,
    ),
  ],
);

export const accountDeletionRequests = pgTable(
  "account_deletion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: accountDeletionStatus("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    graceExpiresAt: timestamp("grace_expires_at", {
      withTimezone: true,
    }).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }).notNull(),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("account_deletion_requests_id_user_unique").on(
      table.id,
      table.userId,
    ),
    uniqueIndex("account_deletion_requests_one_active_user")
      .on(table.userId)
      .where(sql`${table.status} in ('pending', 'processing')`),
    index("account_deletion_requests_grace_due_idx")
      .on(table.graceExpiresAt)
      .where(sql`${table.status} = 'pending'`),
    index("account_deletion_requests_purge_due_idx")
      .on(table.purgeAfter)
      .where(sql`${table.status} in ('pending', 'processing', 'failed')`),
    check(
      "account_deletion_requests_grace_window",
      sql`${table.graceExpiresAt} > ${table.requestedAt}`,
    ),
    check(
      "account_deletion_requests_purge_window",
      sql`${table.purgeAfter} >= ${table.graceExpiresAt}`,
    ),
  ],
);

export const accountDeletionTokens = pgTable(
  "account_deletion_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "account_deletion_tokens_request_owner_fk",
      columns: [table.requestId, table.userId],
      foreignColumns: [
        accountDeletionRequests.id,
        accountDeletionRequests.userId,
      ],
    }).onDelete("cascade"),
    uniqueIndex("account_deletion_tokens_hash_unique").on(table.tokenHash),
    index("account_deletion_tokens_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.usedAt} is null`),
    check(
      "account_deletion_tokens_hash_length",
      sql`char_length(${table.tokenHash}) = 64`,
    ),
  ],
);

export const deletionTombstones = pgTable(
  "deletion_tombstones",
  {
    subjectHash: text("subject_hash").primaryKey(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    purgeVerifiedAt: timestamp("purge_verified_at", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("deletion_tombstones_retention_idx").on(table.retainUntil),
    check(
      "deletion_tombstones_hash_length",
      sql`char_length(${table.subjectHash}) = 64`,
    ),
    check(
      "deletion_tombstones_retention_window",
      sql`${table.retainUntil} > ${table.deletedAt}`,
    ),
  ],
);
