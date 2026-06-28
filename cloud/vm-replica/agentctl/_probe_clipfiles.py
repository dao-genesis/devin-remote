"""F202 — the **file clipboard** (CF_HDROP): copy/paste *files* between Explorer
and apps, the way a human moves data around the OS.

The floor's clipboard was text-only. But the commonest cross-app transfer is not
text: a Ctrl+C in Explorer (or a "Copy" in any shell view) puts a **file list** on
the clipboard, and ``get_clipboard()`` returns "" — the floor is blind to it, and
cannot *originate* one either, so it could neither see what a user copied nor paste
files into a target. This proves the non-text twin:

  1. friction — with a file on the clipboard, the text channel reads "" (blind);
  2. ``get_clipboard_files()`` reads the file list (incl. one an external app put there);
  3. ``set_clipboard_files()`` round-trips; and
  4. live: set files, then Ctrl+V in a real Explorer window copies them (copy, not
     move — the source survives).

Run: ``C:\\devin\\python\\python.exe _probe_clipfiles.py``
"""
import os
import sys
import time
import shutil
import tempfile
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
import osctl

VK_CONTROL = 0x11
PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")


base = tempfile.mkdtemp(prefix="daoclip_")
src = os.path.join(base, "dao_payload.txt")
dest = os.path.join(base, "dest")
os.makedirs(dest, exist_ok=True)
with open(src, "w", encoding="utf-8") as f:
    f.write("道法自然 — file clipboard payload\n")

explorer_hwnd = None
try:
    # external app (PowerShell Set-Clipboard) copies the file -> we must SEE it
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    "Set-Clipboard -Path '%s'" % src], check=False)
    time.sleep(0.5)
    check("friction: text clipboard is blind to a copied file (get_clipboard()=='')",
          osctl.get_clipboard() == "", f"got={osctl.get_clipboard()!r}")
    seen = osctl.get_clipboard_files()
    check("get_clipboard_files() reads a file copied by an external app",
          [os.path.normcase(p) for p in seen] == [os.path.normcase(src)], f"seen={seen}")

    # the floor can ORIGINATE a file clipboard, and read its own back
    ok = osctl.set_clipboard_files([src])
    rt = osctl.get_clipboard_files()
    check("set_clipboard_files() round-trips",
          ok and [os.path.normcase(p) for p in rt] == [os.path.normcase(src)],
          f"ok={ok} rt={rt}")

    # live: paste into a real Explorer window (Ctrl+V) and verify the copy landed
    subprocess.Popen(["explorer.exe", dest])
    for _ in range(40):
        time.sleep(0.4)
        cands = [w for w in osctl.list_windows()
                 if os.path.basename(dest).lower() in (w.get("title") or "").lower()]
        if cands:
            explorer_hwnd = cands[0]["id"]
            break
    check("opened a real Explorer window at the destination folder", bool(explorer_hwnd),
          f"hwnd={explorer_hwnd}")

    pasted = os.path.join(dest, os.path.basename(src))
    if explorer_hwnd:
        osctl.set_clipboard_files([src])      # ensure our copy effect is current
        osctl.activate_window(explorer_hwnd)
        time.sleep(0.6)
        osctl.chord(VK_CONTROL, ord("V"))
        for _ in range(25):
            time.sleep(0.4)
            if os.path.exists(pasted):
                break
    check("Ctrl+V in Explorer pasted the file (file clipboard drove a real copy)",
          os.path.exists(pasted), f"dest={pasted}")
    check("it was a COPY, not a move (source survives)", os.path.exists(src))
    if os.path.exists(pasted):
        check("pasted content matches the source",
              open(pasted, encoding="utf-8").read() == open(src, encoding="utf-8").read())
finally:
    try:
        if explorer_hwnd:
            osctl.close_window(explorer_hwnd)
    except Exception:
        pass
    time.sleep(0.4)
    shutil.rmtree(base, ignore_errors=True)

print(f"\n==== {len(PASS)} PASS / {len(FAIL)} FAIL ====")
sys.exit(1 if FAIL else 0)
