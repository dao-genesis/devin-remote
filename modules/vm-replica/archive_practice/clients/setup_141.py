# -*- coding: utf-8 -*-
"""Deploy the v2 stack on 141 (DESKTOP-MASTER) for the real environment:
   - write C:\\ProgramData\\dao_vm\\config.json (anaconda python, rdp_target=127.0.0.3)
   - copy inner agent / host daemon / mcp / vmctl from E:\\...\\impl_v2 to C:\\dao_vm
No account/password changes; attach happens separately."""
import sys, os, json, base64, secrets
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A = 'DESKTOP-MASTER'
IMPL = r'E:\DAO_ARCHIVE\20_多RDP虚拟机化_VM_REPLICA\impl_v2'

def ps(cmd, t=60):
    return d.dao(f'powershell -NoProfile -Command "{cmd}"', agent=A, timeout=t)

# 1) config.json (token fixed so daemon + vmctl + mcp agree)
cfg = {
    "host_port": 9000,
    "base_port": 9001,
    "token": secrets.token_hex(16),
    "python_exe": r"C:\ProgramData\anaconda3\python.exe",
    "inner_script": r"C:\dao_vm\vm_inner_agent.py",
    "inner_exe": r"C:\dao_vm\dao_inner_agent.exe",
    "rdp_target": "127.0.0.3",
    "default_password": "Vm@2026dao!"
}
cfg_b64 = base64.b64encode(json.dumps(cfg, ensure_ascii=False, indent=2).encode('utf-8')).decode()
print("config write:", ps(
    "New-Item -ItemType Directory -Path 'C:\\ProgramData\\dao_vm' -Force | Out-Null; "
    f"[IO.File]::WriteAllBytes('C:\\ProgramData\\dao_vm\\config.json',[Convert]::FromBase64String('{cfg_b64}')); "
    "(Get-Item 'C:\\ProgramData\\dao_vm\\config.json').Length"))

# 2) deploy code to C:\dao_vm
print("deploy:", ps(
    "New-Item -ItemType Directory -Path 'C:\\dao_vm' -Force | Out-Null; "
    f"Copy-Item '{IMPL}\\vm_inner_agent.py','{IMPL}\\vm_host_daemon.py','{IMPL}\\mcp_server.py','{IMPL}\\vmctl.py' "
    "-Destination 'C:\\dao_vm' -Force; "
    "Get-ChildItem 'C:\\dao_vm' | Select-Object Name,Length | Format-Table -Auto | Out-String"))

print("token=", cfg["token"])
