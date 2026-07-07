<#
dao-bridge 独立后端 一键启动（PowerShell 5.1+ / 7）
  - 首次自动：生成 token 写 conn.json
  - 之后：node agent.js（起本地服务 + cloudflared 快速隧道出站 + 可选持久 Worker 通道）

用法:
  .\start.ps1                       # 用已有/新生成的 conn.json
  $env:DAO_TOKEN='xxx'; .\start.ps1 # 显式指定 token
  # 持久通道（IDE 无关·固定地址）：挂到自有持久 Worker 一个固定 (session,token)：
  .\start.ps1 -RelayUrl https://dao-relay-do.<sub>.workers.dev -Session desktop-master -RelayToken dao-vsix-xxxx
#>
param(
  [int]$Port         = $(if($env:DAO_PORT){[int]$env:DAO_PORT}else{9920}),
  [string]$Root      = $(if($env:DAO_ROOT){$env:DAO_ROOT}else{$env:USERPROFILE}),
  [string]$RelayUrl  = $(if($env:DAO_RELAY_URL){$env:DAO_RELAY_URL}else{''}),
  [string]$Session   = $(if($env:DAO_SESSION){$env:DAO_SESSION}else{''}),
  [string]$RelayToken= $(if($env:DAO_RELAY_TOKEN){$env:DAO_RELAY_TOKEN}else{''})
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# conn.json（token 仅存本机，不入库）
$connPath = Join-Path $PSScriptRoot 'conn.json'
$conn = $null
if(Test-Path $connPath){ try{ $conn = Get-Content $connPath -Raw | ConvertFrom-Json }catch{} }
$token = if($env:DAO_TOKEN){$env:DAO_TOKEN} elseif($conn -and $conn.token){$conn.token} else {
  'dao-' + ([guid]::NewGuid().ToString('N').Substring(0,16))
}
$obj = [ordered]@{ token=$token; port=$Port; root=$Root; host=$env:COMPUTERNAME }
if($RelayUrl){ $obj.relayUrl = $RelayUrl }
if($Session){ $obj.session = $Session }
if($RelayToken){ $obj.relayToken = $RelayToken }
($obj | ConvertTo-Json) | Set-Content -Path $connPath -Encoding UTF8
if($RelayUrl){ Write-Host "[dao-bridge] 持久通道: $RelayUrl/relay/$(if($Session){$Session}else{$env:COMPUTERNAME})  (固定·IDE 无关)" -ForegroundColor Cyan }
Write-Host "[dao-bridge] conn.json -> $connPath" -ForegroundColor Green
Write-Host "[dao-bridge] 启动 cloudflared 快速隧道，拿到 URL 后打印公网入口 (Bearer $token)" -ForegroundColor Yellow

# 运行
node agent.js
