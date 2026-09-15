import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeContentAddressedJson } from "./airport-release-provenance";
import {
  createVercelPrebuiltArtifactManifest,
  writeVercelPrebuiltArtifactManifest,
} from "./vercel-prebuilt-artifact";
import {
  packVercelPrebuiltArtifact,
  preflightVercelPrebuiltArchive,
  restoreVercelPrebuiltArtifact,
  runTarCommand,
  type RunTar,
  verifyTransportedVercelPrebuiltArtifact,
} from "./vercel-prebuilt-transport";

interface TarEntry {
  readonly name: string;
  readonly type: string;
  readonly contents?: string;
  readonly linkTarget?: string;
  readonly dialect?: "gnu" | "ustar" | "v7";
  readonly ignoredPrefix?: string;
}

function tarArchive(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000755\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(
      `${contents.length.toString(8).padStart(11, "0")}\0`,
      124,
      12,
      "ascii",
    );
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, "ascii");
    header.write(entry.linkTarget ?? "", 157, 100, "utf8");
    if (entry.dialect === "ustar") {
      header.write("ustar\0", 257, 6, "ascii");
      header.write("00", 263, 2, "ascii");
    } else if (entry.dialect !== "v7") {
      header.write("ustar  \0", 257, 8, "ascii");
    }
    header.write(entry.ignoredPrefix ?? "", 345, 155, "utf8");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
      "ascii",
    );
    blocks.push(header, contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

class MockTarProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  killResult = true;
  killError: Error | undefined;

  kill(): boolean {
    this.killed = true;
    if (this.killError) {
      throw this.killError;
    }
    return this.killResult;
  }
}

describe("vercel-prebuilt-transport", () => {
  const workspaces = new Set<string>();

  async function createWorkspace(): Promise<string> {
    const root = path.join(
      process.cwd(),
      "artifacts",
      "test-workspaces",
      `vercel-transport-${randomUUID()}`,
    );
    await mkdir(root, { recursive: true });
    workspaces.add(root);
    return root;
  }

  async function writeReviewedManifest(
    root: string,
    fileCount: number,
  ): Promise<string> {
    const outputDirectory = path.join(root, ".vercel", "output");
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: fileCount }, (_, index) =>
        writeFile(
          path.join(outputDirectory, `entry-${String(index).padStart(3, "0")}`),
          `entry-${index}`,
        ),
      ),
    );
    const result = await createVercelPrebuiltArtifactManifest({
      repositoryRoot: root,
      sourceCommitSha: "a".repeat(40),
      candidateManifestSha256: "b".repeat(64),
    });
    await writeVercelPrebuiltArtifactManifest(result, {
      repositoryRoot: root,
    });
    return result.manifestSha256;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      [...workspaces].map((workspace) =>
        rm(workspace, { recursive: true, force: true }),
      ),
    );
    workspaces.clear();
  });

  it("requires the transported output to retain the exact reviewed 221-entry manifest", async () => {
    const root = await createWorkspace();
    const manifestSha256 = await writeReviewedManifest(root, 221);

    await expect(
      verifyTransportedVercelPrebuiltArtifact({
        repositoryRoot: root,
        approvedManifestSha256: manifestSha256,
      }),
    ).resolves.toMatchObject({
      manifestSha256,
      fileCount: 221,
    });

    await writeFile(
      path.join(root, ".vercel", "output", "transport-expanded-entry"),
      "unexpected",
    );
    await expect(
      verifyTransportedVercelPrebuiltArtifact({
        repositoryRoot: root,
        approvedManifestSha256: manifestSha256,
      }),
    ).rejects.toThrow(/transported prebuilt artifact does not match/i);
  });

  it("rejects a transport archive hash mismatch before extraction", async () => {
    const root = await createWorkspace();
    const manifestSha256 = await writeReviewedManifest(root, 1);
    const transportDirectory = path.join(
      root,
      "artifacts",
      "release-evidence",
      "vercel-prebuilt-transport",
    );
    await mkdir(transportDirectory, { recursive: true });
    const archivePath = path.join(
      transportDirectory,
      `bundle-${manifestSha256}.tar`,
    );
    await writeFile(archivePath, "tampered");
    await writeContentAddressedJson(
      transportDirectory,
      "transport",
      {
        schemaVersion: 1,
        archiveFormat: "gnu-tar",
        archivePath:
          `artifacts/release-evidence/vercel-prebuilt-transport/` +
          `bundle-${manifestSha256}.tar`,
        archiveSha256: createHash("sha256")
          .update("reviewed")
          .digest("hex"),
        prebuiltArtifactManifestPath:
          `artifacts/release-evidence/vercel-prebuilt-artifact/` +
          `manifest-${manifestSha256}.json`,
        prebuiltArtifactManifestSha256: manifestSha256,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        fileCount: 1,
      },
    );
    const archiveRunner = async (args: readonly string[]) => {
      if (args[0] === "--version") {
        return { stdout: "tar (GNU tar) 1.35" };
      }
      throw new Error("Archive extraction must not run");
    };

    await expect(
      restoreVercelPrebuiltArtifact({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        approvedManifestSha256: manifestSha256,
        archiveRunner,
      }),
    ).rejects.toThrow(/archive hash does not match/i);
  });

  it("rejects unsafe tar headers before invoking extraction", async () => {
    const root = await createWorkspace();
    const manifestSha256 = await writeReviewedManifest(root, 1);
    const transportDirectory = path.join(
      root,
      "artifacts",
      "release-evidence",
      "vercel-prebuilt-transport",
    );
    await mkdir(transportDirectory, { recursive: true });
    const archivePath = path.join(
      transportDirectory,
      `bundle-${manifestSha256}.tar`,
    );
    const archive = tarArchive([
      { name: ".vercel/output/", type: "5" },
      { name: ".vercel/output/../../outside", type: "0" },
    ]);
    await writeFile(archivePath, archive);
    await writeContentAddressedJson(
      transportDirectory,
      "transport",
      {
        schemaVersion: 1,
        archiveFormat: "gnu-tar",
        archivePath:
          `artifacts/release-evidence/vercel-prebuilt-transport/` +
          `bundle-${manifestSha256}.tar`,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
        prebuiltArtifactManifestPath:
          `artifacts/release-evidence/vercel-prebuilt-artifact/` +
          `manifest-${manifestSha256}.json`,
        prebuiltArtifactManifestSha256: manifestSha256,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        fileCount: 1,
      },
    );
    let extractionAttempted = false;
    const archiveRunner = async (args: readonly string[]) => {
      if (args[0] === "--version") {
        return { stdout: "tar (GNU tar) 1.35" };
      }
      extractionAttempted = true;
      return { stdout: "" };
    };

    await expect(
      restoreVercelPrebuiltArtifact({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        approvedManifestSha256: manifestSha256,
        archiveRunner,
      }),
    ).rejects.toThrow(/invalid path/i);
    expect(extractionAttempted).toBe(false);
  });

  it("rejects a V7 ignored-prefix collision before extraction", async () => {
    const root = await createWorkspace();
    const manifestSha256 = await writeReviewedManifest(root, 1);
    const transportDirectory = path.join(
      root,
      "artifacts",
      "release-evidence",
      "vercel-prebuilt-transport",
    );
    await mkdir(transportDirectory, { recursive: true });
    const archivePath = path.join(
      transportDirectory,
      `bundle-${manifestSha256}.tar`,
    );
    const archive = tarArchive([
      { name: ".vercel/output/", type: "5" },
      {
        name: ".vercel/output/file",
        type: "0",
        contents: "reviewed file",
        dialect: "v7",
        ignoredPrefix: ".vercel/output/decoy",
      },
      {
        name: ".vercel/output/file",
        type: "2",
        linkTarget: "entry-000",
      },
    ]);
    await writeFile(archivePath, archive);
    await writeContentAddressedJson(
      transportDirectory,
      "transport",
      {
        schemaVersion: 1,
        archiveFormat: "gnu-tar",
        archivePath:
          `artifacts/release-evidence/vercel-prebuilt-transport/` +
          `bundle-${manifestSha256}.tar`,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
        prebuiltArtifactManifestPath:
          `artifacts/release-evidence/vercel-prebuilt-artifact/` +
          `manifest-${manifestSha256}.json`,
        prebuiltArtifactManifestSha256: manifestSha256,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        fileCount: 1,
      },
    );
    let extractionAttempted = false;
    const archiveRunner = async (args: readonly string[]) => {
      if (args[0] === "--version") {
        return { stdout: "tar (GNU tar) 1.35" };
      }
      extractionAttempted = true;
      return { stdout: "" };
    };

    expect(() => preflightVercelPrebuiltArchive(archive)).toThrow(
      /tar dialect/i,
    );
    await expect(
      restoreVercelPrebuiltArtifact({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        approvedManifestSha256: manifestSha256,
        archiveRunner,
      }),
    ).rejects.toThrow(/tar dialect/i);
    expect(extractionAttempted).toBe(false);
  });

  it("packages with deterministic GNU tar metadata controls", async () => {
    const root = await createWorkspace();
    await writeReviewedManifest(root, 1);
    const deterministicArchive = tarArchive([
      { name: ".vercel/output/", type: "5" },
      {
        name: ".vercel/output/entry-000",
        type: "0",
        contents: "entry-0",
      },
    ]);
    let createArguments: readonly string[] = [];
    const archiveRunner = async (args: readonly string[]) => {
      if (args[0] === "--version") {
        return { stdout: "tar (GNU tar) 1.35" };
      }
      createArguments = args;
      const archivePath = args[args.indexOf("--file") + 1];
      if (!archivePath) {
        throw new Error("Archive path was not provided");
      }
      await writeFile(path.join(root, archivePath), deterministicArchive);
      return { stdout: "" };
    };

    await expect(
      packVercelPrebuiltArtifact({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        archiveRunner,
      }),
    ).resolves.toMatchObject({
      archiveSha256: createHash("sha256")
        .update(deterministicArchive)
        .digest("hex"),
      fileCount: 1,
    });
    expect(createArguments).toEqual(
      expect.arrayContaining([
        "--format=gnu",
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        ".vercel/output",
      ]),
    );
  });

  it("packs, validates, and restores locale-sensitive filenames canonically", async () => {
    const root = await createWorkspace();
    const outputDirectory = path.join(root, ".vercel", "output");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "Z-entry"), "uppercase");
    await writeFile(path.join(outputDirectory, "a-entry"), "lowercase");
    const collator = new Intl.Collator("en");
    vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      value,
    ) {
      return collator.compare(String(this), value);
    });

    const reviewed = await createVercelPrebuiltArtifactManifest({
      repositoryRoot: root,
      sourceCommitSha: "a".repeat(40),
      candidateManifestSha256: "b".repeat(64),
    });
    expect(reviewed.manifest.files.map((file) => file.path)).toEqual([
      ".vercel/output/Z-entry",
      ".vercel/output/a-entry",
    ]);
    await writeVercelPrebuiltArtifactManifest(reviewed, {
      repositoryRoot: root,
    });

    let archivedFiles = new Map<string, string>();
    const archiveRunner: RunTar = async (args) => {
      if (args[0] === "--version") {
        return { stdout: "tar (GNU tar) 1.35" };
      }
      if (args[0] === "--create") {
        const names = await readdir(outputDirectory);
        archivedFiles = new Map(
          await Promise.all(
            names.map(async (name) => [
              name,
              await readFile(path.join(outputDirectory, name), "utf8"),
            ] as const),
          ),
        );
        const archive = tarArchive([
          { name: ".vercel/output/", type: "5" },
          ...[...archivedFiles].map(([name, contents]) => ({
            name: `.vercel/output/${name}`,
            type: "0",
            contents,
          })),
        ]);
        const archiveArgument = args[args.indexOf("--file") + 1];
        if (!archiveArgument) {
          throw new Error("Archive path was not provided");
        }
        await writeFile(
          path.join(root, ...archiveArgument.split("/")),
          archive,
        );
        return { stdout: "" };
      }
      if (args[0] === "--extract") {
        const directoryArgument = args[args.indexOf("--directory") + 1];
        if (!directoryArgument) {
          throw new Error("Extraction directory was not provided");
        }
        const restoredOutput = path.join(
          root,
          ...directoryArgument.split("/"),
          ".vercel",
          "output",
        );
        await mkdir(restoredOutput, { recursive: true });
        await Promise.all(
          [...archivedFiles].map(([name, contents]) =>
            writeFile(path.join(restoredOutput, name), contents),
          ),
        );
        return { stdout: "" };
      }
      throw new Error(`Unexpected tar arguments: ${args.join(" ")}`);
    };

    const packed = await packVercelPrebuiltArtifact({
      repositoryRoot: root,
      sourceCommitSha: "a".repeat(40),
      candidateManifestSha256: "b".repeat(64),
      archiveRunner,
    });
    await rm(path.join(root, ".vercel"), {
      recursive: true,
      force: true,
    });
    const restored = await restoreVercelPrebuiltArtifact({
      repositoryRoot: root,
      sourceCommitSha: "a".repeat(40),
      candidateManifestSha256: "b".repeat(64),
      approvedManifestSha256: reviewed.manifestSha256,
      archiveRunner,
    });

    expect(restored).toMatchObject({
      archiveSha256: packed.archiveSha256,
      prebuiltArtifactManifestSha256: reviewed.manifestSha256,
      fileCount: 2,
    });
    await expect(
      verifyTransportedVercelPrebuiltArtifact({
        repositoryRoot: root,
        approvedManifestSha256: reviewed.manifestSha256,
      }),
    ).resolves.toEqual({
      manifestSha256: reviewed.manifestSha256,
      fileCount: 2,
    });
    await expect(
      readFile(path.join(outputDirectory, "Z-entry"), "utf8"),
    ).resolves.toBe("uppercase");
    await expect(
      readFile(path.join(outputDirectory, "a-entry"), "utf8"),
    ).resolves.toBe("lowercase");
  });

  it("consumes pipe data emitted after exit and settles only on close", async () => {
    const child = new MockTarProcess();
    const resultPromise = runTarCommand(
      ["--version"],
      { cwd: process.cwd(), timeoutMs: 1_000 },
      () => child,
    );

    child.emit("exit", 0, null);
    child.stdout.write("tar (GNU ");
    child.stdout.write("tar) 1.35");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toEqual({
      stdout: "tar (GNU tar) 1.35",
    });
  });

  it("fails closed when tar exceeds its output capture limit", async () => {
    const child = new MockTarProcess();
    const resultPromise = runTarCommand(
      ["--list"],
      { cwd: process.cwd(), maxOutputBytes: 4, timeoutMs: 1_000 },
      () => child,
    );

    child.stdout.write("12345");

    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    await expect(resultPromise).rejects.toThrow(/capture limit/i);
    expect(child.killed).toBe(true);
  });

  it("fails closed when tar exceeds its local timeout", async () => {
    const root = await createWorkspace();
    const stagingDirectory = path.join(root, "timeout-staging");
    const partialFile = path.join(stagingDirectory, "partial");
    await mkdir(stagingDirectory, { recursive: true });
    const child = new MockTarProcess();
    const resultPromise = runTarCommand(
      ["--list"],
      { cwd: root, timeoutMs: 5 },
      () => child,
    );
    let cleanupComplete = false;
    const caller = resultPromise.finally(async () => {
      await rm(stagingDirectory, { recursive: true, force: true });
      cleanupComplete = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(partialFile, "late timeout output");
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cleanupComplete).toBe(false);
    expect(await lstat(partialFile)).toBeDefined();
    child.emit("close", null, "SIGKILL");
    await expect(caller).rejects.toThrow(/timed out/i);
    expect(child.killed).toBe(true);
    expect(cleanupComplete).toBe(true);
    await expect(lstat(partialFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for delayed close before caller cleanup removes extraction staging", async () => {
    const root = await createWorkspace();
    const stagingDirectory = path.join(root, "staging");
    const partialFile = path.join(stagingDirectory, "partial");
    await mkdir(stagingDirectory, { recursive: true });
    const child = new MockTarProcess();
    const command = runTarCommand(
      ["--extract"],
      { cwd: root, maxOutputBytes: 4, timeoutMs: 1_000 },
      () => child,
    );
    let cleanupComplete = false;
    const caller = command.finally(async () => {
      await rm(stagingDirectory, { recursive: true, force: true });
      cleanupComplete = true;
    });

    child.stdout.write("12345");
    await writeFile(partialFile, "late process output");
    expect(cleanupComplete).toBe(false);
    expect(await lstat(partialFile)).toBeDefined();

    child.emit("close", null, "SIGKILL");
    await expect(caller).rejects.toThrow(/capture limit/i);
    expect(cleanupComplete).toBe(true);
    await expect(lstat(partialFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["returns false", false, undefined],
    ["throws", true, new Error("kill failed")],
  ])("waits for close when termination %s", async (_name, result, error) => {
    const root = await createWorkspace();
    const stagingDirectory = path.join(root, `failed-kill-${_name}`);
    const partialFile = path.join(stagingDirectory, "partial");
    await mkdir(stagingDirectory, { recursive: true });
    const child = new MockTarProcess();
    child.killResult = result;
    child.killError = error;
    const resultPromise = runTarCommand(
      ["--list"],
      { cwd: root, maxOutputBytes: 4, timeoutMs: 1_000 },
      () => child,
    );
    let cleanupComplete = false;
    const caller = resultPromise.finally(async () => {
      await rm(stagingDirectory, { recursive: true, force: true });
      cleanupComplete = true;
    });

    child.stdout.write("12345");
    await writeFile(partialFile, "late failed-kill output");
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cleanupComplete).toBe(false);
    expect(await lstat(partialFile)).toBeDefined();
    child.emit("close", 1, null);
    await expect(caller).rejects.toThrow(/capture limit/i);
    expect(cleanupComplete).toBe(true);
    await expect(lstat(partialFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles a process error only after the matching close event", async () => {
    const child = new MockTarProcess();
    const resultPromise = runTarCommand(
      ["--version"],
      { cwd: process.cwd(), timeoutMs: 1_000 },
      () => child,
    );
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    child.emit("error", new Error("spawn failed"));
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null, null);
    await expect(resultPromise).rejects.toThrow(/unable to start/i);
  });

  it("accepts only safe regular files, directories, and internal symlinks", () => {
    expect(() =>
      preflightVercelPrebuiltArchive(
        tarArchive([
          { name: ".vercel/output/", type: "5" },
          {
            name: ".vercel/output/file.txt",
            type: "0",
            contents: "contents",
          },
          {
            name: ".vercel/output/link",
            type: "2",
            linkTarget: "file.txt",
          },
        ]),
      ),
    ).not.toThrow();
  });

  it.each([
    {
      name: "an escaping symlink",
      entries: [
        { name: ".vercel/output/", type: "5" },
        {
          name: ".vercel/output/link",
          type: "2",
          linkTarget: "../../outside",
        },
      ],
      error: /symlink escapes/i,
    },
    {
      name: "a hard link",
      entries: [
        { name: ".vercel/output/", type: "5" },
        {
          name: ".vercel/output/link",
          type: "1",
          linkTarget: ".vercel/output/file",
        },
      ],
      error: /hard link/i,
    },
    {
      name: "a special node",
      entries: [
        { name: ".vercel/output/", type: "5" },
        { name: ".vercel/output/device", type: "3" },
      ],
      error: /unsupported type/i,
    },
    {
      name: "an unsupported pax member",
      entries: [
        { name: ".vercel/output/", type: "5" },
        { name: ".vercel/output/pax", type: "x", contents: "metadata" },
      ],
      error: /unsupported type/i,
    },
    {
      name: "a POSIX ustar header",
      entries: [
        { name: ".vercel/output/", type: "5" },
        {
          name: ".vercel/output/file",
          type: "0",
          dialect: "ustar",
        },
      ],
      error: /tar dialect/i,
    },
    {
      name: "a V7 header",
      entries: [
        { name: ".vercel/output/", type: "5" },
        {
          name: ".vercel/output/file",
          type: "0",
          dialect: "v7",
        },
      ],
      error: /tar dialect/i,
    },
    {
      name: "duplicate members",
      entries: [
        { name: ".vercel/output/", type: "5" },
        { name: ".vercel/output/file", type: "0" },
        { name: ".vercel/output/file", type: "0" },
      ],
      error: /duplicate members/i,
    },
    {
      name: "a dot-component alias",
      entries: [
        { name: ".vercel/output/", type: "5" },
        { name: ".vercel/output/file", type: "0" },
        { name: ".vercel/output/./file", type: "0" },
      ],
      error: /invalid path/i,
    },
    {
      name: "an empty-component alias",
      entries: [
        { name: ".vercel/output/", type: "5" },
        { name: ".vercel/output//file", type: "0" },
      ],
      error: /invalid path/i,
    },
    {
      name: "a noncanonical directory spelling",
      entries: [
        { name: ".vercel/output/", type: "5" },
        { name: ".vercel/output/directory", type: "5" },
      ],
      error: /invalid path/i,
    },
    {
      name: "a trailing-slash file alias",
      entries: [
        { name: ".vercel/output/", type: "5" },
        { name: ".vercel/output/file/", type: "0" },
      ],
      error: /invalid path/i,
    },
    {
      name: "a traversal member",
      entries: [
        { name: ".vercel/output/", type: "5" },
        { name: ".vercel/output/../../outside", type: "0" },
      ],
      error: /invalid path/i,
    },
    {
      name: "an absolute member",
      entries: [
        { name: ".vercel/output/", type: "5" },
        { name: "/.vercel/output/file", type: "0" },
      ],
      error: /invalid path/i,
    },
    {
      name: "a non-directory output root",
      entries: [{ name: ".vercel/output", type: "0" }],
      error: /real directory/i,
    },
  ])("rejects $name before extraction", ({ entries, error }) => {
    expect(() =>
      preflightVercelPrebuiltArchive(tarArchive(entries)),
    ).toThrow(error);
  });

  it.runIf(process.platform !== "win32")(
    "detects a reviewed regular file replaced by a symlink with identical bytes",
    async () => {
      const root = await createWorkspace();
      const outputDirectory = path.join(root, ".vercel", "output");
      await mkdir(outputDirectory, { recursive: true });
      const entryPath = path.join(outputDirectory, "entry");
      await writeFile(entryPath, "target");
      const reviewed = await createVercelPrebuiltArtifactManifest({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
      });
      await writeVercelPrebuiltArtifactManifest(reviewed, {
        repositoryRoot: root,
      });

      await rm(entryPath);
      await symlink("target", entryPath);

      await expect(
        verifyTransportedVercelPrebuiltArtifact({
          repositoryRoot: root,
          approvedManifestSha256: reviewed.manifestSha256,
        }),
      ).rejects.toThrow(/does not match/i);
    },
  );

  it.runIf(process.platform !== "win32")(
    "detects a reviewed symlink replaced by a regular file with identical bytes",
    async () => {
      const root = await createWorkspace();
      const outputDirectory = path.join(root, ".vercel", "output");
      await mkdir(outputDirectory, { recursive: true });
      const entryPath = path.join(outputDirectory, "entry");
      await symlink("target", entryPath);
      const reviewed = await createVercelPrebuiltArtifactManifest({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
      });
      await writeVercelPrebuiltArtifactManifest(reviewed, {
        repositoryRoot: root,
      });

      await rm(entryPath);
      await writeFile(entryPath, "target");

      await expect(
        verifyTransportedVercelPrebuiltArtifact({
          repositoryRoot: root,
          approvedManifestSha256: reviewed.manifestSha256,
        }),
      ).rejects.toThrow(/does not match/i);
    },
  );

  it.runIf(process.platform !== "win32")(
    "round trips a 221-entry symlink-sensitive bundle without expansion",
    async () => {
      const root = await createWorkspace();
      const outputDirectory = path.join(root, ".vercel", "output");
      const functionDirectory = path.join(outputDirectory, "functions");
      await mkdir(functionDirectory, { recursive: true });
      await Promise.all(
        Array.from({ length: 220 }, (_, index) =>
          writeFile(
            path.join(
              functionDirectory,
              `entry-${String(index).padStart(3, "0")}`,
            ),
            `entry-${index}`,
          ),
        ),
      );
      await symlink(
        "functions",
        path.join(outputDirectory, "z-api.func"),
        "dir",
      );
      const reviewed = await createVercelPrebuiltArtifactManifest({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
      });
      expect(reviewed.manifest.fileCount).toBe(221);
      await writeVercelPrebuiltArtifactManifest(reviewed, {
        repositoryRoot: root,
      });
      const packed = await packVercelPrebuiltArtifact({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
      });
      const repacked = await packVercelPrebuiltArtifact({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
      });
      expect(repacked.archiveSha256).toBe(packed.archiveSha256);
      expect(repacked.transportManifestSha256).toBe(
        packed.transportManifestSha256,
      );
      await rm(path.join(root, ".vercel"), {
        recursive: true,
        force: true,
      });
      const restored = await restoreVercelPrebuiltArtifact({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        approvedManifestSha256: reviewed.manifestSha256,
      });

      expect(restored).toMatchObject({
        prebuiltArtifactManifestSha256: reviewed.manifestSha256,
        fileCount: 221,
        archiveSha256: packed.archiveSha256,
      });
      expect(
        (
          await lstat(path.join(root, ".vercel", "output", "z-api.func"))
        ).isSymbolicLink(),
      ).toBe(true);
    },
  );

  it.runIf(process.env.FLIGHT_MAP_RUN_GNU_TAR_TESTS === "true")(
    "round trips a regular-file bundle with the installed GNU tar",
    async () => {
      const root = await createWorkspace();
      const outputDirectory = path.join(root, ".vercel", "output");
      await mkdir(path.join(outputDirectory, "functions"), {
        recursive: true,
      });
      await writeFile(path.join(outputDirectory, "config.json"), "{}");
      await writeFile(
        path.join(outputDirectory, "functions", "index.func"),
        "function",
      );
      const longName = `${"long-".repeat(22)}entry.func`;
      await writeFile(path.join(outputDirectory, longName), "long-name");
      const reviewed = await createVercelPrebuiltArtifactManifest({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
      });
      await writeVercelPrebuiltArtifactManifest(reviewed, {
        repositoryRoot: root,
      });

      const packed = await packVercelPrebuiltArtifact({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
      });
      await rm(path.join(root, ".vercel"), {
        recursive: true,
        force: true,
      });
      const restored = await restoreVercelPrebuiltArtifact({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        approvedManifestSha256: reviewed.manifestSha256,
      });

      expect(restored).toMatchObject({
        archiveSha256: packed.archiveSha256,
        prebuiltArtifactManifestSha256: reviewed.manifestSha256,
        fileCount: 3,
      });
      await expect(
        readFile(
          path.join(outputDirectory, "functions", "index.func"),
          "utf8",
        ),
      ).resolves.toBe("function");
      await expect(
        readFile(path.join(outputDirectory, longName), "utf8"),
      ).resolves.toBe("long-name");
    },
  );
});
