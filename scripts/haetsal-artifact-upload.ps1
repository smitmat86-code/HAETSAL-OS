param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('codex', 'claude')]
  [string]$Client,
  [string]$FilePath,
  [string]$MimeType,
  [string]$IdempotencyKey,
  [switch]$DryRun,
  [switch]$Proof
)

$ErrorActionPreference = 'Stop'
$prefix = if ($Client -eq 'codex') { 'HAETSAL_CODEX' } else { 'HAETSAL_CLAUDE' }
$clientId = [Environment]::GetEnvironmentVariable("${prefix}_CF_CLIENT_ID", 'User')
$clientSecret = [Environment]::GetEnvironmentVariable("${prefix}_CF_CLIENT_SECRET", 'User')
if ((-not $DryRun) -and ([string]::IsNullOrWhiteSpace($clientId) -or [string]::IsNullOrWhiteSpace($clientSecret))) {
  throw 'HAETSAL delegated credentials are unavailable for the selected client.'
}

$scriptPath = Join-Path $PSScriptRoot 'haetsal-artifact-upload.mjs'
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw 'The HAETSAL artifact upload helper is incomplete. Run its installer with -Fix.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required for the HAETSAL artifact upload helper.'
}

if (-not $DryRun) {
  $env:HAETSAL_CF_CLIENT_ID = $clientId
  $env:HAETSAL_CF_CLIENT_SECRET = $clientSecret
}
$nodeArgs = @($scriptPath, '--client', $Client)
if ($Proof) {
  $nodeArgs += '--proof'
} else {
  if ([string]::IsNullOrWhiteSpace($FilePath)) { throw '-FilePath is required unless -Proof is used.' }
  $nodeArgs += @('--path', $FilePath)
  if ($MimeType) { $nodeArgs += @('--mime', $MimeType) }
  if ($IdempotencyKey) { $nodeArgs += @('--idempotency-key', $IdempotencyKey) }
  if ($DryRun) { $nodeArgs += '--dry-run' }
}

try {
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw 'HAETSAL artifact upload failed.' }
} finally {
  Remove-Item Env:HAETSAL_CF_CLIENT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:HAETSAL_CF_CLIENT_SECRET -ErrorAction SilentlyContinue
}
