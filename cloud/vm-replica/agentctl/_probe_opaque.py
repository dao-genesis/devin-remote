"""F201 — perceive a **semantically-opaque** window and operate it by pixels+keys.

The zero-pixel rounds (F192/F199/F200) found windows with *meaning but no pixels*.
This is the **inverse**: a window with *pixels but no meaning*. A GTK app on Windows
(Inkscape) exposes its entire client area as a single opaque UIA ``Pane`` — File/Edit,
the toolbox, the palette are all invisible to the meaning floor; the only UIA elements
are the OS window frame (caption buttons + System menu). Games, video surfaces and bare
``<canvas>`` are the same. The friction: ``uia_find → None`` cannot tell "wrong name"
from "no semantic surface at all", so an agent guesses names at a wall.

``window_opaque(win)`` answers it: True ⟺ no operable control in the a11y tree, only
frame chrome ⟹ drive this one by the pixel+keyboard channel. This proves:
  1. a rich UIA window (WPF) reads NOT opaque, and its controls are found by meaning;
  2. an opaque window (pixels, no controls) reads opaque, ``uia_find`` for any app
     control is None, yet the floor still OPERATES it by pixel (click → white→red);
  3. the discrimination rests on *operable controls*, not raw element count (the
     opaque window still has its frame chrome — UIA is not broken, the toolkit is mute).

Run: ``C:\\devin\\python\\python.exe _probe_opaque.py``
"""
import os
import sys
import time
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
import osctl

HERE = os.path.dirname(os.path.abspath(__file__))
PID = os.getpid() % 100000
RICH = "DaoRich_%d" % PID
OPAQUE = "DaoOpaque_%d" % PID

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")


def launch(fixture, title):
    subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                      "-File", os.path.join(HERE, fixture), "-Title", title])
    for _ in range(40):
        time.sleep(0.4)
        for w in osctl.list_windows():
            if title in (w.get("title") or ""):
                return w["id"]
    return None


rich_id = launch("_fixture_wpf.ps1", RICH)
opaque_id = launch("_fixture_opaque.ps1", OPAQUE)
print("rich window:", rich_id, " opaque window:", opaque_id)
try:
    # 1) a rich UIA window is NOT opaque, and meaning works on it
    check("rich WPF window reads NOT opaque", rich_id and not osctl.window_opaque(rich_id))
    check("  …and its controls are found by meaning (uia_find 'field')",
          bool(rich_id and osctl.uia_find(rich_id, name="field")))

    # 2) the opaque window reads opaque, meaning is futile, pixels still operate it
    check("opaque window reads opaque (no operable control in a11y tree)",
          bool(opaque_id and osctl.window_opaque(opaque_id)))
    check("  …uia_find for any app control returns None (meaning channel futile)",
          bool(opaque_id) and osctl.uia_find(opaque_id, name="surface") is None
          and osctl.uia_find(opaque_id, name="File") is None)

    g = osctl.window_geometry(opaque_id) if opaque_id else None
    cx, cy = (g["x"] + g["w"] // 2, g["y"] + g["h"] // 2) if g else (0, 0)
    before = osctl.pixel(cx, cy) if g else (0, 0, 0)
    if opaque_id:
        osctl.activate_window(opaque_id)
        time.sleep(0.3)
        osctl.click(cx, cy)
        time.sleep(0.4)
    after = osctl.pixel(cx, cy) if g else (0, 0, 0)
    check("  …yet the floor OPERATES it by pixel (click: white → red)",
          before == (255, 255, 255) and after[0] > 200 and after[1] < 60 and after[2] < 60,
          f"before={before} after={after}")

    # 3) opacity is about *operable* controls, not element count: the frame remains
    frame = osctl.uia_find_all(opaque_id) if opaque_id else []
    names = {(e.get("name") or "").strip().lower() for e in frame}
    check("opaque window still exposes its frame chrome (UIA not broken, toolkit mute)",
          bool(frame) and ("close" in names or "minimize" in names),
          f"frame_elems={len(frame)} names={sorted(n for n in names if n)}")
    check("  …none of the frame elements is an operable app control",
          osctl.window_opaque(opaque_id),
          f"types={sorted({e.get('type') for e in frame})}")
finally:
    for wid in (rich_id, opaque_id):
        try:
            if wid:
                osctl.close_window(wid)
        except Exception:
            pass
    time.sleep(0.5)

print(f"\n==== {len(PASS)} PASS / {len(FAIL)} FAIL ====")
sys.exit(1 if FAIL else 0)
