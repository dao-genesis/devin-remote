# -*- coding: utf-8 -*-
"""Launch the host daemon on 141 via a SCHEDULED TASK (fully detached from the
relay agent's job object, so it never blocks the agent's command worker).
Attach-only mode needs no interactive desktop, but we run it in Administrator's
console session (Interactive) for parity with screenshots-from-host scenarios."""
import sys, os, io, base64
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A = 'DESKTOP-MASTER'
PY = r'C:\ProgramData\anaconda3\python.exe'

# PowerShell that registers + starts the daemon task and returns immediately.
ps = r'''
$ErrorActionPreference='Continue'
$tn='dao_host_daemon'
# kill a prior daemon if pidfile exists (fast, no CIM enumeration)
if(Test-Path C:\dao_vm\host.pid){ Stop-Process -Id (Get-Content C:\dao_vm\host.pid) -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue
$a=New-ScheduledTaskAction -Execute 'PY_EXE' -Argument 'C:\dao_vm\vm_host_daemon.py'
$t=New-ScheduledTaskTrigger -AtLogOn -User 'DESKTOP-MASTER\Administrator'
$p=New-ScheduledTaskPrincipal -UserId 'DESKTOP-MASTER\Administrator' -LogonType Interactive -RunLevel Highest
$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $tn -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName $tn
'task-registered-and-started'
'''.replace('PY_EXE', PY)

b64 = base64.b64encode(ps.encode('utf-8')).decode()
# run the script via -EncodedCommand to avoid any quoting/wedge issues; returns fast
print(d.dao(f'powershell -NoProfile -EncodedCommand {base64.b64encode(ps.encode("utf-16-le")).decode()}', agent=A, timeout=30))
