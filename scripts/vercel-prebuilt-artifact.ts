import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const PREBUILT_OUTPUT_DIRECTORY = ".vercel/output";
const CONTENT_ADDRESS_PATTERN = /^[a-f0-9]{64}$/u;

export interface VercelPrebuiltArtifactFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha1: string;
  readonly sha256: string;
}

export interface VercelPrebuiltArtifactManifest {
  readonly schemaVersion: 1;
  readonly deploymentMethod: "vercel-cli-prebuilt";
  readonly sourceCommitSha: string;
  readonly candidateManifestSha256: string;
  readonly outputDirectory: typeof PREBUILT_OUTPUT_DIRECTORY;
  readonly fileCount: number;
  readonly files: readonly VercelPrebuiltArtifactFile[];
}

export interface VercelPrebuiltArtifactResult {
  readonly manifest: VercelPrebuiltArtifactManifest;
  readonly manifestSha256: string;
}

export interface VercelPrebuiltDryRun {
  readonly fileCount: number;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha: string;
  }[];
}

function serializeManifest(manifest: VercelPrebuiltArtifactManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function toRepositoryPath(repositoryRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repositoryRoot, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Prebuilt upload path escapes the repository: ${absolutePath}`);
  }

  return relativePath.split(path.sep).join("/");
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(absolutePath);
      continue;
    }

    throw new Error(`Unsupported prebuilt output entry: ${absolutePath}`);
  }

  return files;
}

async function hashUploadFile(
  repositoryRoot: string,
  absolutePath: string,
): Promise<VercelPrebuiltArtifactFile> {
  const fileStat = await lstat(absolutePath);
  const bytes = fileStat.isSymbolicLink()
    ? Buffer.from(await readlink(absolutePath), "utf8")
    : await readFile(absolutePath);

  return {
    path: toRepositoryPath(repositoryRoot, absolutePath),
    bytes: bytes.length,
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function createVercelPrebuiltArtifactManifest(options: {
  readonly repositoryRoot?: string;
  readonly sourceCommitSha: string;
  readonly candidateManifestSha256: string;
  readonly dryRun?: VercelPrebuiltDryRun;
}): Promise<VercelPrebuiltArtifactResult> {
  if (!/^[a-f0-9]{40}$/u.test(options.sourceCommitSha)) {
    throw new Error("sourceCommitSha must be a lowercase 40-character SHA");
  }
  if (!CONTENT_ADDRESS_PATTERN.test(options.candidateManifestSha256)) {
    throw new Error("candidateManifestSha256 must be a lowercase SHA-256");
  }

  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const outputDirectory = path.join(repositoryRoot, ".vercel", "output");
  let uploadFiles: string[];
  if (options.dryRun !== undefined) {
    if (
      options.dryRun.fileCount !== options.dryRun.files.length ||
      options.dryRun.files.length === 0
    ) {
      throw new Error("Vercel dry-run file inventory is invalid");
    }
    const dryRunPaths = options.dryRun.files.map((file) => file.path);
    if (new Set(dryRunPaths).size !== dryRunPaths.length) {
      throw new Error("Vercel dry-run file inventory contains duplicates");
    }
    uploadFiles = dryRunPaths.map((filePath) => {
      if (
        !filePath.startsWith(`${PREBUILT_OUTPUT_DIRECTORY}/`) ||
        filePath.includes("\\") ||
        path.posix.isAbsolute(filePath) ||
        filePath.split("/").includes("..")
      ) {
        throw new Error(`Unexpected Vercel prebuilt upload path: ${filePath}`);
      }
      return path.resolve(repositoryRoot, ...filePath.split("/"));
    });
  } else {
    uploadFiles = await collectFiles(outputDirectory);
  }
  const files = await Promise.all(
    uploadFiles.map((filePath) => hashUploadFile(repositoryRoot, filePath)),
  );
  files.sort((left, right) => left.path.localeCompare(right.path));

  if (options.dryRun !== undefined) {
    const dryRunByPath = new Map(
      options.dryRun.files.map((file) => [file.path, file]),
    );
    for (const file of files) {
      const dryRunFile = dryRunByPath.get(file.path);
      if (
        dryRunFile?.size !== file.bytes ||
        dryRunFile.sha !== file.sha1
      ) {
        throw new Error(`Vercel dry-run hash mismatch: ${file.path}`);
      }
    }
  }

  if (files.length === 0) {
    throw new Error("Vercel prebuilt output contains no uploadable files");
  }

  const manifest: VercelPrebuiltArtifactManifest = {
    schemaVersion: 1,
    deploymentMethod: "vercel-cli-prebuilt",
    sourceCommitSha: options.sourceCommitSha,
    candidateManifestSha256: options.candidateManifestSha256,
    outputDirectory: PREBUILT_OUTPUT_DIRECTORY,
    fileCount: files.length,
    files,
  };

  return {
    manifest,
    manifestSha256: createHash("sha256")
      .update(serializeManifest(manifest))
      .digest("hex"),
  };
}

export async function writeVercelPrebuiltArtifactManifest(
  result: VercelPrebuiltArtifactResult,
  options: {
    readonly repositoryRoot?: string;
    readonly outputDirectory?: string;
  } = {},
): Promise<string> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const outputDirectory = path.resolve(
    repositoryRoot,
    options.outputDirectory ??
      "artifacts/release-evidence/vercel-prebuilt-artifact",
  );
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    `manifest-${result.manifestSha256}.json`,
  );
  const serialized = serializeManifest(result.manifest);
  await writeFile(outputPath, serialized, {
    encoding: "utf8",
    flag: "wx",
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
    const existing = await readFile(outputPath, "utf8");
    if (existing !== serialized) {
      throw new Error(`Existing prebuilt artifact differs: ${outputPath}`);
    }
  });
  return outputPath;
}

export async function loadVercelPrebuiltArtifactManifest(
  filePath: string,
  expectedSha256?: string,
): Promise<VercelPrebuiltArtifactResult> {
  const bytes = await readFile(filePath);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined && manifestSha256 !== expectedSha256) {
    throw new Error(
      `Prebuilt artifact manifest hash mismatch: expected ${expectedSha256}, got ${manifestSha256}`,
    );
  }

  const manifest = JSON.parse(
    bytes.toString("utf8"),
  ) as VercelPrebuiltArtifactManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.deploymentMethod !== "vercel-cli-prebuilt" ||
    manifest.fileCount !== manifest.files.length ||
    manifest.files.length === 0
  ) {
    throw new Error("Prebuilt artifact manifest is invalid");
  }

  return { manifest, manifestSha256 };
}
