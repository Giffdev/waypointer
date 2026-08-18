import { describe, expect, it } from "vitest";
import { assertCredentialFreeArtifact } from "./prepare-airport-production-release";

describe("production release preparation evidence", () => {
  it("accepts target, snapshot, and deployment metadata without credentials", () => {
    expect(() =>
      assertCredentialFreeArtifact(
        {
          deploymentId: "dpl_12345678",
          targetFingerprint: "a".repeat(64),
          snapshotId: "snapshot-123",
        },
        ["postgresql://owner:secret@db.example/flight_map"],
      ),
    ).not.toThrow();
  });

  it.each([
    { migrationDatabaseUrl: "postgresql://owner:secret@db.example/db" },
    { token: "secret-token" },
    { nested: { cookie: "session-value" } },
    { restoreCommand: { args: ["postgresql://owner:secret@db/db"] } },
  ])("rejects credential-bearing artifacts", (artifact) => {
    expect(() =>
      assertCredentialFreeArtifact(artifact, [
        "postgresql://owner:secret@db.example/db",
      ]),
    ).toThrow();
  });
});
