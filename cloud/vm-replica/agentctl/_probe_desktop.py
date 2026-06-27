"""F150 live probe — a window on another virtual desktop (workspace) has no
on-screen pixels: no click can reach it, regardless of focus, Z-order, or
position. Two distinct remedies the floor now has:

  * GO THERE  — activate_window follows the window to its workspace, OR
                set_desktop switches the shown workspace explicitly.
  * BRING HERE — move_window_to_desktop(win, current_desktop()) pulls the window
                 onto the visible workspace WITHOUT leaving it (activate cannot).

Official screenshot+click is blind to every workspace but the current one.

Linux/konsole + a multi-desktop WM only.  Run:  python3 _probe_desktop.py
"""
import os
import subprocess
import sys
import time

import osctl

MARK = os.path.join(__import__("tempfile").gettempdir(), "dao_desktop_probe.txt")


def launch():
    env = dict(os.environ)
    env["XDG_RUNTIME_DIR"] = env.get("XDG_RUNTIME_DIR", "/tmp/runtime-ubuntu")
    return subprocess.Popen(
        ["konsole", "--separate", "-p", "tabtitle=VDWIN", "--geometry",
         "640x420+200+200", "-e", "env", "WTAG=D", "bash", "--norc", "-i"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def click_mark(cx, cy):
    osctl.click(cx, cy)
    time.sleep(0.4)
    osctl.type_unicode("echo VD-$WTAG > " + MARK)
    osctl.tap(osctl.VK_RETURN)
    time.sleep(0.7)


def read():
    try:
        with open(MARK) as f:
            return f.read().strip()
    except OSError:
        return ""


def ensure_two_desktops():
    if osctl.num_desktops() < 2:
        # bump via wmctrl (setup only; the floor reads/switches, doesn't create)
        subprocess.run(["wmctrl", "-n", "2"], check=False)
        time.sleep(0.5)


def main():
    if sys.platform.startswith("win"):
        print("(skip: needs konsole on a multi-desktop X11 WM)")
        return
    ensure_two_desktops()
    if osctl.num_desktops() < 2:
        print("(skip: WM exposes no second virtual desktop)")
        return
    osctl.set_desktop(0)
    time.sleep(0.5)
    p = launch()
    time.sleep(3)
    try:
        win = next((w for w in osctl.list_windows()
                    if "VDWIN" in (w.get("title") or "")), None)
        if not win:
            print("FAIL: window not found")
            return
        wid = win["id"]
        g = osctl.window_geometry(wid)
        cx, cy = g["x"] + g["w"] // 2, g["y"] + g["h"] // 2
        print("launched on desktop", win.get("desktop"),
              "| current", osctl.current_desktop())

        # Send it to workspace 1 while we stay on 0.
        osctl.move_window_to_desktop(wid, 1)
        time.sleep(1.0)
        seen = next((w.get("desktop") for w in osctl.list_windows()
                     if w["id"] == wid), None)
        print("after move-to-desktop-1: list_windows reports desktop", seen,
              "| current", osctl.current_desktop())

        # FRICTION: off-workspace window — clicking its coords hits empty desktop 0.
        with open(MARK, "w") as f:
            f.write("SENTINEL")
        click_mark(cx, cy)
        off = read()
        print("FRICTION  off-workspace click ->", repr(off),
              "(unreached)" if off == "SENTINEL" else "(LEAKED)")

        # REMEDY A — BRING HERE: pull it onto the current workspace, stay on 0.
        with open(MARK, "w") as f:
            f.write("SENTINEL")
        osctl.move_window_to_desktop(wid, osctl.current_desktop())
        time.sleep(1.0)
        osctl.activate_window(wid)
        time.sleep(0.6)
        click_mark(cx, cy)
        here = read()
        print("REMEDY-A  bring-here + click  ->", repr(here),
              "(reached, stayed on", osctl.current_desktop(), ")")

        ok = off == "SENTINEL" and here == "VD-D"
        print("\nRESULT:", "PASS" if ok else "FAIL",
              "— off-workspace unreachable; pulling it to the current desktop rescues it")
    finally:
        try:
            p.terminate()
        except Exception:
            pass
        time.sleep(0.3)
        os.system("pkill -9 konsole 2>/dev/null")


if __name__ == "__main__":
    main()
