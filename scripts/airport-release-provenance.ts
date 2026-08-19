import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  AirportCatalogSafetyError,
  assertNoRawPostgresNotice,
} from "./postgres-diagnostics.ts";

const root = path.resolve(import.meta.dirname, "..");
const releaseConfigPath = path.join(
  root,
  "config",
  "airport-catalog-release.json",
);

export const SOURCE_MANIFEST_SELECTION = {
  roots: [
    ".github",
    "config",
    "docs",
    "drizzle/migrations",
    "e2e",
    "public",
    "scripts",
    "src",
  ],
  topLevelFiles: [
    ".firebaserc",
    ".gitattributes",
    ".gitignore",
    ".nvmrc",
    ".vercelignore",
    "compose.yaml",
    "DEPLOYMENT.md",
    "Dockerfile.worker",
    "drizzle.config.ts",
    "eslint.config.mjs",
    "next.config.ts",
    "package.json",
    "package-lock.json",
    "playwright.config.ts",
    "postcss.config.mjs",
    "railway.json",
    "README.md",
    "tsconfig.json",
    "vitest.config.ts",
    "vitest.setup.ts",
  ],
  extraFiles: [],
  generatedFiles: [
  ],
} as const;

export const DEPLOYMENT_SOURCE_MANIFEST_SELECTION = {
  roots: ["public", "src"],
  topLevelFiles: [
    ".nvmrc",
    ".vercelignore",
    "next.config.ts",
    "package.json",
    "package-lock.json",
    "postcss.config.mjs",
    "tsconfig.json",
  ],
  extraFiles: ["scripts/copy-maplibre-assets.mjs"],
} as const;

export interface CandidateFileEntry {
  path: string;
  bytes: number;
  sha1?: string;
  sha256: string;
}

export interface DeploymentSourceManifest {
  schemaVersion: 1;
  role: "vercel-cli-source";
  selection: {
    roots: string[];
    topLevelFiles: string[];
    extraFiles: string[];
  };
  files: CandidateFileEntry[];
}

export interface RepositorySourceManifest {
  schemaVersion: 2;
  role: "rejected-v3-baseline" | "candidate-source";
  selection: {
    roots: string[];
    topLevelFiles: string[];
    extraFiles: string[];
    generatedFiles: string[];
  };
  files: CandidateFileEntry[];
}

type PriorCandidateManifest =
  | {
      schemaVersion: 1;
      files: CandidateFileEntry[];
    }
  | AirportReleaseCandidateManifest;

export interface CandidateDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  beforeSha256?: string;
  afterSha256?: string;
}

export interface AirportReleaseCandidateManifest {
  schemaVersion: 3;
  provenanceMode: "content-addressed-repository-and-provider-source";
  baseline: {
    sourceManifestPath: string;
    sourceManifestSha256: string;
    rejectedCandidateManifestPath: string;
    rejectedCandidateManifestSha256: string;
  };
  source: {
    manifestSha256: string;
    selection: RepositorySourceManifest["selection"];
    files: CandidateFileEntry[];
  };
  deploymentSource: {
    manifestSha256: string;
    selection: DeploymentSourceManifest["selection"];
    files: CandidateFileEntry[];
  };
  diff: {
    sha256: string;
    added: number;
    modified: number;
    deleted: number;
    unchanged: number;
    entries: CandidateDiffEntry[];
  };
}

export interface ValidationCommandEvidence {
  command: string;
  result: "passed" | "failed" | "blocked";
  exitCode: number;
  artifactPath: string;
  outputSha256: string;
  previousSha256: string;
  linkSha256: string;
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortedValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

export function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryPath(relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split("/").includes("..") ||
    relativePath.includes("\\")
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  return resolved;
}

async function walkFiles(relativeRoot: string): Promise<string[]> {
  const absoluteRoot = repositoryPath(relativeRoot);
  const files: string[] = [];
  async function visit(absoluteDirectory: string) {
    const entries = await readdir(absoluteDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        files.push(
          path.relative(root, absolutePath).split(path.sep).join("/"),
        );
      }
    }
  }
  await visit(absoluteRoot);
  const generatedFiles = new Set<string>(
    SOURCE_MANIFEST_SELECTION.generatedFiles,
  );
  return files.filter((file) => !generatedFiles.has(file));
}

function selectionValue(): RepositorySourceManifest["selection"] {
  return {
    roots: [...SOURCE_MANIFEST_SELECTION.roots],
    topLevelFiles: [...SOURCE_MANIFEST_SELECTION.topLevelFiles],
    extraFiles: [...SOURCE_MANIFEST_SELECTION.extraFiles],
    generatedFiles: [...SOURCE_MANIFEST_SELECTION.generatedFiles],
  };
}

function validBaselineSelection(
  selection: Partial<RepositorySourceManifest["selection"]>,
): boolean {
  const historicalSelection = {
    roots: SOURCE_MANIFEST_SELECTION.roots.map((relativeRoot) =>
      relativeRoot === ".github" ? ".github/workflows" : relativeRoot,
    ),
    topLevelFiles: [
      ".env.example",
      ".env.local.example",
      ...SOURCE_MANIFEST_SELECTION.topLevelFiles,
    ],
    extraFiles: [
      "data/private/reference/ourairports-airports.csv",
    ],
    generatedFiles: [...SOURCE_MANIFEST_SELECTION.generatedFiles],
  };
  const legacySelection = {
    roots: historicalSelection.roots.filter(
      (relativeRoot) => relativeRoot !== "public",
    ),
    topLevelFiles: historicalSelection.topLevelFiles.filter(
      (file) =>
        ![
          ".gitattributes",
          ".gitignore",
          ".nvmrc",
        ].includes(file),
    ),
    extraFiles: [...historicalSelection.extraFiles],
  };
  return (
    canonicalJson(selection) === canonicalJson(legacySelection) ||
    canonicalJson(selection) === canonicalJson(historicalSelection) ||
    canonicalJson(selection) === canonicalJson(selectionValue())
  );
}

async function hashFiles(relativePaths: string[]): Promise<
  CandidateFileEntry[]
> {
  const uniquePaths = [...new Set(relativePaths)].sort();
  if (uniquePaths.length !== relativePaths.length || uniquePaths.length === 0) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const files: CandidateFileEntry[] = [];
  for (const relativePath of uniquePaths) {
    const absolutePath = repositoryPath(relativePath);
    const [contents, metadata] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath),
    ]);
    if (!metadata.isFile()) {
      throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
    }
    files.push({
      path: relativePath,
      bytes: metadata.size,
      sha1: createHash("sha1").update(contents).digest("hex"),
      sha256: sha256Bytes(contents),
    });
  }

  return files;
}

export async function createRepositorySourceManifest(): Promise<
  RepositorySourceManifest
> {
  const selection = selectionValue();
  const discovered = (
    await Promise.all(selection.roots.map(walkFiles))
  ).flat();
  return {
    schemaVersion: 2,
    role: "candidate-source",
    selection,
    files: await hashFiles([
      ...discovered,
      ...selection.topLevelFiles,
      ...selection.extraFiles,
    ]),
  };
}

export async function createDeploymentSourceManifest(): Promise<
  DeploymentSourceManifest
> {
  const selection = {
    roots: [...DEPLOYMENT_SOURCE_MANIFEST_SELECTION.roots],
    topLevelFiles: [
      ...DEPLOYMENT_SOURCE_MANIFEST_SELECTION.topLevelFiles,
    ],
    extraFiles: [...DEPLOYMENT_SOURCE_MANIFEST_SELECTION.extraFiles],
  };
  const discovered = (
    await Promise.all(selection.roots.map(walkFiles))
  ).flat();
  return {
    schemaVersion: 1,
    role: "vercel-cli-source",
    selection,
    files: await hashFiles([
      ...discovered,
      ...selection.topLevelFiles,
      ...selection.extraFiles,
    ]),
  };
}

async function readContentAddressedJson<T>(
  relativePath: string,
  expectedSha256: string,
): Promise<T> {
  try {
    const contents = await readFile(repositoryPath(relativePath));
    if (
      !/^[a-f0-9]{64}$/.test(expectedSha256) ||
      sha256Bytes(contents) !== expectedSha256
    ) {
      throw new Error("hash");
    }
    return JSON.parse(contents.toString("utf8")) as T;
  } catch {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
}

function validateFileEntries(files: CandidateFileEntry[]) {
  if (
    files.length === 0 ||
    files.some(
      (file, index) =>
        !file.path ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        (index > 0 && files[index - 1]!.path >= file.path),
    )
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
}

async function loadBaseline() {
  let config: {
    provenance?: {
      baselineManifest?: {
        relativePath?: string;
        sha256?: string;
      };
      rejectedCandidateManifest?: {
        relativePath?: string;
        sha256?: string;
      };
    };
  };
  try {
    config = JSON.parse(await readFile(releaseConfigPath, "utf8"));
  } catch {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const baselineReference = config.provenance?.baselineManifest;
  const rejectedReference = config.provenance?.rejectedCandidateManifest;
  if (
    !baselineReference?.relativePath ||
    !baselineReference.sha256 ||
    !rejectedReference?.relativePath ||
    !rejectedReference.sha256
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const baselineArtifact = await readContentAddressedJson<
    RepositorySourceManifest | AirportReleaseCandidateManifest
  >(
    baselineReference.relativePath,
    baselineReference.sha256,
  );
  const rejected = await readContentAddressedJson<PriorCandidateManifest>(
    rejectedReference.relativePath,
    rejectedReference.sha256,
  );
  const baseline =
    "source" in baselineArtifact
      ? {
          schemaVersion: 2 as const,
          role: "rejected-v3-baseline" as const,
          selection: baselineArtifact.source.selection,
          files: baselineArtifact.source.files,
        }
      : baselineArtifact;
  const rejectedFiles =
    "source" in rejected ? rejected.source.files : rejected.files;
  if (
    baseline.schemaVersion !== 2 ||
    baseline.role !== "rejected-v3-baseline" ||
    !validBaselineSelection(baseline.selection) ||
    !Array.isArray(baseline.files) ||
    !Array.isArray(rejectedFiles)
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  validateFileEntries(baseline.files);
  validateFileEntries(rejectedFiles);
  const baselineByPath = new Map(
    baseline.files.map((file) => [file.path, file]),
  );
  for (const rejectedFile of rejectedFiles) {
    const baselineFile = baselineByPath.get(rejectedFile.path);
    if (
      !baselineFile ||
      canonicalJson(baselineFile) !== canonicalJson(rejectedFile)
    ) {
      throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
    }
  }
  return {
    baseline,
    baselineReference: {
      relativePath: baselineReference.relativePath,
      sha256: baselineReference.sha256,
    },
    rejectedReference: {
      relativePath: rejectedReference.relativePath,
      sha256: rejectedReference.sha256,
    },
  };
}

export async function createCandidateManifest(): Promise<
  AirportReleaseCandidateManifest
> {
  const {
    baseline,
    baselineReference,
    rejectedReference,
  } = await loadBaseline();
  const source = await createRepositorySourceManifest();
  const deploymentSource = await createDeploymentSourceManifest();
  const before = new Map(baseline.files.map((file) => [file.path, file]));
  const after = new Map(source.files.map((file) => [file.path, file]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const entries: CandidateDiffEntry[] = [];
  let unchanged = 0;
  for (const filePath of paths) {
    const oldFile = before.get(filePath);
    const newFile = after.get(filePath);
    if (!oldFile && newFile) {
      entries.push({
        path: filePath,
        status: "added",
        afterSha256: newFile.sha256,
      });
    } else if (oldFile && !newFile) {
      entries.push({
        path: filePath,
        status: "deleted",
        beforeSha256: oldFile.sha256,
      });
    } else if (oldFile!.sha256 !== newFile!.sha256) {
      entries.push({
        path: filePath,
        status: "modified",
        beforeSha256: oldFile!.sha256,
        afterSha256: newFile!.sha256,
      });
    } else {
      unchanged += 1;
    }
  }
  const diffCore = {
    added: entries.filter(({ status }) => status === "added").length,
    modified: entries.filter(({ status }) => status === "modified").length,
    deleted: entries.filter(({ status }) => status === "deleted").length,
    unchanged,
    entries,
  };
  return {
    schemaVersion: 3,
    provenanceMode: "content-addressed-repository-and-provider-source",
    baseline: {
      sourceManifestPath: baselineReference.relativePath,
      sourceManifestSha256: baselineReference.sha256,
      rejectedCandidateManifestPath: rejectedReference.relativePath,
      rejectedCandidateManifestSha256: rejectedReference.sha256,
    },
    source: {
      manifestSha256: sha256Bytes(canonicalJson(source)),
      selection: source.selection,
      files: source.files,
    },
    deploymentSource: {
      manifestSha256: sha256Bytes(canonicalJson(deploymentSource)),
      selection: deploymentSource.selection,
      files: deploymentSource.files,
    },
    diff: {
      sha256: sha256Bytes(canonicalJson(diffCore)),
      ...diffCore,
    },
  };
}

export async function verifyCandidateManifest(
  manifestPath: string,
  expectedSha256: string,
): Promise<AirportReleaseCandidateManifest> {
  const manifest = await loadCandidateManifestArtifact(
    manifestPath,
    expectedSha256,
  );
  const regenerated = await createCandidateManifest();
  if (canonicalJson(regenerated) !== canonicalJson(manifest)) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  return manifest;
}

export async function loadCandidateManifestArtifact(
  manifestPath: string,
  expectedSha256: string,
): Promise<AirportReleaseCandidateManifest> {
  let manifest: AirportReleaseCandidateManifest;
  try {
    const contents = await readFile(manifestPath);
    if (
      !/^[a-f0-9]{64}$/.test(expectedSha256) ||
      sha256Bytes(contents) !== expectedSha256
    ) {
      throw new Error("hash");
    }
    manifest = JSON.parse(
      contents.toString("utf8"),
    ) as AirportReleaseCandidateManifest;
  } catch {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  if (
    manifest.schemaVersion !== 3 ||
    manifest.provenanceMode !==
      "content-addressed-repository-and-provider-source"
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  validateFileEntries(manifest.source.files);
  validateFileEntries(manifest.deploymentSource.files);
  const validEntries = manifest.diff.entries.every(
    (entry, index) =>
      typeof entry.path === "string" &&
      entry.path !== "" &&
      !path.posix.isAbsolute(entry.path) &&
      !entry.path.includes("\\") &&
      !entry.path.split("/").includes("..") &&
      (index === 0 ||
        manifest.diff.entries[index - 1]!.path < entry.path) &&
      ["added", "modified", "deleted"].includes(entry.status) &&
      (entry.beforeSha256 === undefined ||
        /^[a-f0-9]{64}$/.test(entry.beforeSha256)) &&
      (entry.afterSha256 === undefined ||
        /^[a-f0-9]{64}$/.test(entry.afterSha256)),
  );
  const sourceManifest = {
    schemaVersion: 2 as const,
    role: "candidate-source" as const,
    selection: manifest.source.selection,
    files: manifest.source.files,
  };
  const deploymentManifest = {
    schemaVersion: 1 as const,
    role: "vercel-cli-source" as const,
    selection: manifest.deploymentSource.selection,
    files: manifest.deploymentSource.files,
  };
  const diffCore = {
    added: manifest.diff.added,
    modified: manifest.diff.modified,
    deleted: manifest.diff.deleted,
    unchanged: manifest.diff.unchanged,
    entries: manifest.diff.entries,
  };
  if (
    canonicalJson(manifest.source.selection) !==
      canonicalJson(selectionValue()) ||
    canonicalJson(manifest.deploymentSource.selection) !==
      canonicalJson({
        roots: [...DEPLOYMENT_SOURCE_MANIFEST_SELECTION.roots],
        topLevelFiles: [
          ...DEPLOYMENT_SOURCE_MANIFEST_SELECTION.topLevelFiles,
        ],
        extraFiles: [
          ...DEPLOYMENT_SOURCE_MANIFEST_SELECTION.extraFiles,
        ],
      }) ||
    manifest.source.files.some(
      (file) =>
        !/^[a-f0-9]{40}$/.test(file.sha1 ?? "") ||
        path.posix.isAbsolute(file.path) ||
        file.path.includes("\\") ||
        file.path.split("/").includes(".."),
    ) ||
    manifest.deploymentSource.files.some(
      (file) =>
        !/^[a-f0-9]{40}$/.test(file.sha1 ?? "") ||
        path.posix.isAbsolute(file.path) ||
        file.path.includes("\\") ||
        file.path.split("/").includes(".."),
    ) ||
    !validEntries ||
    manifest.diff.added !==
      manifest.diff.entries.filter(({ status }) => status === "added")
        .length ||
    manifest.diff.modified !==
      manifest.diff.entries.filter(({ status }) => status === "modified")
        .length ||
    manifest.diff.deleted !==
      manifest.diff.entries.filter(({ status }) => status === "deleted")
        .length ||
    !Number.isSafeInteger(manifest.diff.unchanged) ||
    manifest.diff.unchanged < 0 ||
    sha256Bytes(canonicalJson(sourceManifest)) !==
      manifest.source.manifestSha256 ||
    sha256Bytes(canonicalJson(deploymentManifest)) !==
      manifest.deploymentSource.manifestSha256 ||
    sha256Bytes(canonicalJson(diffCore)) !== manifest.diff.sha256
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  return manifest;
}

export async function verifyValidationEvidenceChain(
  candidateManifestSha256: string,
  commands: ValidationCommandEvidence[],
  expectedChainRootSha256: string,
): Promise<string> {
  if (
    !/^[a-f0-9]{64}$/.test(candidateManifestSha256) ||
    !/^[a-f0-9]{64}$/.test(expectedChainRootSha256) ||
    commands.length === 0
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  let previousSha256 = candidateManifestSha256;
  for (const command of commands) {
    let output: Buffer;
    try {
      const absolutePath = repositoryPath(command.artifactPath);
      const permittedRoot = path.join(
        root,
        "artifacts",
        "release-evidence",
        "airport-catalog",
      );
      if (!absolutePath.startsWith(`${permittedRoot}${path.sep}`)) {
        throw new Error("path");
      }
      output = await readFile(absolutePath);
    } catch {
      throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
    }
    assertNoRawPostgresNotice(output.toString("utf8"));
    if (
      command.previousSha256 !== previousSha256 ||
      sha256Bytes(output) !== command.outputSha256 ||
      !Number.isSafeInteger(command.exitCode)
    ) {
      throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
    }
    const expectedLink = sha256Bytes(
      canonicalJson({
        command: command.command,
        exitCode: command.exitCode,
        outputSha256: command.outputSha256,
        previousSha256,
        result: command.result,
      }),
    );
    if (command.linkSha256 !== expectedLink) {
      throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
    }
    previousSha256 = expectedLink;
  }
  if (previousSha256 !== expectedChainRootSha256) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  return previousSha256;
}

export async function writeContentAddressedJson(
  outputDirectory: string,
  prefix: string,
  value: unknown,
): Promise<{ path: string; sha256: string }> {
  const contents = canonicalJson(value);
  const sha256 = sha256Bytes(contents);
  const outputPath = path.join(outputDirectory, `${prefix}-${sha256}.json`);
  await mkdir(outputDirectory, { recursive: true });
  let file;
  try {
    file = await open(outputPath, "wx");
    await file.writeFile(contents, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      const existing = await readFile(outputPath);
      if (sha256Bytes(existing) === sha256) return { path: outputPath, sha256 };
      throw new AirportCatalogSafetyError("evidence-already-exists");
    }
    throw error;
  } finally {
    await file?.close();
  }
  return { path: outputPath, sha256 };
}

export async function writeContentAddressedLog(
  outputDirectory: string,
  prefix: string,
  contents: string,
): Promise<{ path: string; sha256: string }> {
  assertNoRawPostgresNotice(contents);
  const sha256 = sha256Bytes(contents);
  const outputPath = path.join(outputDirectory, `${prefix}-${sha256}.log`);
  await mkdir(outputDirectory, { recursive: true });
  let file;
  try {
    file = await open(outputPath, "wx");
    await file.writeFile(contents, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      const existing = await readFile(outputPath);
      if (sha256Bytes(existing) === sha256) return { path: outputPath, sha256 };
      throw new AirportCatalogSafetyError("evidence-already-exists");
    }
    throw error;
  } finally {
    await file?.close();
  }
  return { path: outputPath, sha256 };
}
