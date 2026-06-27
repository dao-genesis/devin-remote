"""Standalone live reproduction of F167: uia_set_value writes a field's value
through the UIA ValuePattern (modern-app-capable write dual of set_window_text),
uia_get_value reads it back, uia_invoke presses by meaning. Verified on Notepad's
Edit: set value via UIA, then read it back via BOTH UIA and the native window_text
(cross-floor agreement)."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

MARK = "DAO-F167-" + str(os.getpid())


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
        ok = osctl.uia_set_value(note["id"], MARK, ctype="Edit")
        print(f"uia_set_value -> {ok}")
        time.sleep(0.3)
        via_uia = osctl.uia_get_value(note["id"], ctype="Edit")
        edit = next((k for k in osctl.child_windows(note["id"])
                     if k["class"] == "Edit"), None)
        via_native = osctl.window_text(edit["id"]) if edit else ""
        print(f"uia_get_value = {via_uia!r}  window_text(native) = {via_native!r}")
        print(f"[{'PASS' if ok else 'FAIL'}] uia_set_value wrote through the "
              f"ValuePattern -> {ok}")
        print(f"[{'PASS' if via_uia == MARK else 'FAIL'}] uia_get_value reads the same "
              f"value back -> {via_uia!r}")
        print(f"[{'PASS' if via_native == MARK else 'FAIL'}] cross-floor: the native "
              f"window_text sees the UIA-written value -> {via_native!r}")
    finally:
        try:
            osctl.terminate_window(note["id"]) if note else p.terminate()
        except Exception:
            p.terminate()
        os.system("taskkill /F /IM notepad.exe >NUL 2>&1")


if __name__ == "__main__":
    main()
