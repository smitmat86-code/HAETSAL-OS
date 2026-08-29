param(
  [switch]$Fix,
  [switch]$Proof,
  [ValidateSet('codex', 'claude', 'both')]
  [string]$Client = 'both'
)

$ErrorActionPreference = 'Stop'
$installDirectory = Join-Path $HOME '.haetsal\bin'
$sourceLauncher = Join-Path $PSScriptRoot 'haetsal-artifact-upload.ps1'
$sourceHelper = Join-Path $PSScriptRoot 'haetsal-artifact-upload.mjs'
$installedLauncher = Join-Path $installDirectory 'haetsal-artifact-upload.ps1'
$installedHelper = Join-Path $installDirectory 'haetsal-artifact-upload.mjs'

if (-not (Test-Path -LiteralPath $sourceLauncher) -or -not (Test-Path -LiteralPath $sourceHelper)) {
  throw 'Repository artifact helper sources are missing.'
}
if ($Fix) {
  New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
  Copy-Item -LiteralPath $sourceLauncher -Destination $installedLauncher -Force
  Copy-Item -LiteralPath $sourceHelper -Destination $installedHelper -Force
}
if (-not (Test-Path -LiteralPath $installedLauncher) -or -not (Test-Path -LiteralPath $installedHelper)) {
  throw 'The HAETSAL artifact upload helper is not installed. Re-run with -Fix.'
}
$sourceLauncherHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceLauncher).Hash
$installedLauncherHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedLauncher).Hash
$sourceHelperHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceHelper).Hash
$installedHelperHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedHelper).Hash
if ($sourceLauncherHash -ne $installedLauncherHash -or $sourceHelperHash -ne $installedHelperHash) {
  throw 'The installed HAETSAL artifact upload helper is stale. Re-run with -Fix.'
}
Write-Host 'HAETSAL artifact upload helper installation is current.'

if ($Proof) {
  $clients = if ($Client -eq 'both') { @('codex', 'claude') } else { @($Client) }
  foreach ($selected in $clients) {
    & $installedLauncher -Client $selected -Proof
    if ($LASTEXITCODE -ne 0) { throw "Artifact helper proof failed for $selected." }
  }
}
