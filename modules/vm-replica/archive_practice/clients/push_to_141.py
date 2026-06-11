import sys, os, base64, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d

AGENT = 'DESKTOP-MASTER'
DST = r'E:\DAO_ARCHIVE\20_多RDP虚拟机化_VM_REPLICA\impl_v2'
SRC = r'C:\Users\Administrator\dao_work'

FILES = [
    ('impl_v2', 'vm_inner_agent.py'),        # type_text(): \n/\t -> real VK keystrokes (multi-line code types verbatim)
    ('impl_v2', 'parity_provision.ps1'),     # NEW: idempotent toolchain parity (Git/Node/Py/Chrome/VSCode) + deterministic VSCode settings
    ('impl_v2', 'deploy_blank_windows.ps1'), # + -Provision switch (calls parity_provision.ps1)
    ('impl_v2', 'README_v2.md'),             # + toolchain 1:1 parity section
]

def ps(cmd, timeout=60):
    return d.dao(f'powershell -NoProfile -Command "{cmd}"', agent=AGENT, timeout=timeout)

# ensure target dir
print('mkdir:', ps(f"New-Item -ItemType Directory -Path '{DST}' -Force | Out-Null; Test-Path '{DST}'"))

CHUNK = 3500
for sub, name in FILES:
    local = os.path.join(SRC, sub, name) if sub != '.' else os.path.join(SRC, name)
    raw = open(local, 'rb').read()
    b64 = base64.b64encode(raw).decode()
    sha = hashlib.sha256(raw).hexdigest()
    tmp = f"{DST}\\{name}.b64"
    tgt = f"{DST}\\{name}"
    # write chunks: first overwrites, rest append
    parts = [b64[i:i+CHUNK] for i in range(0, len(b64), CHUNK)]
    for idx, part in enumerate(parts):
        op = 'Set-Content' if idx == 0 else 'Add-Content'
        ps(f"{op} -LiteralPath '{tmp}' -Value '{part}' -NoNewline -Encoding ascii", timeout=40)
    # decode + verify
    out = ps(
        f"$b=[IO.File]::ReadAllText('{tmp}'); "
        f"[IO.File]::WriteAllBytes('{tgt}',[Convert]::FromBase64String($b)); "
        f"Remove-Item '{tmp}' -Force; "
        f"$h=(Get-FileHash '{tgt}' -Algorithm SHA256).Hash.ToLower(); "
        f"$s=(Get-Item '{tgt}').Length; Write-Output \\\"$s $h\\\"",
        timeout=40)
    out = (out or '').strip()
    ok = sha in out and str(len(raw)) in out
    print(f"{'OK ' if ok else 'BAD'} {name:34s} local={len(raw)}B sha={sha[:12]} remote={out}")
