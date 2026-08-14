param(
  [switch]$Fix,
  [switch]$Login,
  [switch]$Proof
)

$ErrorActionPreference = "Stop"

$BridgePath = Join-Path $HOME ".haetsal\bin\haetsal-mcp-bridge.ps1"
$RemoteCommand = Join-Path $env:APPDATA "npm\mcp-remote.cmd"
$ConfigPath = Join-Path $HOME ".codex\config.toml"
$ArtifactInstaller = Join-Path $PSScriptRoot "install-haetsal-artifact-upload.ps1"
$RequiredVariables = @(
  "HAETSAL_CODEX_CF_CLIENT_ID",
  "HAETSAL_CODEX_CF_CLIENT_SECRET"
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

function Test-CodexBridgeConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    return $false
  }
  $config = Get-Content -LiteralPath $ConfigPath -Raw
  $section = [regex]::Match(
    $config,
    '(?ms)^\[mcp_servers\.haetsal\]\s*(.*?)(?=^\[|\z)'
  )
  if (-not $section.Success) {
    return $false
  }
  return (
    $section.Value -match 'haetsal-mcp-bridge\.ps1' -and
    $section.Value -match '"-Client"' -and
    $section.Value -match '"codex"'
  )
}

function Backup-CodexConfig {
  if (Test-Path -LiteralPath $ConfigPath) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = "$ConfigPath.bak-haetsal-repair-$stamp"
    Copy-Item -LiteralPath $ConfigPath -Destination $backup
    Write-Host "Backed up config to $backup"
  }
}

Test-Command "codex"

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

Write-Step "Checking long-lived Codex credentials"
$missingCredentials = @(Get-UserCredentialState)
if ($missingCredentials.Count -gt 0) {
  throw "Codex HAETSAL credentials need reprovisioning; do not fall back to repeated OAuth login."
}

Write-Step "Checking global Codex HAETSAL registration"
if (Test-CodexBridgeConfig) {
  Write-Host "HAETSAL uses the durable Codex bridge in $ConfigPath"
} elseif ($Fix) {
  Backup-CodexConfig
  & codex mcp remove haetsal 2>$null
  Write-Host "Registering the durable user-scoped HAETSAL bridge."
  & codex mcp add haetsal -- powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $BridgePath -Client codex
  if ($LASTEXITCODE -ne 0 -or -not (Test-CodexBridgeConfig)) {
    throw "Codex HAETSAL bridge registration failed."
  }
} else {
  throw "HAETSAL is not using the durable bridge. Re-run with -Fix."
}

Write-Step "Checking current HAETSAL MCP config"
& codex mcp get haetsal

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
  Write-Warning "-Login is a legacy emergency fallback. The normal Codex setup does not use browser OAuth."
  Write-Host "If you continue, use the real desktop browser so the localhost callback reaches Codex."
  & codex mcp login haetsal
}

if ($Proof) {
  Write-Step "Running fresh-session HAETSAL proof"
  $prompt = @'
Do not edit files. Use the global haetsal MCP server only. Call memory_stats and return one line: SUCCESS followed by the capture count. If unavailable, return one line: UNAVAILABLE followed by the reason.
'@
  $prompt | codex exec -C (Get-Location).Path --dangerously-bypass-approvals-and-sandbox -
  if ($LASTEXITCODE -ne 0) {
    throw "Fresh-session Codex proof failed."
  }
  & $ArtifactInstaller -Proof -Client codex
  if ($LASTEXITCODE -ne 0) {
    throw "Codex artifact tool discovery proof failed."
  }
}

Write-Step "Done"
