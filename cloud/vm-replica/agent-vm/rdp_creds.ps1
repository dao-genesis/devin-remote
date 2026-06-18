<#
.SYNOPSIS
  RDP credential store + quick-select multi-account launcher for the local box.

.DESCRIPTION
  Companion to ts_multifix.py (which lifts the client-SKU single-session limit). It lets
  you reach every local Windows account over RDP without retyping anything:

    * each account is mapped to a STABLE loopback target (127.0.0.<n>) so the saved
      cmdkey credential and the mstsc history entry never shuffle between runs;
    * -Register populates the built-in "Computer" drop-down of the Remote Desktop
      client (MRU + per-target UsernameHint) and drops a ready-to-click <user>.rdp for
      every account, so you can quick-pick an account from the default selector;
    * every connect goes through a generated .rdp that sets `authentication level:i:0`
      and `prompt for credentials:i:0`, and the cert warning is disabled globally, so a
      connection opens as ONE clean window with no extra cert / credential pop-ups;
    * helper processes (cmdkey, the patch refresh) run windowless, so launching from a
      hidden shortcut no longer flashes several stray console windows.

  Passwords given to -Set are DPAPI-encrypted (LocalMachine) under
  C:\ProgramData\dao_vm\creds\<user>.cred and also written into Windows Credential
  Manager (cmdkey) for the account's target. -Register works on accounts that already
  have a cmdkey credential too, so the drop-down can be fixed without re-entering them.

.EXAMPLE
  # store a password once (prompts securely; nothing echoed) and wire everything up
  powershell -ExecutionPolicy Bypass -File rdp_creds.ps1 -Set zhou

.EXAMPLE
  # (re)build the Remote Desktop drop-down + .rdp shortcuts for all known accounts
  powershell -ExecutionPolicy Bypass -File rdp_creds.ps1 -Register

.EXAMPLE
  # see all enabled local accounts + their target / credential / session state
  powershell -ExecutionPolicy Bypass -File rdp_creds.ps1 -List

.EXAMPLE
  # open concurrent sessions for several accounts at once
  powershell -ExecutionPolicy Bypass -File rdp_creds.ps1 -Connect zhou,zhou1,ai

.EXAMPLE
  # interactive picker (default when no verb is given)
  powershell -ExecutionPolicy Bypass -File rdp_creds.ps1
#>
[CmdletBinding(DefaultParameterSetName = 'Menu')]
param(
    [Parameter(ParameterSetName = 'Set')]      [string]   $Set,
    [Parameter(ParameterSetName = 'Connect')]  [string[]] $Connect,
    [Parameter(ParameterSetName = 'List')]     [switch]   $List,
    [Parameter(ParameterSetName = 'Register')] [switch]   $Register,
    [switch] $Force,                  # connect even if the account already has a session
    [int]    $Width   = 1280,
    [int]    $Height  = 800
)

$ErrorActionPreference = 'Stop'
$CredDir  = 'C:\ProgramData\dao_vm\creds'
$RdpDir   = 'C:\ProgramData\dao_vm\rdp'
$MapPath  = Join-Path $CredDir 'targets.json'
$TscKey   = 'HKCU:\Software\Microsoft\Terminal Server Client'
$MultiFix = 'C:\dao_vm\ts_multifix.py'

function Find-Python {
    foreach ($p in 'C:\ProgramData\anaconda3\python.exe', 'C:\Windows\py.exe') {
        if (Test-Path $p) { return $p }
    }
    $c = Get-Command python.exe, py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
    return $null
}

function Initialize-Store {
    foreach ($d in $CredDir, $RdpDir) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }
}

function Get-EnabledAccounts {
    Get-LocalUser | Where-Object { $_.Enabled } | Select-Object -ExpandProperty Name | Sort-Object
}

function Get-CredPath([string] $User) { Join-Path $CredDir ($User.ToLower() + '.cred') }
function Get-RdpPath([string]  $User) { Join-Path $RdpDir  ($User + '.rdp') }

# Run a console tool without ever flashing a window (so a hidden launcher stays clean).
function Invoke-Hidden([string] $File, [string] $Arguments) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName               = $File
    $psi.Arguments              = $Arguments
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $p = [Diagnostics.Process]::Start($psi)
    $null = $p.StandardOutput.ReadToEnd(); $null = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return $p.ExitCode
}

function Ensure-MultiSession {
    $py = Find-Python
    if ($py -and (Test-Path $MultiFix)) {
        try { Invoke-Hidden $py "`"$MultiFix`" ensure" | Out-Null } catch { Write-Warning "ensure_multisession 调用失败: $_" }
    }
}

# --- stable account -> loopback-octet map -------------------------------------------
# Seeded from credentials already saved in Windows (cmdkey TERMSRV/127.0.0.<n>) so we
# never reshuffle a user's existing target, then persisted to targets.json.
function Get-CmdkeyTargets {
    $map = @{}
    $cur = $null
    foreach ($line in (cmdkey /list)) {
        if ($line -match 'Target:\s*\S*TERMSRV/127\.0\.0\.(\d+)') { $cur = [int]$Matches[1]; continue }
        if ($cur -ne $null -and $line -match 'User:\s*(.+?)\s*$') {
            $u = ($Matches[1] -replace '^.*\\', '').ToLower()
            if ($u -and -not $map.ContainsKey($u)) { $map[$u] = $cur }
            $cur = $null
        }
    }
    return $map
}

function Load-TargetMap {
    $map = @{}
    if (Test-Path $MapPath) {
        try { (Get-Content $MapPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $map[$_.Name.ToLower()] = [int]$_.Value } } catch {}
    }
    foreach ($kv in (Get-CmdkeyTargets).GetEnumerator()) { if (-not $map.ContainsKey($kv.Key)) { $map[$kv.Key] = $kv.Value } }
    return $map
}

function Save-TargetMap($map) {
    Initialize-Store
    ($map.GetEnumerator() | Sort-Object Name | ForEach-Object { [pscustomobject]@{ k = $_.Key; v = $_.Value } } |
        ForEach-Object -Begin { $o = [ordered]@{} } -Process { $o[$_.k] = $_.v } -End { $o }) |
        ConvertTo-Json | Set-Content -Path $MapPath -Encoding UTF8
}

function Resolve-Target([string] $User, $map) {
    $u = $User.ToLower()
    if (-not $map.ContainsKey($u)) {
        $used = [int[]]$map.Values
        $n = 2; while ($used -contains $n) { $n++ }
        $map[$u] = $n
        Save-TargetMap $map
    }
    return "127.0.0.$($map[$u])"
}

# --- credential storage --------------------------------------------------------------
function Set-Cmdkey([string] $Target, [string] $User, [string] $Plain) {
    # cmdkey is invoked windowless; password is passed once and not logged.
    Invoke-Hidden 'cmdkey.exe' "/generic:TERMSRV/$Target /user:$User /pass:`"$Plain`"" | Out-Null
}

function Set-Credential([string] $User) {
    Initialize-Store
    if ($User -notin (Get-LocalUser | Select-Object -ExpandProperty Name)) {
        Write-Warning "本机没有名为 '$User' 的账号（仍可保存，连接时会失败）。"
    }
    $sec = Read-Host -AsSecureString "请输入账号 [$User] 的密码（不回显）"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

    $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
    Add-Type -AssemblyName System.Security
    $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    [IO.File]::WriteAllBytes((Get-CredPath $User), $enc)
    [Array]::Clear($bytes, 0, $bytes.Length)

    $map = Load-TargetMap
    $tgt = Resolve-Target $User $map
    Set-Cmdkey $tgt $User $plain
    $plain = $null
    Register-Account $User $map | Out-Null
    Update-Mru $map
    Write-Host "已为 '$User' 保存凭证并登记到远程桌面选择框 -> 目标 $tgt" -ForegroundColor Green
}

function Unprotect-Credential([string] $User) {
    $p = Get-CredPath $User
    if (-not (Test-Path $p)) { return $null }
    Add-Type -AssemblyName System.Security
    $enc = [IO.File]::ReadAllBytes($p)
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    return [Text.Encoding]::UTF8.GetString($bytes)
}

function Test-HasCmdkey([string] $Target) {
    return [bool]((cmdkey /list) | Select-String -SimpleMatch "TERMSRV/$Target")
}

# --- making the default Remote Desktop selector work --------------------------------
function Write-RdpFile([string] $User, [string] $Target) {
    $content = @"
screen mode id:i:1
desktopwidth:i:$Width
desktopheight:i:$Height
session bpp:i:32
full address:s:$Target
username:s:$User
authentication level:i:0
prompt for credentials:i:0
enablecredsspsupport:i:1
negotiate security layer:i:1
autoreconnection enabled:i:1
"@
    Set-Content -Path (Get-RdpPath $User) -Value $content -Encoding ASCII
}

function Set-UsernameHint([string] $Target, [string] $User) {
    $k = Join-Path (Join-Path $TscKey 'Servers') $Target
    if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
    New-ItemProperty -Path $k -Name 'UsernameHint' -Value $User -PropertyType String -Force | Out-Null
}

function Update-Mru($map) {
    # Populate the client's "Computer" drop-down (MRU0..N) with the configured targets.
    $def = Join-Path $TscKey 'Default'
    if (-not (Test-Path $def)) { New-Item -Path $def -Force | Out-Null }
    Get-Item $def | Select-Object -ExpandProperty Property | Where-Object { $_ -like 'MRU*' } |
        ForEach-Object { Remove-ItemProperty -Path $def -Name $_ -ErrorAction SilentlyContinue }
    $i = 0
    foreach ($kv in ($map.GetEnumerator() | Sort-Object Value)) {
        New-ItemProperty -Path $def -Name ("MRU{0}" -f $i) -Value "127.0.0.$($kv.Value)" -PropertyType String -Force | Out-Null
        $i++
    }
}

function Register-Account([string] $User, $map) {
    $tgt = Resolve-Target $User $map
    Set-UsernameHint $tgt $User
    Write-RdpFile $User $tgt
    return $tgt
}

function Register-All {
    Initialize-Store
    # disable the "identity of the remote computer cannot be verified" prompt globally
    if (-not (Test-Path $TscKey)) { New-Item -Path $TscKey -Force | Out-Null }
    New-ItemProperty -Path $TscKey -Name 'AuthenticationLevelOverride' -Value 0 -PropertyType DWord -Force | Out-Null

    $map = Load-TargetMap
    $accts = Get-EnabledAccounts
    # also register accounts that only exist in the credential stores
    foreach ($u in @($map.Keys)) { if ($accts -notcontains $u) { $accts += $u } }
    foreach ($u in ($accts | Sort-Object -Unique)) {
        $tgt = Resolve-Target $u $map
        if ((Test-HasCmdkey $tgt) -or (Test-Path (Get-CredPath $u))) { Register-Account $u $map | Out-Null }
    }
    Save-TargetMap $map
    Update-Mru $map
    return $map
}

# --- connecting ----------------------------------------------------------------------
function Test-HasSession([string] $User) {
    return [bool]((qwinsta) | Select-String -Pattern ("\b{0}\b" -f [regex]::Escape($User)) | Select-String -Pattern 'Active|Disc')
}

function Connect-Accounts([string[]] $Users) {
    # `-File` passes a comma list as one token, so flatten/split defensively.
    $Users = @($Users | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    Ensure-MultiSession
    $map = Register-All
    foreach ($u in $Users) {
        $tgt = Resolve-Target $u $map
        if (-not (Test-HasCmdkey $tgt)) {
            $pw = Unprotect-Credential $u
            if ($null -eq $pw) {
                Write-Warning "账号 '$u' 还没有保存凭证，跳过。先运行: rdp_creds.ps1 -Set $u"
                continue
            }
            Set-Cmdkey $tgt $u $pw
            $pw = $null
        }
        Register-Account $u $map | Out-Null
        if ((Test-HasSession $u) -and -not $Force) {
            Write-Host "账号 '$u' 已有会话，重连到现有桌面 ($tgt)。" -ForegroundColor DarkYellow
        }
        Start-Process mstsc -ArgumentList "`"$(Get-RdpPath $u)`""
        Write-Host "已发起连接: $u  ->  $tgt" -ForegroundColor Cyan
        Start-Sleep -Milliseconds 800
    }
    Update-Mru $map
    Write-Host "`n当前会话:" -ForegroundColor Yellow
    qwinsta
}

function Show-Menu {
    $map = Load-TargetMap
    $accts = Get-EnabledAccounts
    Write-Host "`n=== 本机启用的 Windows 账号 ===" -ForegroundColor Yellow
    for ($n = 0; $n -lt $accts.Count; $n++) {
        $u = $accts[$n]; $tgt = "127.0.0.$($map[$u.ToLower()])"
        $hasCred = (Test-Path (Get-CredPath $u)) -or (Test-HasCmdkey $tgt)
        $mark = if ($hasCred) { '[已存凭证]' } else { '[无凭证] ' }
        "{0,2}) {1} {2,-16} -> {3}" -f ($n + 1), $mark, $u, $tgt
    }
    Write-Host "`n输入要连接的序号（多个用逗号分隔，如 1,3,5），或 q 退出。" -ForegroundColor Yellow
    $sel = Read-Host '选择'
    if ($sel -eq 'q' -or [string]::IsNullOrWhiteSpace($sel)) { return }
    $chosen = foreach ($t in ($sel -split ',')) {
        $t = $t.Trim()
        if ($t -match '^\d+$' -and [int]$t -ge 1 -and [int]$t -le $accts.Count) { $accts[[int]$t - 1] }
    }
    foreach ($m in ($chosen | Where-Object { -not ((Test-Path (Get-CredPath $_)) -or (Test-HasCmdkey "127.0.0.$($map[$_.ToLower()])")) })) { Set-Credential $m }
    if ($chosen) { Connect-Accounts $chosen }
}

switch ($PSCmdlet.ParameterSetName) {
    'Set'      { Set-Credential $Set }
    'Connect'  { Connect-Accounts $Connect }
    'Register' { $m = Register-All; Write-Host "已登记 $($m.Count) 个账号到远程桌面选择框（MRU + 用户名提示 + .rdp 文件）。" -ForegroundColor Green }
    'List'     {
        $map = Load-TargetMap
        "{0,-18}{1,-14}{2,-10}{3}" -f '账号', '目标', '凭证', '会话'
        foreach ($a in Get-EnabledAccounts) {
            $tgt = "127.0.0.$($map[$a.ToLower()])"
            $cred = if ((Test-Path (Get-CredPath $a)) -or (Test-HasCmdkey $tgt)) { '已存' } else { '无' }
            $sess = if (Test-HasSession $a) { '在线' } else { '-' }
            "{0,-18}{1,-14}{2,-10}{3}" -f $a, $tgt, $cred, $sess
        }
    }
    default    { Show-Menu }
}
