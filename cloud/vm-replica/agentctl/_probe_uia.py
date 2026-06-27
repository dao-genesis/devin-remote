"""Standalone live reproduction of F165: UIA read access sees inside modern apps
(Chrome) where the Win32 child_windows path is blind, and gives a uniform
accessible name/children read across native (Notepad) and modern software."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl


def main():
    # native app — UIA agrees with the Win32 floor
    p = subprocess.Popen(["notepad.exe"])
    osctl.wait_window("Notepad", timeout=8.0)
    time.sleep(1.0)
    note = next((w for w in osctl.list_windows()
                 if "Notepad" in (w.get("title") or "")
                 or "Untitled" in (w.get("title") or "")), None)
    try:
        nm = osctl.uia_name(note["id"]) if note else ""
        print(f"uia_name(notepad) = {nm!r}")
        print(f"[{'PASS' if nm and 'Notepad' in nm else 'FAIL'}] UIA reads a native "
              f"window's accessible name -> {nm!r}")
        kids = osctl.uia_children(note["id"]) if note else []
        print(f"uia_children(notepad) = {kids}")
        print(f"[{'PASS' if kids else 'FAIL'}] UIA enumerates the native window's "
              f"elements -> {len(kids)}")
        has_doc = any(k["type"] in ("Document", "Edit") for k in kids)
        print(f"[{'PASS' if has_doc else 'FAIL'}] it sees the editable Document/Edit "
              f"by control type -> {[k['type'] for k in kids]}")
    finally:
        try:
            osctl.terminate_window(note["id"]) if note else p.terminate()
        except Exception:
            p.terminate()
        os.system("taskkill /F /IM notepad.exe >NUL 2>&1")

    # modern app — UIA sees inside Chrome where Win32 is blind
    ch = next((w for w in osctl.list_windows()
               if "Chrome" in (w.get("title") or "")
               or "Chromium" in (w.get("title") or "")), None)
    print(f"\nchrome window = {ch}")
    if not ch:
        print("[FAIL] no chrome window to inspect"); return
    win32_kids = osctl.child_windows(ch["id"])
    uia_kids = osctl.uia_children(ch["id"])
    print(f"child_windows(chrome) (Win32) = {len(win32_kids)} generic child(ren)")
    print(f"uia_children(chrome) (UIA)   = {[k['name'] or k['type'] for k in uia_kids]}")
    print(f"[{'PASS' if uia_kids else 'FAIL'}] UIA sees inside the modern app "
          f"-> {len(uia_kids)} element(s)")
    print(f"[{'PASS' if osctl.uia_name(ch['id']) else 'FAIL'}] UIA reads Chrome's "
          f"accessible name -> {osctl.uia_name(ch['id'])!r}")


if __name__ == "__main__":
    main()
