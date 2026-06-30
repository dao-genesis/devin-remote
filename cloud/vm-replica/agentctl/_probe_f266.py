"""F266 probe — independent motion under a panning camera (SuperTux).

F265's `consensus_shift` fuses per-block displacement votes into the one dominant
world shift and *rejects the outliers*. But in a scene with a moving enemy while
the camera pans, an independent mover's blocks ARE outliers — with a *consistent,
spatially-coherent* residual displacement, unlike scattered mislocks. The question
this probe asks of real pixels: when the camera pans and a badguy walks, do the
mover's blocks separate from the background consensus as a coherent cluster (a
detectable "this is moving in the world, not just sliding because I panned"), or
do they drown in mislock noise?

Captures frame pairs while running right (camera follows), computes a fine
per-block flow, finds the background shift via consensus_shift, then prints the
RESIDUAL (block displacement minus background shift) and screen position of every
block, grouped into background-explained vs residual-mover candidates.

Run with the SuperTux window visible on DISPLAY=:0 (STX_WID = its window id).
"""
import os
import statistics
import subprocess
import sys
import time
sys.path.insert(0, ".")
import osctl

WID = os.environ.get("STX_WID", "0x0380000e")
REGION = (0, 29, 1024, 768)
FACTOR = 4
BS = 10           # finer blocks than F265 (16) to catch a small mover
MAXDX = 40
MAXDY = 10
MIN_VAR = 50


def key(action, k):
    subprocess.run(["xdotool", action, "--window", WID, k],
                   env={**os.environ, "DISPLAY": ":0"})


def grab_raw():
    x, y, w, h = REGION
    sw, sh, rgb = osctl.capture_rgb(x, y, w, h)
    return rgb, sw, sh


def downsample(rgb, sw, sh, factor=FACTOR):
    qw, qh = sw // factor, sh // factor
    out = bytearray(qw * qh * 3)
    stride = sw * 3
    for j in range(qh):
        row = (j * factor) * stride
        for i in range(qw):
            p = row + (i * factor) * 3
            o = (j * qw + i) * 3
            out[o] = rgb[p]
            out[o + 1] = rgb[p + 1]
            out[o + 2] = rgb[p + 2]
    return bytes(out), qw, qh


def luma_var(patch, pw, ph):
    n = pw * ph
    s = s2 = 0
    for i in range(n):
        l = (patch[i * 3] * 299 + patch[i * 3 + 1] * 587
             + patch[i * 3 + 2] * 114) // 1000
        s += l
        s2 += l * l
    m = s / n
    return s2 / n - m * m


def block_flow(A, B, qw, qh):
    """Per-block (screen_x, screen_y, dx, dy) in real px, gated by match_unique."""
    out = []
    for by in range(0, qh - BS, BS):
        for bx in range(0, qw - BS, BS):
            patch, pw, ph = osctl.crop_rgb(A, (qw, qh),
                                           (bx, by, bx + BS - 1, by + BS - 1))
            if luma_var(patch, pw, ph) < MIN_VAR:
                continue
            sx0, sy0 = max(0, bx - MAXDX), max(0, by - MAXDY)
            sx1 = min(qw - 1, bx + BS - 1 + MAXDX)
            sy1 = min(qh - 1, by + BS - 1 + MAXDY)
            m = osctl.match_unique(patch, pw, ph, rgb=B, size=(qw, qh),
                                   search=(sx0, sy0, sx1, sy1))
            if not m:
                continue
            ocx, ocy = bx + pw // 2, by + ph // 2
            out.append((ocx * FACTOR, ocy * FACTOR,
                        (m["x"] - ocx) * FACTOR, (m["y"] - ocy) * FACTOR))
    return out


def main():
    print("F266 probe: independent motion under a panning camera (SuperTux)")
    key("keydown", "Right")
    time.sleep(1.5)                     # cross deadzone; camera now follows
    pairs = []
    for _ in range(6):
        a = grab_raw()
        time.sleep(0.10)
        b = grab_raw()
        pairs.append((a, b))
    key("keyup", "Right")

    for idx, (rawA, rawB) in enumerate(pairs):
        A, qw, qh = downsample(*rawA)
        B, _, _ = downsample(*rawB)
        flow = block_flow(A, B, qw, qh)
        if len(flow) < 4:
            print(f"[{idx}] too few blocks ({len(flow)})")
            continue
        votes = [(dx, dy) for (_, _, dx, dy) in flow]
        cs = osctl.consensus_shift(votes, tol=12.0, min_support=0.4)
        if not cs:
            print(f"[{idx}] consensus -> None (no background majority), "
                  f"n={len(flow)}")
            continue
        sdx, sdy = cs["dx"], cs["dy"]
        movers = []
        for (sx, sy, dx, dy) in flow:
            rx, ry = dx - sdx, dy - sdy
            if abs(rx) > 12.0 or abs(ry) > 12.0:        # not explained by shift
                movers.append((sx, sy, dx, dy, rx, ry))
        print(f"[{idx}] background shift=({sdx:+.0f},{sdy:+.0f})px "
              f"support={cs['support']*100:.0f}% n={cs['n']}  "
              f"residual-movers={len(movers)}")
        for (sx, sy, dx, dy, rx, ry) in movers:
            print(f"      @({sx:4d},{sy:4d}) disp=({dx:+4.0f},{dy:+4.0f}) "
                  f"residual=({rx:+4.0f},{ry:+4.0f})")
        if len(movers) >= 2:
            mxs = [m[4] for m in movers]
            mys = [m[5] for m in movers]
            print(f"      mover residual median=({statistics.median(mxs):+.0f},"
                  f"{statistics.median(mys):+.0f})  "
                  f"x-spread=[{min(m[0] for m in movers)},"
                  f"{max(m[0] for m in movers)}]")


if __name__ == "__main__":
    main()
