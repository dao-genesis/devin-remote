#requires -RunAsAdministrator
<#
  daovm-up.ps1 — bring up the background "Agent VM" session on this machine.

  Creates/uses a dedicated local account (daovm), keeps a background RDP session
  alive for it via loopback (relying on the RDP-Wrapper multi-session fix), and
  auto-starts vm_agent.py inside that session. The session is fully isolated from
  the user's console session — the Agent drives it like its own VM, the user's
  foreground is never touched.

  Idempotent. Safe to re-run. Params let you override the account/port.
#>
[CmdletBinding()]
param(
  [string]$User = "daovm",
  [string]$Password = "DaoVm@8521#Agent",
  [int]$Port = 9921,
  [string]$Token = "9dd1db47b078638b2d5196c8384edfe4",
  [string]$LoopbackIp = "127.0.0.9",
  [string]$AgentDir = "C:\ProgramData\dao-vm"
)
$ErrorActionPreference = "Stop"

# 1) account
$sec = ConvertTo-SecureString $Password -AsPlainText -Force
if (Get-LocalUser $User -ErrorAction SilentlyContinue) {
  Set-LocalUser $User -Password $sec
} else {
  New-LocalUser $User -Password $sec -PasswordNeverExpires -AccountNeverExpires -FullName "DAO VM Agent" | Out-Null
}
Add-LocalGroupMember -Group "Remote Desktop Users" -Member $User -ErrorAction SilentlyContinue
Add-LocalGroupMember -Group "Administrators" -Member $User -ErrorAction SilentlyContinue
Write-Host "[1/6] account $User ready"

# 2) deploy agent code (vm_agent.py must sit next to this script)
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "vm_agent.py") (Join-Path $AgentDir "vm_agent.py")
# env file the launchers read
@("DAO_VM_PORT=$Port", "DAO_VM_TOKEN=$Token") | Set-Content -Encoding ASCII (Join-Path $AgentDir "vm.env")
Write-Host "[2/6] vm_agent.py deployed to $AgentDir"

# 3) scheduled task: start vm_agent inside daovm's session at its logon
$pythonw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pythonw) { $pythonw = "C:\ProgramData\anaconda3\pythonw.exe" }
$act = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$AgentDir\vm_agent.py`"" -WorkingDirectory $AgentDir
$trg = New-ScheduledTaskTrigger -AtLogOn -User $User
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$prin = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName "DaoVMAgent" -Action $act -Trigger $trg -Settings $set -Principal $prin -Force | Out-Null
# env for the task (machine-level, pythonw reads process env from task — set via wrapper)
Write-Host "[3/6] scheduled task DaoVMAgent registered (autostart in-session)"

# 4) keep the session's desktop rendering even when the loopback mstsc is minimized
#    (client-side reg key, applies to the console user launching mstsc)
$rdc = "HKCU:\Software\Microsoft\Terminal Server Client"
New-Item -Path $rdc -Force | Out-Null
New-ItemProperty -Path $rdc -Name "RemoteDesktop_SuppressWhenMinimized" -PropertyType DWord -Value 2 -Force | Out-Null
Write-Host "[4/6] minimized-render trick set"

# 5) saved loopback credential (DPAPI) so mstsc auto-logs daovm
cmdkey /add:TERMSRV/$LoopbackIp /user:"$env:COMPUTERNAME\$User" /pass:"$Password" | Out-Null
$rdp = @"
full address:s:$LoopbackIp
username:s:$env:COMPUTERNAME\$User
prompt for credentials:i:0
administrative session:i:0
screen mode id:i:1
desktopwidth:i:1600
desktopheight:i:900
authentication level:i:0
enablecredsspsupport:i:1
"@
$rdpPath = Join-Path $AgentDir "daovm.rdp"
[IO.File]::WriteAllText($rdpPath, $rdp, [Text.Encoding]::Unicode)
Write-Host "[5/6] loopback credential + $rdpPath ready"

# 6) launch (or relaunch) the keep-alive session
Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq $LoopbackIp } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process mstsc.exe -ArgumentList "`"$rdpPath`"" -WindowStyle Minimized
Write-Host "[6/6] keep-alive session launched -> $LoopbackIp ($User)"
Write-Host "Done. vm_agent will bind 127.0.0.1:$Port inside the $User session."
