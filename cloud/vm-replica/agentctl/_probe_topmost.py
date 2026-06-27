"""Standalone live reproduction of F155 always-on-top on Windows:
set_window_topmost/is_window_topmost, and the crux — a topmost window stays on
the STACK top (window_under) even when another window holds FOCUS (active_window).
Run alone."""
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
    pa = launch("UTOP-A")
    osctl.wait_window("UTOP-A", timeout=8.0)
    pb = launch("UTOP-B")
    osctl.wait_window("UTOP-B", timeout=8.0)
    a = next((w for w in osctl.list_windows() if "UTOP-A" in (w.get("title") or "")), None)
    bb = next((w for w in osctl.list_windows() if "UTOP-B" in (w.get("title") or "")), None)
    try:
        if not a or not bb:
            print("[FAIL] could not launch both windows")
            return
        # Overlap them so one pixel sits inside both bodies.
        osctl.move_window(a["id"], 120, 120, 640, 420)
        time.sleep(0.4)
        osctl.move_window(bb["id"], 170, 170, 640, 420)
        time.sleep(0.4)
        px, py = 450, 380

        print(f"[{'PASS' if not osctl.is_window_topmost(a['id']) else 'FAIL'}] "
              f"A starts not-topmost -> {osctl.is_window_topmost(a['id'])}")

        # Pin A topmost, then give B focus.
        ok = osctl.set_window_topmost(a["id"], True)
        time.sleep(0.4)
        print(f"[{'PASS' if ok and osctl.is_window_topmost(a['id']) else 'FAIL'}] "
              f"set_window_topmost(A) and read back True -> ok={ok} "
              f"is={osctl.is_window_topmost(a['id'])}")

        osctl.activate_window(bb["id"])  # B gets FOCUS
        time.sleep(0.6)
        af = osctl.active_window()
        owner = osctl.window_under(px, py)
        # Crux: focus is B, but the shared pixel still belongs to topmost A.
        print(f"[{'PASS' if af == bb['id'] else 'FAIL'}] B holds focus "
              f"-> active={af} B={bb['id']}")
        print(f"[{'PASS' if owner == a['id'] else 'FAIL'}] yet the shared pixel "
              f"still belongs to topmost A (stack != focus) -> under={owner} A={a['id']}")

        # Unpin; now activating B should let B rise over A at the shared pixel.
        osctl.set_window_topmost(a["id"], False)
        time.sleep(0.3)
        osctl.activate_window(bb["id"])
        time.sleep(0.6)
        owner2 = osctl.window_under(px, py)
        print(f"[{'PASS' if not osctl.is_window_topmost(a['id']) else 'FAIL'}] "
              f"unpin reads back False -> {osctl.is_window_topmost(a['id'])}")
        print(f"[{'PASS' if owner2 == bb['id'] else 'FAIL'}] after unpin, the "
              f"shared pixel goes to focused B -> under={owner2} B={bb['id']}")
    finally:
        for p in (pa, pb):
            try:
                p.terminate()
            except Exception:
                pass


if __name__ == "__main__":
    main()
