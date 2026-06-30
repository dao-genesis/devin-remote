"""F267c — decisive test: is lost mouse-look motion a PER-STEP dead zone?

move_rel(dx, steps) emits `steps` equal increments summing to dx (F261: this made
big turns driftless and exactly summed). Hypothesis: the relative-motion consumer
(here the FPS) drops increments below a minimum effective delta, so the SAME total
yaw vanishes when split into many tiny steps but registers when split coarsely.

Hold the TOTAL yaw fixed and vary only the step count. If the produced image shift
collapses as steps rise (per-step delta shrinks), the dead zone is per-step and
move_rel's fine sub-stepping silently swallows motion. If shift is constant
regardless of steps, there is no per-step floor and the earlier zero was something
else.
"""
import sys
import time
sys.path.insert(0, ".")
import osctl

VX, VY, VW, VH = 350, 300, 720, 430
F = 3
TOTAL = 48


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


def dominant_dx(A, B, sw, sh):
    a, qw, qh = downs(A, sw, sh)
    b, _, _ = downs(B, sw, sh)
    dxs = []
    for by in range(0, qh - 12, 14):
        for bx in range(0, qw - 12, 14):
            pt, pw, ph = osctl.crop_rgb(a, (qw, qh), (bx, by, bx + 11, by + 11))
            if lvar(pt, pw, ph) < 60:
                continue
            s = (0, max(0, by - 6), qw - 1, min(qh - 1, by + 17))
            m = osctl.match_unique(pt, pw, ph, rgb=b, size=(qw, qh), search=s)
            if not m:
                continue
            dxs.append((m["x"] - (bx + pw // 2)) * F)
    if not dxs:
        return None
    dxs.sort()
    return dxs[len(dxs) // 2]


def main():
    osctl.focus_window("ioquake3")
    time.sleep(0.4)
    osctl.click(VX + VW // 2, VY + VH // 2)
    time.sleep(0.3)
    print(f"TOTAL yaw fixed at {TOTAL} counts; vary step count:")
    for steps in (1, 2, 4, 8, 16):
        per = TOTAL / steps
        A, sw, sh = grab()
        osctl.move_rel(TOTAL, 0, steps=steps, delay=0.004)
        time.sleep(0.12)
        B, _, _ = grab()
        osctl.move_rel(-TOTAL, 0, steps=steps, delay=0.004)
        time.sleep(0.22)
        dx = dominant_dx(A, B, sw, sh)
        med = abs(dx) if dx is not None else -1
        print(f"  steps={steps:2d} ({per:4.1f}/step): |dx|~{med:3d}px")


if __name__ == "__main__":
    main()
