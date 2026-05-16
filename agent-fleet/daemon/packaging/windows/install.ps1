# agent-fleet daemon installer for Windows (Win10/11 + Server 2019+).
# Installs as a Windows Service via node-windows.
# Usage:
#   iwr -useb https://brain.itiswednesdaymydud.es/fleet/install-windows.ps1 | iex
#   Or local: powershell -ExecutionPolicy Bypass -File install.ps1

#Requires -RunAsAdministrator

[CmdletBinding()]
param(
  [string]$TarballUrl   = "$env:AGENT_FLEET_TARBALL",
  [string]$Hub          = "$env:AGENT_FLEET_HUB",
  [string]$Token        = "$env:AGENT_FLEET_TOKEN",
  [string]$HostName     = "$env:AGENT_FLEET_HOST_NAME",
  [string]$InstallDir   = "$env:ProgramFiles\agent-fleet",
  [string]$ConfDir      = "$env:ProgramData\agent-fleet",
  [string]$ServiceName  = "agent-fleet-daemon"
)

$ErrorActionPreference = 'Stop'
if (-not $TarballUrl) { $TarballUrl = 'https://brain.itiswednesdaymydud.es/fleet/download/agent-fleet-daemon.tar.gz' }
if (-not $HostName)   { $HostName   = $env:COMPUTERNAME }

# --- Sanity checks ----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node not on PATH. Install Node.js >= 20 from https://nodejs.org first."
}
$nodeMajor = (& node -p 'process.versions.node.split(".")[0]') -as [int]
if ($nodeMajor -lt 20) { throw "node $nodeMajor detected; need >= 20." }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  throw "tar not on PATH. Windows 10 1803+ ships tar in System32; check your PATH."
}

Write-Host "[install] downloading daemon → $TarballUrl"
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "agent-fleet-$([guid]::NewGuid().Guid)")
$tarball = Join-Path $tmp.FullName 'daemon.tar.gz'
Invoke-WebRequest -Uri $TarballUrl -OutFile $tarball -UseBasicParsing

Write-Host "[install] extracting → $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfDir    | Out-Null
# tar --strip-components=1 to drop the top "agent-fleet-daemon/" dir.
tar -xzf $tarball -C $InstallDir --strip-components=1

Write-Host "[install] npm ci (fetch node-pty + ws prebuilts for this arch)"
Push-Location $InstallDir
& npm ci --omit=dev --no-audit --no-fund
& npm install --omit=dev --no-audit --no-fund node-windows
Pop-Location

# --- daemon.env -------------------------------------------------------------
$envFile = Join-Path $ConfDir 'daemon.env'
if (-not (Test-Path $envFile)) {
  Copy-Item -Path (Join-Path $InstallDir 'packaging\common\daemon.env.template') -Destination $envFile
}
if (-not $Hub)   { $Hub   = Read-Host 'Hub URL (wss://...)' }
if (-not $Token) { $Token = Read-Host 'Bearer token' -AsSecureString | ConvertFrom-SecureString -AsPlainText }
(Get-Content $envFile) -replace '^AGENT_FLEET_HUB=.*',   "AGENT_FLEET_HUB=$Hub"   |
  ForEach-Object { $_ -replace '^AGENT_FLEET_TOKEN=.*', "AGENT_FLEET_TOKEN=$Token" } |
  ForEach-Object { $_ -replace '^#?AGENT_FLEET_HOST_NAME=.*', "AGENT_FLEET_HOST_NAME=$HostName" } |
  Set-Content -Path $envFile -Encoding UTF8

# --- Service install (via node-windows) -------------------------------------
$installerJs = Join-Path $InstallDir 'packaging\windows\install-service.js'
& node $installerJs install `
  --service-name $ServiceName `
  --install-dir  $InstallDir `
  --env-file     $envFile

Write-Host "`n[install] done."
Write-Host "  Service:    Get-Service '$ServiceName'"
Write-Host "  Logs:       Get-EventLog -LogName Application -Source $ServiceName -Newest 20"
Write-Host "  Uninstall:  powershell -File '$InstallDir\packaging\windows\uninstall.ps1'"
