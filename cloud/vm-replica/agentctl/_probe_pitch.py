"""Measure yaw vs pitch actuation gain in AssaultCube.

Turn by a known move_rel count against the static world, then recover the induced
image translation by 1-D projection cross-correlation (cheap, dense, seed-free):
column-sum signal -> best horizontal shift; row-sum signal -> best vertical shift.
gain = counts / induced_pixels. If pitch gain << yaw gain (or saturates), that is
why the combat loop's vertical aim stalls ~180px high.
"""
import time
import osctl

ROI = (300, 200, 1300, 980)   # central band, away from HUD/weapon/radar


def _gray_cols(rgb, size, roi):
    w, _h = size
    x0, y0, x1, y1 = roi
    cols = [0] * (x1 - x0)
    for y in range(y0, y1, 2):
        base = y * w * 3
        for x in range(x0, x1):
            i = base + x * 3
            cols[x - x0] += rgb[i] + rgb[i + 1] + rgb[i + 2]
    return cols


def _gray_rows(rgb, size, roi):
    w, _h = size
    x0, y0, x1, y1 = roi
    rows = [0] * (y1 - y0)
    for y in range(y0, y1):
        base = y * w * 3
        s = 0
        for x in range(x0, x1, 2):
            i = base + x * 3
            s += rgb[i] + rgb[i + 1] + rgb[i + 2]
        rows[y - y0] = s
    return rows


def _best_shift(a, b, maxs=260):
    """integer shift s (b is a shifted by s) maximizing negative SAD overlap."""
    n = len(a)
    best_s, best = 0, None
    for s in range(-maxs, maxs + 1):
        tot = cnt = 0
        for i in range(n):
            j = i + s
            if 0 <= j < n:
                tot += abs(a[i] - b[j]); cnt += 1
        if cnt < n // 3:
            continue
        err = tot / cnt
        if best is None or err < best:
            best, best_s = err, s
    return best_s


def probe(dx, dy, label):
    w, h, a = osctl.capture_rgb()
    time.sleep(0.15)
    osctl.move_rel(dx, dy, steps=6, delay=0.008)
    time.sleep(0.25)
    w2, h2, b = osctl.capture_rgb()
    size = (w, h)
    if dx:
        sa, sb = _gray_cols(a, size, ROI), _gray_cols(b, size, ROI)
        sh = _best_shift(sa, sb)
        g = dx / sh if sh else float("inf")
        print(f"{label}: move_rel({dx},{dy}) -> horiz img shift {sh}px  gain={g:.3f} counts/px")
    else:
        sa, sb = _gray_rows(a, size, ROI), _gray_rows(b, size, ROI)
        sh = _best_shift(sa, sb)
        g = dy / sh if sh else float("inf")
        print(f"{label}: move_rel({dx},{dy}) -> vert  img shift {sh}px  gain={g:.3f} counts/px")
    return sh


if __name__ == "__main__":
    for _ in range(3):
        probe(300, 0, "YAW+ ")
        probe(-300, 0, "YAW- ")
        probe(0, 200, "PITCHdn")
        probe(0, -200, "PITCHup")
        print("---")
