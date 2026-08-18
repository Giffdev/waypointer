import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const retiredVariables = [
  "AUTH_PREVIEW_ACCESS_SECRET",
  "AUTH_PREVIEW_ALLOWED_EMAILS",
];
const retiredProductSymbols = [
  "isHostedPreviewRegistrationAllowed",
  "canExposeHostedPreviewAuthLink",
  "previewAccessCode",
  "preview-access-denied",
  "preview-code-hint",
  "preview-access-code",
  "preview-access",
];
const scanTargets = [
  ".env.example",
  ".env.local.example",
  "DEPLOYMENT.md",
  "package.json",
  "src",
  "scripts",
  ".github",
];

function filesUnder(target) {
  const absolute = path.join(root, target);
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) return filesUnder(path.relative(root, child));
    return [child];
  });
}

function isScannable(file) {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  if (
    relative === "scripts/check-public-auth-gates.mjs" ||
    relative === "scripts/check-preview-release-config.mjs" ||
    relative === "scripts/check-production-release-config.mjs" ||
    relative === "scripts/public-auth-smoke.mjs"
  ) {
    return false;
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(relative)) return false;
  return /\.(?:md|json|mjs|js|ts|tsx|yml|yaml|example)$/.test(relative);
}

function localFailures() {
  const failures = [];
  for (const variable of retiredVariables) {
    if (process.env[variable]?.trim()) {
      failures.push(`${variable} is configured in the deployment environment.`);
    }
  }
  for (const file of scanTargets.flatMap(filesUnder).filter(isScannable)) {
    const content = readFileSync(file, "utf8");
    for (const variable of retiredVariables) {
      if (content.includes(variable)) {
        failures.push(
          `${path.relative(root, file)} still references retired ${variable}.`,
        );
      }
    }
    if (path.relative(root, file).replaceAll("\\", "/").startsWith("src/")) {
      for (const symbol of retiredProductSymbols) {
        if (content.includes(symbol)) {
          failures.push(
            `${path.relative(root, file)} still references retired public-auth gate symbol ${symbol}.`,
          );
        }
      }
    }
  }
  return failures;
}

function vercelFailures(environment) {
  const command = process.platform === "win32" ? "vercel.cmd" : "vercel";
  const result = spawnSync(
    command,
    ["env", "list", environment, "--format", "json", "--non-interactive"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    return [
      `Could not audit Vercel ${environment} environment variables: ${
        result.stderr || result.stdout || "unknown error"
      }`.trim(),
    ];
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return [`Vercel ${environment} environment output was not valid JSON.`];
  }
  const names = new Set(
    Array.isArray(payload.envs)
      ? payload.envs.map((entry) => entry?.key).filter(Boolean)
      : [],
  );
  return retiredVariables
    .filter((variable) => names.has(variable))
    .map(
      (variable) =>
        `Vercel ${environment} still configures retired ${variable}.`,
    );
}

const vercelIndex = process.argv.indexOf("--vercel");
const environment =
  vercelIndex >= 0 ? process.argv[vercelIndex + 1] : undefined;
const failures = [
  ...localFailures(),
  ...(environment ? vercelFailures(environment) : []),
];

if (failures.length > 0) {
  console.error("Public authentication gate check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Public authentication gate check passed${
      environment ? ` for Vercel ${environment}` : ""
    }.`,
  );
}
