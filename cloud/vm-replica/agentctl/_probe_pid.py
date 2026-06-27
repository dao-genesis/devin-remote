"""Standalone live reproduction of F156 on Windows: window_pid (identity beyond
title) + terminate_window (forceful death dual to graceful close). Run alone."""
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
    # Two windows with the IDENTICAL title — a title cannot tell them apart.
    pa = launch("UPID-SAME")
    time.sleep(2.0)
    pb = launch("UPID-SAME")
    time.sleep(2.2)
    same = [w for w in osctl.list_windows() if "UPID-SAME" in (w.get("title") or "")]
    try:
        print(f"[{'PASS' if len(same) >= 2 else 'FAIL'}] two identically-titled "
              f"windows exist -> n={len(same)}")
        if len(same) < 2:
            return
        a, bb = same[0], same[1]
        pa_id, pb_id = osctl.window_pid(a["id"]), osctl.window_pid(bb["id"])
        print(f"[{'PASS' if pa_id and pb_id else 'FAIL'}] window_pid returns a pid "
              f"for each -> {pa_id}, {pb_id}")
        print(f"[{'PASS' if pa_id != pb_id else 'FAIL'}] same title, DIFFERENT "
              f"pids — identity beyond the title -> {pa_id} != {pb_id}")

        # Forceful kill of A by its window; B (other pid) must survive.
        ok = osctl.terminate_window(a["id"])
        gone = osctl.wait_window_closed(a["id"], timeout=6.0)
        b_alive = osctl.window_exists(bb["id"])
        print(f"[{'PASS' if ok else 'FAIL'}] terminate_window accepted -> {ok}")
        print(f"[{'PASS' if gone else 'FAIL'}] the terminated window is gone -> {gone}")
        print(f"[{'PASS' if b_alive else 'FAIL'}] the OTHER same-titled window "
              f"survives -> {b_alive}")
    finally:
        for p in (pa, pb):
            try:
                p.terminate()
            except Exception:
                pass


if __name__ == "__main__":
    main()
