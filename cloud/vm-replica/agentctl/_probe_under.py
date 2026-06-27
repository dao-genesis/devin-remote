"""Probe: window_under reads which window owns a screen pixel (Z-order read).

Two overlapping consoles share a pixel. The later-launched one sits on top, so a
click there would hit it; after raising the other, the same pixel belongs to the
other. Screenshot+click is blind to this — a pixel carries no window identity.
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

PX, PY = 450, 380  # inside both frames below


def launch(title):
    return subprocess.Popen(["cmd", "/k", f"title {title}"],
                            creationflags=0x00000010)  # CREATE_NEW_CONSOLE


def find(title):
    return next((w for w in osctl.list_windows()
                 if title in (w.get("title") or "")), None)


def main():
    procs = [launch("UNDERWIN-A")]
    time.sleep(1.6)
    procs.append(launch("UNDERWIN-B"))
    time.sleep(1.8)
    a, bb = find("UNDERWIN-A"), find("UNDERWIN-B")
    print("enumerated:", "A" if a else "-", "B" if bb else "-")
    if not a or not bb:
        return
    osctl.move_window(a["id"], 120, 120, 640, 420)
    time.sleep(0.4)
    osctl.move_window(bb["id"], 170, 170, 640, 420)  # overlaps A, launched later
    time.sleep(0.6)
    osctl.activate_window(bb["id"])  # ensure B is the top one
    time.sleep(0.5)

    ga = osctl.window_geometry(a["id"])
    gb = osctl.window_geometry(bb["id"])
    print("geomA", ga, "geomB", gb)

    u0 = osctl.window_under(PX, PY)
    print(f"under({PX},{PY}) with B on top -> {u0}  (B={bb['id']} A={a['id']})",
          "OK" if u0 == bb["id"] else "MISMATCH")

    osctl.activate_window(a["id"])  # raise A
    time.sleep(0.6)
    u1 = osctl.window_under(PX, PY)
    print(f"under after raising A -> {u1}", "OK" if u1 == a["id"] else "MISMATCH")

    osctl.activate_window(bb["id"])  # raise B again
    time.sleep(0.6)
    u2 = osctl.window_under(PX, PY)
    print(f"under after raising B -> {u2}", "OK" if u2 == bb["id"] else "MISMATCH")

    # bare desktop corner should be None or at least not one of our windows
    far = osctl.window_under(2, 2)
    print("under(2,2) bare-ish ->", far)

    for p in procs:
        try:
            p.terminate()
        except Exception:
            pass
    os.system('taskkill /F /IM cmd.exe >NUL 2>&1')


if __name__ == "__main__":
    main()
