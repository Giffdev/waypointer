import { randomBytes } from "node:crypto";

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function createImportObjectKey(userId: string, batchId: string): string {
  assertUuid(userId);
  assertUuid(batchId);
  return `imports/${userId}/${batchId}/${randomBytes(32).toString("hex")}.csv`;
}

export function canonicalImportObjectKey(
  userId: string,
  batchId: string,
  sha256: string,
): string {
  assertUuid(userId);
  assertUuid(batchId);
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error("A canonical SHA-256 is required.");
  }
  return `imports/${userId}/${batchId}/${sha256.toLowerCase()}.csv`;
}

export function quarantineObjectKey(key: string): string {
  if (!new RegExp(`^imports/${UUID}/${UUID}/[0-9a-f]{64}\\.csv$`, "i").test(key)) {
    throw new Error("Invalid import object key.");
  }
  return key.replace(/^imports\//, "quarantine/");
}

function assertUuid(value: string): void {
  if (!new RegExp(`^${UUID}$`, "i").test(value)) {
    throw new Error("A valid immutable ID is required.");
  }
}
