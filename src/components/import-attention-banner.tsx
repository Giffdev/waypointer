"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import type { PendingImportAttention } from "@/lib/import/types";

/**
 * The one thing standing between "the importer set a row aside" and the user
 * never learning about it.
 *
 * Rows that need a decision — an unresolved airport, an unresolved duplicate,
 * a route token that could not be placed — are held back deliberately. Held
 * back and *unmentioned* is indistinguishable, from the map, from having
 * imported cleanly. This reads the existing `/api/import/attention` aggregate
 * so the count can never disagree with the review screen, and links straight
 * into the existing import workflow rather than restating it here.
 *
 * It renders nothing at all when there is nothing outstanding, and it never
 * blocks or delays the map: a failed or slow fetch simply leaves it absent.
 */
export function ImportAttentionBanner() {
  const [attention, setAttention] = useState<PendingImportAttention | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/import/attention", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: PendingImportAttention | null) => {
        if (data) setAttention(data);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!attention) return null;
  const outstanding =
    attention.pendingRows +
    attention.unresolvedDuplicateRows +
    attention.unresolvedRouteTokenRows;
  if (outstanding === 0) return null;

  return (
    <aside
      className="import-attention panel-surface"
      aria-label="Imports needing your attention"
    >
      <p className="import-attention-headline">
        <TriangleAlert size={15} aria-hidden="true" />
        <strong>
          {outstanding.toLocaleString()}{" "}
          {outstanding === 1 ? "imported row needs" : "imported rows need"} your
          review
        </strong>
      </p>
      <p className="import-attention-detail">
        {describeAttention(attention)} They are not on your map until you decide.
      </p>
      <Link className="import-attention-link" href="/import">
        Review imports
      </Link>
    </aside>
  );
}

function describeAttention(attention: PendingImportAttention): string {
  const parts: string[] = [];
  if (attention.pendingRows > 0) {
    parts.push(`${attention.pendingRows.toLocaleString()} awaiting a decision`);
  }
  if (attention.unresolvedDuplicateRows > 0) {
    parts.push(
      `${attention.unresolvedDuplicateRows.toLocaleString()} possible duplicates`,
    );
  }
  if (attention.unresolvedRouteTokenRows > 0) {
    parts.push(
      `${attention.unresolvedRouteTokenRows.toLocaleString()} with a route point we could not place`,
    );
  }
  return `${parts.join(", ")}.`;
}
