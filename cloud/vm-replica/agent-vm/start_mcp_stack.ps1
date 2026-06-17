<#
start_mcp_stack.ps1  ·  道法自然 · 无为而无不为

One-shot, idempotent launcher for the DAO four-module MCP stack on a Windows host.
Brings up (and leaves running) exactly three pieces, reusing what is already alive:

  1. vm_inner_agent.py   on PC_PORT (default 9050) in the INTERACTIVE console session
                         => the "先不用多RDP" target = the user's real desktop.
  2. mcp_http.py         on MCP_PORT (default 9100) = the Streamable-HTTP MCP endpoint.
  3. cloudflared         a quick tunnel -> http://127.0.0.1:<MCP_PORT>, giving a public
                         https URL for remote MCP clients (Devin Cloud / Claude / Cursor).

The resolved public URL + bearer token are written to
  C:\ProgramData\dao_vm\mcp_public.json   { "url": "https://.../mcp", "token": "..." }
so the plugin (dao-vsix) can read it and (re)inject the MCP into accounts. Because a
quick-tunnel URL changes across restarts, the plugin re-injects only when the URL
changes — embrace the churn, auto-heal.

Usage:  powershell -ExecutionPolicy Bypass -File start_mcp_stack.ps1
#>
param(
  [int]$PcPort   = $(if ($env:PC_PORT)   { [int]$env:PC_PORT }   else { 9050 }),
  [int]$McpPort  = $(if ($env:MCP_PORT)  { [int]$env:MCP_PORT }  else { 9100 }),
  [string]$Token = $env:MCP_TOKEN
)

$ErrorActionPreference = 'Continue'
$cfgDir = 'C:\ProgramData\dao_vm'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null

# token: reuse the existing dao_vm token if present, else generate + persist
if (-not $Token) {
  $cfgPath = Join-Path $cfgDir 'config.json'
  if (Test-Path $cfgPath) { try { $Token = (Get-Content $cfgPath -Raw | ConvertFrom-Json).token } catch {} }
}
if (-not $Token) { $Token = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) }) }

$py = 'C:\ProgramData\anaconda3\python.exe'
if (-not (Test-Path $py)) { $py = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
if (-not $py) { Write-Error 'python.exe not found'; exit 1 }

$daoVm = 'C:\dao_vm'

function Test-Listen([int]$port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

# 1) inner agent (console session)
if (Test-Listen $PcPort) {
  Write-Output "inner-agent already on :$PcPort"
} else {
  $env:VM_AGENT_PORT = "$PcPort"; $env:VM_AGENT_TOKEN = $Token; $env:VM_AGENT_BIND = '127.0.0.1'
  Start-Process -FilePath $py -ArgumentList (Join-Path $daoVm 'vm_inner_agent.py') -WindowStyle Hidden | Out-Null
  Write-Output "inner-agent launched on :$PcPort"
}

# 2) mcp_http
if (Test-Listen $McpPort) {
  Write-Output "mcp_http already on :$McpPort"
} else {
  $env:MCP_HTTP_PORT = "$McpPort"; $env:MCP_HTTP_TOKEN = $Token
  $env:PC_PORT = "$PcPort"; $env:PC_TOKEN = $Token; $env:DV_PORT = '9920'
  Start-Process -FilePath $py -ArgumentList (Join-Path $daoVm 'mcp_http.py') -WindowStyle Hidden | Out-Null
  Write-Output "mcp_http launched on :$McpPort"
}

# 3) cloudflared quick tunnel -> :McpPort
$cf = "$env:USERPROFILE\.dao\bin\cloudflared.exe"
if (-not (Test-Path $cf)) { $cf = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source }
$log = Join-Path $cfgDir 'mcp_tunnel.log'
function Get-TunnelUrl { if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { return $m.Matches[0].Value } } return $null }
$existing = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match "127.0.0.1:$McpPort" }
# Own the tunnel: if one exists but its URL isn't resolvable from our log, restart it
# under our control so the public URL is always captured into mcp_public.json.
if ($existing -and -not (Get-TunnelUrl)) {
  Write-Output "cloudflared tunnel for :$McpPort not under our log; restarting to capture URL"
  $existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  $existing = $null
}
if ($existing) {
  Write-Output "cloudflared already tunneling :$McpPort (pid $($existing.ProcessId))"
} elseif ($cf) {
  Remove-Item $log -ErrorAction SilentlyContinue
  Start-Process -FilePath $cf -ArgumentList @('tunnel','--no-autoupdate','--url',"http://127.0.0.1:$McpPort",'--logfile',$log) -WindowStyle Hidden | Out-Null
  Write-Output "cloudflared launched -> :$McpPort"
} else {
  Write-Output "cloudflared not found; MCP reachable on 127.0.0.1:$McpPort only"
}

# resolve public URL from the tunnel log (best effort)
$publicUrl = $null
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if ($m) { $publicUrl = ($m.Matches[0].Value); break }
  }
}

$out = [ordered]@{
  url       = if ($publicUrl) { "$publicUrl/mcp" } else { $null }
  base      = $publicUrl
  token     = $Token
  mcp_port  = $McpPort
  pc_port   = $PcPort
  updated   = (Get-Date).ToString('o')
}
$pubPath = Join-Path $cfgDir 'mcp_public.json'
$out | ConvertTo-Json | Set-Content -LiteralPath $pubPath -Encoding UTF8
Write-Output ("mcp_public.json => " + ($out | ConvertTo-Json -Compress))
