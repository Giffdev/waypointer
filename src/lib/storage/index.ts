import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  isHostedPreviewConfiguration,
  isMvpProductionConfiguration,
} from "@/lib/runtime-mode";

export type StoredObject = {
  key: string;
  bytes: Uint8Array;
};

export type StoredObjectHead = {
  key: string;
  sizeBytes: number;
  contentType: string;
  etag?: string;
};

export type PresignedPut = {
  url: string;
  expiresAt: Date;
  headers: Record<string, string>;
};

export interface PrivateObjectStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
  head(key: string): Promise<StoredObjectHead | null>;
  presignPut(
    key: string,
    sizeBytes: number,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<PresignedPut>;
  move(sourceKey: string, destinationKey: string): Promise<void>;
  /**
   * Duplicate an object, leaving the source in place.
   *
   * Distinct from `move` because reprocessing must not reassign the original
   * batch's only object to a new batch: retention cleanup for either batch
   * deletes by key, so a shared key means the first cleanup silently destroys
   * the other batch's source file and a second reprocess has nothing to read.
   */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function validateKey(key: string): string {
  if (
    !/^(imports|quarantine)\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f]{64}\.csv$/i.test(key)
  ) {
    throw new Error("Invalid private object key.");
  }
  return key;
}

class LocalPrivateObjectStorage implements PrivateObjectStorage {
  constructor(private readonly root: string) {}

  private filePath(key: string): string {
    const segments = validateKey(key).split("/");
    return path.join(this.root, ...segments);
  }

  async put(
    key: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const target = this.filePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }

  async get(key: string): Promise<StoredObject> {
    return { key, bytes: await readFile(this.filePath(key)) };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    try {
      const details = await stat(this.filePath(key));
      return {
        key,
        sizeBytes: details.size,
        contentType: "text/csv",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async presignPut(): Promise<PresignedPut> {
    throw new Error("Direct uploads require private R2 storage.");
  }

  async move(sourceKey: string, destinationKey: string): Promise<void> {
    const source = this.filePath(sourceKey);
    const destination = this.filePath(destinationKey);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const source = this.filePath(sourceKey);
    const destination = this.filePath(destinationKey);
    await mkdir(path.dirname(destination), { recursive: true });
    // `wx` matches `put`: an existing destination is a caller bug, not
    // something to overwrite silently.
    await writeFile(destination, await readFile(source), {
      flag: "wx",
      mode: 0o600,
    });
  }

  async delete(key: string): Promise<void> {
    await rm(this.filePath(key), { force: true });
  }
}

class S3PrivateObjectStorage implements PrivateObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: {
      endpoint?: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
  ) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: validateKey(key),
        Body: bytes,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async get(key: string): Promise<StoredObject> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: validateKey(key) }),
    );
    if (!result.Body) throw new Error("Stored import object is empty.");
    return { key, bytes: await result.Body.transformToByteArray() };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: validateKey(key) }),
      );
      return {
        key,
        sizeBytes: result.ContentLength ?? -1,
        contentType: result.ContentType ?? "",
        etag: result.ETag?.replace(/^"|"$/g, ""),
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    }
  }

  async presignPut(
    key: string,
    sizeBytes: number,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<PresignedPut> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: validateKey(key),
      ContentLength: sizeBytes,
      ContentType: contentType,
    });
    return {
      url: await getSignedUrl(this.client, command, {
        expiresIn: expiresInSeconds,
      }),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      headers: { "content-type": contentType },
    };
  }

  async move(sourceKey: string, destinationKey: string): Promise<void> {
    await this.copy(sourceKey, destinationKey);
    await this.delete(validateKey(sourceKey));
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const source = validateKey(sourceKey);
    const destination = validateKey(destinationKey);
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${source}`,
        Key: destination,
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: validateKey(key),
      }),
    );
  }
}

class SynchronousEphemeralObjectStorage implements PrivateObjectStorage {
  async put(key: string): Promise<void> {
    validateKey(key);
  }

  async get(): Promise<StoredObject> {
    throw new Error("Synchronous import originals are not retained.");
  }

  async head(): Promise<StoredObjectHead | null> {
    return null;
  }

  async presignPut(): Promise<PresignedPut> {
    throw new Error("Direct uploads are unavailable in synchronous import mode.");
  }

  async move(): Promise<void> {
    throw new Error("Synchronous import originals are not retained.");
  }

  async copy(): Promise<void> {
    throw new Error("Synchronous import originals are not retained.");
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
  }
}

let storage: PrivateObjectStorage | undefined;

export function getPrivateObjectStorage(): PrivateObjectStorage {
  if (storage) return storage;
  const backend = process.env.IMPORT_STORAGE_BACKEND?.trim().toLowerCase();

  if (backend === "local") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Local import storage is forbidden in production.");
    }
    const root =
      process.env.IMPORT_LOCAL_STORAGE_DIR?.trim() ||
      path.join(process.cwd(), "data", "private", "uploads");
    storage = new LocalPrivateObjectStorage(root);
    return storage;
  }

  if (backend === "sync-preview" || backend === "sync-mvp") {
    if (
      (backend === "sync-preview" && !isHostedPreviewConfiguration()) ||
      (backend === "sync-mvp" && !isMvpProductionConfiguration())
    ) {
      throw new Error(
        "Synchronous import storage requires its bounded runtime configuration.",
      );
    }
    storage = new SynchronousEphemeralObjectStorage();
    return storage;
  }

  if (backend === "s3" || backend === "r2") {
    const required = {
      bucket: process.env.OBJECT_STORAGE_BUCKET?.trim(),
      region: process.env.OBJECT_STORAGE_REGION?.trim(),
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim(),
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim(),
    };
    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `Missing S3 import storage configuration: ${missing.join(", ")}.`,
      );
    }
    storage = new S3PrivateObjectStorage(required.bucket!, {
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT?.trim(),
      region: required.region!,
      accessKeyId: required.accessKeyId!,
      secretAccessKey: required.secretAccessKey!,
    });
    return storage;
  }

  throw new Error(
    "IMPORT_STORAGE_BACKEND must explicitly be set to local, sync-mvp, sync-preview, s3, or r2.",
  );
}
