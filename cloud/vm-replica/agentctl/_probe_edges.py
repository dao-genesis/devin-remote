"""Probe F055: locate by structure when colour/brightness has shifted.

F053's match_template scores by absolute-luma SAD. That is dominated by a global
brightness/colour offset: the SAME shape rendered in a different colour scores
WORSE than a DIFFERENT shape rendered in the reference's colour. Matching the
gradient/edge map instead follows structure, which a uniform colour shift leaves
intact.

Scene: two same-coloured tiles (so find_color_blobs gives the candidates).
  - LEFT tile  = reference glyph (a ring) in a SHIFTED colour  -> the target.
  - RIGHT tile = a DIFFERENT glyph (a disk) in the reference's colour -> decoy.
Reference patch = a tile with the ring in the reference colour.
"""
from __future__ import annotations

import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser  # noqa: E402
import osctl  # noqa: E402

TILE = "#ff00ff"   # tile background, shared by all candidates (segmentable)
REF = "#ffffff"    # reference glyph colour
SHIFT = "#000000"  # target glyph: same SHAPE, very different colour
TILE_RGB = (255, 0, 255)


def ring(cx, cy, col):
    return (f"x.fillStyle='{col}';x.beginPath();x.arc({cx},{cy},30,0,7);"
            f"x.fill();x.fillStyle='{TILE}';x.beginPath();x.arc({cx},{cy},15,0,7);x.fill();")


def disk(cx, cy, col):
    return f"x.fillStyle='{col}';x.beginPath();x.arc({cx},{cy},30,0,7);x.fill();"


def page(body_canvas):
    html = ("<!doctype html><title>edges</title><style>html,body{margin:0}</style>"
            "<canvas id=c width=620 height=200 style='display:block'></canvas>"
            "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
            "x.fillStyle='#fff';x.fillRect(0,0,620,200);" + body_canvas + "</script>")
    return "data:text/html," + urllib.parse.quote(html)


def edge_map(rgb, w, bbox, thr=40):
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    lum = [[0] * bw for _ in range(bh)]
    for yy in range(bh):
        for xx in range(bw):
            j = ((y0 + yy) * w + (x0 + xx)) * 3
            lum[yy][xx] = (rgb[j] * 299 + rgb[j + 1] * 587 + rgb[j + 2] * 114) // 1000
    e = bytearray(bw * bh)
    for yy in range(bh - 1):
        for xx in range(bw - 1):
            g = abs(lum[yy][xx + 1] - lum[yy][xx]) + abs(lum[yy + 1][xx] - lum[yy][xx])
            e[yy * bw + xx] = 1 if g > thr else 0
    return e, bw, bh


def luma_sad(ref_rgb, rw, ref_bbox, rgb, w, cand_bbox):
    rx0, ry0, rx1, ry1 = ref_bbox
    cx0, cy0 = cand_bbox[0], cand_bbox[1]
    bw, bh = rx1 - rx0 + 1, ry1 - ry0 + 1
    s = 0
    for yy in range(bh):
        for xx in range(bw):
            a = ((ry0 + yy) * rw + (rx0 + xx)) * 3
            b = ((cy0 + yy) * w + (cx0 + xx)) * 3
            if b + 2 >= len(rgb) or a + 2 >= len(ref_rgb):
                continue
            la = (ref_rgb[a] * 299 + ref_rgb[a + 1] * 587 + ref_rgb[a + 2] * 114) // 1000
            lb = (rgb[b] * 299 + rgb[b + 1] * 587 + rgb[b + 2] * 114) // 1000
            s += abs(la - lb)
    return s


def edge_sad(ref_e, ce):
    return sum(1 for i in range(len(ref_e)) if ref_e[i] != ce[i])


def main():
    b = Browser()
    # Reference: a single tile with the ring in the reference colour.
    b.navigate(page(f"x.fillStyle='{TILE}';x.fillRect(60,50,120,120);" + ring(120, 110, REF)))
    time.sleep(0.4)
    rw, rh, ref_rgb = osctl.capture_rgb()
    rblobs = osctl.find_color_blobs(TILE_RGB, tol=40, rgb=ref_rgb, size=(rw, rh), min_count=200)
    tile = max(rblobs, key=lambda bl: bl["count"])
    ref_bbox = tile["bbox"]
    print("ref tile bbox", ref_bbox, "size", (ref_bbox[2] - ref_bbox[0] + 1, ref_bbox[3] - ref_bbox[1] + 1))
    ref_e, ew, eh = edge_map(ref_rgb, rw, ref_bbox)
    print("ref edge pixels", sum(ref_e))

    # Scene: target (ring, shifted colour) LEFT, decoy (disk, ref colour) RIGHT.
    scene = page(
        f"x.fillStyle='{TILE}';x.fillRect(60,50,120,120);" + ring(120, 110, SHIFT) +
        f"x.fillStyle='{TILE}';x.fillRect(440,50,120,120);" + disk(500, 110, REF))
    b.navigate(scene)
    time.sleep(0.4)
    w, h, rgb = osctl.capture_rgb()
    blobs = osctl.find_color_blobs(TILE_RGB, tol=40, rgb=rgb, size=(w, h), min_count=200)
    # keep only tile-sized blobs (drop the ring's inner-hole blob)
    blobs = [bl for bl in blobs
             if bl["bbox"][2] - bl["bbox"][0] > 80 and bl["bbox"][3] - bl["bbox"][1] > 80]
    blobs.sort(key=lambda bl: bl["x"])
    print("candidates", [(bl["x"], bl["y"]) for bl in blobs])

    for name, bl in zip(("LEFT(target/ring-shifted)", "RIGHT(decoy/disk-refcolour)"), blobs):
        ls = luma_sad(ref_rgb, rw, ref_bbox, rgb, w, bl["bbox"])
        ce, _, _ = edge_map(rgb, w, (bl["bbox"][0], bl["bbox"][1],
                                     bl["bbox"][0] + ew - 1, bl["bbox"][1] + eh - 1))
        es = edge_sad(ref_e, ce)
        print(f"{name}: luma_sad={ls}  edge_sad={es}")


if __name__ == "__main__":
    main()
