# coldstart.ps1 — one-key cold start for a fresh Windows VM (Devin cloud VM or any devinbox).
# Full chain: download+install latest Devin Desktop -> build+install the dao-vsix TWO-IN-ONE VSIX
# straight from this repo -> verify. Account login is interactive/injected by design
# (the vendored rt-flow handles the first-account login; account pool is NOT in the repo).
#
# 重锚本源(re-anchored): 日常主交付 = dao-vsix 二合一(左 rt-flow 切号 + 中 Devin Cloud 全功能面板)。
# 三合一大 one(core/dao-one, 折入 proxy-pro/bridge)不再由冷启动构建/安装, 仍可手动构建。
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
$daoVsixDir = Join-Path $repoRoot 'core\dao-vsix'
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

# ---------- 2. Install the two-in-one dao-vsix (+ any optional addon VSIX present) ----------
# dao-vsix 内联了 rt-flow 前端视图(wam-container/wam.panel)与 Devin Cloud 全功能面板; 只装它即得二合一。
# core/dao-one、core/rt-flow、core/dao-proxy-pro 会与 dao-vsix 抢占同名 view/command id, 一律排除。
$excludeDirs = @(
    (Join-Path $repoRoot 'core\dao-one'),
    (Join-Path $repoRoot 'core\rt-flow'),
    (Join-Path $repoRoot 'core\dao-proxy-pro')
)
$vsixSearch = @(
    (Join-Path $repoRoot 'core'),
    (Join-Path $repoRoot 'addons')
)
$vsixFiles = $vsixSearch |
    Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem -Path $_ -Recurse -Filter *.vsix -File } |
    Where-Object { $f = $_.FullName; -not ($excludeDirs | Where-Object { $f.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) }

if (-not $vsixFiles) { throw "no VSIX found under $($vsixSearch -join ', ') (did dao-vsix build in step 1.5?)" }

foreach ($v in $vsixFiles) {
    Step "Installing extension $($v.Name)"
    & $devinCli --install-extension $v.FullName --force 2>&1 | Select-Object -Last 1
}

# ---------- 2.5 Uninstall the three-in-one / standalone engines that conflict with dao-vsix ----------
# dao-vsix 自带 rt-flow 视图(wam-container/wam.panel)与 Devin Cloud 面板。VS Code 的 view/command id
# 必须全局唯一 —— 若 dao-one / rt-flow / dao-proxy-pro 仍各自安装, 会抢占同名 id, 导致二合一面板板块不渲染。
# 故卸载它们, 让 dao.dao-vsix 成为唯一属主。反者道之动: 收腰归二。dao-bridge(内网穿透)为独立 addon, 不冲突, 保留。
$conflicting = @('dao.dao-one', 'devaid.rt-flow', 'dao-agi.dao-proxy-pro')
foreach ($id in $conflicting) {
    Step "Uninstalling conflicting engine $id (superseded by dao.dao-vsix two-in-one)"
    & $devinCli --uninstall-extension $id 2>&1 | Select-Object -Last 1
}

# ---------- 3. Verify ----------
Step 'Installed extensions:'
$installed = & $devinCli --list-extensions
$installed
if ($installed -notcontains 'dao.dao-vsix') {
    throw 'dao.dao-vsix is NOT installed - the two-in-one panel would be missing. Check the dao-vsix build step above.'
}
Step "COLD START COMPLETE in $($sw.Elapsed.ToString('mm\:ss'))"
Write-Host ''
Write-Host 'Next steps - IDE login (the only gate to a verifiable workbench):'
Write-Host '  1. Launch Devin Desktop and click "Log in" on the welcome screen. The browser opens'
Write-Host '     app.devin.ai/auth/login (redirect_uri = devin://codeium.windsurf deep link).'
Write-Host '  2. Enter the account email + password (one row from the rt-flow pool), then "Open Devin".'
Write-Host '     The devin:// deep link returns the session to the IDE and unlocks the workbench.'
Write-Host '     NOTE: injecting auth1 into state.vscdb is NOT enough - the welcome gate requires the'
Write-Host '     real firstparty session (devin-session-token$...) from this OAuth round-trip.'
Write-Host '  3. Open the RT Flow activity-bar icon (account switcher), then run "Dao: Open Devin Cloud Panel"'
Write-Host '     for the full single-account dashboard (额度/Knowledge/Playbook/Secret/蓝图/MCP/环境/自动化 + 反向注入).'
Write-Host '  4. See cloud/coldstart/README.md for the full bootstrap guide, token rules, and webview pitfalls.'
