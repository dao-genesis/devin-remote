"""Standalone live reproduction of F152 window lifecycle on Windows:
wait_window (wait for a window to appear by identity) + close_window (graceful
close by identity) + wait_window_closed. Run alone, do not touch the machine."""
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
    # Negative: a window that never appears times out (no false positive).
    t0 = time.time()
    miss = osctl.wait_window("NOPE-NOEXIST-XYZ", timeout=1.0)
    print(f"[{'PASS' if miss is None else 'FAIL'}] wait_window times out on a "
          f"window that never appears ({time.time()-t0:.2f}s) -> {miss!r}")

    p = launch("ULIFE-1")
    try:
        # Positive: wait_window returns the window once it is born.
        w = osctl.wait_window("ULIFE-1", timeout=8.0)
        print(f"[{'PASS' if w else 'FAIL'}] wait_window returns the window once "
              f"it appears -> {w!r}")
        if not w:
            return
        wid = w["id"]
        print(f"[{'PASS' if osctl.window_exists(wid) else 'FAIL'}] window_exists "
              f"True while the window lives -> id={wid}")

        # Graceful close by identity, then confirm it is gone.
        ok = osctl.close_window(wid)
        gone = osctl.wait_window_closed(wid, timeout=6.0)
        still = any("ULIFE-1" in (x.get("title") or "")
                    for x in osctl.list_windows())
        print(f"[{'PASS' if ok else 'FAIL'}] close_window accepted the request "
              f"-> {ok}")
        print(f"[{'PASS' if gone else 'FAIL'}] wait_window_closed confirms the "
              f"window is gone -> {gone}")
        print(f"[{'PASS' if not still else 'FAIL'}] list_windows no longer "
              f"contains the closed window -> still={still}")
        print(f"[{'PASS' if not osctl.window_exists(wid) else 'FAIL'}] "
              f"window_exists False after close -> id={wid}")
    finally:
        try:
            p.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    main()
