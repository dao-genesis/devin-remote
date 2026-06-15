# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A = 'DESKTOP-MASTER'
def ps(cmd, t=40):
    return d.dao(f'powershell -NoProfile -Command "{cmd}"', agent=A, timeout=t)

print("=== whoami / host / OS ===")
print(ps(r"whoami; hostname; (Get-CimInstance Win32_OperatingSystem).Caption"))
print("=== sessions (quser) ===")
print(d.dao("quser", agent=A, timeout=30))
print("=== local users (zhou?) ===")
print(ps(r"Get-LocalUser | Select-Object Name,Enabled | Format-Table -Auto | Out-String"))
print("=== RDP listeners / 127.0.0.x established ===")
print(ps(r"Get-NetTCPConnection -State Listen -LocalPort 3389 -EA SilentlyContinue | Select LocalAddress,LocalPort | Format-Table -Auto | Out-String; netstat -ano | Select-String ':3389' | Select-Object -First 12 | Out-String"))
print("=== termsrv / RDPWrap multi-session hints ===")
print(ps(r"$f=(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -EA SilentlyContinue).fDenyTSConnections; 'fDenyTSConnections='+\"$f\"; Test-Path 'C:\Program Files\RDP Wrapper\rdpwrap.dll'; (Get-Item C:\Windows\System32\termsrv.dll).VersionInfo.FileVersion"))
print("=== deployed impl_v2 on E: ===")
print(ps(r"Get-ChildItem 'E:\DAO_ARCHIVE\20_多RDP虚拟机化_VM_REPLICA\impl_v2' -EA SilentlyContinue | Select Name,Length | Format-Table -Auto | Out-String"))
print("=== C:\\dao_vm present? config? ===")
print(ps(r"Test-Path C:\dao_vm; Get-ChildItem C:\dao_vm -EA SilentlyContinue | Select Name | Format-Table -Auto | Out-String; Test-Path C:\ProgramData\dao_vm\config.json; Get-Content C:\ProgramData\dao_vm\config.json -EA SilentlyContinue"))
print("=== python available? ===")
print(ps(r"(Get-Command python -EA SilentlyContinue).Source; Test-Path C:\devin\python\python.exe; py --version 2>&1"))
