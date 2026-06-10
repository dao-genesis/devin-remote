<#
dao v4.1 · 大道至简 · 太上 下知有之
GitHub Issues Comments = 无感传输层

一行启动:
  irm https://raw.githubusercontent.com/zhouyoukang1234-spec/devin-remote/main/agent.ps1 | iex

本质:
  PowerShell窗口不关闭 = 一直可操控
  GitHub = 无感传输层 (太上 下知有之)
  命令 = Comment (dao-cmd:base64)
  结果 = Comment (dao-result:base64)

v4.1 vs v3.2.1:
  去自适应轮询     — 固定间隔 大道至简
  去心跳文件       — mailbox本身即存活证明
  去rate追踪显示   — 403则等reset 道法自然
  去proxy自动发现  — DAO_PROXY环境变量即可
  去安装/卸载      — 手动运行 窗口不关即可
  保留If-Modified-Since — 304不计配额 道法自然
  用labels查询mailbox  — 1次API代替20次扫描

支持: shell screenshot sysinfo process_list process_kill
      file_list file_read file_write registry_read
      service_list network_info env_vars installed_apps
#>
param(
  [string]$Repo   = $(if($env:DAO_REPO){$env:DAO_REPO}else{'zhouyoukang1234-spec/devin-remote'}),
  [string]$Token  = $(if($env:DAO_TOKEN){$env:DAO_TOKEN}else{''}),
  [int]$Poll      = $(if($env:DAO_POLL){[int]$env:DAO_POLL}else{10})
)

# ════════════════════════════════════════════════════════════
# §0 · 道 · 一
# ════════════════════════════════════════════════════════════
$VER = '4.1'
$ID  = $env:COMPUTERNAME
$API = "https://api.github.com/repos/$Repo"

# Token: param > env > file > prompt
if(!$Token){
  $tf = Join-Path $env:USERPROFILE '.dao-token'
  if(Test-Path $tf){ $Token = (Get-Content $tf -Raw -EA 0).Trim() }
}
if(!$Token){
  $Token = Read-Host '[dao] GitHub PAT (classic, repo scope)'
  if($Token){ $Token | Set-Content (Join-Path $env:USERPROFILE '.dao-token') -Force -Encoding UTF8 }
}
if(!$Token){ Write-Host '[dao] no token, exit' -ForegroundColor Red; exit 1 }

# Proxy: env only
if($env:DAO_PROXY){ $env:HTTPS_PROXY=$env:DAO_PROXY; $env:HTTP_PROXY=$env:DAO_PROXY }

# ════════════════════════════════════════════════════════════
# §1 · API · 二 (一生二: 请求与响应)
# ════════════════════════════════════════════════════════════
# If-Modified-Since: 304 Not Modified 不计配额 — 道法自然
$script:LastModified = ''

function api($m='GET',$p,$b,[switch]$Cond){
  $h = @{'Authorization'="token $Token";'Accept'='application/vnd.github.v3+json'}
  $r = @{Uri="$API$p";Method=$m;Headers=$h;UseBasicParsing=$true;ErrorAction='Stop'}
  if($b){$r.Body=$b;$r.ContentType='application/json; charset=utf-8'}

  # Conditional GET: If-Modified-Since → 304 = free (不计配额)
  if($Cond -and $m -eq 'GET' -and $script:LastModified){
    $h['If-Modified-Since'] = $script:LastModified
  }

  try{
    $resp = Invoke-WebRequest @r
    # Save Last-Modified for next conditional request
    $lm = $resp.Headers['Last-Modified']
    if($lm){ $script:LastModified = $lm }
    return $resp.Content | ConvertFrom-Json
  }catch{
    $ex = $_.Exception
    # 304 Not Modified = no change = free
    if($ex.Response -and [int]$ex.Response.StatusCode -eq 304){
      return $null  # no new data
    }
    # 403 = rate limited
    if($ex.Response -and [int]$ex.Response.StatusCode -eq 403){
      # Read reset time from header
      $resetEpoch = $ex.Response.Headers['X-RateLimit-Reset']
      if($resetEpoch){
        $resetTime = [DateTimeOffset]::FromUnixTimeSeconds([long]$resetEpoch).ToLocalTime()
        $waitSec = [math]::Max(10, ($resetTime - (Get-Date)).TotalSeconds + 5)
        Write-Host "[dao] rate limited — wait ${waitSec}s until $resetTime" -ForegroundColor Red
        Start-Sleep ([int]$waitSec)
      }else{
        Write-Host '[dao] rate limited — sleep 60s' -ForegroundColor Red
        Start-Sleep 60
      }
      return $null
    }
    throw
  }
}

# ════════════════════════════════════════════════════════════
# §2 · Base64 · 万物负阴抱阳
# ════════════════════════════════════════════════════════════
function b64([string]$s){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))}
function unb64([string]$s){[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($s -replace '\s','')))}

# ════════════════════════════════════════════════════════════
# §3 · 执行 · 三生万物
# ════════════════════════════════════════════════════════════
function exec($cmd){
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $t = if($cmd.type){$cmd.type}else{'shell'}
  $p = if($cmd.payload){$cmd.payload}else{$cmd}
  $r = @{ exit_code=0; stdout=''; stderr=''; type=$t }

  try{
    switch($t){
      'shell' {
        $out = Invoke-Expression $p.command 2>&1
        $r.stdout = ($out | Out-String).TrimEnd()
      }
      'screenshot' {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $scale = if($p.scale){[int]$p.scale}else{50}
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen(0,0,0,0,$bmp.Size); $g.Dispose()
        if($scale -lt 100){
          $nw=[int]($bmp.Width*$scale/100); $nh=[int]($bmp.Height*$scale/100)
          $nb=New-Object System.Drawing.Bitmap($nw,$nh)
          $ng=[System.Drawing.Graphics]::FromImage($nb)
          $ng.DrawImage($bmp,0,0,$nw,$nh); $ng.Dispose(); $bmp.Dispose(); $bmp=$nb
        }
        $ms=New-Object System.IO.MemoryStream
        $bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
        $r.result=[Convert]::ToBase64String($ms.ToArray()); $ms.Dispose()
      }
      'sysinfo' {
        $os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem
        $ip=(Get-NetIPAddress -AddressFamily IPv4 -EA 0|Where-Object{$_.IPAddress -notmatch '^(127|169)'}|Select-Object -First 1).IPAddress
        $r.result=@{
          hostname=$ID; os=$os.Caption; arch=$os.OSArchitecture
          cpu=$cs.Name; ram_gb=[math]::Round($cs.TotalPhysicalMemory/1GB,1)
          free_gb=[math]::Round($os.FreePhysicalMemory/1MB,1); ip=$ip
          uptime=((Get-Date)-$os.LastBootUpTime).ToString('dd\d\ hh\h\ mm\m')
        }
      }
      'process_list' {
        $f=if($p.filter){$p.filter}else{''}
        $r.result=Get-Process -EA 0|Where-Object{$_.Name -like "*$f*" -or $f -eq ''}|
          Sort-Object WorkingSet64 -Descending|Select-Object -First 100 Name,Id,@{N='MB';E={[math]::Round($_.WorkingSet64/1MB,1)}},CPU
      }
      'process_kill' {
        if($p.pid){Stop-Process -Id ([int]$p.pid) -Force;$r.stdout="killed pid $($p.pid)"}
        elseif($p.name){Stop-Process -Name $p.name -Force -EA Stop;$r.stdout="killed $($p.name)"}
      }
      'file_list' {
        $path=if($p.path){$p.path}else{'C:\'}
        $r.result=Get-ChildItem $path -Force -EA 0|Select-Object Name,Length,LastWriteTime,Mode
      }
      'file_read' {
        $bytes=[System.IO.File]::ReadAllBytes($p.path)
        $r.result=[Convert]::ToBase64String($bytes)
        $r.stdout="read $($p.path) ($($bytes.Length) bytes)"
      }
      'file_write' {
        $bytes=[Convert]::FromBase64String($p.content_base64)
        [System.IO.File]::WriteAllBytes($p.path,$bytes)
        $r.stdout="wrote $($p.path) ($($bytes.Length) bytes)"
      }
      'registry_read' {
        $r.result=Get-ItemProperty $p.path -EA Stop
      }
      'service_list' {
        $f=if($p.filter){$p.filter}else{'*'}
        $r.result=Get-Service|Where-Object{$_.Name -like "*$f*" -or $_.DisplayName -like "*$f*"}|
          Select-Object Name,DisplayName,Status,StartType
      }
      'network_info' {
        $r.result=@{
          adapters=Get-NetAdapter|Select-Object Name,InterfaceDescription,Status,LinkSpeed
          ip=Get-NetIPAddress -AddressFamily IPv4 -EA 0|Where-Object{$_.IPAddress -notmatch '^(127|169)'}|Select-Object InterfaceAlias,IPAddress
          dns=Get-DnsClientServerAddress -AddressFamily IPv4 -EA 0|Select-Object InterfaceAlias,ServerAddresses
        }
      }
      'env_vars' {
        $f=if($p.filter){$p.filter}else{'*'}
        $r.result=Get-ChildItem Env:|Where-Object{$_.Name -like "*$f*"}|Select-Object Name,Value
      }
      'installed_apps' {
        $r.result=Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -EA 0|
          Where-Object{$_.DisplayName}|Select-Object DisplayName,DisplayVersion,Publisher
      }
      default { $r.exit_code=1; $r.stderr="unknown: $t" }
    }
  }catch{
    $r.exit_code=1; $r.stderr=$_.Exception.Message
  }
  $sw.Stop()
  $r.execution_time_ms=$sw.ElapsedMilliseconds
  return $r
}

# ════════════════════════════════════════════════════════════
# §4 · 启动 · 找到或创建mailbox
# ════════════════════════════════════════════════════════════
Write-Host "`n  dao v$VER · 大道至简 · 太上 下知有之" -ForegroundColor Cyan
Write-Host "  agent: $ID · repo: $Repo · poll: ${Poll}s`n" -ForegroundColor DarkGray

# Ensure label
try{ api POST '/labels' '{"name":"dao-mailbox","color":"0e8a16"}' }catch{}

# Mailbox: cache > labels query > create
$mb = 0
$cf = Join-Path $env:USERPROFILE '.dao-mailbox'
if(Test-Path $cf){ $mb = [int]((Get-Content $cf -Raw -EA 0).Trim()) }

if($mb -eq 0){
  # Use labels query: 1 API call finds all mailbox issues
  try{
    $issues = api GET '/issues?labels=dao-mailbox&state=open&per_page=100'
    if($issues){
      foreach($i in $issues){
        if($i.title -eq "mailbox-$ID"){ $mb=$i.number; break }
      }
    }
  }catch{}
}

if($mb -eq 0){
  try{
    $ni = api POST '/issues' (@{title="mailbox-$ID";body="dao mailbox v4 — $ID";labels=@('dao-mailbox')}|ConvertTo-Json -Depth 3 -Compress)
    $mb = $ni.number
  }catch{
    Write-Host "[dao] failed to create mailbox" -ForegroundColor Red; exit 1
  }
}

$mb | Set-Content $cf -Force -Encoding UTF8
Write-Host "[dao] mailbox: #$mb" -ForegroundColor Green

# ════════════════════════════════════════════════════════════
# §5 · 主循环 · 道恒无名
# ════════════════════════════════════════════════════════════
$seen = @{}
$n = 0

Write-Host "[dao] polling... (Ctrl+C to stop)`n" -ForegroundColor DarkGray

while($true){
  try{
    # Conditional GET: 304 = no change = free (不计配额)
    $comments = api GET "/issues/$mb/comments?per_page=50&sort=created&direction=asc" -Cond
    if($comments){
      foreach($c in $comments){
        if($seen[$c.id]){ continue }
        $seen[$c.id] = $true

        if($c.body -match '^dao-cmd:(.+)'){
          $n++
          try{ $cmd = unb64 $Matches[1] | ConvertFrom-Json }
          catch{ $cmd = @{type='shell';payload=@{command=$Matches[1]}} }

          $ts = Get-Date -Format 'HH:mm:ss'
          Write-Host "[$ts] #$n cmd: $($cmd.type)" -ForegroundColor Cyan

          $result = exec $cmd
          $rj = $result | ConvertTo-Json -Depth 10 -Compress
          try{
            api POST "/issues/$mb/comments" (@{body="dao-result:$(b64 $rj)"}|ConvertTo-Json -Compress)
            Write-Host "  [+] $($result.execution_time_ms)ms" -ForegroundColor Green
          }catch{
            Write-Host "  [!] post failed" -ForegroundColor Red
          }
        }
      }
    }
  }catch{
    Write-Host "[dao] err: $($_.Exception.Message)" -ForegroundColor Red
  }
  Start-Sleep $Poll
}
