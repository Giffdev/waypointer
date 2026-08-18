import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const project = JSON.parse(
  readFileSync(new URL("../.vercel/project.json", import.meta.url), "utf8"),
);

function api(path) {
  const result = spawnSync("vercel", ["api", path, "--raw"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.error?.message ||
        "Unable to inspect Vercel project configuration.",
    );
  }
  return JSON.parse(result.stdout);
}

const query = `teamId=${encodeURIComponent(project.orgId)}`;
const environment = api(
  `/v10/projects/${project.projectId}/env?${query}`,
).envs.filter((entry) => entry.target?.includes("production"));
const settings = api(`/v9/projects/${project.projectName}?${query}`);
const keys = new Set(environment.map((entry) => entry.key));
const durableEnabled = keys.has("FLIGHT_MAP_DURABLE_IMPORTS");

const required = [
  "DATABASE_URL",
  "DB_POOL_MAX",
  "AUTH_URL",
  "AUTH_SECRET",
  "DELETION_TOMBSTONE_SECRET",
  "FLIGHT_MAP_MVP_SYNC_IMPORTS",
  "FLIGHT_MAP_RELEASE_WRITES_PAUSED",
  "IMPORT_STORAGE_BACKEND",
  "IMPORT_MAX_BYTES",
  "IMPORT_RETENTION_DAYS",
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
];
const forbidden = [
  "AUTH_PREVIEW_ACCESS_SECRET",
  "AUTH_PREVIEW_ALLOWED_EMAILS",
  "FLIGHT_MAP_HOSTED_PREVIEW",
  "FLIGHT_MAP_DEV_PREVIEW",
  "AUTH_DEV_EXPOSE_VERIFICATION_LINK",
  "FLIGHT_MAP_RELEASE_PHASE",
  "FLIGHT_MAP_SOURCE_MANIFEST_SHA256",
  "FLIGHT_MAP_DEPLOYMENT_SOURCE_MANIFEST_SHA256",
  "FLIGHT_MAP_CANDIDATE_MANIFEST_SHA256",
  "FLIGHT_MAP_APPROVED_AIRPORT_CANDIDATE_SHA256",
  "FLIGHT_MAP_TARGET_FINGERPRINT",
  "FLIGHT_MAP_MIGRATION_MANIFEST_SHA256",
  "FLIGHT_MAP_CATALOG_CHECKSUM",
  "FLIGHT_MAP_DATABASE_EVIDENCE_SHA256",
];

const failures = [];
for (const key of required) {
  if (!keys.has(key)) failures.push(`missing Production variable: ${key}`);
}
for (const key of forbidden) {
  if (keys.has(key)) failures.push(`deployment-scoped or Preview-only variable is set in Production: ${key}`);
}
const deletionEmail = ["AUTH_EMAIL_FROM", "RESEND_API_KEY"].filter((key) =>
  keys.has(key),
);
if (deletionEmail.length === 1) {
  failures.push(
    "Account deletion email variables must be configured together or both omitted",
  );
}
if (durableEnabled) {
  for (const key of [
    "OBJECT_STORAGE_ENDPOINT",
    "OBJECT_STORAGE_REGION",
    "OBJECT_STORAGE_BUCKET",
    "OBJECT_STORAGE_ACCESS_KEY_ID",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  ]) {
    if (!keys.has(key)) failures.push(`durable imports require Production variable: ${key}`);
  }
}
if (settings.ssoProtection != null) {
  failures.push("Vercel SSO protection is enabled");
}
if (settings.passwordProtection != null) {
  failures.push("Vercel password protection is enabled");
}
if (settings.autoExposeSystemEnvs !== true) {
  failures.push("Vercel system environment variables are not enabled");
}
if (settings.oidcTokenConfig?.enabled !== true) {
  failures.push("Vercel OIDC federation is not enabled");
}

if (failures.length > 0) {
  console.error("Production release configuration is not ready:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Production release configuration names and public access settings are ready. Account deletion is ${
    deletionEmail.length === 2 ? "enabled" : "disabled"
  }. Durable imports are ${
    durableEnabled ? "configured by variable names; verify safe values and worker gates" : "disabled"
  }. Verify documented safe values before deployment.`,
);
