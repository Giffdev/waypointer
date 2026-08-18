import { describe, expect, it } from "vitest";
import { retryDelayMs } from "@/lib/jobs/repository";
import { isDurableImportConfiguration } from "@/lib/runtime-mode";
import {
  canonicalImportObjectKey,
  createImportObjectKey,
  quarantineObjectKey,
} from "@/lib/storage/presign";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";

describe("durable import boundaries", () => {
  it("creates private owner-scoped keys and canonical hash keys", () => {
    const temporary = createImportObjectKey(USER_ID, BATCH_ID);
    expect(temporary).toMatch(
      new RegExp(`^imports/${USER_ID}/${BATCH_ID}/[0-9a-f]{64}\\.csv$`),
    );
    const hash = "a".repeat(64);
    expect(canonicalImportObjectKey(USER_ID, BATCH_ID, hash)).toBe(
      `imports/${USER_ID}/${BATCH_ID}/${hash}.csv`,
    );
    expect(quarantineObjectKey(temporary)).toBe(
      temporary.replace("imports/", "quarantine/"),
    );
  });

  it("rejects keys that do not preserve immutable ownership", () => {
    expect(() => quarantineObjectKey("imports/public/file.csv")).toThrow(
      "Invalid import object key",
    );
    expect(() =>
      canonicalImportObjectKey(USER_ID, BATCH_ID, "not-a-hash"),
    ).toThrow("canonical SHA-256");
  });

  it("uses bounded exponential backoff with jitter", () => {
    expect(retryDelayMs(1, () => 0)).toBe(3_750);
    expect(retryDelayMs(1, () => 1)).toBe(6_250);
    expect(retryDelayMs(25, () => 1)).toBe(900_000);
  });

  it("fails closed unless the complete R2 capability is configured", () => {
    const complete = {
      FLIGHT_MAP_DURABLE_IMPORTS: "true",
      FLIGHT_MAP_MVP_SYNC_IMPORTS: "false",
      IMPORT_STORAGE_BACKEND: "r2",
      IMPORT_MAX_BYTES: "10485760",
      OBJECT_STORAGE_ENDPOINT: "https://storage.invalid",
      OBJECT_STORAGE_REGION: "auto",
      OBJECT_STORAGE_BUCKET: "private-imports",
      OBJECT_STORAGE_ACCESS_KEY_ID: "configured",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "configured",
    } as NodeJS.ProcessEnv;
    expect(isDurableImportConfiguration(complete)).toBe(true);
    expect(
      isDurableImportConfiguration({
        ...complete,
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "",
      }),
    ).toBe(false);
    expect(
      isDurableImportConfiguration({
        ...complete,
        FLIGHT_MAP_DURABLE_IMPORTS: "false",
      }),
    ).toBe(false);
  });
});
