"""F265 friction probe — does a side-scroller's camera pan produce a *uniform*
translational flow (one global shift), unlike FPS yaw's scattered rotational
flow (rejected in F264's _probe)?

Measures per-block displacement between two frames separated by a short camera
pan in SuperTux, on a 4x-downsampled luma frame (keeps the floor pure-Python).
Reports the agreement among blocks: tight agreement => a single global shift is
the right model (estimate_shift earns its place); scatter => it does not.
"""
import os
import subprocess
import time
import statistics

import osctl

WID = os.environ.get("STX_WID", "0x0380000e")
REGION = (0, 29, 1024, 768)   # game canvas in real screen coords (x, y, w, h)
FACTOR = 4                    # downsample for pure-Python speed
BS = 16                       # block size in downsampled px
MAXDX = 40                    # search half-window x (downsampled px)
MAXDY = 6                     # search half-window y
MIN_VAR = 60                  # skip near-smooth blocks (sky gradient)


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


def grab_q(factor=FACTOR):
    rgb, sw, sh = grab_raw()
    return downsample(rgb, sw, sh, factor)


def block_flow_xy(A, B, qw, qh):
    """Like block_flow but keeps each trusted block's screen y (for depth
    splitting) — returns list of (by, dx, dy)."""
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
            out.append((by, (m["x"] - ocx) * FACTOR, (m["y"] - ocy) * FACTOR))
    return out


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


def block_flow(A, B, qw, qh, gated=True):
    res = []
    textured = refused = 0
    for by in range(0, qh - BS, BS):
        for bx in range(0, qw - BS, BS):
            patch, pw, ph = osctl.crop_rgb(A, (qw, qh),
                                           (bx, by, bx + BS - 1, by + BS - 1))
            if luma_var(patch, pw, ph) < MIN_VAR:
                continue
            textured += 1
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
                refused += 1
                continue
            ocx, ocy = bx + pw // 2, by + ph // 2
            res.append((m["x"] - ocx, m["y"] - ocy, m["score"]))
    return res, textured, refused


def summarise(tag, packed):
    flows, textured, refused = packed
    if not flows:
        print(f"[{tag}] textured={textured} refused={refused} -> "
              f"no trusted block (gate refused all)")
        return
    dxs = [f[0] * FACTOR for f in flows]
    dys = [f[1] * FACTOR for f in flows]
    mdx, mdy = statistics.median(dxs), statistics.median(dys)
    tol = FACTOR  # within one downsampled px of the median
    agree = sum(1 for dx, dy in zip(dxs, dys)
                if abs(dx - mdx) <= tol and abs(dy - mdy) <= tol)
    print(f"[{tag}] textured={textured} refused={refused} trusted={len(flows)}  "
          f"median=({mdx:+.0f},{mdy:+.0f})px  "
          f"dx=[{min(dxs)},{max(dxs)}] dy=[{min(dys)},{max(dys)}]  "
          f"agreement={agree}/{len(flows)} ({100*agree/len(flows):.0f}%)")


def main():
    print("F265 probe: camera-pan flow in SuperTux side-scroller")
    print("Hypothesis: a side-scroller pan is a single global translation that "
          "estimate_shift can recover -- IF periodic-tile aliasing is gated out.")

    # Standing-still control first (truth: zero shift everywhere).
    A, qw, qh = grab_q()
    time.sleep(0.13)
    B, _, _ = grab_q()
    print("-- standing still (truth: zero shift) --")
    summarise("still/ungated", block_flow(A, B, qw, qh, gated=False))
    summarise("still/gated", block_flow(A, B, qw, qh, gated=True))

    # Sustained run, then capture two frames BACK-TO-BACK (dt = capture time
    # only) at the moment the camera is panning. Split the gated flow by screen
    # depth: top third (sky / parallax background) vs bottom third (foreground
    # ice). If a single global shift held, both depths share one dx. If parallax
    # layers move at different rates, the depths disagree -> flow is multi-modal
    # and no single shift exists (the F265 negative result).
    print("-- panning: dt sweep (capture all pairs first, then analyse) --")
    key("keydown", "Right")
    time.sleep(0.70)               # Tux crosses scroll threshold; camera panning
    pairs = []
    for sdt in (0.0, 0.05, 0.10, 0.16):
        t0 = time.time()
        a = grab_raw()
        if sdt:
            time.sleep(sdt)
        b = grab_raw()
        pairs.append((time.time() - t0, a, b))
    key("keyup", "Right")
    for dt, rawA, rawB in pairs:
        A, _, _ = downsample(*rawA)
        B, _, _ = downsample(*rawB)
        flow = block_flow_xy(A, B, qw, qh)
        if not flow:
            print(f"  dt={dt*1000:.0f}ms  no trusted block")
            continue
        allx = [dx for (by, dx, dy) in flow]
        med = statistics.median(allx)
        agree = sum(1 for dx in allx if abs(dx - med) <= FACTOR)
        bins = {}
        for dx in allx:
            bb = int(round(dx / 16.0)) * 16
            bins[bb] = bins.get(bb, 0) + 1
        hist = "  ".join(f"{b:+}:{n}" for b, n in sorted(bins.items()))
        print(f"  dt={dt*1000:3.0f}ms  trusted={len(allx):2d}  "
              f"median={med:+4.0f}px  agree={agree}/{len(allx)} "
              f"({100*agree/len(allx):3.0f}%)  hist[{hist}]")


if __name__ == "__main__":
    main()
