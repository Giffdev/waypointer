import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ name: string; input: Record<string, unknown> }> = [];

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        sent.push({ name: command.constructor.name, input: command.input });
        return {};
      }
    },
    PutObjectCommand: class PutObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    HeadObjectCommand: class HeadObjectCommand extends Command {},
    CopyObjectCommand: class CopyObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async () => "https://objects.invalid/signed",
}));

const user = "00000000-0000-4000-8000-000000000001";
const batch = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const sha = "a".repeat(64);
const sourceKey = `imports/${user}/${batch}/${sha}.csv`;
const destinationKey = `imports/${user}/${other}/${sha}.csv`;

async function s3Storage() {
  vi.resetModules();
  const { getPrivateObjectStorage } = await import("./index");
  return getPrivateObjectStorage();
}

/**
 * Copy and move are separate operations with separate options.
 *
 * They were briefly the same call, and the shared implementation carried
 * `ServerSideEncryption: "AES256"` — an option only the new copy path wanted.
 * `move` relocates an object that already exists in the bucket, including
 * objects written by presigned browser uploads under whatever the bucket
 * default is, so forcing an algorithm there silently rewrites the encryption
 * of objects we did not create.
 */
describe("private object storage on S3", () => {
  beforeEach(() => {
    sent.length = 0;
    vi.stubEnv("IMPORT_STORAGE_BACKEND", "s3");
    vi.stubEnv("OBJECT_STORAGE_BUCKET", "flight-map-test");
    vi.stubEnv("OBJECT_STORAGE_REGION", "auto");
    vi.stubEnv("OBJECT_STORAGE_ACCESS_KEY_ID", "test-key-id");
    vi.stubEnv("OBJECT_STORAGE_SECRET_ACCESS_KEY", "test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("moves without imposing an encryption algorithm on an existing object", async () => {
    const storage = await s3Storage();
    await storage.move(sourceKey, destinationKey);

    const [copy, remove] = sent;
    expect(copy.name).toBe("CopyObjectCommand");
    expect(copy.input).toEqual({
      Bucket: "flight-map-test",
      CopySource: `flight-map-test/${sourceKey}`,
      Key: destinationKey,
    });
    expect(copy.input).not.toHaveProperty("ServerSideEncryption");
    // And it is still a move: the source is removed afterwards.
    expect(remove.name).toBe("DeleteObjectCommand");
    expect(remove.input).toMatchObject({ Key: sourceKey });
  });

  it("copies without removing the source and without changing its encryption", async () => {
    const storage = await s3Storage();
    await storage.copy(sourceKey, destinationKey);

    expect(sent.map(({ name }) => name)).toEqual(["CopyObjectCommand"]);
    expect(sent[0].input).toEqual({
      Bucket: "flight-map-test",
      CopySource: `flight-map-test/${sourceKey}`,
      Key: destinationKey,
    });
  });

  it("still encrypts objects this service writes itself", async () => {
    // The distinction is between *creating* bytes and *relocating* them. We
    // choose the algorithm for what we write.
    const storage = await s3Storage();
    await storage.put(sourceKey, new Uint8Array([1, 2, 3]), "text/csv");

    expect(sent[0]).toMatchObject({
      name: "PutObjectCommand",
      input: { ServerSideEncryption: "AES256" },
    });
  });

  it("refuses a key outside the private import namespace", async () => {
    const storage = await s3Storage();
    await expect(storage.copy("../../etc/passwd", destinationKey)).rejects.toThrow(
      /Invalid private object key/,
    );
    await expect(storage.move(sourceKey, "imports/../secret.csv")).rejects.toThrow(
      /Invalid private object key/,
    );
    expect(sent).toEqual([]);
  });
});
