import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPinnedVercelCliVersion,
  assertLinkedVercelProject,
  buildVercelPrebuiltOutput,
  parseProductionDeploymentOutput,
  parseVercelCliVersion,
  parseVercelPrebuiltDryRun,
  sanitizedDeploymentEnvironment,
  validVercelEnvironmentId,
  vercelCommandInvocation,
  verifyPublicAuthAvailability,
} from "./deploy-production";

describe("deploy-production", () => {
  const workspaces = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...workspaces].map((workspace) =>
        rm(workspace, { recursive: true, force: true }),
      ),
    );
    workspaces.clear();
  });

  it("strips database credentials while preserving the parent environment", () => {
    const parent = {
      NODE_ENV: "test" as const,
      MIGRATION_DATABASE_URL: "not-forwarded",
      DIRECT_DATABASE_URL: "not-forwarded",
      POSTGRES_URL: "not-forwarded",
      VERCEL_TOKEN: "configured",
    };

    const child = sanitizedDeploymentEnvironment(parent);

    expect(parent.MIGRATION_DATABASE_URL).toBe("not-forwarded");
    expect(child.MIGRATION_DATABASE_URL).toBeUndefined();
    expect(child.DIRECT_DATABASE_URL).toBeUndefined();
    expect(child.POSTGRES_URL).toBeUndefined();
    expect(child.DATABASE_URL).toContain("flight_map_build");
    expect(child.VERCEL_TOKEN).toBe("configured");
  });

  it("accepts only immutable Vercel deployment metadata", () => {
    expect(
      parseProductionDeploymentOutput(
        JSON.stringify({
          id: "dpl_12345678",
          url: "flight-map-abc.vercel.app",
        }),
      ),
    ).toEqual({
      id: "dpl_12345678",
      url: "https://flight-map-abc.vercel.app",
    });
    expect(() =>
      parseProductionDeploymentOutput('{"id":"dpl_12345678","url":"example.com"}'),
    ).toThrow(/immutable metadata/);
  });

  it("fails closed on local project or team drift", () => {
    expect(() =>
      assertLinkedVercelProject({
        projectId: "prj_1XEu7EWNl1Eekl3TKQ6FnKnGznv8",
        orgId: "team_qymLK9gugmE5lSs2mxC5XqRY",
      }),
    ).not.toThrow();
    expect(() =>
      assertLinkedVercelProject({
        projectId: "prj_wrong",
        orgId: "team_qymLK9gugmE5lSs2mxC5XqRY",
      }),
    ).toThrow(/does not match/);
  });

  it("requires the exact pinned Vercel CLI version", () => {
    expect(
      parseVercelCliVersion("Vercel CLI 58.9.2\n58.9.2\n"),
    ).toBe("58.9.2");
    expect(() => assertPinnedVercelCliVersion("58.9.20")).toThrow(
      /58\.9\.2 is required/,
    );
  });

  it("parses the exact Vercel dry-run file inventory", () => {
    expect(
      parseVercelPrebuiltDryRun(
        JSON.stringify({
          fileCount: 1,
          files: [
            {
              path: ".vercel/output/config.json",
              size: 2,
              sha: "a".repeat(40),
            },
          ],
        }),
      ),
    ).toEqual({
      fileCount: 1,
      files: [
        {
          path: ".vercel/output/config.json",
          size: 2,
          sha: "a".repeat(40),
        },
      ],
    });
  });

  it("accepts current opaque Vercel environment IDs", () => {
    expect(validVercelEnvironmentId("aD29JHJ3otYaRJVq")).toBe(true);
    expect(validVercelEnvironmentId("env_12345678")).toBe(true);
    expect(validVercelEnvironmentId("../production")).toBe(false);
  });

  it("requires public registration and sign-in before deployment", async () => {
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return new Response(
        url.pathname === "/auth/register" ? "register" : "sign in",
        { status: 200 },
      );
    });

    await expect(
      verifyPublicAuthAvailability(
        "https://flight-map-one.vercel.app",
        fetchImplementation as typeof fetch,
      ),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    fetchImplementation.mockResolvedValueOnce(
      new Response("", { status: 503 }),
    );
    await expect(
      verifyPublicAuthAvailability(
        "https://flight-map-one.vercel.app",
        fetchImplementation as typeof fetch,
      ),
    ).rejects.toThrow(/Public auth route is unavailable/);
  });

  it("passes Windows CLI arguments exactly without shell interpretation", async () => {
    const workspace = path.join(
      process.cwd(),
      "artifacts",
      "test-workspaces",
      `vercel-argv-${randomUUID()}`,
    );
    workspaces.add(workspace);
    await mkdir(workspace, { recursive: true });
    const entryPoint = path.join(workspace, "argv.cjs");
    await writeFile(
      entryPoint,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    );
    const expectedArgs = [
      "api",
      "/v10/projects/project/env/id?teamId=team&decrypt=true",
      "",
      'quoted"value',
      "--raw",
    ];
    const invocation = vercelCommandInvocation(
      expectedArgs,
      "win32",
      entryPoint,
    );

    const result = spawnSync(
      invocation.executable,
      [...invocation.args],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expectedArgs);
  });

  it("builds without pull or persisted production environment files", async () => {
    const workspace = path.join(
      process.cwd(),
      "artifacts",
      "test-workspaces",
      `vercel-build-${randomUUID()}`,
    );
    workspaces.add(workspace);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, ".env.local"), "TEST_ONLY=true\n");
    const calls: string[][] = [];

    await expect(
      buildVercelPrebuiltOutput({
        repositoryRoot: workspace,
        environment: sanitizedDeploymentEnvironment({
          NODE_ENV: "test",
          VERCEL_TOKEN: "configured",
        }),
        runCli: async (args) => {
          calls.push([...args]);
          return { stdout: "" };
        },
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      [
        "build",
        "--prod",
        "--scope",
        "giffdevs-projects",
        "--global-config",
        path.join(workspace, ".vercel", "release-control-global"),
      ],
    ]);
    expect(calls.flat()).not.toContain("pull");
    expect(
      JSON.parse(
        await readFile(
          path.join(workspace, ".vercel", "project.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      projectId: "prj_1XEu7EWNl1Eekl3TKQ6FnKnGznv8",
      orgId: "team_qymLK9gugmE5lSs2mxC5XqRY",
      projectName: "flight-map",
      settings: {
        framework: "nextjs",
        devCommand: null,
        installCommand: null,
        buildCommand: null,
        outputDirectory: null,
        rootDirectory: null,
        directoryListing: false,
        nodeVersion: "24.x",
      },
    });
    await expect(
      access(path.join(workspace, ".env.local")),
    ).resolves.toBeUndefined();
    await expect(
      access(
        path.join(
          workspace,
          ".vercel",
          "env.local.release-control-hold",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(workspace, ".vercel", ".env.production.local")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(workspace, ".vercel", "release-control-global")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores local environment files when the Vercel build fails", async () => {
    const workspace = path.join(
      process.cwd(),
      "artifacts",
      "test-workspaces",
      `vercel-build-failure-${randomUUID()}`,
    );
    workspaces.add(workspace);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, ".env.production"), "TEST_ONLY=true\n");

    await expect(
      buildVercelPrebuiltOutput({
        repositoryRoot: workspace,
        environment: sanitizedDeploymentEnvironment({
          NODE_ENV: "test",
          VERCEL_TOKEN: "configured",
        }),
        runCli: async () => {
          throw new Error("synthetic build failure");
        },
      }),
    ).rejects.toThrow("synthetic build failure");

    await expect(
      access(path.join(workspace, ".env.production")),
    ).resolves.toBeUndefined();
    await expect(
      access(
        path.join(
          workspace,
          ".vercel",
          "env.production.release-control-hold",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(workspace, ".vercel", ".env.production.local")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(workspace, ".vercel", "release-control-global")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed and cleans up if the build writes an environment file", async () => {
    const workspace = path.join(
      process.cwd(),
      "artifacts",
      "test-workspaces",
      `vercel-build-env-write-${randomUUID()}`,
    );
    workspaces.add(workspace);
    await mkdir(workspace, { recursive: true });

    await expect(
      buildVercelPrebuiltOutput({
        repositoryRoot: workspace,
        environment: sanitizedDeploymentEnvironment({
          NODE_ENV: "test",
          VERCEL_TOKEN: "configured",
        }),
        runCli: async () => {
          await writeFile(
            path.join(
              workspace,
              ".vercel",
              ".env.production.local",
            ),
            "UNEXPECTED=true\n",
          );
          return { stdout: "" };
        },
      }),
    ).rejects.toThrow(/persisted a production environment file/);

    await expect(
      access(path.join(workspace, ".vercel", ".env.production.local")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
