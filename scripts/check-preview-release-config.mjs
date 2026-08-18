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
).envs.filter((entry) => entry.target?.includes("preview"));
const settings = api(`/v9/projects/${project.projectName}?${query}`);
const keys = new Set(environment.map((entry) => entry.key));

const required = [
  "DATABASE_URL",
  "DB_POOL_MAX",
  "AUTH_URL",
  "AUTH_SECRET",
  "FLIGHT_MAP_HOSTED_PREVIEW",
  "IMPORT_STORAGE_BACKEND",
  "IMPORT_MAX_BYTES",
  "DELETION_TOMBSTONE_SECRET",
];
const retired = [
  "AUTH_PREVIEW_ACCESS_SECRET",
  "AUTH_PREVIEW_ALLOWED_EMAILS",
];
const providerPairs = [
  ["AUTH_EMAIL_FROM", "RESEND_API_KEY"],
  ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"],
  ["AUTH_MICROSOFT_ENTRA_ID_ID", "AUTH_MICROSOFT_ENTRA_ID_SECRET"],
];
const firebaseProvider = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
];

const failures = [];
for (const key of required) {
  if (!keys.has(key)) failures.push(`missing current Preview variable: ${key}`);
}
for (const key of retired) {
  if (keys.has(key)) {
    failures.push(`retired Preview variable is still set: ${key}`);
  }
}
for (const pair of providerPairs) {
  const configured = pair.filter((key) => keys.has(key));
  if (configured.length === 1) {
    failures.push(`OAuth provider variables must be all-or-none: ${pair.join(", ")}`);
  }
}
const configuredFirebase = firebaseProvider.filter((key) => keys.has(key));
if (
  configuredFirebase.length > 0 &&
  configuredFirebase.length < firebaseProvider.length
) {
  failures.push(
    `Firebase provider variables must be all-or-none: ${firebaseProvider.join(", ")}`,
  );
}
const hasPublicProvider =
  configuredFirebase.length === firebaseProvider.length ||
  providerPairs.some((pair) => pair.every((key) => keys.has(key)));
if (!hasPublicProvider) {
  failures.push(
    "Preview requires a complete Firebase, Resend, Google, or Microsoft authentication configuration",
  );
}
if (settings.ssoProtection != null) {
  failures.push("Vercel SSO protection is enabled");
}
if (settings.passwordProtection != null) {
  failures.push("Vercel password protection is enabled");
}

if (failures.length > 0) {
  console.error("Preview release configuration is not ready:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "Preview release configuration is ready: current variables are present, retired gates are absent, optional providers are complete pairs, and Vercel access protection is disabled.",
);
