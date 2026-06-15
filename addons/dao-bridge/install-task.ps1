<#
开机自启固化：注册计划任务，登录时后台拉起 dao-bridge 后端（窗口隐藏）。
  .\install-task.ps1            # 安装/更新任务 DaoBridge141
  .\install-task.ps1 -Remove    # 卸载
#>
param([switch]$Remove, [string]$TaskName = 'DaoBridge141')

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$start = Join-Path $dir 'start.ps1'

if($Remove){
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[dao-bridge] 已卸载计划任务 $TaskName" -ForegroundColor Yellow
  return
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "[dao-bridge] 已注册计划任务 $TaskName（登录自启，异常自动重启）" -ForegroundColor Green
