import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVercelPrebuiltArtifactManifest,
  loadVercelPrebuiltArtifactManifest,
  writeVercelPrebuiltArtifactManifest,
} from "./vercel-prebuilt-artifact";

describe("vercel-prebuilt-artifact", () => {
  const workspaces = new Set<string>();

  async function createWorkspace(): Promise<string> {
    const root = path.join(
      process.cwd(),
      "artifacts",
      "test-workspaces",
      `vercel-prebuilt-${randomUUID()}`,
    );
    await mkdir(root, { recursive: true });
    workspaces.add(root);
    return root;
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

  it("binds the manifest to the pinned Vercel dry-run inventory", async () => {
    const root = await createWorkspace();
    const functionDirectory = path.join(
      root,
      ".vercel",
      "output",
      "functions",
      "api.func",
    );
    await mkdir(functionDirectory, { recursive: true });
    await mkdir(path.join(root, "shared"), { recursive: true });
    const configContents = JSON.stringify({
      runtime: "nodejs20.x",
      filePathMap: { "shared.txt": "shared/shared.txt" },
    });
    const functionContents = "export default 1;";
    await writeFile(
      path.join(functionDirectory, ".vc-config.json"),
      configContents,
    );
    await writeFile(
      path.join(functionDirectory, "index.js"),
      functionContents,
    );
    await writeFile(path.join(root, "shared", "shared.txt"), "shared");

    const result = await createVercelPrebuiltArtifactManifest({
      repositoryRoot: root,
      sourceCommitSha: "a".repeat(40),
      candidateManifestSha256: "b".repeat(64),
      dryRun: {
        fileCount: 2,
        files: [
          {
            path: ".vercel/output/functions/api.func/.vc-config.json",
            size: Buffer.byteLength(configContents),
            sha: createHash("sha1").update(configContents).digest("hex"),
          },
          {
            path: ".vercel/output/functions/api.func/index.js",
            size: Buffer.byteLength(functionContents),
            sha: createHash("sha1").update(functionContents).digest("hex"),
          },
        ],
      },
    });

    expect(result.manifest.files.map((file) => file.path)).toEqual([
      ".vercel/output/functions/api.func/.vc-config.json",
      ".vercel/output/functions/api.func/index.js",
    ]);
    expect(result.manifest.files).not.toContainEqual(
      expect.objectContaining({ path: "shared/shared.txt" }),
    );
  });

  it("rejects dry-run inventory drift", async () => {
    const root = await createWorkspace();
    const outputDirectory = path.join(root, ".vercel", "output");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "config.json"), "{}");

    await expect(
      createVercelPrebuiltArtifactManifest({
        repositoryRoot: root,
        sourceCommitSha: "a".repeat(40),
        candidateManifestSha256: "b".repeat(64),
        dryRun: {
          fileCount: 1,
          files: [
            {
              path: ".vercel/output/config.json",
              size: 2,
              sha: "f".repeat(40),
            },
          ],
        },
      }),
    ).rejects.toThrow(/dry-run hash mismatch/);
  });

  it("hashes symbolic links using their link target, matching the Vercel CLI", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await createWorkspace();
    const outputDirectory = path.join(root, ".vercel", "output");
    await mkdir(outputDirectory, { recursive: true });
    await symlink("target.txt", path.join(outputDirectory, "link.txt"));

    const result = await createVercelPrebuiltArtifactManifest({
      repositoryRoot: root,
      sourceCommitSha: "a".repeat(40),
      candidateManifestSha256: "b".repeat(64),
    });

    expect(result.manifest.files[0]).toMatchObject({
      bytes: 10,
      sha1: createHash("sha1").update("target.txt").digest("hex"),
    });
  });

  it("writes and reloads a content-addressed manifest", async () => {
    const root = await createWorkspace();
    const outputDirectory = path.join(root, ".vercel", "output");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "config.json"), "{}");

    const result = await createVercelPrebuiltArtifactManifest({
      repositoryRoot: root,
      sourceCommitSha: "a".repeat(40),
      candidateManifestSha256: "b".repeat(64),
    });
    const manifestPath = await writeVercelPrebuiltArtifactManifest(result, {
      repositoryRoot: root,
    });

    await expect(
      loadVercelPrebuiltArtifactManifest(
        manifestPath,
        result.manifestSha256,
      ),
    ).resolves.toEqual(result);
  });
});
