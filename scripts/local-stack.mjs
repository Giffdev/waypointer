import { copyFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import postgres from "postgres";

const root = path.resolve(import.meta.dirname, "..");
const envPath = path.join(root, ".env.local");
const templatePath = path.join(root, ".env.local.example");
const command = process.argv[2] ?? "dev";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function ensureEnvironment() {
  if (!existsSync(envPath)) {
    if (!existsSync(templatePath)) {
      throw new Error(
        "Create a local .env.local before running the full stack. Environment files and templates are intentionally excluded from source control.",
      );
    }
    copyFileSync(templatePath, envPath);
    console.log("Created .env.local from the local-only .env.local.example.");
  }
  process.loadEnvFile(envPath);
}

function requireLoopbackDatabaseUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the local PostgreSQL stack.`);
  }

  let databaseUrl;
  try {
    databaseUrl = new URL(value);
  } catch {
    throw new Error(`${name} must be an unambiguous PostgreSQL URL.`);
  }

  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !loopbackHosts.has(databaseUrl.hostname) ||
    !databaseUrl.pathname ||
    databaseUrl.pathname === "/"
  ) {
    throw new Error(
      `${name} must target an explicit database on localhost, 127.0.0.1, or ::1.`,
    );
  }

  return databaseUrl;
}

function requireLoopbackDatabaseEnvironment() {
  requireLoopbackDatabaseUrl("DATABASE_URL");
  if (process.env.MIGRATION_DATABASE_URL?.trim()) {
    requireLoopbackDatabaseUrl("MIGRATION_DATABASE_URL");
  }
}

function configureLocalAirportReleaseApproval() {
  const databaseUrl = requireLoopbackDatabaseUrl("DATABASE_URL");
  const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL?.trim()
    ? requireLoopbackDatabaseUrl("MIGRATION_DATABASE_URL")
    : databaseUrl;
  const canonical = (target) =>
    `postgresql://${target.hostname.toLowerCase()}:${target.port || "5432"}/${decodeURIComponent(target.pathname.slice(1))}`;
  if (canonical(databaseUrl) !== canonical(migrationDatabaseUrl)) {
    throw new Error(
      "Local airport refresh requires DATABASE_URL and MIGRATION_DATABASE_URL to target the same database.",
    );
  }
  process.env.MIGRATION_DATABASE_URL = migrationDatabaseUrl.toString();
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/tsx/dist/cli.mjs",
      "scripts/prepare-local-airport-release.ts",
    ],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr || "Local airport release preparation failed.",
    );
  }
  const prepared = JSON.parse(result.stdout);
  process.env.AIRPORT_RELEASE_TARGET_APPROVAL_PATH =
    prepared.targetApprovalPath;
  process.env.AIRPORT_RELEASE_TARGET_APPROVAL_SHA256 =
    prepared.targetApprovalSha256;
  process.env.AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH =
    prepared.candidateManifestPath;
  process.env.AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256 =
    prepared.candidateManifestSha256;
  process.env.AIRPORT_RELEASE_CONFIRMATION =
    `release-airport-catalog:${prepared.targetApprovalSha256}`;
  process.env.AIRPORT_RELEASE_EVIDENCE_DIRECTORY =
    prepared.evidenceDirectory;
}

function requireDocker() {
  const result = spawnSync("docker", ["--version"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      "Docker Desktop with Docker Compose v2 is required for the local PostgreSQL service. Install and start Docker Desktop, then rerun npm run dev:full.",
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Docker is installed but unavailable. Start Docker Desktop and retry. ${result.stderr || result.stdout}`.trim(),
    );
  }
  run("docker", ["compose", "version"], { quiet: true });
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: process.env,
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: options.quiet ? "utf8" : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      options.quiet
        ? `${program} ${args.join(" ")} failed: ${result.stderr || result.stdout}`
        : `${program} ${args.join(" ")} failed with exit code ${result.status}.`,
    );
  }
}

function compose(args, options) {
  run("docker", ["compose", "--env-file", envPath, ...args], options);
}

async function waitForDatabase() {
  const user = process.env.POSTGRES_USER || "flight_map";
  const database = process.env.POSTGRES_DB || "flight_map";
  let consecutiveReadyChecks = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        envPath,
        "exec",
        "-T",
        "db",
        "pg_isready",
        "-U",
        user,
        "-d",
        database,
      ],
      { cwd: root, env: process.env, stdio: "ignore" },
    );
    consecutiveReadyChecks =
      result.status === 0 ? consecutiveReadyChecks + 1 : 0;
    if (consecutiveReadyChecks >= 5) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Local PostgreSQL did not become stably healthy within 60 seconds.");
}

async function up() {
  requireLoopbackDatabaseEnvironment();
  requireDocker();
  compose(["up", "-d", "db"]);
  await waitForDatabase();
  console.log("Local PostgreSQL is healthy on port " + process.env.POSTGRES_PORT + ".");
}

async function setup() {
  await up();
  requireLoopbackDatabaseEnvironment();
  run(process.execPath, [
    "node_modules/tsx/dist/cli.mjs",
    "scripts/safe-migrate.ts",
  ]);
  requireLoopbackDatabaseEnvironment();
  configureLocalAirportReleaseApproval();
  run(process.execPath, [
    "node_modules/tsx/dist/cli.mjs",
    "scripts/release-airport-catalog.ts",
  ]);
}

function runNpmScript(name) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm executable path is unavailable.");
  run(process.execPath, [npmCli, "run", name]);
}

function runPostgresTests() {
  process.env.FLIGHT_MAP_RUN_POSTGRES_IMPORT_TESTS = "true";
  process.env.FLIGHT_MAP_RUN_POSTGRES_SCHEMA_TESTS = "true";
  run(process.execPath, [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--maxWorkers=1",
    "src/lib/db/launch-schema.postgres.test.ts",
    "src/lib/import/drizzle-import-repository.postgres.test.ts",
    "src/lib/import/airport-repository.postgres.test.ts",
    "src/lib/flights/backfill.postgres.test.ts",
    "src/lib/jobs/repository.postgres.test.ts",
    "src/lib/profile/service.postgres.test.ts",
    "src/lib/sharing/service.postgres.test.ts",
  ]);
}

async function provisionPostgresTestRole() {
  const databaseUrl = requireLoopbackDatabaseUrl("DATABASE_URL");

  process.env.MIGRATION_DATABASE_URL = databaseUrl.toString();
  const role = "flight_map_test_app";
  const password = randomBytes(24).toString("hex");
  const admin = postgres(databaseUrl.toString(), {
    max: 1,
    onnotice: () => {},
  });
  const database = databaseUrl.pathname.slice(1);
  try {
    await admin.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${role}') then
          create role ${role} login;
        end if;
      end
      $$;
      alter role ${role}
        with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls
        password '${password}';
      grant connect on database "${database}" to ${role};
      grant usage on schema public to ${role};
      grant select, insert, update, delete on all tables in schema public to ${role};
      grant usage, select, update on all sequences in schema public to ${role};
      grant execute on function public_map_projection(uuid, text) to ${role};
    `);
  } finally {
    await admin.end();
  }

  databaseUrl.username = role;
  databaseUrl.password = password;
  process.env.DATABASE_URL = databaseUrl.toString();
}

async function main() {
  ensureEnvironment();
  if (command === "down") {
    requireDocker();
    compose(["down"]);
    return;
  }
  requireLoopbackDatabaseEnvironment();
  if (command === "up") {
    await up();
    return;
  }
  if (command === "setup") {
    await setup();
    return;
  }
  if (command === "test:postgres") {
    await up();
    try {
      process.env.MIGRATION_DATABASE_URL = process.env.DATABASE_URL;
      requireLoopbackDatabaseEnvironment();
      run(process.execPath, [
        "node_modules/tsx/dist/cli.mjs",
        "scripts/safe-migrate.ts",
      ]);
      await provisionPostgresTestRole();
      runPostgresTests();
    } finally {
      compose(["down", "--volumes", "--remove-orphans"]);
    }
    return;
  }
  if (command === "test:airport-release") {
    await up();
    try {
      process.env.MIGRATION_DATABASE_URL = process.env.DATABASE_URL;
      requireLoopbackDatabaseEnvironment();
      run(process.execPath, [
        "node_modules/tsx/dist/cli.mjs",
        "scripts/safe-migrate.ts",
      ]);
      process.env.FLIGHT_MAP_RUN_POSTGRES_SCHEMA_TESTS = "true";
      run(process.execPath, [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--maxWorkers=1",
        "scripts/airport-release-upgrade.postgres.test.ts",
      ]);
      const results = [];
      for (let pass = 0; pass < 2; pass += 1) {
        configureLocalAirportReleaseApproval();
        run(process.execPath, [
          "node_modules/tsx/dist/cli.mjs",
          "scripts/release-airport-catalog.ts",
        ]);
        const client = postgres(process.env.DATABASE_URL, {
          max: 1,
          prepare: false,
          onnotice: () => {},
        });
        try {
          const [audit] = await client`
            select
              count(*)::integer as airports,
              (select count(*)::integer from airport_aliases) as aliases,
              md5(string_agg(id::text || ':' || source_ident, ',' order by id))
                as checksum
            from airports
          `;
          results.push(audit);
        } finally {
          await client.end();
        }
      }
      if (
        results[0].checksum !== results[1].checksum ||
        results[0].airports !== results[1].airports ||
        results[0].aliases !== results[1].aliases
      ) {
        throw new Error("Airport catalog rerun evidence did not match.");
      }
      console.log(
        `Airport catalog rerun checksum verified: ${results[1].checksum}.`,
      );
    } finally {
      compose(["down", "--volumes", "--remove-orphans"]);
    }
    return;
  }
  if (command === "check-full") {
    await setup();
    runNpmScript("check");
    runPostgresTests();
    runNpmScript("test:e2e");
    return;
  }
  if (command !== "dev") throw new Error(`Unknown local stack command: ${command}`);

  await setup();
  console.log("Starting full local Waypointer at http://localhost:3000");
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev"],
    { cwd: root, env: process.env, stdio: "inherit" },
  );
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
