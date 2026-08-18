import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./local-stack.mjs", import.meta.url));

function runSetup(
  databaseUrl: string,
  migrationDatabaseUrl: string | undefined = undefined,
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PATH: "",
  };
  if (migrationDatabaseUrl === undefined) {
    delete env.MIGRATION_DATABASE_URL;
  } else {
    env.MIGRATION_DATABASE_URL = migrationDatabaseUrl;
  }

  return spawnSync(process.execPath, [script, "setup"], {
    encoding: "utf8",
    env,
  });
}

describe("local PostgreSQL stack safety", () => {
  it("rejects a remote DATABASE_URL before invoking Docker or migrations", () => {
    const result = runSetup("postgres://flight_map:secret@db.example.test/flight_map");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "DATABASE_URL must target an explicit database on localhost",
    );
    expect(result.stderr).not.toContain("Docker Desktop");
  });

  it("rejects an unparseable DATABASE_URL before invoking Docker or migrations", () => {
    const result = runSetup("not a database URL");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "DATABASE_URL must be an unambiguous PostgreSQL URL",
    );
    expect(result.stderr).not.toContain("Docker Desktop");
  });

  it("rejects a remote migration override before invoking Docker or migrations", () => {
    const result = runSetup(
      "postgres://flight_map:secret@127.0.0.1:54329/flight_map",
      "postgres://migration:secret@db.example.test/flight_map",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "MIGRATION_DATABASE_URL must target an explicit database on localhost",
    );
    expect(result.stderr).not.toContain("Docker Desktop");
  });
});
