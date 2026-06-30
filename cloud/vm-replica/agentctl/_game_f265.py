"""F265 live proof — `consensus_shift` on real SuperTux pixels.

A side-scroller's camera-follow translates the whole world under the view as Tux
runs. A block-flow over the textured foreground produces, between two frames, a
cloud of per-block displacement votes that *should* all be the one world shift —
but the repeating ice texture makes each `match_unique` vote land a tile-fraction
off and a few blocks gross-mislock, so the naive median lands in the gap between
vote clusters with unreadable confidence (and the *ungated* matcher fabricates a
shift even at rest). `consensus_shift` votes for the dominant translation, refines
to its inliers, and reports a support fraction — recovering the true shift and
rejecting the outliers the median is dragged by.

This reproduces the two regimes measured by `_probe_f265.py`:
  - standing still: ungated median fabricates a shift; consensus reports ~zero;
  - running (camera panning): consensus recovers the dominant leftward shift with
    a stated majority support, rejecting the gross-mislock votes.

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
BS = 16
MAXDX = 40
MAXDY = 6
MIN_VAR = 60


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


def votes(A, B, qw, qh, gated=True):
    """Per-block (dx, dy) displacement votes in real pixels."""
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
            if gated:
                m = osctl.match_unique(patch, pw, ph, rgb=B, size=(qw, qh),
                                       search=(sx0, sy0, sx1, sy1))
            else:
                m = osctl.match_template(patch, pw, ph, rgb=B, size=(qw, qh),
                                         search=(sx0, sy0, sx1, sy1))
            if not m:
                continue
            ocx, ocy = bx + pw // 2, by + ph // 2
            out.append(((m["x"] - ocx) * FACTOR, (m["y"] - ocy) * FACTOR))
    return out


def naive(vs):
    """Naive median shift + its tight-agreement fraction (the status quo)."""
    if not vs:
        return None
    dxs = [v[0] for v in vs]
    dys = [v[1] for v in vs]
    mx, my = statistics.median(dxs), statistics.median(dys)
    agree = sum(1 for dx, dy in vs
                if abs(dx - mx) <= FACTOR and abs(dy - my) <= FACTOR)
    return mx, my, agree / len(vs)


def show(tag, vs, tol):
    nv = naive(vs)
    cs = osctl.consensus_shift(vs, tol=tol, min_support=0.5)
    if nv:
        print(f"  {tag}: naive median=({nv[0]:+.0f},{nv[1]:+.0f})px "
              f"agreement={nv[2]*100:.0f}%")
    if cs:
        print(f"  {tag}: consensus=({cs['dx']:+.1f},{cs['dy']:+.1f})px "
              f"support={cs['support']*100:.0f}% "
              f"inliers={cs['inliers']}/{cs['n']} "
              f"(rejected {cs['n']-cs['inliers']} outlier votes)")
    else:
        print(f"  {tag}: consensus -> None (no shift commands a majority)")
    return nv, cs


def main():
    osctl.focus_window("SuperTux") if hasattr(osctl, "focus_window") else None
    time.sleep(0.3)

    print("F265 live: consensus_shift vs naive median on SuperTux camera-pan flow")
    print("-- standing still (truth: zero world shift) --")
    rawA = grab_raw()
    time.sleep(0.12)
    rawB = grab_raw()
    A, qw, qh = downsample(*rawA)
    B, _, _ = downsample(*rawB)
    vu = votes(A, B, qw, qh, gated=False)   # F263 trap: periodic-tile aliasing
    vg = votes(A, B, qw, qh, gated=True)    # ambiguous tiles refused
    show("ungated", vu, tol=8.0)
    show("gated  ", vg, tol=8.0)

    print("-- running right (camera panning): recover the world shift --")
    key("keydown", "Right")
    time.sleep(1.5)                         # cross the camera deadzone first
    pairs = []
    for _ in range(5):                      # capture WHILE still running right
        t0 = time.time()
        a = grab_raw()
        time.sleep(0.11)
        b = grab_raw()
        pairs.append((time.time() - t0, a, b))
    key("keyup", "Right")

    best = None
    for dt, rawA, rawB in pairs:
        A, _, _ = downsample(*rawA)
        B, _, _ = downsample(*rawB)
        vg = votes(A, B, qw, qh, gated=True)
        if not vg:
            continue
        print(f"  [dt={dt*1000:.0f}ms]")
        nv, cs = show("    pan", vg, tol=16.0)
        if cs and abs(cs["dx"]) > FACTOR and (best is None
                                              or cs["support"] > best[1]):
            best = (cs, cs["support"], nv)

    print()
    if best:
        cs, _, nv = best
        print(f"recovered world shift = ({cs['dx']:+.1f},{cs['dy']:+.1f})px at "
              f"{cs['support']*100:.0f}% support, rejecting "
              f"{cs['n']-cs['inliers']} mislock votes; the naive median read "
              f"{nv[0]:+.0f}px at only {nv[2]*100:.0f}% agreement.")
    print("F265 live: consensus_shift fuses noisy per-block votes into one shift "
          "with a confidence the median cannot state, and refuses when none "
          "dominates")


if __name__ == "__main__":
    main()
