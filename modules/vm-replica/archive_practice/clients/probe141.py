import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
P = r'E:\DAO_ARCHIVE\20_多RDP虚拟机化_VM_REPLICA'
print('--- top level ---')
print(d.dao(f'powershell -NoProfile -Command "Get-ChildItem -LiteralPath \'{P}\' -Force | Select-Object Mode,Name | Format-Table -Auto | Out-String"', agent='DESKTOP-MASTER', timeout=40))
print('--- impl dir? ---')
print(d.dao(f'powershell -NoProfile -Command "Test-Path \'{P}\\impl\'; Test-Path \'{P}\\impl_v2\'; Test-Path \'{P}\\.git\'"', agent='DESKTOP-MASTER', timeout=40))
