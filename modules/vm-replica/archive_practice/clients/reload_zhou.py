# -*- coding: utf-8 -*-
import sys, os, io, base64
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A = 'DESKTOP-MASTER'
ps = r'''
$ErrorActionPreference='Continue'
# kill the running inner agent (so it reloads new code), then restart its task
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*vm_inner_agent*' } |
  ForEach-Object { 'kill PID='+$_.ProcessId+' SID='+$_.SessionId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
Start-ScheduledTask -TaskName dao_agent_zhou
'restarted dao_agent_zhou'
'''
print(d.dao(f'powershell -NoProfile -EncodedCommand {base64.b64encode(ps.encode("utf-16-le")).decode()}', agent=A, timeout=40))
