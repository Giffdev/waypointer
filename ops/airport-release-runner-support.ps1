Set-StrictMode -Version Latest

function Resolve-NeonCliInvocation {
  $globalCommand = Get-Command neonctl.cmd, neonctl.exe, neonctl `
    -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $globalCommand) {
    return [pscustomobject]@{
      Executable = [string]$globalCommand.Source
      PrefixArguments = @()
      AttestationExecutable = "neonctl"
    }
  }

  $npxCommand = Get-Command npx.cmd, npx.exe, npx `
    -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $npxCommand) {
    throw "neon-authentication-required"
  }
  return [pscustomobject]@{
    Executable = [string]$npxCommand.Source
    PrefixArguments = @("--yes", "neonctl")
    AttestationExecutable = "npx"
  }
}

function Invoke-NeonCliOutput(
  [object]$Invocation,
  [string[]]$Arguments
) {
  $allArguments = @($Invocation.PrefixArguments) + $Arguments
  return @(& $Invocation.Executable @allArguments 2>$null)
}

function Assert-VercelCliAuthentication {
  $command = Get-Command vercel.cmd, vercel.exe, vercel `
    -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $command) {
    throw "vercel-authentication-required"
  }
  $null = @(& $command.Source whoami 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw "vercel-authentication-required"
  }
}

function Resolve-FreshProviderExpectation(
  [string]$Root,
  [scriptblock]$Generate
) {
  $result = & $Generate
  $relativePath = [string]$result.providerExpectationPath
  $sha256 = [string]$result.providerExpectationSha256
  if (
    [string]::IsNullOrWhiteSpace($relativePath) -or
    $sha256 -notmatch '^[a-f0-9]{64}$'
  ) {
    throw "vercel-provider-verification-failed"
  }
  if (
    $relativePath -notmatch "^data[\\/]+private[\\/]+release-approvals[\\/]+vercel-provider-expectation-$sha256\.json$"
  ) {
    throw "vercel-provider-verification-failed"
  }
  $path = Join-Path $Root $relativePath
  if (
    -not (Test-Path -LiteralPath $path) -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne
      $sha256
  ) {
    throw "vercel-provider-verification-failed"
  }
  return [pscustomobject]@{
    Path = $path
    RelativePath = $relativePath
    Sha256 = $sha256
  }
}
