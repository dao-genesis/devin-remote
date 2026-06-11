import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A='DESKTOP-MASTER'
for size in (6000, 9000, 12000, 16000):
    s='A'*size; tmp=r'C:\dao_vm\_ct.txt'
    cmd="powershell -NoProfile -Command \"Set-Content -LiteralPath '%s' -Value '%s' -NoNewline -Encoding ascii; (Get-Item '%s').Length\"" % (tmp,s,tmp)
    try:
        r=d.dao_raw(cmd, agent=A, timeout=40)
        out=(r.get('stdout','') if isinstance(r,dict) else str(r)).strip()
        print('size',size,'-> stdout=',repr(out[:40]),'keys=',list(r.keys()) if isinstance(r,dict) else '?')
    except Exception as e:
        print('size',size,'-> EXC',e)
