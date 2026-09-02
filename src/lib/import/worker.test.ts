/**
 * Regression coverage for the worker.ts MIME allowlist. worker.ts previously
 * hardcoded its own ACCEPTED_MIME_TYPES set instead of importing the shared
 * CSV_MIME_TYPES allowlist (src/lib/import/csv-mime.ts), silently rejecting
 * "application/vnd.ms-excel" uploads that the client preview and both the
 * synchronous and durable upload services already accepted. worker.ts now
 * imports CSV_MIME_TYPES directly so all four call sites stay in sync.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { InMemoryImportRepository } from "./in-memory-repository";
import { CSV_MIME_TYPES } from "./csv-mime";
import { stageFlightImport } from "./worker";

const fixture = readFileSync(
  fileURLToPath(new URL("./__fixtures__/foreflight-v1.csv", import.meta.url)),
  "utf8",
);

const airport = (code: string): Airport => ({
  code,
  name: `Synthetic ${code}`,
  city: "Test",
  country: "US",
  lat: 40,
  lon: -75,
  facility: "general-aviation",
});

function repository() {
  return new InMemoryImportRepository([
    { id: "airport-kaaa", airport: airport("KAAA"), aliases: ["KAAA"] },
    { id: "airport-kbbb", airport: airport("KBBB"), aliases: ["KBBB"] },
  ]);
}

function upload(mime: string) {
  return {
    fileName: "logbook.csv",
    mimeType: mime,
    sizeBytes: Buffer.byteLength(fixture),
    content: fixture,
  };
}

describe("stageFlightImport MIME allowlist", () => {
  it.each(CSV_MIME_TYPES)(
    "accepts every entry in the shared CSV_MIME_TYPES allowlist (%s)",
    async (mime) => {
      const store = repository();
      await expect(
        stageFlightImport(`owner-${mime}`, upload(mime), {
          imports: store,
          flights: store,
          airports: store,
        }),
      ).resolves.toMatchObject({ status: "review" });
    },
  );

  it("accepts a blank MIME type, matching the client and sync/durable services", async () => {
    const store = repository();
    await expect(
      stageFlightImport("owner-blank-mime", upload(""), {
        imports: store,
        flights: store,
        airports: store,
      }),
    ).resolves.toMatchObject({ status: "review" });
  });

  it("still rejects MIME types unrelated to CSV/plain text", async () => {
    const store = repository();
    await expect(
      stageFlightImport("owner-pdf-mime", upload("application/pdf"), {
        imports: store,
        flights: store,
        airports: store,
      }),
    ).rejects.toThrow("The upload MIME type is not supported");
  });
});
