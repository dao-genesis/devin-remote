"""Standalone live reproduction of F162 on Windows: control_at(x,y) resolves a
screen pixel to the leaf CONTROL behind it (class+text+top), joining the pixel
floor (window_under) to the semantic floor (window_text). Run alone."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

MARK = "DAO-F162-" + str(os.getpid())


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
        osctl.move_window(note["id"], 120, 120, 700, 500)
        time.sleep(0.5)
        edit = next((k for k in osctl.child_windows(note["id"])
                     if k["class"] in ("Edit", "RichEditD2DPT")), None)
        osctl.set_window_text(edit["id"], MARK)
        time.sleep(0.3)
        g = osctl.window_geometry(note["id"])
        print(f"geometry={g}")
        cx, cy = g["x"] + g["w"] // 2, g["y"] + g["h"] // 2
        c = osctl.control_at(cx, cy)
        print(f"control_at({cx},{cy}) -> {c}")
        print(f"[{'PASS' if c else 'FAIL'}] control_at returns a control at the "
              f"Edit area -> {bool(c)}")
        print(f"[{'PASS' if c and c['class'] in ('Edit', 'RichEditD2DPT') else 'FAIL'}] "
              f"it is the Edit control (pixel resolved to semantic control) -> "
              f"{c['class'] if c else None}")
        print(f"[{'PASS' if c and c['top'] == note['id'] else 'FAIL'}] its top-level "
              f"is the Notepad window -> top={c['top'] if c else None} note={note['id']}")
        print(f"[{'PASS' if c and MARK in (c['text'] or '') else 'FAIL'}] its text is "
              f"the content under the pixel -> {c['text'] if c else None!r}")
        none = osctl.control_at(2, 2)
        print(f"  (corner control_at(2,2) -> {none})")
    finally:
        try:
            osctl.terminate_window(note["id"]) if note else p.terminate()
        except Exception:
            p.terminate()
        os.system("taskkill /F /IM notepad.exe >NUL 2>&1")


if __name__ == "__main__":
    main()
