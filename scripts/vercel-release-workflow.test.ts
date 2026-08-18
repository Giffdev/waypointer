import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(workflow).toContain('test "$APPROVER" != "$REQUESTER"');
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
  });
});
