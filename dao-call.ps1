<#
dao-call v4.1 · 大道至简 · 太上 下知有之
Mailbox Pattern commander · Pure HTTPS

  iex ((New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/zhouyoukang1234-spec/devin-remote/main/dao-call.ps1'))

  dao 179 hostname          # shell command
  dao-shot 179              # screenshot
  dao-sys 141               # system info

v4.1 vs v3.2:
  去proxy自动发现  — DAO_PROXY环境变量即可
  去heartbeat列表  — mailbox本身即存活证明
  去broadcast      — 非核心
  用labels查询mailbox — 1次API代替20次扫描
#>
param(
  [string]$Repo    = $(if($env:DAO_REPO){$env:DAO_REPO}else{'zhouyoukang1234-spec/devin-remote'}),
  [string]$Token   = $(if($env:DAO_TOKEN){$env:DAO_TOKEN}else{''}),
  [int]$Timeout    = $(if($env:DAO_TIMEOUT){[int]$env:DAO_TIMEOUT}else{120})
)

$VER = '4.1'
$API = "https://api.github.com/repos/$Repo"

# Token: param > env > file
if(!$Token){
  $tf = Join-Path $env:USERPROFILE '.dao-token'
  if(Test-Path $tf){ $Token = (Get-Content $tf -Raw -EA 0).Trim() }
}
if(!$Token){ Write-Host '[dao] set $env:DAO_TOKEN first' -ForegroundColor Red; return }

# Proxy: env only
if($env:DAO_PROXY){ $env:HTTPS_PROXY=$env:DAO_PROXY; $env:HTTP_PROXY=$env:DAO_PROXY }

# ════════════════════════════════════════════════════════════
# §1 · API
# ════════════════════════════════════════════════════════════
function api($m='GET',$p,$b){
  $h=@{'Authorization'="token $Token";'Accept'='application/vnd.github.v3+json'}
  $r=@{Uri="$API$p";Method=$m;Headers=$h;UseBasicParsing=$true;ErrorAction='Stop'}
  if($b){$r.Body=$b;$r.ContentType='application/json; charset=utf-8'}
  (Invoke-WebRequest @r).Content | ConvertFrom-Json
}

# ════════════════════════════════════════════════════════════
# §2 · Base64
# ════════════════════════════════════════════════════════════
function b64([string]$s){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))}
function unb64([string]$s){[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($s -replace '\s','')))}

# ════════════════════════════════════════════════════════════
# §3 · Alias + Mailbox
# ════════════════════════════════════════════════════════════
$Alias = @{ '141'='DESKTOP-MASTER'; '179'='ZHOUMAC'; 'desktop'='DESKTOP-MASTER'; 'laptop'='ZHOUMAC' }
$mbCache = @{}

function resolve($n){
  if($Alias[$n.ToLower()]){ return $Alias[$n.ToLower()] }
  return $n
}

function mailbox($agent){
  if($mbCache[$agent]){ return $mbCache[$agent] }

  # Use labels query: 1 API call finds all mailbox issues
  try{
    $issues = api GET '/issues?labels=dao-mailbox&state=open&per_page=100'
    if($issues){
      foreach($i in $issues){
        # Cache all mailboxes found
        if($i.title -match '^mailbox-(.+)'){
          $mbCache[$Matches[1]] = $i.number
        }
        if($i.title -eq "mailbox-$agent"){ return $i.number }
      }
    }
  }catch{}

  # create
  try{
    $ni = api POST '/issues' (@{title="mailbox-$agent";body="dao mailbox v4 — $agent";labels=@('dao-mailbox')}|ConvertTo-Json -Depth 3 -Compress)
    $mbCache[$agent]=$ni.number; return $ni.number
  }catch{
    Write-Host "[dao] no mailbox for $agent" -ForegroundColor Red; return $null
  }
}

# ════════════════════════════════════════════════════════════
# §4 · 发命令 + 等结果
# ════════════════════════════════════════════════════════════
function send($agent,$type,$payload,[int]$sec=$Timeout){
  $target = resolve $agent
  $mb = mailbox $target
  if(!$mb){ return $null }

  # post command
  $cmd = @{type=$type;payload=$payload}|ConvertTo-Json -Depth 5 -Compress
  try{
    api POST "/issues/$mb/comments" (@{body="dao-cmd:$(b64 $cmd)"}|ConvertTo-Json -Compress)
    Write-Host "[dao] -> $target (mailbox #$mb)" -ForegroundColor Cyan
  }catch{
    Write-Host "[dao] send failed" -ForegroundColor Red; return $null
  }

  # wait for result
  $deadline = (Get-Date).AddSeconds($sec)
  $seenIds = @{}
  try{
    $existing = api GET "/issues/$mb/comments?per_page=50&sort=created&direction=desc"
    foreach($c in $existing){ $seenIds[$c.id]=$true }
  }catch{}

  while((Get-Date) -lt $deadline){
    Start-Sleep 3
    try{
      $comments = api GET "/issues/$mb/comments?per_page=10&sort=created&direction=desc"
      foreach($c in $comments){
        if($seenIds[$c.id]){ continue }
        if($c.body -match 'dao-result:(.+)'){
          $result = unb64 $Matches[1] | ConvertFrom-Json
          if($result.exit_code -eq 0){ Write-Host "[dao] OK ($($result.execution_time_ms)ms)" -ForegroundColor Green }
          else{ Write-Host "[dao] FAILED ($($result.execution_time_ms)ms)" -ForegroundColor Red }
          if($result.stdout){ Write-Host $result.stdout }
          if($result.stderr){ Write-Host $result.stderr -ForegroundColor Red }
          return $result
        }
      }
    }catch{}
  }
  Write-Host "[dao] timeout (${sec}s)" -ForegroundColor Red
  return $null
}

# ════════════════════════════════════════════════════════════
# §5 · 命令函数
# ════════════════════════════════════════════════════════════
function dao([string]$agent,[string]$command){
  if(!$agent -or !$command){ Write-Host "usage: dao <agent> <command>" -F Yellow; return }
  send $agent 'shell' @{command=$command}
}
function dao-shot([string]$agent,[int]$scale=50){ send $agent 'screenshot' @{scale=$scale} }
function dao-sys([string]$agent){ send $agent 'sysinfo' @{} }
function dao-ps([string]$agent,[string]$filter=''){ send $agent 'process_list' @{filter=$filter} }
function dao-kill([string]$agent,[int]$ProcessId=0,[string]$name=''){
  $p=@{}; if($ProcessId){$p.pid=$ProcessId}; if($name){$p.name=$name}
  send $agent 'process_kill' $p
}
function dao-ls([string]$agent,[string]$path='C:\'){ send $agent 'file_list' @{path=$path} }
function dao-get([string]$agent,[string]$path){ send $agent 'file_read' @{path=$path} }
function dao-put([string]$agent,[string]$local,[string]$remote){
  $bytes=[System.IO.File]::ReadAllBytes((Resolve-Path $local -EA Stop).Path)
  send $agent 'file_write' @{path=$remote;content_base64=[Convert]::ToBase64String($bytes)}
}
function dao-reg([string]$agent,[string]$path){ send $agent 'registry_read' @{path=$path} }
function dao-svc([string]$agent,[string]$filter=''){ send $agent 'service_list' @{filter=$filter} }
function dao-net([string]$agent){ send $agent 'network_info' @{} }
function dao-env([string]$agent,[string]$filter=''){ send $agent 'env_vars' @{filter=$filter} }
function dao-apps([string]$agent){ send $agent 'installed_apps' @{} }

function dao-help {
  Write-Host "`n  dao-call v$VER · 大道至简`n" -ForegroundColor Cyan
  Write-Host "  dao <agent> <cmd>        Shell command"
  Write-Host "  dao-shot <agent> [scale] Screenshot"
  Write-Host "  dao-sys <agent>          System info"
  Write-Host "  dao-ps <agent> [filter]  Process list"
  Write-Host "  dao-kill <agent> -ProcessId N  Kill process"
  Write-Host "  dao-ls <agent> [path]    List files"
  Write-Host "  dao-get <agent> <path>   Read file"
  Write-Host "  dao-put <agent> <l> <r>  Write file"
  Write-Host "  dao-reg <agent> <path>   Read registry"
  Write-Host "  dao-svc <agent> [filter] List services"
  Write-Host "  dao-net <agent>          Network info"
  Write-Host "  dao-env <agent> [filter] Env vars"
  Write-Host "  dao-apps <agent>         Installed apps"
  Write-Host "  dao-help                 This help`n"
  Write-Host "  Aliases: 141=DESKTOP-MASTER  179=ZHOUMAC" -ForegroundColor DarkGray
  Write-Host "  Env: DAO_TOKEN DAO_REPO DAO_PROXY DAO_TIMEOUT`n" -ForegroundColor DarkGray
}

# ════════════════════════════════════════════════════════════
# §6 · 加载完成
# ════════════════════════════════════════════════════════════
Write-Host "[dao] dao-call v$VER loaded · dao-help for commands" -ForegroundColor Green
