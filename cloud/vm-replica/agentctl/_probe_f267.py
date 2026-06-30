"""F267 — is an FPS yaw a CONTINUUM of motions or DISCRETE modes?

consensus_shift (F265) fits ONE global translation and refuses when no single
shift dominates; F264 already showed FPS yaw is not a global shift but a
depth-graded flow (near walls slide far, the distant end barely moves). The open
question for a multi-motion primitive: does that flow field cluster into a few
DISCRETE coherent modes (which a layer/segmentation primitive could recover), or
is it a SMOOTH continuum (for which discrete modes are the wrong model)?

This probe yaws the OpenArena view by a fixed delta, lays a seed grid over the
central viewport, finds each seed's displacement with match_unique, and reports
dx as a function of screen position plus a dx histogram. A smooth ramp of dx with
screen-x/seed-depth => continuum (no discrete primitive warranted). Tight
clusters separated by gaps => discrete modes (primitive may be warranted).
"""
import sys
import time
sys.path.insert(0, ".")
import osctl

# central viewport, clear of HUD (bottom) and the gun (lower-right)
VX, VY, VW, VH = 350, 300, 720, 430
F = 3                      # downsample factor for speed
MIN_VAR = 45.0
YAW = 70                   # move_rel counts; ~63px shift, unclamped in a +-90 window


def grab():
    _w, _h, rgb = osctl.capture_rgb(VX, VY, VW, VH)
    return bytes(rgb), VW, VH


def downs(rgb, sw, sh, f=F):
    qw, qh = sw // f, sh // f
    out = bytearray(qw * qh * 3)
    st = sw * 3
    for j in range(qh):
        r = (j * f) * st
        for i in range(qw):
            p = r + (i * f) * 3
            o = (j * qw + i) * 3
            out[o], out[o + 1], out[o + 2] = rgb[p], rgb[p + 1], rgb[p + 2]
    return bytes(out), qw, qh


def lvar(patch, pw, ph):
    n = pw * ph
    s = s2 = 0
    for i in range(n):
        l = (patch[i * 3] * 299 + patch[i * 3 + 1] * 587 + patch[i * 3 + 2] * 114) // 1000
        s += l
        s2 += l * l
    return s2 / n - (s / n) ** 2


def votes(A, B, sw, sh):
    a, qw, qh = downs(A, sw, sh)
    b, _, _ = downs(B, sw, sh)
    out = []
    for by in range(0, qh - 12, 6):
        for bx in range(0, qw - 12, 6):
            pt, pw, ph = osctl.crop_rgb(a, (qw, qh), (bx, by, bx + 11, by + 11))
            if lvar(pt, pw, ph) < MIN_VAR:
                continue
            s = (max(0, bx - 30), max(0, by - 8), min(qw - 1, bx + 30), min(qh - 1, by + 19))
            m = osctl.match_unique(pt, pw, ph, rgb=b, size=(qw, qh), search=s)
            if not m:
                continue
            dx = (m["x"] - (bx + pw // 2)) * F
            dy = (m["y"] - (by + ph // 2)) * F
            # native screen coords of the seed centre
            out.append((bx * F + 18, by * F + 18, dx, dy))
    return out


def hist(vals, lo, hi, step):
    from collections import Counter
    c = Counter(int(round(v / step)) * step for v in vals)
    return " ".join(f"{k}:{c[k]}" for k in sorted(c))


def main():
    osctl.focus_window("ioquake3")
    time.sleep(0.4)
    osctl.click(VX + VW // 2, VY + VH // 2)
    time.sleep(0.3)
    for trial in range(3):
        A, sw, sh = grab()
        osctl.move_rel(YAW, 0, steps=14, delay=0.003)
        time.sleep(0.10)
        B, _, _ = grab()
        osctl.move_rel(-YAW, 0, steps=14, delay=0.003)   # undo, keep view put
        time.sleep(0.25)
        v = votes(A, B, sw, sh)
        if len(v) < 10:
            print(f"[trial {trial}] only {len(v)} votes (view may be static)")
            continue
        cs = osctl.consensus_shift([(d[2], d[3]) for d in v], tol=4.0, min_support=0.3)
        allx = [d[2] for d in v]
        print(f"\n[trial {trial}] {len(v)} seeds; consensus_shift -> "
              + (f"dx={cs['dx']:+.1f} support={cs['support']*100:.0f}%" if cs else "None (no single mode)"))
        print(f"   dx histogram (bin 6px): {hist(allx, -90, 24, 6)}")
        # dx vs screen-Y (near floor at bottom vs distant centre): a PURE yaw is
        # camera rotation, whose optical flow is depth-INDEPENDENT -> uniform dx.
        # A depth ramp would instead mean translation parallax (walking), not yaw.
        for lo in range(0, VH, VH // 4):
            hi = lo + VH // 4
            row = [d[2] for d in v if lo <= d[1] < hi]
            if row:
                row.sort()
                print(f"   screen-y [{lo:3d}..{hi:3d}]: n={len(row):3d} "
                      f"median dx={row[len(row)//2]:+.0f}  IQR[{row[len(row)//4]:+.0f},{row[3*len(row)//4]:+.0f}]")


if __name__ == "__main__":
    main()
