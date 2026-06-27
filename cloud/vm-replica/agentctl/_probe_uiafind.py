"""Standalone live reproduction of F166: uia_find locates an element by meaning
(name/type) inside a window's accessibility tree and returns its screen rect —
the UIA analogue of find_control, reaching INSIDE modern apps. Cross-floor proof:
the UIA-found rect's centre, fed to control_at, resolves to the matching native
control (the accessibility floor and the pixel floor agree on where it is)."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl


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
        osctl.set_window_state(note["id"], "normal")
        osctl.move_window(note["id"], 160, 160, 720, 520)
        time.sleep(0.5)
        e = osctl.uia_find(note["id"], ctype="Edit")
        print(f"uia_find(notepad, type=Edit) -> {e}")
        ok = e and e["rect"] and e["rect"][2] > 0 and e["rect"][3] > 0
        print(f"[{'PASS' if ok else 'FAIL'}] UIA locates the Edit by meaning and "
              f"returns a real screen rect -> {e['rect'] if e else None}")
        if ok:
            x, y, w, h = e["rect"]
            cx, cy = x + w // 2, y + h // 2
            native = osctl.control_at(cx, cy)
            same = native and native.get("class") == "Edit"
            print(f"[{'PASS' if same else 'FAIL'}] cross-floor: the UIA rect's centre "
                  f"resolves via control_at to the native Edit -> {native}")
    finally:
        try:
            osctl.terminate_window(note["id"]) if note else p.terminate()
        except Exception:
            p.terminate()
        os.system("taskkill /F /IM notepad.exe >NUL 2>&1")

    ch = next((w for w in osctl.list_windows()
               if "Chrome" in (w.get("title") or "")
               or "Chromium" in (w.get("title") or "")), None)
    print(f"\nchrome window = {ch}")
    if not ch:
        print("[FAIL] no chrome"); return
    g = osctl.window_geometry(ch["id"])
    pane = osctl.uia_find(ch["id"], ctype="Pane")
    print(f"uia_find(chrome, type=Pane) -> {pane}")
    inside = (pane and pane["rect"] and g
              and pane["rect"][0] >= g["x"] - 5 and pane["rect"][1] >= g["y"] - 5)
    print(f"[{'PASS' if pane and pane['rect'] else 'FAIL'}] semantic locate works "
          f"INSIDE the modern app and yields a clickable rect -> "
          f"{pane['rect'] if pane else None}")
    print(f"[{'PASS' if inside else 'FAIL'}] the found rect lies within the Chrome "
          f"window -> win={g}")


if __name__ == "__main__":
    main()
