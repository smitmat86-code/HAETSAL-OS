param(
  [switch]$Fix,
  [switch]$Login,
  [switch]$Proof,
  [switch]$ListAll
)

$ErrorActionPreference = "Stop"

$BridgePath = Join-Path $HOME ".haetsal\bin\haetsal-mcp-bridge.ps1"
$RemoteCommand = Join-Path $env:APPDATA "npm\mcp-remote.cmd"
$ArtifactInstaller = Join-Path $PSScriptRoot "install-haetsal-artifact-upload.ps1"
$RequiredVariables = @(
  "HAETSAL_CLAUDE_CF_CLIENT_ID",
  "HAETSAL_CLAUDE_CF_CLIENT_SECRET"
)

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Test-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found on PATH."
  }
}

function Get-UserCredentialState {
  $missing = @()
  foreach ($name in $RequiredVariables) {
    $value = [Environment]::GetEnvironmentVariable($name, "User")
    if ([string]::IsNullOrWhiteSpace($value)) {
      Write-Warning "$name is missing from the Windows user environment."
      $missing += $name
    } else {
      Write-Host "$name is present (length $($value.Length))."
    }
  }
  return $missing
}

function Get-ClaudeHaetsalState {
  $output = & claude mcp get haetsal 2>&1
  return ($output | Out-String)
}

function Test-ClaudeBridgeConfig {
  param([string]$Text)
  return (
    $Text -match [regex]::Escape($BridgePath) -and
    $Text -match '-Client' -and
    $Text -match 'claude'
  )
}

Test-Command "claude"

Write-Step "Checking the secret-free HAETSAL bridge"
if (-not (Test-Path -LiteralPath $BridgePath)) {
  throw "Bridge launcher is missing: $BridgePath"
}
Write-Host "Bridge launcher found: $BridgePath"

if (-not (Test-Path -LiteralPath $RemoteCommand)) {
  if ($Fix) {
    Test-Command "npm"
    Write-Host "Installing pinned mcp-remote bridge."
    & npm install -g mcp-remote@0.1.38
    if ($LASTEXITCODE -ne 0) {
      throw "mcp-remote installation failed."
    }
  } else {
    throw "mcp-remote is missing. Re-run with -Fix."
  }
}
Write-Host "mcp-remote found: $RemoteCommand"

Write-Step "Checking long-lived Claude credentials"
$missingCredentials = @(Get-UserCredentialState)
if ($missingCredentials.Count -gt 0) {
  throw "Claude HAETSAL credentials need reprovisioning; do not fall back to repeated OAuth login."
}

Write-Step "Checking Claude HAETSAL MCP registration"
$getText = Get-ClaudeHaetsalState
if (Test-ClaudeBridgeConfig $getText) {
  Write-Host $getText
} elseif ($Fix) {
  & claude mcp remove --scope user haetsal 2>$null
  Write-Host "Registering the durable user-scoped HAETSAL bridge."
  & claude mcp add --scope user haetsal -- powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $BridgePath -Client claude
  if ($LASTEXITCODE -ne 0) {
    throw "Claude HAETSAL bridge registration failed."
  }
  $getText = Get-ClaudeHaetsalState
  if (-not (Test-ClaudeBridgeConfig $getText)) {
    throw "Claude HAETSAL registration does not reference the durable bridge."
  }
  Write-Host $getText
} else {
  Write-Host $getText
  throw "HAETSAL is not using the durable bridge. Re-run with -Fix."
}

if ($getText -notmatch "Connected") {
  Write-Warning "Claude does not currently report HAETSAL as connected."
}

Write-Step "Checking the governed artifact upload helper"
if (-not (Test-Path -LiteralPath $ArtifactInstaller)) {
  throw "Artifact upload installer is missing: $ArtifactInstaller"
}
if ($Fix) {
  & $ArtifactInstaller -Fix
} else {
  & $ArtifactInstaller
}

if ($Login) {
  Write-Warning "-Login is a legacy emergency fallback. The normal Claude setup does not use browser OAuth."
  & claude mcp login haetsal
}

if ($Proof) {
  Write-Step "Running Claude HAETSAL tool proof"
  & claude -p "Use the haetsal memory_stats tool and return one line: SUCCESS followed by the capture count." --allowedTools "mcp__haetsal__memory_stats"
  if ($LASTEXITCODE -ne 0) {
    throw "Claude HAETSAL proof failed."
  }
  & $ArtifactInstaller -Proof -Client claude
  if ($LASTEXITCODE -ne 0) {
    throw "Claude artifact tool discovery proof failed."
  }
}

if ($ListAll) {
  Write-Step "Listing all Claude MCP servers"
  & claude mcp list
}

Write-Step "Done"
