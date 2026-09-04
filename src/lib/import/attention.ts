import type { ImportBatchSummary, ImportIssue, PendingImportAttention } from "./types";

export const IMPORT_ATTENTION_HREF = "/import";

/**
 * Route-token warnings that count as outstanding work.
 *
 * Centralized so the two repository implementations cannot drift: a code that
 * raises a warning but is missing from this set is a row the user is told
 * about on the review screen and *not* told about in the badge, which is the
 * exact "nothing to do" lie the attention aggregate exists to prevent.
 */
export const UNRESOLVED_ROUTE_TOKEN_ISSUE_CODES: ReadonlySet<
  ImportIssue["code"]
> = new Set([
  "route-token-unmatched",
  "route-token-ambiguous",
  "route-token-navaid-collision",
]);

export function hasUnresolvedRouteToken(issues: readonly ImportIssue[]): boolean {
  return issues.some((issue) =>
    UNRESOLVED_ROUTE_TOKEN_ISSUE_CODES.has(issue.code),
  );
}

/**
 * The one place that decides what "an import needs you" means.
 *
 * Every surface that shows an import badge reads this, so the map, the flights
 * list, and the import page can never disagree about whether there is
 * outstanding work. It is derived from batch summaries rather than a bespoke
 * query so a count can never drift from what the review screen actually shows.
 *
 * This exists because the alternative — deciding per-surface — is how
 * unresolved rows end up invisible: a user is redirected away from a batch
 * that still had duplicates to resolve, and nothing anywhere says so.
 */
export function summarizePendingImportAttention(
  batches: readonly ImportBatchSummary[],
): PendingImportAttention {
  const reviewable = batches.filter((batch) => batch.status === "review");
  const sum = (
    source: readonly ImportBatchSummary[],
    pick: (batch: ImportBatchSummary) => number,
  ): number => source.reduce((total, batch) => total + pick(batch), 0);

  return {
    reviewBatches: reviewable.length,
    pendingRows: sum(reviewable, (batch) => batch.counts.pendingRows),
    unresolvedDuplicateRows: sum(
      reviewable,
      (batch) => batch.counts.unresolvedDuplicateRows,
    ),
    unresolvedRouteTokenRows: sum(
      reviewable,
      (batch) => batch.counts.unresolvedRouteTokenRows,
    ),
    adoptedFlightRows: sum(
      reviewable,
      (batch) => batch.counts.adoptedFlightRows,
    ),
    reprocessAvailableBatches: batches.filter(
      (batch) => batch.reprocessAvailable === true,
    ).length,
    href: IMPORT_ATTENTION_HREF,
  };
}
