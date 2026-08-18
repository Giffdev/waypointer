const SAFE_POSTGRES_FIELDS = [
  "code",
  "severity",
  "schema_name",
  "table_name",
  "constraint_name",
  "routine",
] as const;

const SAFE_CONTEXT_FIELDS = [
  "incomingCount",
  "candidateCount",
  "claimedCount",
  "duplicateCount",
  "referenceIndex",
  "expectedCount",
  "actualCount",
] as const;

export type AirportCatalogDiagnosticCode =
  | "ambiguous-existing-identity"
  | "crossed-identifiers"
  | "database-target-mismatch"
  | "candidate-provenance-mismatch"
  | "duplicate-incoming-source-ident"
  | "evidence-already-exists"
  | "evidence-path-invalid"
  | "health-check-failed"
  | "identity-reassignment"
  | "migration-ledger-mismatch"
  | "operator-confirmation-missing"
  | "release-lock-unavailable"
  | "rollback-not-eligible"
  | "rollback-verification-failed"
  | "schema-state-mismatch"
  | "snapshot-approval-missing"
  | "source-checksum-mismatch"
  | "source-count-mismatch"
  | "target-approval-invalid"
  | "target-allowlist-mismatch"
  | "target-configuration-invalid";

export class AirportCatalogSafetyError extends Error {
  readonly diagnosticCode: AirportCatalogDiagnosticCode;
  readonly safeContext: Partial<
    Record<(typeof SAFE_CONTEXT_FIELDS)[number], number>
  >;

  constructor(
    diagnosticCode: AirportCatalogDiagnosticCode,
    safeContext: Partial<
      Record<(typeof SAFE_CONTEXT_FIELDS)[number], number>
    > = {},
  ) {
    super("Airport catalog operation blocked.");
    this.name = "AirportCatalogSafetyError";
    this.diagnosticCode = diagnosticCode;
    this.safeContext = safeContext;
  }
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return /^[A-Za-z0-9_.-]{1,128}$/.test(token) ? token : undefined;
}

function findPostgresDiagnostics(
  error: unknown,
): Record<string, unknown> | undefined {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      !current ||
      (typeof current !== "object" && typeof current !== "function") ||
      visited.has(current)
    ) {
      return undefined;
    }
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (safeToken(record.code)) return record;
    current = record.cause;
  }
  return undefined;
}

export function formatSafePostgresError(error: unknown): string {
  if (error instanceof AirportCatalogSafetyError) {
    const context = SAFE_CONTEXT_FIELDS.flatMap((field) => {
      const value = error.safeContext[field];
      return Number.isSafeInteger(value) && value! >= 0
        ? [`${field}=${value}`]
        : [];
    });
    return `Airport catalog operation blocked [reason=${error.diagnosticCode}${
      context.length ? `; ${context.join("; ")}` : ""
    }]`;
  }

  const record = findPostgresDiagnostics(error);
  if (!record) return "Airport catalog operation failed.";
  const diagnostics = SAFE_POSTGRES_FIELDS.flatMap((field) => {
    const value = safeToken(record[field]);
    return value ? [`${field}=${value}`] : [];
  });
  return `Airport catalog operation failed${
    diagnostics.length ? ` [${diagnostics.join("; ")}]` : ""
  }`;
}

export const safePostgresClientOptions = {
  onnotice: (notice: unknown) => {
    void notice;
  },
} as const;

const RAW_NOTICE_PATTERNS = [
  /\bseverity_local\s*:/i,
  /\bmessage\s*:\s*['"]/i,
  /\bfile\s*:\s*['"][^'"]+\.c['"]/i,
  /\bline\s*:\s*['"]?\d+/i,
  /\b(?:NOTICE|WARNING):\s+.+/i,
] as const;

export function assertNoRawPostgresNotice(value: string): void {
  if (RAW_NOTICE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
}
