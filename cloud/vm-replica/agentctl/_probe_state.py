"""Standalone live reproduction of F153 window show-state on Windows:
window_state (read minimized/maximized/normal) + set_window_state. Run alone."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

CREATE_NEW_CONSOLE = 0x00000010


def main():
    p = subprocess.Popen(["cmd", "/k", "title USTATE-1"],
                         creationflags=CREATE_NEW_CONSOLE)
    try:
        w = osctl.wait_window("USTATE-1", timeout=8.0)
        if not w:
            print("[FAIL] could not launch test window")
            return
        wid = w["id"]
        osctl.set_window_state(wid, "normal")
        time.sleep(0.6)
        s0 = osctl.window_state(wid)
        print(f"[{'PASS' if s0 == 'normal' else 'FAIL'}] starts normal -> {s0!r}")

        osctl.set_window_state(wid, "maximized")
        time.sleep(0.8)
        s1 = osctl.window_state(wid)
        print(f"[{'PASS' if s1 == 'maximized' else 'FAIL'}] maximize -> {s1!r}")

        osctl.set_window_state(wid, "minimized")
        time.sleep(0.8)
        s2 = osctl.window_state(wid)
        print(f"[{'PASS' if s2 == 'minimized' else 'FAIL'}] minimize -> {s2!r}")

        osctl.set_window_state(wid, "normal")
        time.sleep(0.8)
        s3 = osctl.window_state(wid)
        print(f"[{'PASS' if s3 == 'normal' else 'FAIL'}] restore to normal -> {s3!r}")

        bad = osctl.set_window_state(wid, "bogus")
        print(f"[{'PASS' if bad is False else 'FAIL'}] unknown state rejected -> {bad!r}")
    finally:
        try:
            p.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    main()
