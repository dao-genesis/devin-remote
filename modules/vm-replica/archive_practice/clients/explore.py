import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dao_sdk import dao, dao_raw

AGENT = "141"
BASE = r"E:\DAO_ARCHIVE\20_多RDP虚拟机化_VM_REPLICA"

# 1) does E: exist and does the project dir exist?
print("=== E: drive root ===")
print(dao(r'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize | Out-String"', AGENT, timeout=30))

print("=== project dir test ===")
cmd = (
    "powershell -NoProfile -Command \""
    "$p='E:\\DAO_ARCHIVE\\20_多RDP虚拟机化_VM_REPLICA'; "
    "if(Test-Path $p){ Write-Output 'EXISTS'; "
    "Get-ChildItem -LiteralPath $p -Force | Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize | Out-String -Width 200 }"
    "else{ Write-Output 'MISSING' }\""
)
print(dao(cmd, AGENT, timeout=40))
