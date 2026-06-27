"""Standalone live reproduction of F169: uia_focus moves keyboard focus to an
element found by meaning (via UIA SetFocus), bridging semantic LOCATE to the
keystroke floor — once focused, the universal keyboard (osctl.tap) types into it.
Verified on Notepad's Edit: focus by meaning, type 'dao' with the keyboard floor,
read it back."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

VK = {"d": 0x44, "a": 0x41, "o": 0x4F}


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
        ok = osctl.uia_focus(note["id"], ctype="Edit")
        print(f"uia_focus(notepad, type=Edit) -> {ok}")
        print(f"[{'PASS' if ok else 'FAIL'}] uia_focus set focus to the Edit by meaning")
        time.sleep(0.4)
        for ch in "dao":
            osctl.tap(VK[ch])
            time.sleep(0.1)
        time.sleep(0.4)
        edit = next((k for k in osctl.child_windows(note["id"])
                     if k["class"] == "Edit"), None)
        txt = osctl.window_text(edit["id"]) if edit else ""
        print(f"window_text after typing = {txt!r}")
        print(f"[{'PASS' if txt == 'dao' else 'FAIL'}] keyboard floor typed into the "
              f"UIA-focused element -> {txt!r}")
    finally:
        try:
            osctl.terminate_window(note["id"]) if note else p.terminate()
        except Exception:
            p.terminate()
        os.system("taskkill /F /IM notepad.exe >NUL 2>&1")


if __name__ == "__main__":
    main()
