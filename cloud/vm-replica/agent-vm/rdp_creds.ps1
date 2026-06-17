<#
.SYNOPSIS
  RDP credential store + quick-select multi-account launcher for the local box.

.DESCRIPTION
  Companion to ts_multifix.py (which lifts the client-SKU single-session limit). This
  lets you store each local Windows account's password ONCE (DPAPI-encrypted at rest, so
  no plaintext ever touches disk or the repo) and then pick one or several accounts to
  open concurrent RDP sessions to this machine in a single step.

  Passwords are encrypted with DPAPI LocalMachine scope and saved under
  C:\ProgramData\dao_vm\creds\<user>.cred. You type each password yourself via -Set; the
  value is never logged or transmitted.

.EXAMPLE
  # store a password for an account (prompts securely; nothing echoed)
  powershell -ExecutionPolicy Bypass -File rdp_creds.ps1 -Set zhou

.EXAMPLE
  # see all enabled local accounts + which have a stored credential
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
    [Parameter(ParameterSetName = 'Set')]    [string]   $Set,
    [Parameter(ParameterSetName = 'Connect')][string[]] $Connect,
    [Parameter(ParameterSetName = 'List')]   [switch]   $List,
    [string] $Target = '127.0.0.2',   # base loopback target; concurrent sessions get .3, .4, ...
    [int]    $Width   = 1280,
    [int]    $Height  = 800
)

$ErrorActionPreference = 'Stop'
$CredDir   = 'C:\ProgramData\dao_vm\creds'
$PyExe     = 'C:\ProgramData\anaconda3\python.exe'
$MultiFix  = 'C:\dao_vm\ts_multifix.py'

function Initialize-Store {
    if (-not (Test-Path $CredDir)) { New-Item -ItemType Directory -Path $CredDir -Force | Out-Null }
}

function Get-EnabledAccounts {
    Get-LocalUser | Where-Object { $_.Enabled } | Select-Object -ExpandProperty Name | Sort-Object
}

function Get-CredPath([string] $User) { Join-Path $CredDir ($User.ToLower() + '.cred') }

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
    $enc = [Security.Cryptography.ProtectedData]::Protect(
        $bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    [IO.File]::WriteAllBytes((Get-CredPath $User), $enc)
    [Array]::Clear($bytes, 0, $bytes.Length); $plain = $null
    Write-Host "已为 '$User' 保存加密凭证 -> $(Get-CredPath $User)" -ForegroundColor Green
}

function Unprotect-Credential([string] $User) {
    $p = Get-CredPath $User
    if (-not (Test-Path $p)) { return $null }
    Add-Type -AssemblyName System.Security
    $enc = [IO.File]::ReadAllBytes($p)
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $enc, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    return [Text.Encoding]::UTF8.GetString($bytes)
}

function Ensure-MultiSession {
    if ((Test-Path $PyExe) -and (Test-Path $MultiFix)) {
        try { & $PyExe $MultiFix ensure 2>&1 | Out-Null } catch { Write-Warning "ensure_multisession 调用失败: $_" }
    }
}

function Connect-Accounts([string[]] $Users) {
    # `-File` passes a comma list as one token, so flatten/split defensively.
    $Users = @($Users | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    Ensure-MultiSession
    $i = 0
    foreach ($u in $Users) {
        $pw = Unprotect-Credential $u
        if ($null -eq $pw) {
            Write-Warning "账号 '$u' 还没有保存凭证，跳过。先运行: rdp_creds.ps1 -Set $u"
            continue
        }
        # give each concurrent session its own loopback target so the cmdkey credential
        # slots never overwrite each other (TERMSRV/<target> holds one credential each).
        $octet = 2 + $i
        $tgt = ($Target -replace '\.\d+$', ".$octet")
        cmd /c "cmdkey /generic:TERMSRV/$tgt /user:$u /pass:`"$pw`"" | Out-Null
        # suppress the unattended server-identity prompt for this loopback target
        New-Item -Path 'HKCU:\Software\Microsoft\Terminal Server Client' -Force | Out-Null
        New-ItemProperty -Path 'HKCU:\Software\Microsoft\Terminal Server Client' `
            -Name 'AuthenticationLevelOverride' -Value 0 -PropertyType DWord -Force | Out-Null
        Start-Process mstsc -ArgumentList "/v:$tgt /w:$Width /h:$Height"
        Write-Host "已发起连接: $u  ->  $tgt" -ForegroundColor Cyan
        $pw = $null
        $i++
        Start-Sleep -Milliseconds 1500
    }
    Write-Host "`n当前会话:" -ForegroundColor Yellow
    qwinsta
}

function Show-Menu {
    $accts = Get-EnabledAccounts
    Write-Host "`n=== 本机启用的 Windows 账号 ===" -ForegroundColor Yellow
    for ($n = 0; $n -lt $accts.Count; $n++) {
        $mark = if (Test-Path (Get-CredPath $accts[$n])) { '[已存凭证]' } else { '[无凭证] ' }
        "{0,2}) {1} {2}" -f ($n + 1), $mark, $accts[$n]
    }
    Write-Host "`n输入要连接的序号（多个用逗号分隔，如 1,3,5），或 q 退出。" -ForegroundColor Yellow
    $sel = Read-Host '选择'
    if ($sel -eq 'q' -or [string]::IsNullOrWhiteSpace($sel)) { return }
    $chosen = foreach ($t in ($sel -split ',')) {
        $t = $t.Trim()
        if ($t -match '^\d+$' -and [int]$t -ge 1 -and [int]$t -le $accts.Count) { $accts[[int]$t - 1] }
    }
    $missing = $chosen | Where-Object { -not (Test-Path (Get-CredPath $_)) }
    foreach ($m in $missing) { Set-Credential $m }
    if ($chosen) { Connect-Accounts $chosen }
}

switch ($PSCmdlet.ParameterSetName) {
    'Set'     { Set-Credential $Set }
    'Connect' { Connect-Accounts $Connect }
    'List'    {
        foreach ($a in Get-EnabledAccounts) {
            $mark = if (Test-Path (Get-CredPath $a)) { '已存凭证' } else { '无凭证' }
            "{0,-20} {1}" -f $a, $mark
        }
    }
    default   { Show-Menu }
}
