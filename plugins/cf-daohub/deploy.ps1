# ════════════════════════════════════════════════════════════
# ☰ Deploy Agent to 141 (DESKTOP-MASTER) via WinRM
#
# Usage: .\deploy.ps1
# Default: 192.168.31.141 -> 192.168.31.179:9910
# ════════════════════════════════════════════════════════════

param(
    [string]$TargetHost = '192.168.31.141',
    [string]$ServerHost = '192.168.31.179',
    [int]   $ServerPort = 9910,
    [string]$AgentPath  = 'C:\dao\agent_dao.py'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$AGENT_PY_FILE = Join-Path $PSScriptRoot 'agent_dao.py'

if (-not (Test-Path $AGENT_PY_FILE)) {
    Write-Host "[!] agent_dao.py not found" -ForegroundColor Red
    exit 1
}

$bytes = [System.IO.File]::ReadAllBytes($AGENT_PY_FILE)
$b64 = [System.Convert]::ToBase64String($bytes)

Write-Host "=== Deploy Agent to $TargetHost ===" -ForegroundColor Cyan

# 1. WinRM check
Write-Host "[1/3] Test WinRM..." -ForegroundColor Yellow
try {
    $test = Invoke-Command -ComputerName $TargetHost -ScriptBlock { hostname } -ErrorAction Stop
    Write-Host "  [+] Connected: $test" -ForegroundColor Green
} catch {
    Write-Host "  [!] WinRM unreachable: $_" -ForegroundColor Red
    exit 1
}

# 2. Deploy
Write-Host "[2/3] Deploy agent_dao.py..." -ForegroundColor Yellow

$result = Invoke-Command -ComputerName $TargetHost -ScriptBlock {
    param($b64content, $remotePath, $serverHost, $serverPort)

    Get-Process python,pythonw -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
    Start-Sleep 2

    $dir = Split-Path $remotePath -Parent
    if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
    $bytes = [System.Convert]::FromBase64String($b64content)
    [System.IO.File]::WriteAllBytes($remotePath, $bytes)

    $proc = Invoke-WmiMethod -Class Win32_Process -Name Create `
        -ArgumentList "pythonw `"$remotePath`" --server http://${serverHost}:${serverPort}"

    return "PID=$($proc.ProcessId)"
} -ArgumentList $b64, $AgentPath, $ServerHost, $ServerPort

Write-Host "  [+] $result" -ForegroundColor Green

# 3. Verify
Write-Host "[3/3] Verify..." -ForegroundColor Yellow
Start-Sleep 6

try {
    $agents = Invoke-RestMethod "http://localhost:$ServerPort/api/agents" `
        -Headers @{Authorization="Bearer dao-ps-agent-2026"} `
        -TimeoutSec 5
    $a141 = $agents.agents | Where-Object { $_.hostname -eq 'DESKTOP-MASTER' }
    if ($a141 -and $a141.status -eq 'online') {
        Write-Host "  [+] 141 Agent ONLINE" -ForegroundColor Green
    } elseif ($a141) {
        Write-Host "  [~] 141 status: $($a141.status)" -ForegroundColor Yellow
    } else {
        Write-Host "  [~] 141 not found in registry" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [~] Cannot query: $_" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Deploy complete." -ForegroundColor Green
