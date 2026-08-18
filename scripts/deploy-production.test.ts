import { describe, expect, it } from "vitest";

import {
  assertPinnedVercelCliVersion,
  assertLinkedVercelProject,
  parseProductionDeploymentOutput,
  parseVercelCliVersion,
  parseVercelPrebuiltDryRun,
  sanitizedDeploymentEnvironment,
  validVercelEnvironmentId,
} from "./deploy-production";

describe("deploy-production", () => {
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
});
