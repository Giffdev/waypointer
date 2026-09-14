import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;

interface PreparedVercelRun {
  readonly event?: unknown;
  readonly path?: unknown;
  readonly head_branch?: unknown;
  readonly head_sha?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
}

export function validatePreparedVercelRun(
  value: unknown,
  expectedCommitSha: string,
): void {
  if (!SHA_PATTERN.test(expectedCommitSha)) {
    throw new Error("Expected prepared commit SHA is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Prepared workflow run provenance is invalid");
  }
  const run = value as PreparedVercelRun;
  if (
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/vercel-deploy.yml" ||
    run.head_branch !== "main" ||
    run.head_sha !== expectedCommitSha ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error("Prepared workflow run provenance is invalid");
  }
}

async function main(): Promise<void> {
  const expectedCommitSha = process.argv[2] ?? "";
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Prepared workflow run response is too large");
    }
  }
  let run: unknown;
  try {
    run = JSON.parse(input);
  } catch {
    throw new Error("Prepared workflow run response is not valid JSON");
  }
  validatePreparedVercelRun(run, expectedCommitSha);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
