import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A='DESKTOP-MASTER'
for size in (20000, 40000, 60000):
    s = 'A'*size
    tmp = r'C:\dao_vm\_ct.txt'
    r = d.dao("powershell -NoProfile -Command \"Set-Content -LiteralPath '%s' -Value '%s' -NoNewline -Encoding ascii; (Get-Item '%s').Length\"" % (tmp, s, tmp), agent=A, timeout=40)
    print('size', size, '->', (r or '').strip()[:60])
