# -*- coding: utf-8 -*-
import sys, os, io, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d, pushrun141
pushrun141.push(r'C:\Users\Administrator\dao_work\impl_v2\vm_host_daemon.py', r'C:\dao_vm\vm_host_daemon.py')
A = 'DESKTOP-MASTER'
ps = r'''
$ErrorActionPreference='Continue'
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*vm_host_daemon*' } |
  ForEach-Object { 'kill daemon PID='+$_.ProcessId+' SID='+$_.SessionId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
Start-ScheduledTask -TaskName dao_host_daemon
Start-Sleep -Seconds 3
$r = try { (Invoke-WebRequest -Uri http://127.0.0.1:9000/ -Method POST -Body '{"action":"host.health"}' -Headers @{Authorization=('Bearer '+(Get-Content C:\ProgramData\dao_vm\config.json | ConvertFrom-Json).token)} -UseBasicParsing -TimeoutSec 5).Content } catch { 'health-fail: '+$_.Exception.Message }
'daemon restarted; health=' + $r
'''
print(d.dao(f'powershell -NoProfile -EncodedCommand {base64.b64encode(ps.encode("utf-16-le")).decode()}', agent=A, timeout=40))
