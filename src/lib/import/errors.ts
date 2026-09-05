/**
 * Typed import invariants.
 *
 * Before this module every service- and repository-layer invariant threw a
 * bare `Error`, and the API catch-all mapped anything it did not recognise to
 * **503**. A 503 tells a client "retry later", which is wrong for a violated
 * invariant and hides real bugs behind a retry loop. The conditions a caller
 * can act on now carry a stable code that maps 1:1 to a 4xx status.
 *
 * Every code here has a live throw site. Conditions that are *our* defect —
 * a committed flight referencing a missing airport, a flight that cannot be
 * resolved after its own insert — deliberately stay untyped so they surface as
 * 500 with a correlation id. Giving those a 4xx would tell the user to fix
 * something only we can fix.
 */

export type ImportInvariantCode =
  | "batch-not-found"
  | "row-not-found"
  | "batch-not-committable"
  | "duplicate-resolution-required"
  | "row-not-commit-ready"
  | "duplicate-target-unavailable"
  | "duplicate-order-violation"
  | "route-stop-unresolved"
  | "route-stop-invalid";

const STATUS_BY_CODE: Record<ImportInvariantCode, number> = {
  "batch-not-found": 404,
  "row-not-found": 404,
  "batch-not-committable": 409,
  "duplicate-resolution-required": 409,
  "row-not-commit-ready": 409,
  "duplicate-target-unavailable": 409,
  "duplicate-order-violation": 409,
  // 422, not 409: the row's *content* cannot be processed. A conflict implies
  // retrying against different state would help; resolving the airport is the
  // only thing that will.
  "route-stop-unresolved": 422,
  "route-stop-invalid": 422,
};

/**
 * Thrown by the import service and repository layers. Never thrown for an
 * infrastructure failure — those stay untyped so they surface as 500 with a
 * correlation id instead of masquerading as a client error.
 */
export class ImportInvariantError extends Error {
  readonly code: ImportInvariantCode;
  readonly status: number;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: ImportInvariantCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ImportInvariantError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.detail = detail;
  }
}

export function importInvariantStatus(code: ImportInvariantCode): number {
  return STATUS_BY_CODE[code];
}

export function isImportInvariantError(
  error: unknown,
): error is ImportInvariantError {
  return error instanceof ImportInvariantError;
}
