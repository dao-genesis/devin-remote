"""Probe F054: a target that moves while you reach for it.

Reproduces the friction that every primitive so far assumes a *static* frame:
`capture_rgb` is a single snapshot, but a real UI animates. A magenta square
teleports to a new spot every ~180ms for ~1.6s, then settles. A single capture
is already stale by the time the OS click lands → MISS. Sampling until the
target stops moving (settle-detection) recovers the real resting position → HIT.
"""
from __future__ import annotations

import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser  # noqa: E402
import osctl  # noqa: E402

HTML = (
    "<!doctype html><title>settle</title><style>html,body{margin:0}</style>"
    "<canvas id=c width=600 height=320 style='display:block'></canvas>"
    "<script>"
    "var c=document.getElementById('c'),x=c.getContext('2d');"
    "var S=60,cur=[20,20],FINAL=[460,200],t0=Date.now();"
    "function draw(p){cur=p;x.fillStyle='#fff';x.fillRect(0,0,600,320);"
    "x.fillStyle='#ff00ff';x.fillRect(p[0],p[1],S,S);}"
    "draw(cur);"
    "var iv=setInterval(function(){"
    "if(Date.now()-t0>1600){draw(FINAL);clearInterval(iv);window.__settled=1;return;}"
    "draw([20+Math.floor(Math.random()*480),20+Math.floor(Math.random()*220)]);"
    "},180);"
    "c.addEventListener('click',function(e){"
    "var r=c.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;"
    "if(px>=cur[0]&&px<=cur[0]+S&&py>=cur[1]&&py<=cur[1]+S){document.title='HIT';}"
    "else{document.title='MISS';}});"
    "</script>")


def wait_stable(color, tol=40, move_tol=3, settle_frames=3, interval=0.12,
                timeout=6.0):
    """Sample the target centroid until it stops moving; return final locate."""
    deadline = time.time() + timeout
    prev = None
    stable = 0
    samples = 0
    last = None
    while time.time() < deadline:
        w, h, rgb = osctl.capture_rgb()
        loc = osctl.find_color(color, tol=tol, rgb=rgb, size=(w, h))
        samples += 1
        if loc is not None:
            last = loc
            if prev is not None and abs(loc["x"] - prev[0]) <= move_tol \
                    and abs(loc["y"] - prev[1]) <= move_tol:
                stable += 1
                if stable >= settle_frames:
                    loc["samples"] = samples
                    loc["settled"] = True
                    return loc
            else:
                stable = 0
            prev = (loc["x"], loc["y"])
        time.sleep(interval)
    if last is not None:
        last["samples"] = samples
        last["settled"] = False
    return last


def main():
    b = Browser()
    url = "data:text/html," + urllib.parse.quote(HTML)
    b.navigate(url)
    time.sleep(0.3)

    # Naive: one capture, then the inherent latency before the click lands means
    # the square has teleported elsewhere — the click is on a stale position.
    w, h, rgb = osctl.capture_rgb()
    loc = osctl.find_color((255, 0, 255), tol=40, rgb=rgb, size=(w, h))
    print("naive single capture at", (loc["x"], loc["y"]) if loc else None)
    time.sleep(0.25)  # the unavoidable gap between perceiving and acting
    if loc:
        osctl.click(loc["x"], loc["y"])
        time.sleep(0.2)
        print("naive click result:", b.title())

    # Settle-detection: sample until the target stops moving, then act.
    b.eval("document.title='settle'")
    st = wait_stable((255, 0, 255))
    print("settled at", (st["x"], st["y"]) if st else None,
          "after", st.get("samples") if st else None, "samples,",
          "settled=", st.get("settled") if st else None)
    print("page __settled=", b.eval("window.__settled||0"))
    if st:
        osctl.click(st["x"], st["y"])
        time.sleep(0.2)
        print("settled click result:", b.title())


if __name__ == "__main__":
    main()
