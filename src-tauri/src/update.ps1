# SocialSpace self-update. Started by the app (src-tauri/src/updater.rs) in its own console window.
# Pulls main, rebuilds the installer, closes the running app, installs silently and restarts it.
# The app keeps running while it builds, so a failed build leaves the current version untouched.
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$AppExe
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Updating SocialSpace'
$log = Join-Path $env:TEMP 'socialspace-update.log'
Start-Transcript -Path $log -Force | Out-Null

function Invoke-Step([string]$Exe, [string[]]$Arguments) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "'$Exe $($Arguments -join ' ')' failed with exit code $LASTEXITCODE." }
}

try {
  Set-Location -LiteralPath $Source

  Write-Host "`n[1/4] Getting the latest main..." -ForegroundColor Cyan
  Invoke-Step 'git' @('checkout', 'main')
  Invoke-Step 'git' @('pull', '--ff-only', 'origin', 'main')

  Write-Host "`n[2/4] Installing dependencies..." -ForegroundColor Cyan
  Invoke-Step 'npm.cmd' @('install', '--no-audit', '--no-fund')

  Write-Host "`n[3/4] Building the app (this takes a few minutes; SocialSpace stays open meanwhile)..." -ForegroundColor Cyan
  $started = Get-Date
  Invoke-Step 'npm.cmd' @('run', 'tauri', 'build')
  $installer = Get-ChildItem -Path 'src-tauri\target\release\bundle\nsis\*-setup.exe' |
    Where-Object { $_.LastWriteTime -ge $started } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $installer) { throw 'The build finished but no new installer was found in src-tauri\target\release\bundle\nsis.' }

  Write-Host "`n[4/4] Closing SocialSpace and installing $($installer.Name)..." -ForegroundColor Cyan
  Stop-Process -Id $AppPid -Force -ErrorAction SilentlyContinue
  Wait-Process -Id $AppPid -Timeout 30 -ErrorAction SilentlyContinue
  $setup = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "The installer exited with code $($setup.ExitCode)." }

  Write-Host "`nUpdated. Starting SocialSpace..." -ForegroundColor Green
  Start-Process -FilePath $AppExe
  Start-Sleep -Seconds 3
} catch {
  Write-Host "`nUpdate failed: $_" -ForegroundColor Red
  Write-Host "Full log: $log"
  if (-not (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $AppExe)) {
    Start-Process -FilePath $AppExe
  }
  Read-Host 'Press Enter to close this window'
} finally {
  Stop-Transcript | Out-Null
}
