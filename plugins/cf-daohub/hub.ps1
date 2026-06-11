# ════════════════════════════════════════════════════════════
# ☰ CF-DaoHub Hub Launcher v3 — universal
#
# Starts: Server(:9910) + Agent(localhost) + cloudflared tunnel
# One command, three processes, zero config.
#
# Usage: .\hub.ps1
#
# Customize: edit $PORT, $TOKEN below
# ════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$HUB_DIR    = $PSScriptRoot
$AGENT_ROOT = Split-Path -Parent $HUB_DIR
$DAO_HOME   = Join-Path $env:USERPROFILE '.dao'

$PORT       = 9910
$PYTHON     = 'python'
$SERVER_PY  = Join-Path $AGENT_ROOT 'ps_agent_server.py'
$AGENT_PY   = Join-Path $HUB_DIR 'agent_dao.py'
$TOKEN      = 'dao-ps-agent-2026'
$MY_HOST    = $env:COMPUTERNAME

# ── Find cloudflared — universal search ──
function Find-Cloudflared {
    # 1. Already in PATH
    $cmd = Get-Command cloudflared -CommandType Application -EA SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # 2. Common install locations
    $candidates = @(
        # winget
        Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\cloudflared.exe'
        Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Cloudflare.cloudflared_*\cloudflared.exe'
        # scoop
        Join-Path $env:USERPROFILE 'scoop\shims\cloudflared.exe'
        Join-Path $env:USERPROFILE 'scoop\apps\cloudflared\current\cloudflared.exe'
        # choco
        "$env:ProgramData\chocolatey\bin\cloudflared.exe"
        # manual extract in PATH directories
        "$env:SystemRoot\cloudflared.exe"
        "$env:SystemRoot\System32\cloudflared.exe"
        # script directory
        Join-Path $HUB_DIR 'cloudflared.exe'
        # home directory
        Join-Path $env:USERPROFILE 'cloudflared.exe'
    )

    foreach ($p in $candidates) {
        if ($p -match '\*') {
            $resolved = Get-Item $p -EA SilentlyContinue | Select-Object -First 1
            if ($resolved) { return $resolved.FullName }
        } elseif (Test-Path $p) {
            return $p
        }
    }

    # 3. Deep search in common parent dirs (shallow, fast)
    $searchDirs = @(
        Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
        Join-Path $env:USERPROFILE 'scoop\apps'
    )
    foreach ($dir in $searchDirs) {
        $found = Get-ChildItem $dir -Recurse -Depth 2 -Filter 'cloudflared.exe' -EA SilentlyContinue `
            | Select-Object -First 1
        if ($found) { return $found.FullName }
    }

    return $null
}

$CF_EXE = Find-Cloudflared

if (-not $CF_EXE) {
    Write-Host "  [!] cloudflared not found. Install: winget install Cloudflare.cloudflared" -ForegroundColor Yellow
    Write-Host "       Or: https://github.com/cloudflare/cloudflared/releases" -ForegroundColor Yellow
}

# ── Step 1: Server ──
Write-Host "[1/3] Starting Server (port=$PORT)..." -ForegroundColor Yellow
$env:PS_AGENT_PORT = "$PORT"
$env:PS_AGENT_MASTER_TOKEN = $TOKEN

if (-not (Test-Path $DAO_HOME)) { New-Item -Path $DAO_HOME -ItemType Directory -Force | Out-Null }
$serverLog = Join-Path $DAO_HOME 'server.log'
$serverErr = Join-Path $DAO_HOME 'server-err.log'

Start-Process -FilePath $PYTHON `
    -ArgumentList "`"$SERVER_PY`" --port $PORT" `
    -WorkingDirectory $AGENT_ROOT `
    -WindowStyle Hidden `
    -RedirectStandardOutput $serverLog `
    -RedirectStandardError $serverErr

# Wait for port
for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 200
    $conn = Get-NetTCPConnection -LocalPort $PORT -State Listen -EA SilentlyContinue
    if ($conn) { Write-Host "  [+] Server running (PID=$($conn[0].OwningProcess))" -ForegroundColor Green; break }
}

# ── Step 2: Local Agent ──
Write-Host "[2/3] Starting local Agent..." -ForegroundColor Yellow
Start-Process -FilePath $PYTHON `
    -ArgumentList "`"$AGENT_PY`" --server http://localhost:$PORT --hostname $MY_HOST" `
    -WindowStyle Hidden
Start-Sleep 3
Write-Host "  [+] Agent started" -ForegroundColor Green

# ── Step 3: Cloudflare Tunnel ──
Write-Host "[3/3] Starting Cloudflare Tunnel..." -ForegroundColor Yellow
$tunnelUrl = $null

if ($CF_EXE) {
    $cfLog = Join-Path $DAO_HOME 'cloudflared.log'

    Get-Process cloudflared -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue

    Start-Process -FilePath $CF_EXE `
        -ArgumentList "tunnel --no-autoupdate --protocol http2 --url http://localhost:$PORT --logfile `"$cfLog`"" `
        -WindowStyle Hidden

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep 1
        if (Test-Path $cfLog) {
            $log = Get-Content $cfLog -Raw -EA SilentlyContinue
            if ($log -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
                $tunnelUrl = $Matches[1]
                break
            }
        }
    }

    if ($tunnelUrl) {
        Write-Host "  [+] Tunnel: $tunnelUrl" -ForegroundColor Green
        $conn = @{
            url          = $tunnelUrl
            local_url    = "http://localhost:$PORT"
            token        = $TOKEN
            port         = $PORT
            hostname     = $MY_HOST
            generated_at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
        }
        $conn | ConvertTo-Json -Depth 2 | Out-File (Join-Path $DAO_HOME 'cf-hub-conn.json') -Encoding utf8 -Force
    } else {
        Write-Host "  [!] Tunnel URL not detected. Check: $cfLog" -ForegroundColor Red
    }
}

# ── Summary ──
Write-Host ""
Write-Host "=== CF-DaoHub Running ===" -ForegroundColor Cyan
Write-Host "  Local:   http://localhost:$PORT" -ForegroundColor White
if ($tunnelUrl) {
    Write-Host "  Public:  $tunnelUrl" -ForegroundColor Green
}
Write-Host "  Token:   $TOKEN" -ForegroundColor DarkGray
Write-Host ""

try {
    $health = Invoke-RestMethod "http://localhost:$PORT/api/health" -TimeoutSec 3
    Write-Host "  Status: agents=$($health.agents_online)/$($health.agents_total)  v$($health.version)" -ForegroundColor Green
} catch {
    Write-Host "  (Server still booting...)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Cloud client:" -ForegroundColor Yellow
if ($tunnelUrl) {
    Write-Host "  python cf_cloud_agent.py --url $tunnelUrl --token $TOKEN --health" -ForegroundColor White
}
Write-Host "Deploy to LAN: .\deploy.ps1 -ServerHost <this-IP> -TargetHost <target-IP>" -ForegroundColor White
Write-Host ""
