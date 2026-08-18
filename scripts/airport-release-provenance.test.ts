import { appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createCandidateManifest,
  sha256Bytes,
  verifyCandidateManifest,
  verifyValidationEvidenceChain,
  writeContentAddressedJson,
  writeContentAddressedLog,
} from "./airport-release-provenance";

const outputDirectory = path.join(
  process.cwd(),
  "artifacts",
  "release-evidence",
  "airport-catalog",
  `provenance-unit-${process.pid}`,
);

afterEach(async () => {
  await rm(outputDirectory, { recursive: true, force: true });
});

describe("airport release provenance", () => {
  it(
    "binds the complete relevant source tree to the rejected baseline and exact diff",
    async () => {
      const manifest = await createCandidateManifest();
      const artifact = await writeContentAddressedJson(
        outputDirectory,
        "candidate",
        manifest,
      );

      expect(manifest.source.files.length).toBeGreaterThan(300);
      expect(manifest.source.files.map(({ path: filePath }) => filePath)).toEqual(
        expect.arrayContaining([
          "drizzle/migrations/0011_nautical_miles_profile_default.sql",
          "drizzle/migrations/0014_fix_flight_share_invalidation.sql",
          "package-lock.json",
          "public/maplibre/maplibre-gl-worker.mjs",
          "scripts/airport-release-upgrade.postgres.test.ts",
          "src/app/api/health/release/route.ts",
        ]),
      );
      expect(manifest.source.selection.generatedFiles).toEqual([]);
      expect(manifest.deploymentSource.files.length).toBeGreaterThan(100);
      expect(
        manifest.deploymentSource.files.map(({ path: filePath }) => filePath),
      ).toEqual(
        expect.arrayContaining([
          ".vercelignore",
          "next.config.ts",
          "package-lock.json",
          "scripts/copy-maplibre-assets.mjs",
          "src/app/api/health/release/route.ts",
        ]),
      );
      expect(
        manifest.deploymentSource.files.every(
          ({ sha1 }) => typeof sha1 === "string" && sha1.length === 40,
        ),
      ).toBe(true);
      expect(manifest.diff.modified + manifest.diff.added).toBeGreaterThan(0);
      await expect(
        verifyCandidateManifest(artifact.path, artifact.sha256),
      ).resolves.toEqual(manifest);
      await expect(
        writeContentAddressedJson(outputDirectory, "candidate", manifest),
      ).resolves.toEqual(artifact);
    },
    30_000,
  );

  it(
    "fails closed for stale, mutated, or incomplete provenance",
    async () => {
      const manifest = await createCandidateManifest();
      const artifact = await writeContentAddressedJson(
        outputDirectory,
        "candidate",
        manifest,
      );
      await appendFile(artifact.path, "stale", "utf8");

      await expect(
        verifyCandidateManifest(artifact.path, artifact.sha256),
      ).rejects.toMatchObject({
        diagnosticCode: "candidate-provenance-mismatch",
      });

      const incomplete = await writeContentAddressedJson(
        outputDirectory,
        "candidate",
        {
          schemaVersion: 1,
          files: [manifest.source.files[0]],
        },
      );
      await expect(
        verifyCandidateManifest(incomplete.path, incomplete.sha256),
      ).rejects.toMatchObject({
        diagnosticCode: "candidate-provenance-mismatch",
      });
    },
    30_000,
  );

  it("verifies every content-addressed command link and rejects raw notices", async () => {
    const candidateSha256 = "a".repeat(64);
    const output = await writeContentAddressedLog(
      outputDirectory,
      "focused",
      "Focused tests passed: 51/51.\n",
    );
    const outputPath = path.relative(process.cwd(), output.path)
      .split(path.sep)
      .join("/");
    const linkSha256 = sha256Bytes(
      canonicalJson({
        command: "npm run test:focused",
        exitCode: 0,
        outputSha256: output.sha256,
        previousSha256: candidateSha256,
        result: "passed",
      }),
    );
    await expect(
      verifyValidationEvidenceChain(
        candidateSha256,
        [{
          command: "npm run test:focused",
          result: "passed",
          exitCode: 0,
          artifactPath: outputPath,
          outputSha256: output.sha256,
          previousSha256: candidateSha256,
          linkSha256,
        }],
        linkSha256,
      ),
    ).resolves.toBe(linkSha256);
    await expect(
      writeContentAddressedLog(
        outputDirectory,
        "unsafe",
        "NOTICE: private database detail\n",
      ),
    ).rejects.toMatchObject({
      diagnosticCode: "candidate-provenance-mismatch",
    });
  });
});
