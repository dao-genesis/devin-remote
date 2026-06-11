# coldstart.ps1 — one-key cold start for a fresh Windows VM (Devin cloud VM or any devinbox).
# Full chain: download+install latest Devin Desktop -> clone archive branch -> install all
# plugins from prebuilt VSIX artifacts -> apply user settings -> verify.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\coldstart.ps1
#   powershell -ExecutionPolicy Bypass -File tools\coldstart.ps1 -SkipInstall   # IDE already installed
#
# Target time: < 5 minutes on a clean VM (vs. hours of manual GUI work).

param(
    [string]$RepoUrl = 'https://github.com/zhouyoukang1234-spec/devin-remote.git',
    [string]$ArchiveBranch = 'archive',
    [string]$WorkDir = "$env:USERPROFILE\dao",
    [switch]$SkipInstall,
    [switch]$SkipClone
)

$ErrorActionPreference = 'Continue'   # git writes progress to stderr; only fail on explicit checks
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$sw = [Diagnostics.Stopwatch]::StartNew()
function Step($m) { Write-Host ("[{0:mm\:ss}] {1}" -f $sw.Elapsed, $m) -ForegroundColor Cyan }

$devinExe = "$env:LOCALAPPDATA\Programs\Devin\Devin.exe"
$devinCli = "$env:LOCALAPPDATA\Programs\Devin\bin\devin-desktop.cmd"

# ---------- 1. Devin Desktop ----------
if (-not $SkipInstall -and -not (Test-Path $devinExe)) {
    Step 'Resolving latest Devin Desktop installer URL'
    $meta = Invoke-RestMethod 'https://windsurf-stable.codeium.com/api/update/win32-x64-user/stable/latest' -TimeoutSec 30
    $url = $meta.url
    Step "Downloading $($meta.windsurfVersion) ($url)"
    $setup = "$env:TEMP\DevinUserSetup.exe"
    Invoke-WebRequest $url -OutFile $setup -TimeoutSec 600
    Step 'Installing silently'
    Start-Process $setup -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/MERGETASKS=!runcode' -Wait
    if (-not (Test-Path $devinExe)) { throw 'Devin Desktop install failed' }
    Step 'Devin Desktop installed'
} else {
    Step 'Devin Desktop already present (or skipped)'
}

# ---------- 2. Archive (code + prebuilt VSIX artifacts) ----------
if (-not $SkipClone) {
    if (Test-Path "$WorkDir\.git") {
        Step 'Updating existing archive clone'
        cmd /c "git -C `"$WorkDir`" fetch origin $ArchiveBranch 2>&1" | Out-Null
        cmd /c "git -C `"$WorkDir`" checkout $ArchiveBranch 2>&1" | Out-Null
        cmd /c "git -C `"$WorkDir`" pull --ff-only origin $ArchiveBranch 2>&1" | Out-Null
    } else {
        Step "Cloning $ArchiveBranch branch -> $WorkDir"
        cmd /c "git clone --branch $ArchiveBranch --single-branch $RepoUrl `"$WorkDir`" 2>&1" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'archive clone failed' }
    }
}

# ---------- 3. Plugins from prebuilt artifacts ----------
# artifacts live under the 00_* baseline dir (Chinese dir name -> resolve by prefix)
$baseDir = Get-ChildItem -LiteralPath $WorkDir -Directory | Where-Object Name -like '00_*' | Select-Object -First 1
if (-not $baseDir) { throw "00_* baseline dir not found in $WorkDir" }
$artifacts = Join-Path $baseDir.FullName 'artifacts'
if (-not (Test-Path $artifacts)) { throw "artifacts dir not found: $artifacts" }

# newest VSIX per plugin name
$vsixGroups = Get-ChildItem $artifacts -Filter *.vsix |
    Group-Object { ($_.BaseName -replace '-\d+(\.\d+)*$', '') }
foreach ($g in $vsixGroups) {
    $latest = $g.Group | Sort-Object {
        [version](($_.BaseName -replace '^.*-(\d+(\.\d+)*)$', '$1'))
    } | Select-Object -Last 1
    Step "Installing extension $($latest.Name)"
    & $devinCli --install-extension $latest.FullName --force 2>&1 | Select-Object -Last 1
}

# ---------- 4. User settings ----------
$settingsSrc = Join-Path $artifacts 'devin_user_settings.json'
if (Test-Path $settingsSrc) {
    $settingsDst = "$env:APPDATA\Devin\User\settings.json"
    New-Item (Split-Path $settingsDst) -ItemType Directory -Force | Out-Null
    Copy-Item $settingsSrc $settingsDst -Force
    Step 'User settings applied'
}

# ---------- 5. Verify ----------
Step 'Installed extensions:'
& $devinCli --list-extensions
Step "COLD START COMPLETE in $($sw.Elapsed.ToString('mm\:ss'))"
Write-Host ''
Write-Host 'Next steps (account login is interactive by design):'
Write-Host '  1. Launch Devin Desktop, rt-flow handles account switching (accounts NOT in repo - see E:\DAO_ARCHIVE on 141).'
Write-Host '  2. Read 00_*/handoff_*/HANDOFF.md for current progress and context.'
