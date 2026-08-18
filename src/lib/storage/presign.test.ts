import { describe, expect, it } from "vitest";
import {
  canonicalImportObjectKey,
  createImportObjectKey,
  quarantineObjectKey,
} from "./presign";

const userId = "00000000-0000-4000-8000-000000000001";
const batchId = "00000000-0000-4000-8000-000000000002";

describe("private direct-upload object keys", () => {
  it("binds every random upload key to immutable user and batch ownership", () => {
    const key = createImportObjectKey(userId, batchId);

    expect(key).toMatch(
      new RegExp(`^imports/${userId}/${batchId}/[0-9a-f]{64}\\.csv$`),
    );
  });

  it("uses the verified content hash only after canonicalization", () => {
    expect(canonicalImportObjectKey(userId, batchId, "A".repeat(64))).toBe(
      `imports/${userId}/${batchId}/${"a".repeat(64)}.csv`,
    );
    expect(() =>
      canonicalImportObjectKey(userId, batchId, "../private.csv"),
    ).toThrow(/SHA-256/);
  });

  it("can quarantine only a valid private import key without changing ownership", () => {
    const source = `imports/${userId}/${batchId}/${"b".repeat(64)}.csv`;

    expect(quarantineObjectKey(source)).toBe(
      `quarantine/${userId}/${batchId}/${"b".repeat(64)}.csv`,
    );
    expect(() => quarantineObjectKey("../personal.csv")).toThrow(
      /Invalid import object key/,
    );
  });

  it("rejects malformed or mutable ownership identifiers", () => {
    expect(() => createImportObjectKey("user@example.test", batchId)).toThrow(
      /immutable ID/,
    );
    expect(() => createImportObjectKey(userId, "batch")).toThrow(
      /immutable ID/,
    );
  });
});
