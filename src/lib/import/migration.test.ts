import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MigrationCliError,
  runArtifactMigrationCli,
  type ArtifactMigrationCliDependencies,
} from "../../../scripts/migrate-local-artifact";
import { InMemoryImportRepository } from "./in-memory-repository";
import {
  LocalArtifactValidationError,
  validateLocalArtifact,
} from "./migration";

const userId = "11111111-1111-4111-8111-111111111111";
const foreFlightPath = path.join(
  process.cwd(),
  "src",
  "lib",
  "import",
  "__fixtures__",
  "local-foreflight-v5.json",
);
const fr24Path = path.join(
  process.cwd(),
  "src",
  "lib",
  "import",
  "__fixtures__",
  "local-fr24-v4.json",
);

function dependencies(store = repository()): ArtifactMigrationCliDependencies {
  return {
    repositories: { imports: store, flights: store, airports: store },
    async assertDestinationUser(candidate) {
      if (candidate !== userId) throw new MigrationCliError("user-not-found");
    },
    readArtifact: (sourcePath) => readFile(sourcePath, "utf8"),
    artifactStat: (sourcePath) => stat(sourcePath),
  };
}

function repository(): InMemoryImportRepository {
  const airport = (code: string) => ({
    code,
    name: `Synthetic ${code}`,
    city: code,
    country: "US",
    lat: 0,
    lon: 0,
    facility: "commercial" as const,
  });
  return new InMemoryImportRepository([
    { id: "airport-sea", airport: airport("KSEA"), aliases: ["KSEA", "SEA"] },
    { id: "airport-jfk", airport: airport("KJFK"), aliases: ["KJFK", "JFK"] },
  ]);
}

describe("local artifact validation", () => {
  it.each([
    [foreFlightPath, 5, "ForeFlight"],
    [fr24Path, 4, "FlightRadar24"],
  ])("strictly validates synthetic versioned artifacts", async (file, version, source) => {
    const artifact = validateLocalArtifact(
      JSON.parse(await readFile(file, "utf8")),
    );
    expect(artifact.schemaVersion).toBe(version);
    expect(artifact.flights[0].source).toBe(source);
  });

  it("returns safe codes for malformed and unsupported artifacts", async () => {
    const malformed = JSON.parse(await readFile(foreFlightPath, "utf8"));
    malformed.source.sourceFileSha256 = "private raw value";
    expect(() => validateLocalArtifact(malformed)).toThrowError(
      expect.objectContaining<Partial<LocalArtifactValidationError>>({
        code: "invalid-source-hash",
      }),
    );
    expect(() => validateLocalArtifact({ schemaVersion: 99 })).toThrowError(
      expect.objectContaining<Partial<LocalArtifactValidationError>>({
        code: "unsupported-schema-version",
      }),
    );
  });
});

describe("local artifact migration CLI", () => {
  it("defaults to a non-mutating dry-run and leaves the source unchanged", async () => {
    const store = repository();
    const before = await readFile(foreFlightPath, "utf8");
    const report = await runArtifactMigrationCli(
      ["--user-id", userId, "--source", foreFlightPath],
      dependencies(store),
    );
    expect(report).toMatchObject({
      mode: "dry-run",
      artifactType: "foreflight",
      reused: false,
      status: "dry-run",
      counts: { totalRows: 1, commitReadyRows: 1 },
    });
    expect(await store.listBatches(userId)).toEqual([]);
    expect(await store.listFlights(userId)).toEqual([]);
    expect(await readFile(foreFlightPath, "utf8")).toBe(before);
    const output = JSON.stringify(report);
    expect(output).not.toContain(userId);
    expect(output).not.toContain(foreFlightPath);
    expect(output).not.toContain("KSEA");
  });

  it("applies an FR24 artifact through the shared staged-review contract", async () => {
    const store = repository();
    const report = await runArtifactMigrationCli(
      ["--user-id", userId, "--source", fr24Path, "--apply"],
      dependencies(store),
    );
    expect(report).toMatchObject({
      mode: "apply",
      artifactType: "fr24",
      status: "review",
      counts: { totalRows: 1, acceptedRows: 0 },
    });
    expect(await store.listFlights(userId)).toEqual([]);
    expect(await store.listBatches(userId)).toHaveLength(1);
  });

  it("commits safe rows and makes repeated runs idempotent", async () => {
    const store = repository();
    const args = [
      "--user-id",
      userId,
      "--source",
      foreFlightPath,
      "--commit",
    ];
    const first = await runArtifactMigrationCli(args, dependencies(store));
    const second = await runArtifactMigrationCli(args, dependencies(store));
    expect(first).toMatchObject({
      status: "committed",
      reused: false,
      counts: { committedFlights: 1 },
    });
    expect(second).toMatchObject({
      status: "committed",
      reused: true,
      counts: { committedFlights: 0 },
    });
    expect(await store.listFlights(userId)).toHaveLength(1);
    expect(await store.listBatches(userId)).toHaveLength(1);
  });

  it("requires explicit owner and source arguments and rejects conflicting modes", async () => {
    await expect(
      runArtifactMigrationCli(["--source", foreFlightPath], dependencies()),
    ).rejects.toMatchObject({ code: "invalid-user-id" });
    await expect(
      runArtifactMigrationCli(
        [
          "--user-id",
          userId,
          "--source",
          foreFlightPath,
          "--apply",
          "--commit",
        ],
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "conflicting-mode" });
  });

  it("rejects malformed JSON without creating destination data", async () => {
    const store = repository();
    const deps = dependencies(store);
    deps.readArtifact = async () => "{";
    deps.artifactStat = async () => ({ size: 2, isFile: () => true });
    await expect(
      runArtifactMigrationCli(
        ["--user-id", userId, "--source", "malformed.json"],
        deps,
      ),
    ).rejects.toMatchObject({ code: "invalid-json" });
    expect(await store.listBatches(userId)).toEqual([]);
  });

  it("keeps staged artifacts scoped to the explicit destination owner", async () => {
    const store = repository();
    const secondUserId = "22222222-2222-4222-8222-222222222222";
    const deps = dependencies(store);
    deps.assertDestinationUser = async (candidate) => {
      if (candidate !== secondUserId) throw new MigrationCliError("user-not-found");
    };
    await runArtifactMigrationCli(
      ["--user-id", secondUserId, "--source", foreFlightPath, "--apply"],
      deps,
    );
    expect(await store.listBatches(secondUserId)).toHaveLength(1);
    expect(await store.listBatches(userId)).toEqual([]);
  });
});
