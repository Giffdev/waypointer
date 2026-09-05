/**
 * A single monotonic integer bumped by **any** change to parsing,
 * classification, fingerprinting, or duplicate assessment.
 *
 * It is stamped on every batch as `import_batches.importer_version` and is
 * part of the batch-reuse uniqueness key, so the same bytes uploaded again
 * after an importer fix restage as a new batch instead of being deduplicated
 * away. Without it a fixed importer could never re-examine a file it had
 * already seen, which is the defect that made a collapsed leg unrecoverable
 * without database access.
 *
 * Batches created before this column existed default to `0`, which is always
 * lower than the current version, so every historical batch is offered for
 * reprocessing.
 *
 * Version 2: duplicate resolution now enriches an adopted flight with the
 * route waypoints the row supplies. Without the bump, a logbook already
 * uploaded at version 1 would be reused as-is forever and the fix could never
 * reach the flights it exists to repair.
 */
export const IMPORTER_PIPELINE_VERSION = 2 as const;

/** Batches predating `importer_version` and therefore always reprocessable. */
export const LEGACY_IMPORTER_VERSION = 0 as const;

export function isCurrentImporterVersion(version: number | undefined): boolean {
  return version === IMPORTER_PIPELINE_VERSION;
}
