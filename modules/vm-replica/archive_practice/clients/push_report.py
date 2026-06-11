import sys, os, base64, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
AGENT='DESKTOP-MASTER'
DST=r'E:\DAO_ARCHIVE\20_多RDP虚拟机化_VM_REPLICA\impl_v2'
local=r'C:\Users\Administrator\dao_work\test-report.md'
def ps(c,t=60): return d.dao(f'powershell -NoProfile -Command "{c}"',agent=AGENT,timeout=t)
raw=open(local,'rb').read(); b64=base64.b64encode(raw).decode(); sha=hashlib.sha256(raw).hexdigest()
tmp=f"{DST}\\test-report.md.b64"; tgt=f"{DST}\\test-report.md"
parts=[b64[i:i+3500] for i in range(0,len(b64),3500)]
for i,p in enumerate(parts):
    ps(f"{'Set-Content' if i==0 else 'Add-Content'} -LiteralPath '{tmp}' -Value '{p}' -NoNewline -Encoding ascii",40)
out=ps(f"$b=[IO.File]::ReadAllText('{tmp}');[IO.File]::WriteAllBytes('{tgt}',[Convert]::FromBase64String($b));Remove-Item '{tmp}' -Force;$h=(Get-FileHash '{tgt}' -Algorithm SHA256).Hash.ToLower();Write-Output \\\"$((Get-Item '{tgt}').Length) $h\\\"",40)
print(('OK ' if (sha in (out or '') and str(len(raw)) in out) else 'BAD'),'test-report.md',len(raw),sha[:12],'remote=',out.strip())
