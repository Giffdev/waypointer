[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$providerSha256 = "1cb8af7afc10feca2196ec1480787382a37b1b594b184346aef97346e222c1f9"
$candidateSha256 = "e75537fa3a8313ddcf7ce1081bfbbf59286255702a48f4aac89b8a1d5105ac4e"
$approvedAirportCandidateSha256 = "12a1816ff66d4eefaef954ad1ac126087fad44d72e8586ac233c6cc4fddf98d3"
$expectedDeploymentId = "dpl_63kfw6a2YJzQR2xQ6zHgHyCSwGXH"
$providerCommit = "7fc3cafa61177290f37a33416411ee04aaba4278"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseRoot = Join-Path $root ".operator-release-worktree"
$tsx = Join-Path $root "node_modules\tsx\dist\cli.mjs"
$operatorHelper = Join-Path $PSScriptRoot "airport-release-operator.ts"
$prepareScript = Join-Path $releaseRoot "scripts\prepare-airport-production-release.ts"
$releaseScript = Join-Path $releaseRoot "scripts\release-airport-catalog.ts"
$healthScript = Join-Path $releaseRoot "scripts\airport-release-health.ts"
$evidenceDirectory = Join-Path $root "artifacts\release-evidence\airport-catalog"
$secretEnvironmentNames = @(
  "MIGRATION_DATABASE_URL",
  "AIRPORT_RELEASE_HEALTH_SESSION_COOKIE",
  "AIRPORT_RELEASE_VERCEL_API_TOKEN"
)

$stage = "initialization"
$failureMessage = $null
$snapshotId = $null
$snapshotAttestationSha256 = $null
$approvalResult = $null
$databaseEvidencePath = $null
$databaseEvidenceSha256 = $null
$healthStatus = "not-run"
$releaseStarted = $false
$worktreeCreated = $false

function Get-Sha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Copy-VerifiedArtifact(
  [string]$SourceRoot,
  [string]$DestinationRoot,
  [string]$RelativePath,
  [string]$ExpectedSha256
) {
  $source = Join-Path $SourceRoot $RelativePath
  $destination = Join-Path $DestinationRoot $RelativePath
  if (
    -not (Test-Path -LiteralPath $source) -or
    (Get-Sha256 $source) -ne $ExpectedSha256
  ) {
    throw "artifact-copy-source-invalid"
  }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) |
    Out-Null
  if (Test-Path -LiteralPath $destination) {
    if ((Get-Sha256 $destination) -ne $ExpectedSha256) {
      throw "artifact-copy-destination-invalid"
    }
    return
  }
  [IO.File]::Copy($source, $destination, $false)
  if ((Get-Sha256 $destination) -ne $ExpectedSha256) {
    throw "artifact-copy-failed"
  }
}

function Sync-CandidateSource(
  [string]$CandidatePath,
  [string]$SourceRoot,
  [string]$DestinationRoot
) {
  $candidate = Get-Content -Raw -LiteralPath $CandidatePath |
    ConvertFrom-Json
  foreach ($entry in $candidate.source.files) {
    $relativePath = [string]$entry.path
    $expectedSha256 = [string]$entry.sha256
    if (
      [string]::IsNullOrWhiteSpace($relativePath) -or
      [IO.Path]::IsPathRooted($relativePath) -or
      $relativePath -match '(^|/)\.\.(/|$)' -or
      $relativePath.Contains("\")
    ) {
      throw "candidate-source-path-invalid"
    }
    $platformPath = $relativePath.Replace("/", [IO.Path]::DirectorySeparatorChar)
    $destination = Join-Path $DestinationRoot $platformPath
    if (
      (Test-Path -LiteralPath $destination) -and
      (Get-Sha256 $destination) -eq $expectedSha256
    ) {
      continue
    }
    $source = Join-Path $SourceRoot $platformPath
    if (
      -not (Test-Path -LiteralPath $source) -or
      (Get-Sha256 $source) -ne $expectedSha256
    ) {
      throw "candidate-source-unavailable"
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) |
      Out-Null
    [IO.File]::Copy($source, $destination, $true)
  }
}

function Set-SecureEnvironmentValue([string]$Name, [string]$Prompt) {
  $secureValue = Read-Host -Prompt $Prompt -AsSecureString
  Set-EnvironmentFromSecureString $Name $secureValue
}

function Set-EnvironmentFromSecureString(
  [string]$Name,
  [Security.SecureString]$SecureValue
) {
  $bstr = [IntPtr]::Zero
  $plainValue = $null
  try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plainValue)) {
      throw "empty-secret"
    }
    Set-Item -Path "Env:$Name" -Value $plainValue
  }
  finally {
    $plainValue = $null
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Invoke-JsonNode([string]$Script, [string[]]$Arguments) {
  $output = @(& node $tsx $Script @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "node-gate-failed"
  }
  try {
    return ($output[-1] | ConvertFrom-Json)
  }
  catch {
    throw "node-output-invalid"
  }
}

function Invoke-ReleaseNode([string]$Script) {
  $output = @(& node $tsx $Script 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "node-gate-failed"
  }
  foreach ($line in $output) {
    Write-Host $line
  }
  return $output
}

function Get-NeonCommand {
  $neonCommand = Get-Command neonctl, neon -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $neonCommand) {
    throw "neon-authentication-required"
  }
  return $neonCommand
}

function Invoke-NeonJson(
  [object]$NeonCommand,
  [string[]]$Arguments
) {
  $output = @(& $NeonCommand.Source @Arguments 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw "neon-provider-query-failed"
  }
  try {
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json)
  }
  catch {
    throw "neon-provider-query-failed"
  }
}

function Get-AuthenticatedNeonProjects([object]$NeonCommand) {
  $output = @(& $NeonCommand.Source projects list --output json 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw "neon-authentication-required"
  }
  try {
    $projects = @(($output -join [Environment]::NewLine) | ConvertFrom-Json)
  }
  catch {
    throw "neon-provider-query-failed"
  }
  return $projects
}

function Assert-NeonProductionBranch(
  [object]$NeonCommand,
  [string]$ProjectId,
  [string]$ProductionBranchId
) {
  $branches = @(Invoke-NeonJson $NeonCommand @(
    "branches", "list",
    "--project-id", $ProjectId,
    "--output", "json"
  ))
  $parent = @($branches | Where-Object {
    $_.id -eq $ProductionBranchId -and
    $_.project_id -eq $ProjectId -and
    $_.current_state -eq "ready"
  })
  if ($parent.Count -ne 1) {
    throw "neon-production-branch-verification-failed"
  }
}

function New-NeonSnapshot(
  [object]$NeonCommand,
  [string]$SnapshotName,
  [string]$ProjectId,
  [string]$ProductionBranchId
) {
  $output = @(
    & $NeonCommand.Source branches create `
      --name $SnapshotName `
      --parent $ProductionBranchId `
      --project-id $ProjectId `
      --output json 2>$null
  )
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  try {
    $created = (($output -join [Environment]::NewLine) | ConvertFrom-Json)
    if (
      $created.branch.parent_id -ne $ProductionBranchId -or
      $created.branch.project_id -ne $ProjectId -or
      $created.branch.id -notmatch '^br-[a-z0-9-]{3,240}$'
    ) {
      throw "neon-snapshot-creation-response-invalid"
    }
    return [string]$created.branch.id
  }
  catch {
    throw "neon-snapshot-creation-response-invalid"
  }
}

function ConvertTo-Base64Json([object]$Value) {
  $json = $Value | ConvertTo-Json -Depth 10 -Compress
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
}

function Write-OperatorEvidence([string]$Status, [string]$BlockedStage) {
  $evidence = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    status = $Status
    blockedStage = $BlockedStage
    providerExpectationSha256 = $providerSha256
    candidateManifestSha256 = $candidateSha256
    approvedAirportCandidateSha256 = $approvedAirportCandidateSha256
    deploymentId = $expectedDeploymentId
    snapshotId = $snapshotId
    snapshotAttestationSha256 = $snapshotAttestationSha256
    targetApprovalSha256 = if ($null -ne $approvalResult) {
      $approvalResult.approvalSha256
    } else {
      $null
    }
    preflightSha256 = if ($null -ne $approvalResult) {
      $approvalResult.preflightSha256
    } else {
      $null
    }
    databaseEvidenceSha256 = $databaseEvidenceSha256
    healthStatus = $healthStatus
    containsCredentials = $false
  }
  $json = ($evidence | ConvertTo-Json -Depth 8) + [Environment]::NewLine
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $hashBytes = [Security.Cryptography.SHA256]::HashData($bytes)
  $hash = [Convert]::ToHexString($hashBytes).ToLowerInvariant()
  $path = Join-Path $evidenceDirectory "airport-operator-release-$hash.json"
  [IO.Directory]::CreateDirectory($evidenceDirectory) | Out-Null
  if (Test-Path -LiteralPath $path) {
    if ((Get-Sha256 $path) -ne $hash) {
      throw "operator-evidence-mismatch"
    }
  }
  else {
    $stream = [IO.File]::Open(
      $path,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    try {
      $stream.Write($bytes, 0, $bytes.Length)
    }
    finally {
      $stream.Dispose()
    }
  }
  Write-Host "Operator evidence: $([IO.Path]::GetRelativePath($root, $path)) sha256=$hash"
}

$neonApiKeySecure = $null
if (-not [string]::IsNullOrWhiteSpace($env:NEON_API_KEY)) {
  $neonApiKeySecure = ConvertTo-SecureString `
    -String $env:NEON_API_KEY -AsPlainText -Force
}
Remove-Item -Path "Env:NEON_API_KEY" -ErrorAction SilentlyContinue
foreach ($name in $secretEnvironmentNames) {
  Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
}

Push-Location $root
try {
  $stage = "Neon authentication"
  $neonCommand = Get-NeonCommand
  if ($null -ne $neonApiKeySecure) {
    Set-EnvironmentFromSecureString "NEON_API_KEY" $neonApiKeySecure
  }
  try {
    $neonProjects = @(Get-AuthenticatedNeonProjects $neonCommand)
    $neonProjectId = [string]$env:NEON_PROJECT_ID
    $productionBranchId = [string]$env:NEON_PRODUCTION_BRANCH_ID
    if (
      [string]::IsNullOrWhiteSpace($neonProjectId) -or
      [string]::IsNullOrWhiteSpace($productionBranchId)
    ) {
      throw "neon-provider-configuration-missing"
    }
    $neonProject = @($neonProjects | Where-Object {
      $_.id -eq $neonProjectId
    })
    if ($neonProject.Count -ne 1) {
      throw "neon-project-verification-failed"
    }
    Assert-NeonProductionBranch `
      $neonCommand $neonProjectId $productionBranchId
  }
  finally {
    Remove-Item -Path "Env:NEON_API_KEY" -ErrorAction SilentlyContinue
  }

  $stage = "artifact verification"
  $providerPath = Join-Path $root "data\private\release-approvals\vercel-provider-expectation-$providerSha256.json"
  $candidatePath = Join-Path $root "artifacts\release-evidence\airport-catalog\candidate-$candidateSha256.json"
  if (
    -not (Test-Path -LiteralPath $providerPath) -or
    -not (Test-Path -LiteralPath $candidatePath) -or
    (Get-Sha256 $providerPath) -ne $providerSha256 -or
    (Get-Sha256 $candidatePath) -ne $candidateSha256
  ) {
    throw "approved-artifact-missing"
  }
  $provider = Get-Content -Raw -LiteralPath $providerPath | ConvertFrom-Json
  if (
    $provider.deploymentId -ne $expectedDeploymentId -or
    $provider.sourceCommit.commitSha -ne $providerCommit -or
    $provider.approvedAirportCandidateSha256 -ne $approvedAirportCandidateSha256 -or
    $provider.candidateManifestSha256 -ne $candidateSha256 -or
    [DateTimeOffset]::Parse($provider.expiresAt) -le [DateTimeOffset]::UtcNow
  ) {
    throw "provider-expectation-invalid"
  }
  $currentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
  $currentCommit = (git rev-parse HEAD).Trim()
  $originMain = (git rev-parse origin/main).Trim()
  $trackedStatus = @(git status --porcelain --untracked-files=no)
  git merge-base --is-ancestor $providerCommit origin/main
  if (
    $LASTEXITCODE -ne 0 -or
    $currentBranch -ne "main" -or
    $currentCommit -ne $originMain -or
    $trackedStatus.Count -ne 0
  ) {
    throw "main-checkout-not-clean"
  }
  if (Test-Path -LiteralPath $releaseRoot) {
    throw "release-worktree-already-exists"
  }
  git worktree add --detach $releaseRoot $providerCommit --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "release-worktree-create-failed"
  }
  $worktreeCreated = $true
  Copy-VerifiedArtifact $root $releaseRoot `
    ([IO.Path]::GetRelativePath($root, $providerPath)) $providerSha256
  Copy-VerifiedArtifact $root $releaseRoot `
    ([IO.Path]::GetRelativePath($root, $candidatePath)) $candidateSha256
  Sync-CandidateSource $candidatePath $root $releaseRoot
  Push-Location $releaseRoot
  try {
    $verificationScript = @"
import { verifyCandidateManifest } from './scripts/airport-release-provenance.ts';
void (async () => {
  await verifyCandidateManifest(
    'artifacts/release-evidence/airport-catalog/candidate-$candidateSha256.json',
    '$candidateSha256',
  );
})()
"@
    $candidateVerification = @(
      & node $tsx -e $verificationScript 2>&1
    )
    if ($LASTEXITCODE -ne 0) {
      throw "candidate-materialization-invalid"
    }
  }
  finally {
    Pop-Location
  }

  $stage = "secret collection"
  Set-SecureEnvironmentValue "MIGRATION_DATABASE_URL" `
    "Neon owner/DDL MIGRATION_DATABASE_URL (session-only)"
  if ([string]::IsNullOrWhiteSpace($env:AIRPORT_RELEASE_VERCEL_API_TOKEN)) {
    Set-SecureEnvironmentValue "AIRPORT_RELEASE_VERCEL_API_TOKEN" `
      "Vercel API token for fresh provider verification (session-only)"
  }
  if ([string]::IsNullOrWhiteSpace($env:AIRPORT_RELEASE_HEALTH_SESSION_COOKIE)) {
    Set-SecureEnvironmentValue "AIRPORT_RELEASE_HEALTH_SESSION_COOKIE" `
      "Ephemeral dedicated health-account cookie (session-only)"
  }

  $env:AIRPORT_RELEASE_PROVIDER_EXPECTATION_PATH =
    [IO.Path]::GetRelativePath($root, $providerPath)
  $env:AIRPORT_RELEASE_PROVIDER_EXPECTATION_SHA256 = $providerSha256
  $env:AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH =
    [IO.Path]::GetRelativePath($root, $candidatePath)
  $env:AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256 = $candidateSha256
  $env:AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256 =
    $approvedAirportCandidateSha256
  $env:AIRPORT_RELEASE_EVIDENCE_DIRECTORY =
    [IO.Path]::GetRelativePath($root, $evidenceDirectory)
  $env:AIRPORT_RELEASE_APPROVAL_ID =
    "airport-prod-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ'))"

  $stage = "target inspection"
  $target = Invoke-JsonNode $operatorHelper @("inspect")
  Write-Host "Target verified: database=$($target.databaseName) oid=$($target.databaseOid)"
  Write-Host "Target fingerprint: $($target.targetFingerprint)"
  Write-Host "Pre-change state: $($target.preChangeStateSha256)"

  $stage = "Neon snapshot creation"
  $snapshotName =
    "airport-prod-$([DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss'))"
  if ($null -ne $neonApiKeySecure) {
    Set-EnvironmentFromSecureString "NEON_API_KEY" $neonApiKeySecure
  }
  try {
    $snapshotId = New-NeonSnapshot `
      $neonCommand $snapshotName $neonProjectId $productionBranchId
    $snapshotAttempts = 15
    if ($null -eq $snapshotId) {
      Write-Host ""
      Write-Host "One-time Neon Console action required:"
      Write-Host "Create branch '$snapshotName' from the Production branch with a read-write compute endpoint, without changing Production."
      Write-Host "After Neon reports the branch Ready, copy its non-secret branch ID (br-...)."
      $snapshotId = (Read-Host "Neon snapshot branch ID").Trim()
      $snapshotAttempts = 1
    }
    if ($snapshotId -notmatch '^br-[a-z0-9-]{3,240}$') {
      throw "snapshot-id-invalid"
    }
    $verifiedSnapshot = Invoke-JsonNode $operatorHelper @(
      "provider-verify",
      "--neon-executable", [string]$neonCommand.Source,
      "--neon-project-id", $neonProjectId,
      "--production-branch-id", $productionBranchId,
      "--snapshot-id", $snapshotId,
      "--attempts", [string]$snapshotAttempts
    )
  }
  finally {
    Remove-Item -Path "Env:NEON_API_KEY" -ErrorAction SilentlyContinue
  }
  Write-Host "Neon snapshot verified by provider: $snapshotId"
  $restoreWithNeonctl = $neonCommand.Name -eq "neonctl"

  $stage = "snapshot attestation"
  $attestArguments = @(
    "attest",
    "--snapshot-id", $snapshotId,
    "--target-fingerprint", [string]$target.targetFingerprint,
    "--database-name", [string]$target.databaseName,
    "--database-oid", [string]$target.databaseOid,
    "--pre-change-state-sha256", [string]$target.preChangeStateSha256,
    "--neon-project-id", $neonProjectId,
    "--production-branch-id", $productionBranchId,
    "--provider-branch-base64",
    (ConvertTo-Base64Json $verifiedSnapshot.branch),
    "--provider-endpoints-base64",
    (ConvertTo-Base64Json @($verifiedSnapshot.endpoints))
  )
  if ($restoreWithNeonctl) {
    $attestArguments += "--restore-with-neonctl"
  }
  $snapshot = Invoke-JsonNode $operatorHelper $attestArguments
  $env:AIRPORT_RELEASE_SNAPSHOT_ATTESTATION_PATH = [string]$snapshot.path
  $env:AIRPORT_RELEASE_SNAPSHOT_ATTESTATION_SHA256 = [string]$snapshot.sha256
  $snapshotAttestationSha256 = [string]$snapshot.sha256
  Write-Host "Snapshot attestation: $($snapshot.path) sha256=$($snapshot.sha256)"
  Copy-VerifiedArtifact $root $releaseRoot `
    ([string]$snapshot.path) ([string]$snapshot.sha256)

  $stage = "Prepare"
  Push-Location $releaseRoot
  try {
    $approvalResult = Invoke-JsonNode $prepareScript @()
  }
  finally {
    Pop-Location
  }
  $env:AIRPORT_RELEASE_TARGET_APPROVAL_PATH =
    [string]$approvalResult.approvalPath
  $env:AIRPORT_RELEASE_TARGET_APPROVAL_SHA256 =
    [string]$approvalResult.approvalSha256
  $env:AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_PATH =
    [string]$approvalResult.preflightPath
  $env:AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_SHA256 =
    [string]$approvalResult.preflightSha256
  Write-Host ""
  Write-Host "Prepare passed."
  Write-Host "Approval: $($approvalResult.approvalPath) sha256=$($approvalResult.approvalSha256)"
  Write-Host "Preflight: $($approvalResult.preflightPath) sha256=$($approvalResult.preflightSha256)"
  Copy-VerifiedArtifact $releaseRoot $root `
    ([string]$approvalResult.approvalPath) `
    ([string]$approvalResult.approvalSha256)
  Copy-VerifiedArtifact $releaseRoot $root `
    ([string]$approvalResult.preflightPath) `
    ([string]$approvalResult.preflightSha256)

  $stage = "operator confirmation"
  $requiredConfirmation = "RELEASE $($approvalResult.approvalSha256)"
  Write-Host ""
  Write-Host "Type exactly: $requiredConfirmation"
  $typedConfirmation = Read-Host "Release confirmation"
  if ($typedConfirmation -cne $requiredConfirmation) {
    throw "operator-confirmation-missing"
  }
  $env:AIRPORT_RELEASE_CONFIRMATION =
    "release-airport-catalog:$($approvalResult.approvalSha256)"

  $stage = "Release"
  $releaseStarted = $true
  Push-Location $releaseRoot
  try {
    $releaseOutput = Invoke-ReleaseNode $releaseScript
  }
  finally {
    Pop-Location
  }
  $evidenceMatch = [regex]::Match(
    ($releaseOutput -join [Environment]::NewLine),
    'Evidence:\s+(?<path>\S+)\s+sha256=(?<sha>[a-f0-9]{64})'
  )
  if (-not $evidenceMatch.Success) {
    throw "database-evidence-missing"
  }
  $databaseEvidencePath = $evidenceMatch.Groups["path"].Value
  $databaseEvidenceSha256 = $evidenceMatch.Groups["sha"].Value
  Copy-VerifiedArtifact $releaseRoot $root `
    $databaseEvidencePath $databaseEvidenceSha256

  $stage = "Health"
  if (
    $provider.releasePhase -eq "database-released" -and
    -not [string]::IsNullOrWhiteSpace($env:AIRPORT_RELEASE_HEALTH_SESSION_COOKIE)
  ) {
    $env:AIRPORT_RELEASE_DATABASE_EVIDENCE_PATH = $databaseEvidencePath
    $env:AIRPORT_RELEASE_DATABASE_EVIDENCE_SHA256 = $databaseEvidenceSha256
    Push-Location $releaseRoot
    try {
      Invoke-ReleaseNode $healthScript | Out-Null
    }
    finally {
      Pop-Location
    }
    $healthStatus = "passed"
  }
  else {
    $healthStatus = "deferred-provider-expectation-control-plane"
    Write-Host "Health deferred: the approved provider expectation is control-plane phase."
  }

}
catch {
  if (
    -not $releaseStarted -and
    $_.Exception.Message -eq "neon-authentication-required"
  ) {
    $failureMessage = "neonctl auth"
  }
  elseif ($releaseStarted) {
    $failureMessage =
      "Release reached '$stage' and commit status may be committed. Do not retry; verify database state and use any emitted database evidence before following the approved health/rollback stop condition."
  }
  else {
    $failureMessage =
      "Airport release stopped at '$stage' with no database commit. Fix that gate and rerun this command."
  }
}
finally {
  foreach ($name in $secretEnvironmentNames) {
    Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
  }
  foreach ($name in @(
    "AIRPORT_RELEASE_PROVIDER_EXPECTATION_PATH",
    "AIRPORT_RELEASE_PROVIDER_EXPECTATION_SHA256",
    "AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH",
    "AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256",
    "AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256",
    "AIRPORT_RELEASE_EVIDENCE_DIRECTORY",
    "AIRPORT_RELEASE_APPROVAL_ID",
    "AIRPORT_RELEASE_SNAPSHOT_ATTESTATION_PATH",
    "AIRPORT_RELEASE_SNAPSHOT_ATTESTATION_SHA256",
    "AIRPORT_RELEASE_TARGET_APPROVAL_PATH",
    "AIRPORT_RELEASE_TARGET_APPROVAL_SHA256",
    "AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_PATH",
    "AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_SHA256",
    "AIRPORT_RELEASE_CONFIRMATION",
    "AIRPORT_RELEASE_DATABASE_EVIDENCE_PATH",
    "AIRPORT_RELEASE_DATABASE_EVIDENCE_SHA256"
  )) {
    Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
  }
  if ($worktreeCreated) {
    git worktree remove --force $releaseRoot 2>$null
    if ($LASTEXITCODE -ne 0) {
      $cleanupMessage =
        "Remove '.operator-release-worktree' before any further operator attempt."
      $failureMessage = if ($null -eq $failureMessage) {
        if ($releaseStarted) {
          "Database release completed, but the reviewed worktree could not be removed. Do not rerun the release. $cleanupMessage"
        }
        else {
          "Release flow stopped and the reviewed worktree could not be removed. $cleanupMessage"
        }
      }
      else {
        "$failureMessage $cleanupMessage"
      }
    }
  }
  Pop-Location
}

if ($failureMessage -eq "neonctl auth") {
  [Console]::Error.WriteLine($failureMessage)
  exit 1
}

try {
  $operatorStatus = if ($null -ne $failureMessage) {
    "blocked"
  }
  elseif ($healthStatus -eq "passed") {
    "passed"
  }
  else {
    "database-release-passed-health-deferred"
  }
  Write-OperatorEvidence $operatorStatus $(if ($failureMessage) { $stage } else { "" })
}
catch {
  if ($releaseStarted) {
    $failureMessage =
      "Release may be committed, but redacted operator evidence could not be persisted. Do not retry; follow the approved evidence-persistence-failed rollback stop condition."
  }
  else {
    $failureMessage =
      "Airport release stopped because redacted operator evidence could not be persisted. Fix local artifact permissions and rerun."
  }
}

if ($null -ne $failureMessage) {
  Write-Error $failureMessage
  exit 1
}
