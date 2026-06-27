"""Standalone live reproduction of F163 on Windows: find_control locates a control
by MEANING (class/text) and returns its screen rect — the dual of control_at. The
round-trip find_control -> control_at(center) must return the same control. Run alone."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

MARK = "DAO-F163-" + str(os.getpid())


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
        osctl.move_window(note["id"], 140, 140, 720, 520)
        time.sleep(0.5)
        ek = next((k for k in osctl.child_windows(note["id"])
                   if k["class"] == "Edit"), None)
        if ek:
            osctl.set_window_text(ek["id"], MARK)
            time.sleep(0.3)
        # locate the Edit purely by MEANING (class), get its pixel rect
        c = osctl.find_control(note["id"], cls="Edit")
        print(f"find_control(cls=Edit) -> {c}")
        print(f"[{'PASS' if c else 'FAIL'}] found a control by meaning -> {bool(c)}")
        print(f"[{'PASS' if c and c['class'] == 'Edit' else 'FAIL'}] it is the Edit "
              f"-> {c['class'] if c else None}")
        rect = c["rect"] if c else (0, 0, 0, 0)
        print(f"[{'PASS' if rect[2] > 0 and rect[3] > 0 else 'FAIL'}] it carries a "
              f"real screen rect (a pixel target for the mouse) -> {rect}")
        # round-trip: the center of that rect must resolve back to the same control
        cx, cy = rect[0] + rect[2] // 2, rect[1] + rect[3] // 2
        back = osctl.control_at(cx, cy)
        same = back and c and back["id"] == c["id"]
        print(f"[{'PASS' if same else 'FAIL'}] round-trip find_control->control_at "
              f"returns the SAME control (meaning<->location are inverse) -> "
              f"back={back['id'] if back else None} find={c['id'] if c else None}")
        # find by text substring also works
        ct = osctl.find_control(note["id"], text=MARK[:8])
        print(f"[{'PASS' if ct and ct['id'] == c['id'] else 'FAIL'}] find by TEXT "
              f"substring finds the same control -> {ct['id'] if ct else None}")
        miss = osctl.find_control(note["id"], cls="NoSuchClassXYZ")
        print(f"[{'PASS' if miss is None else 'FAIL'}] a non-existent control yields "
              f"None -> {miss}")
    finally:
        try:
            osctl.terminate_window(note["id"]) if note else p.terminate()
        except Exception:
            p.terminate()
        os.system("taskkill /F /IM notepad.exe >NUL 2>&1")


if __name__ == "__main__":
    main()
