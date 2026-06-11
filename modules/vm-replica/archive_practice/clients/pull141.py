# -*- coding: utf-8 -*-
"""Pull a remote file from 141 to local via byte-range base64 chunks (handles big
files; the relay caps single-command output size)."""
import sys, os, io, base64, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
A = 'DESKTOP-MASTER'
CHUNK = 180000  # raw bytes per chunk (~240KB base64, under relay output cap)

def ps(cmd, t=60):
    return d.dao(f'powershell -NoProfile -Command "{cmd}"', agent=A, timeout=t)

def pull(remote, local):
    size = int((ps(f"(Get-Item '{remote}').Length") or '0').strip())
    buf = bytearray()
    off = 0
    while off < size:
        n = min(CHUNK, size - off)
        cmd = (f"$fs=[IO.File]::OpenRead('{remote}');$b=New-Object byte[] {n};"
               f"[void]$fs.Seek({off},0);$r=$fs.Read($b,0,{n});$fs.Close();"
               f"[Convert]::ToBase64String($b,0,$r)")
        part = (ps(cmd, t=60) or '').strip().replace('\r', '').replace('\n', '')
        chunk = base64.b64decode(part)
        buf += chunk
        off += len(chunk)
        if not chunk:
            print("WARN: empty chunk at off", off); break
    open(local, 'wb').write(buf)
    print(f"pulled {remote} -> {local} ({len(buf)}/{size}B) sha={hashlib.sha256(bytes(buf)).hexdigest()[:12]}")

if __name__ == '__main__':
    pull(sys.argv[1], sys.argv[2])
