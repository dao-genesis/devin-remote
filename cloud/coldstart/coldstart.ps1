# coldstart.ps1 — one-key cold start for a fresh Windows VM (Devin cloud VM or any devinbox).
# Full chain: download+install latest Devin Desktop -> build+install the dao-one MEGA (大 one) VSIX
# straight from this repo -> verify. Account login is interactive/injected by design
# (the vendored rt-flow handles the first-account login; account pool is NOT in the repo).
#
# 最终主交付(final): dao-one 大 one = dao-vsix 二合一本源基座 + Proxy Pro 三面板子模块(折入 Devin Cloud 全功能面板)。
# 冷启动构建/安装 dao-one; 若只要纯二合一本源, 可单独构建 core/dao-vsix。
#
# Usage (run from inside a cloned devin-remote repo):
#   git clone https://github.com/zhouyoukang1234-spec/devin-remote.git $env:USERPROFILE\repos\devin-remote
#   powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\repos\devin-remote\cloud\coldstart\coldstart.ps1
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

# repo root = nearest ancestor of this script that holds both core/ and addons/.
# (Script lives at cloud/coldstart/; walking up by a fixed count is brittle after
#  repo restructures, so resolve by marker dirs instead.)
$repoRoot = $PSScriptRoot
while ($repoRoot -and -not ((Test-Path (Join-Path $repoRoot 'core')) -and (Test-Path (Join-Path $repoRoot 'addons')))) {
    $parent = Split-Path -Parent $repoRoot
    if ($parent -eq $repoRoot) { break }   # reached filesystem root
    $repoRoot = $parent
}
if (-not ($repoRoot -and (Test-Path (Join-Path $repoRoot 'core')))) {
    throw "repo root not found from $PSScriptRoot (expected an ancestor with core/ + addons/)"
}
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

# ---------- 1.5 Build the gitignored dao-one MEGA VSIX if absent ----------
# dao-one ships only its overlay source; build.js assembles vendor-* from sibling
# core/{dao-vsix,dao-proxy-pro,rt-flow} + addons/dao-bridge and folds proxy-fold.patch
# onto vendor-vsix (dao-vsix 源永不沾 proxy), then vsce packages. Build before install.
$daoOneDir = Join-Path $repoRoot 'core\dao-one'
if ((Test-Path $daoOneDir) -and -not (Get-ChildItem -Path $daoOneDir -Filter *.vsix -File)) {
    Step 'Building dao-one MEGA VSIX (assemble vendor-* + fold Proxy Pro + package)'
    Push-Location $daoOneDir
    try {
        if (-not (Test-Path 'node_modules')) { & npm install --no-audit --no-fund 2>&1 | Select-Object -Last 1 }
        & node ./build.js
        & npx --yes @vscode/vsce package --allow-missing-repository --skip-license 2>&1 | Select-Object -Last 1
    } finally { Pop-Location }
    if (-not (Get-ChildItem -Path $daoOneDir -Filter *.vsix -File)) { throw 'dao-one build failed (no VSIX produced)' }
}

# ---------- 2. Install the dao-one MEGA (+ any optional addon VSIX present) ----------
# dao-one 内联了 dao-vsix 二合一本源(rt-flow 切号视图 wam-container/wam.panel + Devin Cloud 全功能面板)再折入 Proxy Pro 三面板子模块; 只装它即得大 one。
# core/dao-vsix、core/rt-flow、core/dao-proxy-pro 会与 dao-one 抢占同名 view/command id, 一律排除。
$excludeDirs = @(
    (Join-Path $repoRoot 'core\dao-vsix'),
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

if (-not $vsixFiles) { throw "no VSIX found under $($vsixSearch -join ', ') (did dao-one build in step 1.5?)" }

foreach ($v in $vsixFiles) {
    Step "Installing extension $($v.Name)"
    & $devinCli --install-extension $v.FullName --force 2>&1 | Select-Object -Last 1
}

# ---------- 2.5 Uninstall the standalone engines that conflict with dao-one ----------
# dao-one 自带 dao-vsix 本源(rt-flow 视图 wam-container/wam.panel + Devin Cloud 面板)与 Proxy Pro 子面板。VS Code 的 view/command id
# 必须全局唯一 —— 若 dao-vsix / rt-flow / dao-proxy-pro 仍各自安装, 会抢占同名 id, 导致大 one 面板板块不渲染。
# 故卸载它们, 让 dao.dao-one 成为唯一属主。dao-bridge(内网穿透)为独立 addon, 不冲突, 保留。
$conflicting = @('dao.dao-vsix', 'devaid.rt-flow', 'dao-agi.dao-proxy-pro')
foreach ($id in $conflicting) {
    Step "Uninstalling conflicting engine $id (superseded by dao.dao-one mega)"
    & $devinCli --uninstall-extension $id 2>&1 | Select-Object -Last 1
}

# ---------- 3. Verify ----------
Step 'Installed extensions:'
$installed = & $devinCli --list-extensions
$installed
if ($installed -notcontains 'dao.dao-one') {
    throw 'dao.dao-one is NOT installed - the mega panel would be missing. Check the dao-one build step above.'
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
