# -*- coding: utf-8 -*-
"""Push a local file to 141 at a target path (chunked base64), optionally run it."""
import sys, os, io, base64, hashlib
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A = 'DESKTOP-MASTER'
PY = r'C:\ProgramData\anaconda3\python.exe'

def ps(cmd, t=60):
    return d.dao(f'powershell -NoProfile -Command "{cmd}"', agent=A, timeout=t)

def push(local, remote):
    raw = open(local, 'rb').read()
    b64 = base64.b64encode(raw).decode()
    sha = hashlib.sha256(raw).hexdigest()
    tmp = remote + '.b64'
    CHUNK = 3500
    parts = [b64[i:i+CHUNK] for i in range(0, len(b64), CHUNK)]
    for idx, part in enumerate(parts):
        op = 'Set-Content' if idx == 0 else 'Add-Content'
        ps(f"{op} -LiteralPath '{tmp}' -Value '{part}' -NoNewline -Encoding ascii", t=40)
    out = ps(f"$b=[IO.File]::ReadAllText('{tmp}'); [IO.File]::WriteAllBytes('{remote}',[Convert]::FromBase64String($b)); "
             f"Remove-Item '{tmp}' -Force; (Get-FileHash '{remote}' -Algorithm SHA256).Hash.ToLower()", t=40)
    ok = sha in (out or '')
    print(f"push {'OK' if ok else 'BAD'} {remote} ({len(raw)}B) sha={sha[:12]} remote={(out or '').strip()[:64]}")
    return ok

if __name__ == '__main__':
    local = sys.argv[1]; remote = sys.argv[2]
    push(local, remote)
    if len(sys.argv) > 3 and sys.argv[3] == 'run':
        print('--- run ---')
        print(d.dao(f'"{PY}" {remote}', agent=A, timeout=180))
