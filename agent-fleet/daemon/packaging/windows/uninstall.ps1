#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [string]$InstallDir  = "$env:ProgramFiles\agent-fleet",
  [string]$ConfDir     = "$env:ProgramData\agent-fleet",
  [string]$ServiceName = "agent-fleet-daemon",
  [switch]$Purge
)
$ErrorActionPreference = 'Continue'

Write-Host "[uninstall] stopping + removing service $ServiceName"
$installerJs = Join-Path $InstallDir 'packaging\windows\install-service.js'
if (Test-Path $installerJs) {
  & node $installerJs uninstall --service-name $ServiceName --install-dir $InstallDir
}

Write-Host "[uninstall] removing $InstallDir"
Remove-Item -Recurse -Force -Path $InstallDir -ErrorAction SilentlyContinue

if ($Purge) {
  Write-Host "[uninstall] --purge: removing $ConfDir"
  Remove-Item -Recurse -Force -Path $ConfDir -ErrorAction SilentlyContinue
} else {
  Write-Host "[uninstall] kept $ConfDir (use -Purge to remove)"
}
Write-Host "[uninstall] done"
