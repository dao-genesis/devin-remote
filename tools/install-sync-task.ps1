# install-sync-task.ps1 — register a Windows scheduled task on 141 that runs
# tools\sync-dao-archive.ps1 every 30 minutes, keeping E:\DAO_ARCHIVE and the
# GitHub `archive` branch in continuous sync.
#
# Run once (elevated) on 141:
#   powershell -ExecutionPolicy Bypass -File tools\install-sync-task.ps1

param(
    [string]$ScriptPath = 'E:\DAO_ARCHIVE\tools\sync-dao-archive.ps1',
    [string]$TaskName = 'DAO_ARCHIVE_Sync',
    [int]$IntervalMinutes = 30
)

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 25)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Write-Host "Scheduled task '$TaskName' registered (every $IntervalMinutes min)."
