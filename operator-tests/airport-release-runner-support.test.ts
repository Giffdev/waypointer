import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const support = path.join(
  root,
  "ops",
  "airport-release-runner-support.ps1",
);
const shell = "pwsh";
const scratchPaths: string[] = [];

function runPowerShell(script: string) {
  return spawnSync(
    shell,
    ["-NoProfile", "-Command", script],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths.splice(0).map((scratch) =>
      rm(scratch, { recursive: true, force: true })
    ),
  );
});

describe("airport release runner support", () => {
  it("prefers a global neonctl executable", () => {
    const result = runPowerShell(`
function Get-Command {
  param($Name, $CommandType, $ErrorAction)
  if ($Name -contains 'neonctl.cmd') {
    [pscustomobject]@{ Source = 'C:\\tools\\neonctl.cmd' }
  }
}
. ${quotePowerShell(support)}
Resolve-NeonCliInvocation | ConvertTo-Json -Compress
`);

    expect(
      result.status,
      `${result.stdout}\n${result.stderr}`,
    ).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Executable: "C:\\tools\\neonctl.cmd",
      PrefixArguments: [],
      AttestationExecutable: "neonctl",
    });
  });

  it("falls back to the persisted-auth npx neonctl pair", () => {
    const result = runPowerShell(`
function Get-Command {
  param($Name, $CommandType, $ErrorAction)
  if ($Name -contains 'npx.cmd' -and $Name -notcontains 'neonctl.cmd') {
    [pscustomobject]@{ Source = 'C:\\Program Files\\nodejs\\npx.cmd' }
  }
}
. ${quotePowerShell(support)}
Resolve-NeonCliInvocation | ConvertTo-Json -Compress
`);

    expect(
      result.status,
      `${result.stdout}\n${result.stderr}`,
    ).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Executable: "C:\\Program Files\\nodejs\\npx.cmd",
      PrefixArguments: ["--yes", "neonctl"],
      AttestationExecutable: "npx",
    });
  });

  it("fails closed when neither Neon invocation is available", () => {
    const result = runPowerShell(`
function Get-Command { param($Name, $CommandType, $ErrorAction) }
. ${quotePowerShell(support)}
try {
  Resolve-NeonCliInvocation | Out-Null
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 9
}
`);

    expect(result.status).toBe(9);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("neon-authentication-required");
  });

  it("fails with a distinct action when Vercel auth is unavailable", () => {
    const result = runPowerShell(`
function Get-Command { param($Name, $CommandType, $ErrorAction) }
. ${quotePowerShell(support)}
try {
  Assert-VercelCliAuthentication
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 11
}
`);

    expect(result.status).toBe(11);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("vercel-authentication-required");
  });

  it("binds a newly generated expectation instead of a stale file", () => {
    const scratch = path.join(
      root,
      `.operator-test-${process.pid}-${Date.now()}`,
    );
    scratchPaths.push(scratch);

    const result = runPowerShell(`
. ${quotePowerShell(support)}
$root = ${quotePowerShell(scratch)}
$approvals = Join-Path $root 'data\\private\\release-approvals'
[IO.Directory]::CreateDirectory($approvals) | Out-Null
$staleBytes = [Text.Encoding]::UTF8.GetBytes('{"expiresAt":"2020-01-01T00:00:00Z"}')
$freshBytes = [Text.Encoding]::UTF8.GetBytes('{"expiresAt":"2099-01-01T00:00:00Z"}')
$staleHash = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData($staleBytes)
).ToLowerInvariant()
$freshHash = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData($freshBytes)
).ToLowerInvariant()
[IO.File]::WriteAllBytes(
  (Join-Path $approvals "vercel-provider-expectation-$staleHash.json"),
  $staleBytes
)
[IO.File]::WriteAllBytes(
  (Join-Path $approvals "vercel-provider-expectation-$freshHash.json"),
  $freshBytes
)
$freshRelative = "data\\private\\release-approvals\\vercel-provider-expectation-$freshHash.json"
$selected = Resolve-FreshProviderExpectation $root {
  [pscustomobject]@{
    providerExpectationPath = $freshRelative
    providerExpectationSha256 = $freshHash
  }
}
[pscustomobject]@{
  selected = $selected
  staleHash = $staleHash
} | ConvertTo-Json -Depth 4 -Compress
`);

    expect(
      result.status,
      `${result.stdout}\n${result.stderr}`,
    ).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.selected.RelativePath).toContain(
      `vercel-provider-expectation-${output.selected.Sha256}.json`,
    );
    expect(output.selected.Sha256).not.toBe(output.staleHash);
  });

  it("converts provider generation failure to a fail-closed gate", () => {
    const result = runPowerShell(`
. ${quotePowerShell(support)}
try {
  Resolve-FreshProviderExpectation ${quotePowerShell(root)} {
    [pscustomobject]@{
      providerExpectationPath = 'bad-path.json'
      providerExpectationSha256 = '${"a".repeat(64)}'
    }
  } | Out-Null
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 10
}
`);

    expect(result.status).toBe(10);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("vercel-provider-verification-failed");
  });
});
