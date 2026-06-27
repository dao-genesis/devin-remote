"""Standalone live reproduction of F161 on Windows: set_window_text writes a
control's content directly by handle (write dual of window_text) — no focus, no
typing. Verified by round-trip against window_text on Notepad's Edit. Run alone."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

MARK = "DAO-F161-direct-" + str(os.getpid())


def main():
    p = subprocess.Popen(["notepad.exe"])
    osctl.wait_window("Notepad", timeout=8.0)
    time.sleep(1.0)
    note = next((w for w in osctl.list_windows()
                 if "Notepad" in (w.get("title") or "")
                 or "Untitled" in (w.get("title") or "")), None)
    try:
        if not note:
            print("[FAIL] no notepad"); return
        edit = next((k for k in osctl.child_windows(note["id"])
                     if k["class"] in ("Edit", "RichEditD2DPT")), None)
        print(f"[{'PASS' if edit else 'FAIL'}] found Edit -> {edit['class'] if edit else None}")
        if not edit:
            return
        # write WITHOUT activating the window or pressing a single key
        ok = osctl.set_window_text(edit["id"], MARK)
        time.sleep(0.3)
        got = osctl.window_text(edit["id"])
        print(f"[{'PASS' if ok else 'FAIL'}] set_window_text returned success -> {ok}")
        print(f"[{'PASS' if got == MARK else 'FAIL'}] edit content is EXACTLY what "
              f"was written, no focus/typing -> {got!r}")
        # overwrite replaces, not appends
        ok2 = osctl.set_window_text(edit["id"], "REPLACED")
        time.sleep(0.3)
        got2 = osctl.window_text(edit["id"])
        print(f"[{'PASS' if got2 == 'REPLACED' else 'FAIL'}] a second write replaces "
              f"the content -> {got2!r}")
    finally:
        try:
            osctl.terminate_window(note["id"]) if note else p.terminate()
        except Exception:
            p.terminate()
        os.system("taskkill /F /IM notepad.exe >NUL 2>&1")


if __name__ == "__main__":
    main()
