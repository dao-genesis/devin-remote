# -*- coding: utf-8 -*-
"""Control helper: run host-daemon lifecycle + vmctl actions ON 141 via the hub."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A = 'DESKTOP-MASTER'
PY = r'C:\ProgramData\anaconda3\python.exe'

def ps(cmd, t=60):
    return d.dao(f'powershell -NoProfile -Command "{cmd}"', agent=A, timeout=t)

def start_daemon():
    # lightweight: kill prior daemon by saved PID, then launch detached, save new PID
    return ps(
        "if(Test-Path C:\\dao_vm\\host.pid){ Stop-Process -Id (Get-Content C:\\dao_vm\\host.pid) -Force -EA SilentlyContinue }; "
        f"$p=Start-Process -FilePath '{PY}' -ArgumentList 'C:\\dao_vm\\vm_host_daemon.py' -WindowStyle Hidden -PassThru "
        "-RedirectStandardOutput 'C:\\dao_vm\\host.out.log' -RedirectStandardError 'C:\\dao_vm\\host.err.log'; "
        "$p.Id | Set-Content C:\\dao_vm\\host.pid; 'started pid='+$p.Id", t=30)

def health():
    return ps("try{ (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:9000/health' -TimeoutSec 5).Content }catch{ 'ERR '+$_.Exception.Message }")

def vmctl(args, t=90):
    return d.dao(f'"{PY}" C:\\dao_vm\\vmctl.py {args}', agent=A, timeout=t)

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'health'
    if cmd == 'start':
        print(start_daemon()); print('health:', health())
    elif cmd == 'health':
        print(health())
    elif cmd == 'log':
        print(ps("Get-Content C:\\dao_vm\\host.out.log,C:\\dao_vm\\host.err.log -EA SilentlyContinue | Out-String"))
    elif cmd == 'vmctl':
        print(vmctl(' '.join(sys.argv[2:])))
