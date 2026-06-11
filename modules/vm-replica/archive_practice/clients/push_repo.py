# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pushrun141
SRC = r'C:\Users\Administrator\dao_work\impl_v2'
DST = r'E:\DAO_ARCHIVE\20_多RDP虚拟机化_VM_REPLICA\impl_v2'
files = ['vm_host_daemon.py', 'vm_inner_agent.py', 'deploy_blank_windows.ps1', 'README_v2.md']
for f in files:
    pushrun141.push(os.path.join(SRC, f), DST + '\\' + f)
print("ALL PUSHED")
