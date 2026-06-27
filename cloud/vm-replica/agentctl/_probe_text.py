"""Exploratory probe for F160 semantic content read on Windows: type text into
Notepad, then read it back from the Edit control via window_text/child_windows —
proving the floor reads exact control CONTENT, not pixels. Run alone."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

MARK = "DAO-F160-" + str(os.getpid())


def main():
    p = subprocess.Popen(["notepad.exe"])
    osctl.wait_window("Notepad", timeout=8.0) or osctl.wait_window("无标题", timeout=4.0)
    time.sleep(1.0)
    note = next((w for w in osctl.list_windows()
                 if "Notepad" in (w.get("title") or "")
                 or "无标题" in (w.get("title") or "")
                 or "Untitled" in (w.get("title") or "")), None)
    try:
        print(f"top-level: {note}")
        if not note:
            print("[FAIL] no notepad window found"); return
        kids = osctl.child_windows(note["id"])
        print(f"children: {[(k['class'], repr(k['text'])[:20]) for k in kids]}")
        edit = next((k for k in kids if k["class"] in ("Edit", "RichEditD2DPT")), None)
        print(f"[{'PASS' if edit else 'FAIL'}] found an Edit control -> "
              f"{edit['class'] if edit else None}")
        if not edit:
            return
        osctl.activate_window(note["id"])
        time.sleep(0.5)
        osctl.type_unicode(MARK)
        time.sleep(0.6)
        got = osctl.window_text(edit["id"])
        print(f"[{'PASS' if MARK in got else 'FAIL'}] window_text reads back the "
              f"exact typed content -> {got!r}")
        title = osctl.window_text(note["id"])
        print(f"[{'PASS' if title else 'FAIL'}] window_text on the top-level gives "
              f"its title -> {title!r}")
    finally:
        try:
            osctl.terminate_window(note["id"]) if note else p.terminate()
        except Exception:
            p.terminate()


if __name__ == "__main__":
    main()
