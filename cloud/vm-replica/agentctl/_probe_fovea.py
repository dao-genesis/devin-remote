"""Probe (F142): prove the fovea — an ROI grab is far cheaper than a full-screen
grab yet ``foveate`` returns the *same* screen coordinate as a whole-screen
``find_color``.

Draws one magenta square on a white page, then: (1) locates it with a full-screen
grab (ground truth); (2) times a full grab vs a 160x160 foveal grab around it;
(3) calls ``osctl.foveate`` and checks its screen-mapped centroid matches the full
grab to within a pixel.

Run: ``DISPLAY=:0 python3 _probe_fovea.py``. Typical result here: full grab ~6 ms,
foveal grab ~0.2 ms (~40x faster), foveate AGREE dx=0 dy=0. The speed is what lets
``wait_stable`` (F143) sample faster than a UI animates instead of undersampling it."""
import os
import sys
import time
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import Browser  # noqa: E402
import osctl  # noqa: E402


def main() -> None:
    fixdir = tempfile.mkdtemp(prefix="fovea_")
    path = os.path.join(fixdir, "dot.html")
    with open(path, "w") as f:
        f.write(
            "<!doctype html><title>dot</title>"
            "<style>html,body{margin:0;background:#fff}</style>"
            "<canvas id=c width=600 height=400 style='display:block'></canvas>"
            "<script>var x=document.getElementById('c').getContext('2d');"
            "x.fillStyle='#fff';x.fillRect(0,0,600,400);"
            "x.fillStyle='#ff00ff';x.fillRect(300,200,60,60);</script>")
    b = Browser()
    b.navigate("file://" + path)
    time.sleep(0.3)

    w, h, rgb = osctl.capture_rgb()
    full = osctl.find_color((255, 0, 255), tol=40, rgb=rgb, size=(w, h))
    print("full grab screen:", (w, h), "-> target",
          full and (full["x"], full["y"]), "count", full and full["count"])
    cx, cy = full["x"], full["y"]

    n = 20
    t0 = time.time()
    for _ in range(n):
        osctl.capture_rgb()
    tfull = (time.time() - t0) / n
    t0 = time.time()
    for _ in range(n):
        osctl.capture_rgb(cx - 80, cy - 80, 160, 160)
    troi = (time.time() - t0) / n
    print(f"mean full grab={tfull*1000:.1f}ms  mean ROI(160x160)={troi*1000:.1f}ms"
          f"  speedup x{tfull/troi:.1f}")

    fv = osctl.foveate((255, 0, 255), (cx, cy), radius=80, tol=40)
    print("foveate screen:", fv and (fv["x"], fv["y"]), "roi", fv and fv["roi"])
    dx = abs(fv["x"] - full["x"])
    dy = abs(fv["y"] - full["y"])
    print("AGREE" if dx <= 2 and dy <= 2 else "MISMATCH", "dx", dx, "dy", dy)


if __name__ == "__main__":
    main()
