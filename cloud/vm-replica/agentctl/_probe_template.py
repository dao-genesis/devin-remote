"""Probe F053: two same-colour squares, distinguishable only by inner glyph.

Reproduces the friction that colour-segmentation (F052) cannot resolve: when two
regions share a colour AND size, neither colour nor position tells you which is
the target. Only matching *appearance* (a reference patch) does.
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser  # noqa: E402
import osctl  # noqa: E402


def crop(rgb: bytes, w: int, bbox) -> tuple[bytes, int, int]:
    x0, y0, x1, y1 = bbox
    pw, ph = x1 - x0 + 1, y1 - y0 + 1
    out = bytearray(pw * ph * 3)
    stride = w * 3
    for py in range(ph):
        src = (y0 + py) * stride + x0 * 3
        dst = py * pw * 3
        out[dst:dst + pw * 3] = rgb[src:src + pw * 3]
    return bytes(out), pw, ph


def match(patch, pw, ph, rgb, w, h, search, step=1):
    sx0, sy0, sx1, sy1 = search
    sx0 = max(0, sx0); sy0 = max(0, sy0)
    sx1 = min(w - 1, sx1); sy1 = min(h - 1, sy1)
    aw, ah = sx1 - sx0 + 1, sy1 - sy0 + 1
    if aw < pw or ah < ph:
        return None
    pl = bytearray(pw * ph)
    for i in range(pw * ph):
        pl[i] = (patch[i*3]*299 + patch[i*3+1]*587 + patch[i*3+2]*114) // 1000
    best = None
    for oy in range(0, ah - ph + 1, step):
        for ox in range(0, aw - pw + 1, step):
            s = 0
            for py in range(ph):
                base = ((sy0+oy+py)*w + (sx0+ox)) * 3
                pbase = py * pw
                for px in range(pw):
                    j = base + px*3
                    lum = (rgb[j]*299 + rgb[j+1]*587 + rgb[j+2]*114)//1000
                    d = lum - pl[pbase+px]
                    s += d if d >= 0 else -d
            if best is None or s < best[0]:
                best = (s, sx0+ox, sy0+oy)
    s, tx, ty = best
    return {"x": tx + pw//2, "y": ty + ph//2, "score": s,
            "bbox": (tx, ty, tx+pw-1, ty+ph-1)}


CROSS = ("x.fillStyle='#000';x.fillRect(X+34,Y+12,12,56);"
         "x.fillRect(X+12,Y+34,56,12);")
TRI = ("x.fillStyle='#000';x.beginPath();x.moveTo(X+40,Y+14);"
       "x.lineTo(X+66,Y+66);x.lineTo(X+14,Y+66);x.closePath();x.fill();")


def fixture(b, name, body):
    p = os.path.join(os.environ.get("TEMP", "/tmp"), name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(body)
    b.navigate("file:///" + p.replace("\\", "/"))


def main():
    b = Browser()
    # Phase 1: render the TARGET glyph alone -> capture a reference patch.
    proto = ("<!doctype html><title>proto</title><style>html,body{margin:0}</style>"
             "<canvas id=c width=300 height=200 style='display:block'></canvas>"
             "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
             "x.fillStyle='#fff';x.fillRect(0,0,300,200);"
             "var X=110,Y=60;x.fillStyle='#ff00ff';x.fillRect(X,Y,80,80);"
             + CROSS + "</script>")
    fixture(b, "proto.html", proto)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    sq = osctl.find_color((255, 0, 255), tol=40, rgb=rgb, size=(w, h))
    print("proto square bbox:", sq and sq["bbox"])
    patch, pw, ph = crop(rgb, w, sq["bbox"])
    print("template patch:", pw, "x", ph)

    # Phase 2: scene with TARGET(cross) on the LEFT, DECOY(triangle) on the RIGHT.
    # So the naive "right-most" heuristic (R16) would pick the WRONG one.
    scene = ("<!doctype html><title>scene</title><style>html,body{margin:0}</style>"
             "<canvas id=c width=600 height=260 style='display:block'></canvas>"
             "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
             "x.fillStyle='#fff';x.fillRect(0,0,600,260);"
             "var TGT=[80,90,80,80],DEC=[440,90,80,80];"
             "x.fillStyle='#ff00ff';x.fillRect(TGT[0],TGT[1],80,80);"
             "x.fillRect(DEC[0],DEC[1],80,80);"
             "var X=TGT[0],Y=TGT[1];" + CROSS
             + "X=DEC[0];Y=DEC[1];" + TRI +
             "function inb(p,r){return p[0]>=r[0]&&p[0]<=r[0]+r[2]&&p[1]>=r[1]&&p[1]<=r[1]+r[3];}"
             "c.addEventListener('click',function(e){"
             "var r=c.getBoundingClientRect(),p=[e.clientX-r.left,e.clientY-r.top];"
             "if(inb(p,TGT)){document.title='TARGET-HIT';}"
             "else if(inb(p,DEC)){document.title='DECOY';}else{document.title='MISS';}});"
             "</script>")
    fixture(b, "scene.html", scene)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    blobs = osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rgb, size=(w, h),
                                   min_count=200)
    print("blobs:", [(bl["x"], bl["count"]) for bl in blobs])

    # Friction: position heuristic (right-most) picks the DECOY.
    right = max(blobs, key=lambda bl: bl["x"])
    osctl.click(right["x"], right["y"])
    print("right-most heuristic ->", b.title())

    # Reset title, then template-match each candidate; pick best-appearance.
    b.eval("document.title='scene'")
    best = None
    for bl in blobs:
        x0, y0, x1, y1 = bl["bbox"]
        m = match(patch, pw, ph, rgb, w, h,
                  (x0-6, y0-6, x1+6, y1+6), step=2)
        print("  candidate", (bl["x"], bl["y"]), "score", m and m["score"])
        if m and (best is None or m["score"] < best["score"]):
            best = m
    osctl.click(best["x"], best["y"])
    time.sleep(0.3)
    print("template-match ->", b.title(), "at", (best["x"], best["y"]))
    b.close()


if __name__ == "__main__":
    main()
