// Single source of truth for the CSV content-type allowlist shared by the
// client preview gate (src/app/(routes)/import/route-client.tsx), the
// synchronous upload service (src/app/api/import/_lib/service.ts), and the
// durable upload service (src/lib/import/durable-service.ts).
//
// Mobile browsers - particularly iOS Safari - report unreliable content
// types for .csv files:
//  - "application/vnd.ms-excel": Apple maps the .csv extension to the
//    Excel/Numbers UTI instead of text/csv.
//  - "application/octet-stream": some mobile file pickers fall back to the
//    generic binary type when they can't classify the file.
//  - a blank/omitted content type: some pickers don't report one at all.
//    Blank-type normalization is handled by each call site individually
//    (see the comments there), since the fallback value differs slightly
//    by call site (e.g. the durable service persists a normalized
//    "text/csv" declaration, while the client/sync paths just widen their
//    local allowlist to include "").
//
// The filename extension is validated separately at each call site (e.g.
// cleanCsvName / cleanFileName), so this allowlist only needs to reject
// content types that are clearly unrelated to CSV/plain text (e.g.
// application/pdf, text/html), not every browser/OS MIME-sniffing quirk.
//
// This file exists specifically to prevent the three call sites from
// drifting out of sync with each other, which previously caused mobile
// CSVs declared as "application/octet-stream" to be accepted by the client
// preview and the synchronous upload path but rejected by the durable
// upload path. Any change to the accepted MIME types must be made here so
// all three call sites stay identical.
export const CSV_MIME_TYPES = [
  "text/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/octet-stream",
] as const;
