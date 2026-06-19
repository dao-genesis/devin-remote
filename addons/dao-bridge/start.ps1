<#
dao-bridge 独立后端 一键启动（PowerShell 5.1+ / 7）
  - 首次自动：生成 token 写 conn.json
  - 之后：node agent.js（起本地服务 + cloudflared 快速隧道出站）

用法:
  .\start.ps1                       # 用已有/新生成的 conn.json
  $env:DAO_TOKEN='xxx'; .\start.ps1 # 显式指定 token
#>
param(
  [int]$Port    = $(if($env:DAO_PORT){[int]$env:DAO_PORT}else{9920}),
  [string]$Root = $(if($env:DAO_ROOT){$env:DAO_ROOT}else{$env:USERPROFILE})
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
($obj | ConvertTo-Json) | Set-Content -Path $connPath -Encoding UTF8
Write-Host "[dao-bridge] conn.json -> $connPath" -ForegroundColor Green
Write-Host "[dao-bridge] 启动 cloudflared 快速隧道，拿到 URL 后打印公网入口 (Bearer $token)" -ForegroundColor Yellow

# 运行
node agent.js
