import { spawnSync } from "node:child_process";
import { appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createCandidateDiff,
  createCandidateManifest,
  loadCandidateManifestArtifact,
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

  it(
    "loads producer diff output ordered by UTF-8 bytes across the BMP boundary",
    async () => {
      const manifest = await createCandidateManifest();
      const privateUsePath = "public/\ue000-entry";
      const astralPath = "public/\u{10000}-entry";
      const diff = createCandidateDiff([], [
        {
          path: astralPath,
          bytes: 1,
          sha256: "a".repeat(64),
        },
        {
          path: privateUsePath,
          bytes: 1,
          sha256: "b".repeat(64),
        },
      ]);
      expect(diff.entries.map(({ path: filePath }) => filePath)).toEqual([
        privateUsePath,
        astralPath,
      ]);

      const artifact = await writeContentAddressedJson(
        outputDirectory,
        "unicode-candidate",
        { ...manifest, diff },
      );
      await expect(
        loadCandidateManifestArtifact(artifact.path, artifact.sha256),
      ).resolves.toEqual({ ...manifest, diff });
    },
    30_000,
  );

  it(
    "translates a malformed manifest path to the provenance domain error",
    async () => {
      const manifest = await createCandidateManifest();
      const diffCore = {
        added: 1,
        modified: 0,
        deleted: 0,
        unchanged: manifest.diff.unchanged,
        entries: [
          {
            path: "public/\ud800-entry",
            status: "added" as const,
            afterSha256: "a".repeat(64),
          },
        ],
      };
      const malformed = {
        ...manifest,
        diff: {
          sha256: sha256Bytes(canonicalJson(diffCore)),
          ...diffCore,
        },
      };
      const artifact = await writeContentAddressedJson(
        outputDirectory,
        "malformed-candidate",
        malformed,
      );

      await expect(
        loadCandidateManifestArtifact(artifact.path, artifact.sha256),
      ).rejects.toMatchObject({
        diagnosticCode: "candidate-provenance-mismatch",
      });
    },
    30_000,
  );

  it("serializes identically across subprocess locales and preserves the approved baseline hash", async () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "airport-release-provenance.ts"),
    ).href;
    const script = `
      const collator = new Intl.Collator(process.env.TEST_LOCALE);
      String.prototype.localeCompare = function (other) {
        return collator.compare(String(this), String(other));
      };
      const { canonicalJson } = await import(process.env.PROVENANCE_MODULE_URL);
      process.stdout.write(canonicalJson({ "ä": 1, "z": 2 }));
    `;
    const serialized = ["en-US", "sv-SE"].map((locale) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          script,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            PROVENANCE_MODULE_URL: moduleUrl,
            TEST_LOCALE: locale,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    });
    expect(serialized[0]).toBe(serialized[1]);
    expect(serialized[0]).toBe(canonicalJson({ "ä": 1, z: 2 }));

    const releaseConfig = JSON.parse(
      await readFile(
        path.join(process.cwd(), "config", "airport-catalog-release.json"),
        "utf8",
      ),
    ) as {
      provenance: {
        approvedAirportCandidate: {
          relativePath: string;
          sha256: string;
        };
      };
    };
    const approved = releaseConfig.provenance.approvedAirportCandidate;
    const baselineBytes = await readFile(
      path.join(process.cwd(), ...approved.relativePath.split("/")),
    );
    expect(sha256Bytes(baselineBytes)).toBe(approved.sha256);
    expect(
      sha256Bytes(canonicalJson(JSON.parse(baselineBytes.toString("utf8")))),
    ).toBe(approved.sha256);
  });

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
