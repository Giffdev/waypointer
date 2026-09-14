import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import {
  createVercelPrebuiltArtifactManifest,
  loadVercelPrebuiltArtifactManifest,
} from "./vercel-prebuilt-artifact.ts";

const root = path.resolve(import.meta.dirname, "..");
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREBUILT_EVIDENCE_DIRECTORY = path.join(
  "artifacts",
  "release-evidence",
  "vercel-prebuilt-artifact",
);
const TRANSPORT_EVIDENCE_DIRECTORY = path.join(
  "artifacts",
  "release-evidence",
  "vercel-prebuilt-transport",
);
const TAR_TIMEOUT_MS = 30_000;
const TAR_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const GNU_TAR_MAGIC = Buffer.from("ustar  \0", "ascii");

interface VercelPrebuiltTransportManifest {
  readonly schemaVersion: 1;
  readonly archiveFormat: "gnu-tar";
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly prebuiltArtifactManifestPath: string;
  readonly prebuiltArtifactManifestSha256: string;
  readonly sourceCommitSha: string;
  readonly candidateManifestSha256: string;
  readonly fileCount: number;
}

export interface VercelPrebuiltTransportResult {
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly transportManifestPath: string;
  readonly transportManifestSha256: string;
  readonly prebuiltArtifactManifestSha256: string;
  readonly fileCount: number;
}

interface TarResult {
  readonly stdout: string;
}

interface TarChildProcess {
  readonly stdout: {
    setEncoding(encoding: BufferEncoding): void;
    on(event: "data", listener: (chunk: string) => void): void;
  };
  readonly stderr: {
    setEncoding(encoding: BufferEncoding): void;
    on(event: "data", listener: (chunk: string) => void): void;
  };
  once(
    event: "error",
    listener: (error: Error) => void,
  ): TarChildProcess;
  once(
    event: "close",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): TarChildProcess;
  kill(signal?: NodeJS.Signals | number): boolean;
}

type SpawnTar = (
  command: string,
  args: string[],
  options: {
    readonly cwd: string;
    readonly windowsHide: true;
    readonly stdio: readonly ["ignore", "pipe", "pipe"];
  },
) => TarChildProcess;

export type RunTar = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  },
) => Promise<TarResult>;

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
): string {
  const value = environment[name]?.trim() ?? "";
  if (!pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

export async function runTarCommand(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  },
  spawnTar: SpawnTar = spawn as unknown as SpawnTar,
): Promise<TarResult> {
  return new Promise((resolve, reject) => {
    const child = spawnTar("tar", [...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminalError: Error | undefined;
    const outputLimit = options.maxOutputBytes ?? TAR_OUTPUT_LIMIT_BYTES;
    const timeoutMs = options.timeoutMs ?? TAR_TIMEOUT_MS;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const failAndRequestTermination = (error: Error) => {
      if (terminalError || settled) {
        return;
      }
      terminalError = error;
      try {
        child.kill("SIGKILL");
      } catch {
        // The close event remains the only proof that cleanup is safe.
      }
    };
    const timeout = setTimeout(() => {
      failAndRequestTermination(new Error("GNU tar command timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > outputLimit) {
        failAndRequestTermination(
          new Error("GNU tar stdout exceeded the capture limit"),
        );
        return;
      }
      if (!terminalError) {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > outputLimit) {
        failAndRequestTermination(
          new Error("GNU tar stderr exceeded the capture limit"),
        );
        return;
      }
      if (!terminalError) {
        stderr += chunk;
      }
    });
    child.once("error", () => {
      terminalError ??= new Error("Unable to start GNU tar");
    });
    child.once("close", (code, signal) => {
      if (terminalError) {
        settle(() => reject(terminalError));
        return;
      }
      if (code !== 0) {
        settle(() =>
          reject(
          new Error(
            `GNU tar command failed${
              stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""
            }${signal ? ` (signal ${signal})` : ""}`,
          ),
          ),
        );
        return;
      }
      settle(() => resolve({ stdout }));
    });
  });
}

const runTar: RunTar = runTarCommand;

async function requireGnuTar(
  archiveRunner: RunTar,
  repositoryRoot: string,
): Promise<void> {
  const version = await archiveRunner(["--version"], {
    cwd: repositoryRoot,
  });
  if (!version.stdout.includes("GNU tar")) {
    throw new Error("GNU tar is required for deterministic prebuilt transport");
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return hash.digest("hex");
}

function relativeRepositoryPath(
  repositoryRoot: string,
  filePath: string,
): string {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

async function findSingleEvidenceFile(
  directory: string,
  pattern: RegExp,
  description: string,
): Promise<string> {
  const matches = (await readdir(directory))
    .filter((entry) => pattern.test(entry))
    .sort();
  if (matches.length !== 1) {
    throw new Error(`${description} is not uniquely available`);
  }
  return path.join(directory, matches[0]!);
}

async function loadTransportManifest(
  repositoryRoot: string,
): Promise<{
  readonly manifest: VercelPrebuiltTransportManifest;
  readonly manifestPath: string;
  readonly manifestSha256: string;
}> {
  const directory = path.join(
    repositoryRoot,
    TRANSPORT_EVIDENCE_DIRECTORY,
  );
  const manifestPath = await findSingleEvidenceFile(
    directory,
    /^transport-([a-f0-9]{64})\.json$/u,
    "Prebuilt transport manifest",
  );
  const match = /^transport-([a-f0-9]{64})\.json$/u.exec(
    path.basename(manifestPath),
  );
  const bytes = await readFile(manifestPath);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (match?.[1] !== manifestSha256) {
    throw new Error("Prebuilt transport manifest is not content-addressed");
  }
  return {
    manifest: JSON.parse(
      bytes.toString("utf8"),
    ) as VercelPrebuiltTransportManifest,
    manifestPath,
    manifestSha256,
  };
}

function tarString(field: Buffer): string {
  const nullIndex = field.indexOf(0);
  return field
    .subarray(0, nullIndex === -1 ? field.length : nullIndex)
    .toString("utf8");
}

function tarNumber(field: Buffer): number {
  if ((field[0]! & 0x80) !== 0) {
    throw new Error("Prebuilt transport archive uses unsupported numeric fields");
  }
  const value = tarString(field).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error("Prebuilt transport archive has an invalid numeric field");
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Prebuilt transport archive has an invalid numeric field");
  }
  return parsed;
}

function validateGnuTarHeader(header: Buffer): void {
  if (!header.subarray(257, 265).equals(GNU_TAR_MAGIC)) {
    throw new Error(
      "Prebuilt transport archive uses an unsupported tar dialect",
    );
  }
}

function validateArchivePath(memberPath: string, type: string): string {
  const hasDirectorySuffix = memberPath.endsWith("/");
  const normalized = hasDirectorySuffix
    ? memberPath.slice(0, -1)
    : memberPath;
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.includes("\\") ||
    path.posix.isAbsolute(normalized) ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    path.posix.normalize(normalized) !== normalized ||
    memberPath !== (type === "5" ? `${normalized}/` : normalized) ||
    (normalized !== ".vercel/output" &&
      !normalized.startsWith(".vercel/output/"))
  ) {
    throw new Error("Prebuilt transport archive contains an invalid path");
  }
  return normalized;
}

function validateSymlinkTarget(
  memberPath: string,
  linkTarget: string,
): void {
  if (
    !linkTarget ||
    linkTarget.includes("\\") ||
    path.posix.isAbsolute(linkTarget)
  ) {
    throw new Error("Prebuilt transport archive contains an invalid symlink");
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(memberPath), linkTarget),
  );
  if (
    resolved !== ".vercel/output" &&
    !resolved.startsWith(".vercel/output/")
  ) {
    throw new Error("Prebuilt transport archive symlink escapes output");
  }
}

export function preflightVercelPrebuiltArchive(archive: Buffer): void {
  const names = new Set<string>();
  let offset = 0;
  let terminated = false;
  let longName: string | undefined;
  let longLink: string | undefined;
  let rootType: string | undefined;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      terminated = true;
      if (archive.subarray(offset).some((byte) => byte !== 0)) {
        throw new Error("Prebuilt transport archive has trailing data");
      }
      break;
    }
    const expectedChecksum = tarNumber(header.subarray(148, 156));
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce(
      (sum, byte) => sum + byte,
      0,
    );
    const size = tarNumber(header.subarray(124, 136));
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;
    if (expectedChecksum !== actualChecksum || nextOffset > archive.length) {
      throw new Error("Prebuilt transport archive has an invalid header");
    }
    validateGnuTarHeader(header);
    const type = String.fromCharCode(header[156]!);
    const data = archive.subarray(dataOffset, dataOffset + size);
    if (type === "L" || type === "K") {
      if (
        size === 0 ||
        (type === "L" ? longName !== undefined : longLink !== undefined)
      ) {
        throw new Error("Prebuilt transport archive has invalid GNU metadata");
      }
      const value = tarString(data);
      if (!value) {
        throw new Error("Prebuilt transport archive has invalid GNU metadata");
      }
      if (type === "L") {
        longName = value;
      } else {
        longLink = value;
      }
      offset = nextOffset;
      continue;
    }
    const name = longName ?? tarString(header.subarray(0, 100));
    const linkTarget = longLink ?? tarString(header.subarray(157, 257));
    longName = undefined;
    longLink = undefined;
    const normalizedName = validateArchivePath(name, type);
    if (names.has(normalizedName)) {
      throw new Error("Prebuilt transport archive contains duplicate members");
    }
    names.add(normalizedName);

    if (type === "0" || type === "\0") {
      if (linkTarget) {
        throw new Error("Prebuilt transport archive file has a link target");
      }
    } else if (type === "5") {
      if (size !== 0 || linkTarget) {
        throw new Error("Prebuilt transport archive directory is invalid");
      }
    } else if (type === "2") {
      if (size !== 0) {
        throw new Error("Prebuilt transport archive symlink is invalid");
      }
      validateSymlinkTarget(normalizedName, linkTarget);
    } else if (type === "1") {
      throw new Error("Prebuilt transport archive contains a hard link");
    } else {
      throw new Error("Prebuilt transport archive contains an unsupported type");
    }
    if (normalizedName === ".vercel/output") {
      rootType = type;
    }
    offset = nextOffset;
  }
  if (
    !terminated ||
    longName !== undefined ||
    longLink !== undefined ||
    names.size === 0 ||
    rootType !== "5"
  ) {
    throw new Error(
      "Prebuilt transport archive output root is not a real directory",
    );
  }
}

export async function verifyTransportedVercelPrebuiltArtifact(options: {
  readonly repositoryRoot?: string;
  readonly approvedManifestSha256: string;
}): Promise<{
  readonly manifestSha256: string;
  readonly fileCount: number;
}> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? root);
  if (!SHA256_PATTERN.test(options.approvedManifestSha256)) {
    throw new Error("Approved prebuilt artifact manifest SHA-256 is invalid");
  }
  const manifestPath = path.join(
    repositoryRoot,
    PREBUILT_EVIDENCE_DIRECTORY,
    `manifest-${options.approvedManifestSha256}.json`,
  );
  const reviewed = await loadVercelPrebuiltArtifactManifest(
    manifestPath,
    options.approvedManifestSha256,
  );
  const transported = await createVercelPrebuiltArtifactManifest({
    repositoryRoot,
    sourceCommitSha: reviewed.manifest.sourceCommitSha,
    candidateManifestSha256:
      reviewed.manifest.candidateManifestSha256,
  });
  if (
    transported.manifestSha256 !== options.approvedManifestSha256
  ) {
    throw new Error(
      "Transported prebuilt artifact does not match the reviewed manifest",
    );
  }
  return {
    manifestSha256: transported.manifestSha256,
    fileCount: transported.manifest.fileCount,
  };
}

export function vercelPrebuiltTransportPaths(
  approvedManifestSha256: string,
): {
  readonly prebuiltManifestPath: string;
  readonly archivePath: string;
} {
  if (!SHA256_PATTERN.test(approvedManifestSha256)) {
    throw new Error("Approved prebuilt artifact manifest SHA-256 is invalid");
  }
  return {
    prebuiltManifestPath:
      `${PREBUILT_EVIDENCE_DIRECTORY.replaceAll("\\", "/")}/` +
      `manifest-${approvedManifestSha256}.json`,
    archivePath:
      `${TRANSPORT_EVIDENCE_DIRECTORY.replaceAll("\\", "/")}/` +
      `bundle-${approvedManifestSha256}.tar`,
  };
}

export async function packVercelPrebuiltArtifact(options: {
  readonly repositoryRoot?: string;
  readonly sourceCommitSha: string;
  readonly candidateManifestSha256: string;
  readonly archiveRunner?: RunTar;
}): Promise<VercelPrebuiltTransportResult> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? root);
  if (!SHA_PATTERN.test(options.sourceCommitSha)) {
    throw new Error("Source commit SHA is invalid");
  }
  if (!SHA256_PATTERN.test(options.candidateManifestSha256)) {
    throw new Error("Candidate manifest SHA-256 is invalid");
  }
  const archiveRunner = options.archiveRunner ?? runTar;
  await requireGnuTar(archiveRunner, repositoryRoot);
  const prebuiltDirectory = path.join(
    repositoryRoot,
    PREBUILT_EVIDENCE_DIRECTORY,
  );
  const prebuiltManifestPath = await findSingleEvidenceFile(
    prebuiltDirectory,
    /^manifest-([a-f0-9]{64})\.json$/u,
    "Prebuilt artifact manifest",
  );
  const prebuiltManifestSha256 =
    /^manifest-([a-f0-9]{64})\.json$/u.exec(
      path.basename(prebuiltManifestPath),
    )?.[1] ?? "";
  const prebuilt = await loadVercelPrebuiltArtifactManifest(
    prebuiltManifestPath,
    prebuiltManifestSha256,
  );
  if (
    prebuilt.manifest.sourceCommitSha !== options.sourceCommitSha ||
    prebuilt.manifest.candidateManifestSha256 !==
      options.candidateManifestSha256
  ) {
    throw new Error("Prebuilt artifact provenance does not match transport");
  }

  const transportDirectory = path.join(
    repositoryRoot,
    TRANSPORT_EVIDENCE_DIRECTORY,
  );
  await mkdir(transportDirectory, { recursive: true });
  const archivePath = path.join(
    transportDirectory,
    `bundle-${prebuilt.manifestSha256}.tar`,
  );
  const partialArchivePath = `${archivePath}.partial`;
  await rm(partialArchivePath, { force: true });
  try {
    await archiveRunner(
      [
        "--create",
        "--file",
        relativeRepositoryPath(repositoryRoot, partialArchivePath),
        "--format=gnu",
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--directory",
        repositoryRoot,
        ".vercel/output",
      ],
      { cwd: repositoryRoot },
    );
    await rm(archivePath, { force: true });
    await rename(partialArchivePath, archivePath);
    preflightVercelPrebuiltArchive(await readFile(archivePath));
  } finally {
    await rm(partialArchivePath, { force: true });
  }
  const archiveSha256 = await sha256File(archivePath);
  const transportManifest: VercelPrebuiltTransportManifest = {
    schemaVersion: 1,
    archiveFormat: "gnu-tar",
    archivePath: relativeRepositoryPath(repositoryRoot, archivePath),
    archiveSha256,
    prebuiltArtifactManifestPath: relativeRepositoryPath(
      repositoryRoot,
      prebuiltManifestPath,
    ),
    prebuiltArtifactManifestSha256: prebuilt.manifestSha256,
    sourceCommitSha: options.sourceCommitSha,
    candidateManifestSha256: options.candidateManifestSha256,
    fileCount: prebuilt.manifest.fileCount,
  };
  const transportArtifact = await writeContentAddressedJson(
    transportDirectory,
    "transport",
    transportManifest,
  );
  return {
    archivePath: transportManifest.archivePath,
    archiveSha256,
    transportManifestPath: relativeRepositoryPath(
      repositoryRoot,
      transportArtifact.path,
    ),
    transportManifestSha256: transportArtifact.sha256,
    prebuiltArtifactManifestSha256: prebuilt.manifestSha256,
    fileCount: prebuilt.manifest.fileCount,
  };
}

export async function restoreVercelPrebuiltArtifact(options: {
  readonly repositoryRoot?: string;
  readonly sourceCommitSha: string;
  readonly candidateManifestSha256: string;
  readonly approvedManifestSha256: string;
  readonly archiveRunner?: RunTar;
}): Promise<VercelPrebuiltTransportResult> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? root);
  if (!SHA_PATTERN.test(options.sourceCommitSha)) {
    throw new Error("Source commit SHA is invalid");
  }
  if (
    !SHA256_PATTERN.test(options.candidateManifestSha256) ||
    !SHA256_PATTERN.test(options.approvedManifestSha256)
  ) {
    throw new Error("Approved prebuilt transport provenance is invalid");
  }
  const archiveRunner = options.archiveRunner ?? runTar;
  await requireGnuTar(archiveRunner, repositoryRoot);
  const transport = await loadTransportManifest(repositoryRoot);
  const {
    prebuiltManifestPath: expectedPrebuiltManifestPath,
    archivePath: expectedArchivePath,
  } = vercelPrebuiltTransportPaths(options.approvedManifestSha256);
  if (
    transport.manifest.schemaVersion !== 1 ||
    transport.manifest.archiveFormat !== "gnu-tar" ||
    transport.manifest.archivePath !== expectedArchivePath ||
    transport.manifest.prebuiltArtifactManifestPath !==
      expectedPrebuiltManifestPath ||
    transport.manifest.prebuiltArtifactManifestSha256 !==
      options.approvedManifestSha256 ||
    transport.manifest.sourceCommitSha !== options.sourceCommitSha ||
    transport.manifest.candidateManifestSha256 !==
      options.candidateManifestSha256 ||
    !Number.isSafeInteger(transport.manifest.fileCount) ||
    transport.manifest.fileCount <= 0 ||
    !SHA256_PATTERN.test(transport.manifest.archiveSha256)
  ) {
    throw new Error("Prebuilt transport manifest provenance is invalid");
  }
  const reviewed = await loadVercelPrebuiltArtifactManifest(
    path.join(
      repositoryRoot,
      ...expectedPrebuiltManifestPath.split("/"),
    ),
    options.approvedManifestSha256,
  );
  if (
    reviewed.manifest.sourceCommitSha !== options.sourceCommitSha ||
    reviewed.manifest.candidateManifestSha256 !==
      options.candidateManifestSha256 ||
    reviewed.manifest.fileCount !== transport.manifest.fileCount
  ) {
    throw new Error("Reviewed prebuilt manifest provenance is invalid");
  }
  const archivePath = path.join(
    repositoryRoot,
    ...transport.manifest.archivePath.split("/"),
  );
  const archiveSha256 = await sha256File(archivePath);
  if (archiveSha256 !== transport.manifest.archiveSha256) {
    throw new Error("Prebuilt transport archive hash does not match");
  }
  preflightVercelPrebuiltArchive(await readFile(archivePath));

  const vercelDirectory = path.join(repositoryRoot, ".vercel");
  const outputDirectory = path.join(vercelDirectory, "output");
  const stagingDirectory = path.join(
    vercelDirectory,
    `transport-${transport.manifestSha256}`,
  );
  await rm(stagingDirectory, { recursive: true, force: true });
  try {
    await lstat(outputDirectory);
    throw new Error("Prebuilt output already exists before transport restore");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(stagingDirectory, { recursive: true });
  try {
    await archiveRunner(
      [
        "--extract",
        "--file",
        transport.manifest.archivePath,
        "--directory",
        relativeRepositoryPath(repositoryRoot, stagingDirectory),
        "--no-same-owner",
        "--no-same-permissions",
      ],
      { cwd: repositoryRoot },
    );
    const stagedOutput = path.join(
      stagingDirectory,
      ".vercel",
      "output",
    );
    const stagedOutputStat = await lstat(stagedOutput);
    if (
      !stagedOutputStat.isDirectory() ||
      stagedOutputStat.isSymbolicLink()
    ) {
      throw new Error(
        "Transported prebuilt output root is not a real directory",
      );
    }
    await mkdir(vercelDirectory, { recursive: true });
    await rename(stagedOutput, outputDirectory);
    const verified = await verifyTransportedVercelPrebuiltArtifact({
      repositoryRoot,
      approvedManifestSha256: options.approvedManifestSha256,
    });
    if (verified.fileCount !== transport.manifest.fileCount) {
      throw new Error(
        "Transported prebuilt artifact file count does not match",
      );
    }
    return {
      archivePath: transport.manifest.archivePath,
      archiveSha256,
      transportManifestPath: relativeRepositoryPath(
        repositoryRoot,
        transport.manifestPath,
      ),
      transportManifestSha256: transport.manifestSha256,
      prebuiltArtifactManifestSha256:
        options.approvedManifestSha256,
      fileCount: verified.fileCount,
    };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const sourceCommitSha = required(
    process.env,
    "FLIGHT_MAP_APPROVED_COMMIT_SHA",
    SHA_PATTERN,
  );
  const candidateManifestSha256 = required(
    process.env,
    "AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256",
    SHA256_PATTERN,
  );
  const result = process.argv.includes("restore")
    ? await restoreVercelPrebuiltArtifact({
        sourceCommitSha,
        candidateManifestSha256,
        approvedManifestSha256: required(
          process.env,
          "FLIGHT_MAP_APPROVED_PREBUILT_ARTIFACT_MANIFEST_SHA256",
          SHA256_PATTERN,
        ),
      })
    : await packVercelPrebuiltArtifact({
        sourceCommitSha,
        candidateManifestSha256,
      });
  process.stdout.write(canonicalJson(result));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
