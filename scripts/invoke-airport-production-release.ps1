param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Prepare", "Release", "Health", "Rollback")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:MIGRATION_DATABASE_URL)) {
  throw "Set MIGRATION_DATABASE_URL in this PowerShell session, then launch this script from the same shell."
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$node = Join-Path $root "node_modules\tsx\dist\cli.mjs"
$scripts = @{
  Prepare  = "prepare-airport-production-release.ts"
  Release  = "release-airport-catalog.ts"
  Health   = "airport-release-health.ts"
  Rollback = "airport-release-rollback.ts"
}

Push-Location $root
try {
  & node $node (Join-Path $PSScriptRoot $scripts[$Action])
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
