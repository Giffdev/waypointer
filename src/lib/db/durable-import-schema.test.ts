import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../drizzle/migrations/0004_durable_import.sql", import.meta.url),
  "utf8",
);
const workerDockerfile = readFileSync(
  new URL("../../../Dockerfile.worker", import.meta.url),
  "utf8",
);
const railway = readFileSync(
  new URL("../../../railway.json", import.meta.url),
  "utf8",
);

describe("durable import deployment foundation", () => {
  it("adds exact upload metadata, quarantine, and deduplication fields", () => {
    expect(migration).toContain('"declared_content_type"');
    expect(migration).toContain('"object_etag"');
    expect(migration).toContain('"upload_expires_at"');
    expect(migration).toContain('"quarantine_object_key"');
    expect(migration).toContain('"duplicate_of_batch_id"');
    expect(migration).toContain("'deduplicated'");
  });

  it("pins Railway to the ClamAV worker image", () => {
    expect(workerDockerfile).toContain("FROM node:22-bookworm-slim");
    expect(workerDockerfile).toContain("clamav-daemon");
    expect(workerDockerfile).toContain("worker-entrypoint.sh");
    expect(railway).toContain('"dockerfilePath": "Dockerfile.worker"');
    expect(railway).toContain('"healthcheckPath": "/live"');
  });
});
