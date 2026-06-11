# sync-dao-archive.ps1 — runs ON the 141 desktop (DESKTOP-MASTER).
# Bidirectional sync between E:\DAO_ARCHIVE and GitHub zhouyoukang1234-spec/devin-remote (branch: archive).
#
# Key discoveries baked in (2026-06-11):
#   * 141 CAN reach GitHub directly via the local vortex/clash proxy at 127.0.0.1:7890,
#     BUT the relay agent exports NO_PROXY=* which libcurl honors and silently bypasses
#     http.proxy. Always clear NO_PROXY first.
#   * TLS via openssl backend gets GFW-reset frequently; schannel is more reliable.
#   * Connections are still flaky -> every network op needs a retry loop.
#
# Usage (on 141):
#   powershell -ExecutionPolicy Bypass -File tools\sync-dao-archive.ps1            # full sync (pull + push)
#   powershell -ExecutionPolicy Bypass -File tools\sync-dao-archive.ps1 -PushOnly  # one-way local -> GitHub
#
# Auth: expects the push URL already configured (git remote set-url --push origin https://<PAT>@github.com/...)
#       or a PAT in the DAO_GIT_TOKEN environment variable.

param(
    [string]$ArchiveDir = 'E:\DAO_ARCHIVE',
    [string]$Branch = 'archive',
    [string]$Remote = 'https://github.com/zhouyoukang1234-spec/devin-remote.git',
    [switch]$PushOnly,
    [int]$MaxRetries = 15
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:NO_PROXY = ''; $env:no_proxy = ''
$env:GIT_TERMINAL_PROMPT = '0'

Set-Location -LiteralPath $ArchiveDir

function Invoke-GitRetry {
    param([string[]]$GitArgs, [string]$Label)
    for ($i = 1; $i -le $MaxRetries; $i++) {
        git @GitArgs 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Host "OK: $Label (try $i)"; return $true }
        Write-Host "retry $i/$MaxRetries failed: $Label"
        Start-Sleep ([Math]::Min($i * 3, 20))
    }
    Write-Host "FAILED: $Label"
    return $false
}

# --- one-time init ---
if (-not (Test-Path .git)) {
    git init 2>&1 | Out-Null
    git remote add origin $Remote
}
git config --local http.proxy 'http://127.0.0.1:7890'
git config --local http.sslBackend schannel
git config --local http.postBuffer 524288000
git config --local credential.helper ''
git config --local core.quotepath false
if ($env:DAO_GIT_TOKEN) {
    git remote set-url --push origin ("https://" + $env:DAO_GIT_TOKEN + "@github.com/zhouyoukang1234-spec/devin-remote.git")
}

# --- pull (GitHub -> local) ---
if (-not $PushOnly) {
    if (Invoke-GitRetry @('fetch', 'origin', $Branch) 'fetch') {
        # fast-forward merge remote changes into working tree; local uncommitted changes are preserved by git
        git merge --ff-only "origin/$Branch" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'NOTE: local and remote diverged; committing local first, then merging.'
        }
    }
}

# --- commit local changes ---
git add -A 2>&1 | Out-Null
$pending = git status --porcelain
if ($pending) {
    git commit -m "sync: E:\DAO_ARCHIVE $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>&1 | Out-Null
    Write-Host "committed $(($pending | Measure-Object).Count) change(s)"
}

# merge after committing if we diverged
if (-not $PushOnly) {
    git merge "origin/$Branch" -m 'sync: merge remote archive' 2>&1 | Out-Null
}

# --- push (local -> GitHub) ---
Invoke-GitRetry @('push', '-u', 'origin', $Branch) 'push' | Out-Null
Write-Host 'sync complete'
