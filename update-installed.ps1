# update-installed.ps1
# Copies the current repo files into Sine's installed mod directory and
# walks you through the Zen restart that's required to pick up changes
# to EasyFilesParent.sys.mjs / EasyFilesChild.sys.mjs.
#
# Why a restart matters: Sine's refresh button re-runs the .uc.mjs but
# the JSWindowActor system caches the parent/child .sys.mjs ESM modules
# in chrome process memory. Only a full Zen process exit re-imports them.

param(
    [switch]$KillZen,
    [switch]$NoConfirm
)

$ErrorActionPreference = "Stop"

$repoDir = Split-Path -Parent $PSCommandPath
$installDir = Join-Path $env:APPDATA "zen\Profiles\y94b0swj.Default (release)\chrome\sine-mods\ZenEasyFiles"

if (-not (Test-Path $installDir)) {
    Write-Error "Install directory not found: $installDir"
    exit 1
}

$filesToSync = @(
    "easy-files.uc.mjs",
    "easy-files.css",
    "EasyFilesChild.sys.mjs",
    "EasyFilesParent.sys.mjs",
    "preferences.json",
    "theme.json",
    "userChrome.css"
)

Write-Host ""
Write-Host "Syncing repo -> Sine install dir" -ForegroundColor Cyan
Write-Host "  repo:    $repoDir"
Write-Host "  install: $installDir"
Write-Host ""

foreach ($f in $filesToSync) {
    $src = Join-Path $repoDir $f
    $dst = Join-Path $installDir $f
    if (Test-Path $src) {
        Copy-Item $src $dst -Force
        $size = (Get-Item $dst).Length
        Write-Host "  copied $f ($size bytes)" -ForegroundColor Green
    } else {
        Write-Host "  skipped $f (not in repo)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "Verifying installed version..." -ForegroundColor Cyan
$installedTheme = Get-Content (Join-Path $installDir "theme.json") -Raw | ConvertFrom-Json
Write-Host "  installed version: $($installedTheme.version)" -ForegroundColor Yellow
Write-Host "  installed updatedAt: $($installedTheme.updatedAt)" -ForegroundColor Yellow

$zenProcs = Get-Process -Name "zen" -ErrorAction SilentlyContinue
if ($zenProcs) {
    Write-Host ""
    Write-Host "Zen is currently running ($($zenProcs.Count) processes)." -ForegroundColor Yellow
    Write-Host "JSWindowActor module cache will NOT update without a full restart." -ForegroundColor Yellow

    if ($KillZen) {
        Write-Host "Killing Zen processes..." -ForegroundColor Red
        $zenProcs | Stop-Process -Force
        Start-Sleep -Seconds 2
        Write-Host "Zen killed. Reopen it manually." -ForegroundColor Green
    } elseif (-not $NoConfirm) {
        $resp = Read-Host "Kill Zen now? (y/N)"
        if ($resp -eq "y" -or $resp -eq "Y") {
            $zenProcs | Stop-Process -Force
            Start-Sleep -Seconds 2
            Write-Host "Zen killed. Reopen it manually." -ForegroundColor Green
        } else {
            Write-Host "Leaving Zen running. Quit it yourself before testing." -ForegroundColor DarkYellow
        }
    } else {
        Write-Host "Quit Zen yourself before testing." -ForegroundColor DarkYellow
    }
} else {
    Write-Host ""
    Write-Host "Zen is not running. Start it after this script completes." -ForegroundColor Green
}

Write-Host ""
Write-Host "After Zen restart, verify in Browser Console (Ctrl+Shift+J, Multiprocess):" -ForegroundColor Cyan
Write-Host "  [EasyFiles] mod version $($installedTheme.version) init starting"
Write-Host "  [EasyFiles] discovered filepicker XPCOM contracts: [...]"
Write-Host "  [EasyFiles] FilePicker suppressor installed for contracts: [...]"
Write-Host ""
