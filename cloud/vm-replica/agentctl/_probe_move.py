"""F149 live probe — a window moved OFF the visible screen is unreachable by any
click, and *raising* it (F148) cannot rescue it; only moving it back into view
can. Official screenshot+click has no way to reposition a window at all.

Linux/konsole only. Run on a real X11 desktop:  python3 _probe_move.py
"""
import os
import subprocess
import sys
import time

import osctl

MARK = os.path.join(__import__("tempfile").gettempdir(), "dao_move_probe.txt")
SCREEN_W, _ = osctl.screen_size()


def launch():
    env = dict(os.environ)
    env["XDG_RUNTIME_DIR"] = env.get("XDG_RUNTIME_DIR", "/tmp/runtime-ubuntu")
    return subprocess.Popen(
        ["konsole", "--separate", "-p", "tabtitle=MVWIN", "--geometry",
         "640x420+200+200", "-e", "env", "WTAG=M", "bash", "--norc", "-i"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def body_center(geom):
    return geom["x"] + geom["w"] // 2, geom["y"] + geom["h"] // 2


def click_type_mark(cx, cy):
    osctl.click(cx, cy)
    time.sleep(0.4)
    osctl.type_unicode("echo MV-$WTAG > " + MARK)
    osctl.tap(osctl.VK_RETURN)
    time.sleep(0.7)


def read():
    try:
        with open(MARK) as f:
            return f.read().strip()
    except OSError:
        return ""


def main():
    if sys.platform.startswith("win"):
        print("(skip: needs konsole on X11)")
        return
    p = launch()
    time.sleep(3)
    try:
        win = next((w for w in osctl.list_windows()
                    if "MVWIN" in (w.get("title") or "")), None)
        if not win:
            print("FAIL: window not found")
            return
        wid = win["id"]
        g0 = osctl.window_geometry(wid)
        print("on-screen geom:", g0)

        # sentinel
        with open(MARK, "w") as f:
            f.write("SENTINEL")

        # Push it fully off the right edge of the screen.
        osctl.move_window(wid, SCREEN_W + 100, 300)
        time.sleep(1.2)
        goff = osctl.window_geometry(wid)
        print("after move off-screen:", goff, "(screen width", SCREEN_W, ")")

        # FRICTION: even raising it cannot help — there is no on-screen pixel that
        # belongs to it. Click where its body *would* be (clamped on-screen) and type.
        osctl.activate_window(wid)
        time.sleep(0.4)
        cx, cy = body_center(g0)  # the spot it used to occupy — now empty desktop
        click_type_mark(cx, cy)
        off = read()
        print("FRICTION  raise+click@old-spot ->", repr(off),
              "(unreached)" if off == "SENTINEL" else "(LEAKED)")

        # FIX: move it back into view, then the click reaches it.
        with open(MARK, "w") as f:
            f.write("SENTINEL")
        osctl.move_window(wid, 200, 200)
        time.sleep(1.5)
        osctl.activate_window(wid)
        time.sleep(0.5)
        g1 = osctl.window_geometry(wid)
        cx, cy = body_center(g1)
        click_type_mark(cx, cy)
        on = read()
        print("FIX       move-back+click   ->", repr(on),
              "(reached)" if on == "MV-M" else "(still unreached)")

        ok = off == "SENTINEL" and on == "MV-M"
        print("\nRESULT:", "PASS" if ok else "FAIL",
              "— off-screen unreachable even when raised; move-back rescues it")
    finally:
        try:
            p.terminate()
        except Exception:
            pass
        time.sleep(0.3)
        os.system("pkill -9 konsole 2>/dev/null")


if __name__ == "__main__":
    main()
