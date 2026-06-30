"""F267b — is the FPS mouse-look gain LINEAR or ACCELERATED?

servo (F262) probes the per-count pixel gain ONCE with a small move and then
drives the error to zero assuming that gain is locally constant. If the game
applies mouse acceleration, the pixels-moved-per-count rises with the speed/size
of the motion, so a small probe reports a tiny gain and the controller massively
under-shoots a large correction (and a large probe over-shoots a small one).

This probe sweeps a series of yaw magnitudes, and for each measures the dominant
image shift it actually produced (downsampled consensus_shift), undoing each yaw
so the view stays put. If shift/count is flat => linear (servo's assumption
holds). If shift/count climbs with magnitude => acceleration (servo's single
probe is the wrong model; gain must be calibrated as a curve).
"""
import sys
import time
sys.path.insert(0, ".")
import osctl

VX, VY, VW, VH = 350, 300, 720, 430
F = 3


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
    """Median dx over the few most-distinctive seeds (robust to clamping)."""
    a, qw, qh = downs(A, sw, sh)
    b, _, _ = downs(B, sw, sh)
    dxs = []
    for by in range(0, qh - 12, 8):
        for bx in range(0, qw - 12, 8):
            pt, pw, ph = osctl.crop_rgb(a, (qw, qh), (bx, by, bx + 11, by + 11))
            if lvar(pt, pw, ph) < 60:
                continue
            s = (0, max(0, by - 6), qw - 1, min(qh - 1, by + 17))
            m = osctl.match_unique(pt, pw, ph, rgb=b, size=(qw, qh), search=s)
            if not m:
                continue
            dxs.append((m["x"] - (bx + pw // 2)) * F)
    if not dxs:
        return None, 0
    dxs.sort()
    return dxs[len(dxs) // 2], len(dxs)


def main():
    osctl.focus_window("ioquake3")
    time.sleep(0.4)
    osctl.click(VX + VW // 2, VY + VH // 2)
    time.sleep(0.3)
    print("yaw_counts -> median image dx (px) and gain (px/count):")
    for yaw in (10, 20, 40, 80, 160, 320):
        # measure twice and average for stability
        rows = []
        for _ in range(2):
            A, sw, sh = grab()
            osctl.move_rel(yaw, 0, steps=max(4, yaw // 8), delay=0.003)
            time.sleep(0.12)
            B, _, _ = grab()
            osctl.move_rel(-yaw, 0, steps=max(4, yaw // 8), delay=0.003)
            time.sleep(0.22)
            dx, n = dominant_dx(A, B, sw, sh)
            if dx is not None:
                rows.append(abs(dx))
        if not rows:
            print(f"  yaw {yaw:4d}: no seeds")
            continue
        med = sorted(rows)[len(rows) // 2]
        print(f"  yaw {yaw:4d}: |dx|~{med:4d}px   gain={med / yaw:.3f} px/count"
              + ("   (CLAMPED>~{}px)".format(VW // 2) if med >= VW // 2 - 30 else ""))


if __name__ == "__main__":
    main()
