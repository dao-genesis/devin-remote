<#
dao-bridge 独立后端 一键启动（PowerShell 5.1+ / 7）
  - 首次自动：npm install（装 ws）+ 生成 token 写 conn.json
  - 之后：node agent.js（出站连公网 Worker 中继）

用法:
  .\start.ps1                       # 用已有/新生成的 conn.json
  .\start.ps1 -Session 141          # 指定会话名（云端 /relay/<session>）
  $env:DAO_TOKEN='xxx'; .\start.ps1 # 显式指定 token
#>
param(
  [string]$Relay   = $(if($env:DAO_RELAY){$env:DAO_RELAY}else{'https://dao-relay-do.zhouyoukang.workers.dev'}),
  [string]$Session = $(if($env:DAO_SESSION){$env:DAO_SESSION}else{'141'}),
  [int]$Port       = $(if($env:DAO_PORT){[int]$env:DAO_PORT}else{9920}),
  [string]$Root    = $(if($env:DAO_ROOT){$env:DAO_ROOT}else{$env:USERPROFILE})
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 1) 依赖
if(-not (Test-Path (Join-Path $PSScriptRoot 'node_modules\ws'))){
  Write-Host '[dao-bridge] npm install ...' -ForegroundColor Cyan
  npm install --no-audit --no-fund | Out-Host
}

# 2) conn.json（token 仅存本机，不入库）
$connPath = Join-Path $PSScriptRoot 'conn.json'
$conn = $null
if(Test-Path $connPath){ try{ $conn = Get-Content $connPath -Raw | ConvertFrom-Json }catch{} }
$token = if($env:DAO_TOKEN){$env:DAO_TOKEN} elseif($conn -and $conn.token){$conn.token} else {
  'dao141-' + ([guid]::NewGuid().ToString('N').Substring(0,16))
}
$obj = [ordered]@{ relayUrl=$Relay; session=$Session; token=$token; port=$Port; root=$Root; host=$env:COMPUTERNAME }
($obj | ConvertTo-Json) | Set-Content -Path $connPath -Encoding UTF8
Write-Host "[dao-bridge] conn.json -> $connPath" -ForegroundColor Green
Write-Host "[dao-bridge] 云端入口: POST $($Relay.TrimEnd('/'))/relay/$Session  (Bearer $token)" -ForegroundColor Yellow

# 3) 运行
node agent.js
