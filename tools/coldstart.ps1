# coldstart.ps1 — one-key cold start for a fresh Windows VM (Devin cloud VM or any devinbox).
# Full chain: download+install latest Devin Desktop -> install all 5 plugin VSIX (+ dao-export
# module VSIX) straight from this repo -> verify. Account login is interactive/injected by design
# (rt-flow handles the first-account login; account pool is NOT in the repo).
#
# Usage (run from inside a cloned devin-remote repo):
#   git clone https://github.com/zhouyoukang1234-spec/devin-remote.git $env:USERPROFILE\repos\devin-remote
#   powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\repos\devin-remote\tools\coldstart.ps1
#
#   -SkipInstall   IDE already installed, skip the Devin Desktop download/install step
#
# Target time: < 5 minutes on a clean VM (vs. hours of manual GUI work).

param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Continue'   # git/installers write progress to stderr; only fail on explicit checks
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$sw = [Diagnostics.Stopwatch]::StartNew()
function Step($m) { Write-Host ("[{0:mm\:ss}] {1}" -f $sw.Elapsed, $m) -ForegroundColor Cyan }

# repo root = parent of this script's tools/ dir
$repoRoot = Split-Path -Parent $PSScriptRoot
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
if (-not (Test-Path $devinCli)) { throw "devin-desktop CLI not found: $devinCli" }

# ---------- 1.5 Build the gitignored dao-vsix VSIX if absent ----------
# dao-vsix ships only its TypeScript source (out/, node_modules/, *.vsix are gitignored),
# so on a fresh clone we transpile + package it before the install loop can find it.
$daoVsixDir = Join-Path $repoRoot 'plugins\dao-vsix'
if ((Test-Path $daoVsixDir) -and -not (Get-ChildItem -Path $daoVsixDir -Filter *.vsix -File)) {
    Step 'Building dao-vsix VSIX (TS transpile + package)'
    Push-Location $daoVsixDir
    try {
        if (-not (Test-Path 'node_modules')) { & npm install --no-audit --no-fund 2>&1 | Select-Object -Last 1 }
        & node ./build.js
        & npx --yes @vscode/vsce package --allow-missing-repository --skip-license 2>&1 | Select-Object -Last 1
    } finally { Pop-Location }
    if (-not (Get-ChildItem -Path $daoVsixDir -Filter *.vsix -File)) { throw 'dao-vsix build failed (no VSIX produced)' }
}

# ---------- 2. Install plugins straight from the repo ----------
# 5 plugins under plugins/ + the dao-export module VSIX. Each dir keeps only its latest VSIX
# (older versions were pruned), so a flat search picks the right build with no version parsing.
$vsixSearch = @(
    (Join-Path $repoRoot 'plugins'),
    (Join-Path $repoRoot 'modules\dao-export')
)
$vsixFiles = $vsixSearch |
    Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem -Path $_ -Recurse -Filter *.vsix -File }

if (-not $vsixFiles) { throw "no VSIX found under $($vsixSearch -join ', ')" }

foreach ($v in $vsixFiles) {
    Step "Installing extension $($v.Name)"
    & $devinCli --install-extension $v.FullName --force 2>&1 | Select-Object -Last 1
}

# ---------- 2.5 Uninstall the standalone engines that dao-one inlines ----------
# 归一 (dao.dao-one) 复用并内联了四套引擎本体的真实前端视图(wam.panel / dao.router /
# dao.cloudPanel / daoBridgeView)。VS Code 的 view/command id 必须全局唯一 —— 若这些
# 独立引擎仍各自安装, 会抢占同名 id, 导致归一容器里对应板块(尤其 ④ 内网穿透)不渲染。
# 故安装完成后卸载这四个独立引擎, 让 dao.dao-one 成为唯一属主。反者道之动: 合则归一。
$inlinedEngines = @('dao.dao-vsix', 'dao-agi.dao-proxy-pro', 'devaid.rt-flow', 'dao.dao-bridge')
foreach ($id in $inlinedEngines) {
    Step "Uninstalling standalone engine $id (inlined by dao.dao-one)"
    & $devinCli --uninstall-extension $id 2>&1 | Select-Object -Last 1
}

# ---------- 3. Verify ----------
Step 'Installed extensions:'
& $devinCli --list-extensions
Step "COLD START COMPLETE in $($sw.Elapsed.ToString('mm\:ss'))"
Write-Host ''
Write-Host 'Next steps (account login is interactive/injected by design):'
Write-Host '  1. Launch Devin Desktop; rt-flow handles the first-account login (auth1 via email+password,'
Write-Host '     bypassing the browser OAuth round-trip). Account pool is NOT in the repo.'
Write-Host '  2. See bootstrap/README.md for the full bootstrap guide, token rules, and webview pitfalls.'
