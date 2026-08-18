import type { OwnerImportBatchDetail } from "./types";

export function redactOwnerImportBatchDetail(
  detail: OwnerImportBatchDetail,
): OwnerImportBatchDetail {
  return {
    ...detail,
    rows: {
      ...detail.rows,
      rows: detail.rows.rows.map((row) => ({
        ...row,
        rawSnapshot: null,
      })),
    },
  };
}
