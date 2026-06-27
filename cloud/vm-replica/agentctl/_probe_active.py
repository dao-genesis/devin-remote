"""Standalone live reproduction of F154 active_window (focus read) on Windows:
the keyboard follows focus; active_window() reports who has it. Run alone."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

CREATE_NEW_CONSOLE = 0x00000010


def launch(title):
    return subprocess.Popen(["cmd", "/k", f"title {title}"],
                            creationflags=CREATE_NEW_CONSOLE)


def main():
    pa = launch("UACT-A")
    osctl.wait_window("UACT-A", timeout=8.0)
    pb = launch("UACT-B")
    b = osctl.wait_window("UACT-B", timeout=8.0)
    a = next((w for w in osctl.list_windows()
              if "UACT-A" in (w.get("title") or "")), None)
    try:
        if not a or not b:
            print("[FAIL] could not launch both windows")
            return
        osctl.activate_window(a["id"])
        time.sleep(0.7)
        af = osctl.active_window()
        print(f"[{'PASS' if af == a['id'] else 'FAIL'}] after activating A, "
              f"active_window == A -> {af} a={a['id']} b={b['id']}")

        osctl.activate_window(b["id"])
        time.sleep(0.7)
        bf = osctl.active_window()
        print(f"[{'PASS' if bf == b['id'] else 'FAIL'}] after activating B, "
              f"active_window == B -> {bf} a={a['id']} b={b['id']}")

        # focus_window (write by name) and active_window (read) must agree.
        osctl.focus_window("UACT-A")
        time.sleep(0.7)
        ff = osctl.active_window()
        print(f"[{'PASS' if ff == a['id'] else 'FAIL'}] focus_window(name) and "
              f"active_window() agree -> {ff} a={a['id']}")
    finally:
        for p in (pa, pb):
            try:
                p.terminate()
            except Exception:
                pass


if __name__ == "__main__":
    main()
