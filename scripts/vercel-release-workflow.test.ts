import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { vercelPrebuiltTransportPaths } from "./vercel-prebuilt-transport";

const workflowPath = path.join(
  process.cwd(),
  ".github",
  "workflows",
  "vercel-deploy.yml",
);
const approvalWorkflowPath = path.join(
  process.cwd(),
  ".github",
  "workflows",
  "vercel-release-approval.yml",
);

function workflowStep(workflow: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step is missing: ${name}`);
  }
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function uploadSearchRoot(pattern: string): string {
  const wildcard = pattern.search(/[*?\[]/u);
  const literalPrefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  const slash = literalPrefix.lastIndexOf("/");
  return literalPrefix.slice(0, slash);
}

function leastCommonAncestor(paths: readonly string[]): string {
  const [first, ...rest] = paths.map((entry) => entry.split("/"));
  const common: string[] = [];
  for (let index = 0; index < (first?.length ?? 0); index += 1) {
    const component = first![index]!;
    if (rest.every((entry) => entry[index] === component)) {
      common.push(component);
    } else {
      break;
    }
  }
  return common.join("/");
}

function matchesUploadPattern(pattern: string, repositoryPath: string): boolean {
  const regex = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${regex}$`, "u").test(repositoryPath);
}

function modelUploadArtifactDownload(options: {
  readonly uploadPatterns: readonly string[];
  readonly matchedRepositoryPaths: readonly string[];
  readonly downloadPath: string;
}): string[] {
  const lca = leastCommonAncestor(
    options.uploadPatterns.map(uploadSearchRoot),
  );
  return options.matchedRepositoryPaths.map((repositoryPath) => {
    if (
      !options.uploadPatterns.some((pattern) =>
        matchesUploadPattern(pattern, repositoryPath),
      )
    ) {
      throw new Error(`Fixture is not uploaded: ${repositoryPath}`);
    }
    return path.posix.join(
      options.downloadPath,
      repositoryPath.slice(`${lca}/`.length),
    );
  });
}

describe("Vercel release workflow", () => {
  it("puts every provider credential use behind the production environment", async () => {
    const workflow = (await readFile(workflowPath, "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    const environmentDeclaration =
      "    environment:\n      name: vercel-production";
    const environmentIndex = workflow.indexOf(environmentDeclaration);
    const stepsIndex = workflow.indexOf("    steps:");
    const approvalIndex = workflow.indexOf(
      "      - name: Validate independent manual approval",
    );
    const tokenReferences =
      workflow.match(/\$\{\{ secrets\.VERCEL_TOKEN \}\}/gu) ?? [];

    expect(workflow).toContain("permissions: {}\n\njobs:");
    expect(workflow).toContain(
      "    permissions:\n      actions: read\n      contents: read",
    );
    expect(environmentIndex).toBeGreaterThan(-1);
    expect(environmentIndex).toBeLessThan(stepsIndex);
    expect(approvalIndex).toBeGreaterThan(stepsIndex);
    expect(tokenReferences).toHaveLength(2);
    expect(workflow.slice(0, approvalIndex)).not.toContain(
      "secrets.VERCEL_TOKEN",
    );
    expect(workflow).not.toContain('test "$APPROVER" != "$REQUESTER"');
    expect(workflow).toContain(
      "REPOSITORY_OWNER: ${{ github.repository_owner }}",
    );
    expect(workflow).toContain('test "$REQUESTER" = "$REPOSITORY_OWNER"');
    expect(workflow).toContain('test "$APPROVER" = "$REPOSITORY_OWNER"');
    expect(workflow).toContain(".approvalRunId == $approvalRunId");
    expect(workflow).not.toContain("target_fingerprint");
    expect(workflow).not.toContain("FLIGHT_MAP_TARGET_FINGERPRINT");
    expect(workflow).toContain(
      '.path == ".github/workflows/vercel-release-approval.yml"',
    );
  });

  it("accepts only an exact private-main workflow dispatch", async () => {
    const workflow = (await readFile(workflowPath, "utf8")).replaceAll(
      "\r\n",
      "\n",
    );

    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain(
      "github.repository == 'Giffdev/waypointer'",
    );
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain(
      'test "$REVIEWED_COMMIT_SHA" = "$WORKFLOW_COMMIT_SHA"',
    );
    expect(workflow).toContain(
      'test "$REVIEWED_COMMIT_SHA" = "$(git rev-parse origin/main)"',
    );
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toMatch(/^\s+pull_request:/mu);
    expect(workflow).not.toContain("pull_request_target:");
  });

  it("records approval without source checkout or production credentials", async () => {
    const workflow = (
      await readFile(approvalWorkflowPath, "utf8")
    ).replaceAll("\r\n", "\n");

    expect(workflow).toContain("permissions: {}\n\njobs:");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain(
      "github.repository == 'Giffdev/waypointer'",
    );
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain(
      'test "$REVIEWED_COMMIT_SHA" = "$WORKFLOW_COMMIT_SHA"',
    );
    expect(workflow).not.toContain("actions/checkout");
    expect(workflow).not.toContain("VERCEL_TOKEN");
    expect(workflow).not.toContain("target_fingerprint");
    expect(workflow).not.toMatch(/^\s+pull_request:/mu);
    expect(workflow).toContain(
      "REPOSITORY_OWNER: ${{ github.repository_owner }}",
    );
    expect(workflow).toContain('test "$APPROVER" = "$REPOSITORY_OWNER"');
  });

  it("transports the reviewed prebuilt output as a verified symlink-preserving archive", async () => {
    const workflow = (await readFile(workflowPath, "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    const packIndex = workflow.indexOf(
      "      - name: Package exact prebuilt artifact for transport",
    );
    const uploadIndex = workflow.indexOf(
      "      - name: Upload artifact for independent review",
    );
    const downloadIndex = workflow.indexOf(
      "      - name: Download independently reviewed artifact",
    );
    const preparedRunValidationIndex = workflow.indexOf(
      "      - name: Validate prepared workflow run provenance",
    );
    const restoreIndex = workflow.indexOf(
      "      - name: Restore and verify exact prebuilt artifact",
    );
    const deployIndex = workflow.indexOf(
      "      - name: Deploy exact immutable production candidate",
    );

    expect(packIndex).toBeGreaterThan(-1);
    expect(packIndex).toBeLessThan(uploadIndex);
    expect(preparedRunValidationIndex).toBeGreaterThan(uploadIndex);
    expect(preparedRunValidationIndex).toBeLessThan(downloadIndex);
    expect(downloadIndex).toBeLessThan(restoreIndex);
    expect(restoreIndex).toBeLessThan(deployIndex);
    expect(workflow).toContain("npm run pack:production-artifact");
    expect(workflow).toContain("npm run restore:production-artifact");
    expect(workflow).toContain(
      "artifacts/release-evidence/vercel-prebuilt-transport/bundle-*.tar",
    );
    expect(workflow).toContain(
      "artifacts/release-evidence/vercel-prebuilt-transport/transport-*.json",
    );
    expect(workflow).not.toContain(".vercel/output/**");
    expect(workflow).toContain(
      "FLIGHT_MAP_APPROVED_PREBUILT_ARTIFACT_MANIFEST_SHA256: ${{ inputs.prebuilt_artifact_manifest_sha256 }}",
    );
    expect(workflow).toContain(
      '"$API_URL/repos/$REPOSITORY/actions/runs/$PREPARED_RUN_ID"',
    );
    const preparedValidation = workflowStep(
      workflow,
      "Validate prepared workflow run provenance",
    );
    expect(preparedValidation).toContain(
      "scripts/validate-prepared-vercel-run.ts",
    );
    expect(preparedValidation).not.toContain("jq -e");
  });

  it("restores upload-artifact LCA-stripped members at the paths restore consumes", async () => {
    const workflow = (await readFile(workflowPath, "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    const upload = workflowStep(
      workflow,
      "Upload artifact for independent review",
    );
    const download = workflowStep(
      workflow,
      "Download independently reviewed artifact",
    );
    const uploadPatterns = [
      ...upload.matchAll(/^\s{12}(artifacts\/release-evidence\/.+)$/gmu),
    ].map((match) => match[1]!);
    const downloadPath =
      /^\s{10}path: (.+)$/mu.exec(download)?.[1] ?? "";
    const manifestSha256 = "a".repeat(64);
    const consumed = vercelPrebuiltTransportPaths(manifestSha256);
    const matchedRepositoryPaths = [
      "artifacts/release-evidence/airport-catalog/candidate-b.json",
      consumed.prebuiltManifestPath,
      consumed.archivePath,
      "artifacts/release-evidence/vercel-prebuilt-transport/transport-c.json",
    ];

    expect(uploadPatterns).toHaveLength(4);
    expect(downloadPath).toBe("artifacts/release-evidence");
    expect(
      modelUploadArtifactDownload({
        uploadPatterns,
        matchedRepositoryPaths,
        downloadPath,
      }),
    ).toEqual(matchedRepositoryPaths);
  });
});
