# -*- coding: utf-8 -*-
"""Push a local python script to 141 and run it in administrator's INTERACTIVE
console session (session 1) via a transient scheduled task, then print its task
result. Usage: run_session1.py <local.py> <remote.py>"""
import sys, os, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d, pushrun141  # pushrun141 sets a utf-8 stdout wrapper
A = 'DESKTOP-MASTER'; PY = r'C:\ProgramData\anaconda3\python.exe'
local, remote = sys.argv[1], sys.argv[2]
pushrun141.push(local, remote)
ps = (r'''
$tn='dao_oneoff'
Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue
$a=New-ScheduledTaskAction -Execute 'PYEXE' -Argument 'REMOTE'
$p=New-ScheduledTaskPrincipal -UserId 'DESKTOP-MASTER\Administrator' -LogonType Interactive -RunLevel Highest
$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $tn -Action $a -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName $tn
Start-Sleep -Seconds 4
'oneoff-result=' + ('0x{0:X}' -f (Get-ScheduledTaskInfo -TaskName $tn).LastTaskResult)
''').replace('PYEXE', PY).replace('REMOTE', remote)
print(d.dao(f'powershell -NoProfile -EncodedCommand {base64.b64encode(ps.encode("utf-16-le")).decode()}', agent=A, timeout=40))
