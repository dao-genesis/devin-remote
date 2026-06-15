# -*- coding: utf-8 -*-
import sys, os, io, base64
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A = 'DESKTOP-MASTER'
ps = r'''
$i = Get-ScheduledTaskInfo -TaskName dao_host_daemon -ErrorAction SilentlyContinue
'LastRunTime= ' + $i.LastRunTime
'LastTaskResult= ' + ('0x{0:X}' -f $i.LastTaskResult)
'State= ' + (Get-ScheduledTask -TaskName dao_host_daemon).State
$py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*vm_host_daemon*' }
if($py){ foreach($p in $py){ 'daemon-proc PID='+$p.ProcessId+' SID='+$p.SessionId } } else { 'no daemon python process' }
'port9000= ' + ((Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue | Measure).Count)
'''
print(d.dao(f'powershell -NoProfile -EncodedCommand {base64.b64encode(ps.encode("utf-16-le")).decode()}', agent=A, timeout=40))
