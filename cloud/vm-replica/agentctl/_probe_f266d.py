"""F266d — what ACTUALLY predicts live seed trackability? (structure tensor)

F266c killed the self-similarity hypothesis: the single-frame rival score has no
monotonic tie to whether a seed tracks the pan. The classic optical-flow answer
is the APERTURE PROBLEM: the camera pans horizontally, so a patch can only be
localised in x if it has gradient structure in x. A long horizontal ledge (lots
of luma variance from its vertical edge) slides freely left/right and tracks to
the wrong column; a corner is pinned in both axes.

This probe measures, per variance-passing seed:
  Sxx  = sum of horizontal-gradient^2  (localisability along the PAN axis)
  lmin = min eigenvalue of the 2x2 structure tensor (Shi-Tomasi cornerness)
and correlates each with track correctness (match_unique displacement == pan).
If Sxx / lmin separates the trackable seeds where variance and rival did not,
that is the real F266 gate.
"""
import os
import subprocess
import sys
import time
sys.path.insert(0, ".")
import osctl

WID = os.environ.get("STX_WID", "0x0380000e")
REGION = (0, 29, 1024, 768)
FACTOR = 4
PLAY = (40, 60, 980, 600)
P = 24
MIN_VAR = 50.0
PANTOL = 8.0
PAIRS = 4


def key(a, k):
    subprocess.run(["xdotool", a, "--window", WID, k],
                   env={**os.environ, "DISPLAY": ":0"})


def grab():
    x, y, w, h = REGION
    sw, sh, rgb = osctl.capture_rgb(x, y, w, h)
    return bytes(rgb), sw, sh


def downs(rgb, sw, sh, f=FACTOR):
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


def luma_patch(patch, pw, ph):
    return [[(patch[(j * pw + i) * 3] * 299 + patch[(j * pw + i) * 3 + 1] * 587
              + patch[(j * pw + i) * 3 + 2] * 114) // 1000
             for i in range(pw)] for j in range(ph)]


def lvar_of(L, pw, ph):
    n = pw * ph
    s = sum(L[j][i] for j in range(ph) for i in range(pw))
    s2 = sum(L[j][i] * L[j][i] for j in range(ph) for i in range(pw))
    return s2 / n - (s / n) ** 2


def structure(L, pw, ph):
    sxx = syy = sxy = 0.0
    for j in range(1, ph - 1):
        for i in range(1, pw - 1):
            gx = (L[j][i + 1] - L[j][i - 1]) * 0.5
            gy = (L[j + 1][i] - L[j - 1][i]) * 0.5
            sxx += gx * gx
            syy += gy * gy
            sxy += gx * gy
    tr = sxx + syy
    det = sxx * syy - sxy * sxy
    disc = max(0.0, tr * tr / 4 - det)
    lmin = tr / 2 - disc ** 0.5
    return sxx, lmin


def pan_of(A, B, sw, sh):
    a, qw, qh = downs(A, sw, sh)
    b, _, _ = downs(B, sw, sh)
    v = []
    for by in range(0, qh - 10, 10):
        for bx in range(0, qw - 10, 10):
            pt, pw, ph = osctl.crop_rgb(a, (qw, qh), (bx, by, bx + 9, by + 9))
            L = luma_patch(pt, pw, ph)
            if lvar_of(L, pw, ph) < MIN_VAR:
                continue
            s = (max(0, bx - 12), max(0, by - 4), min(qw - 1, bx + 21), min(qh - 1, by + 13))
            m = osctl.match_unique(pt, pw, ph, rgb=b, size=(qw, qh), search=s)
            if m:
                v.append(((m["x"] - (bx + pw // 2)) * FACTOR, (m["y"] - (by + ph // 2)) * FACTOR))
    cs = osctl.consensus_shift(v, tol=12.0, min_support=0.4)
    return (cs["dx"], cs["dy"]) if cs else None


def report(name, rows):
    rows = sorted(rows, key=lambda t: t[0])
    n = len(rows)
    print(f"\ncorrectness by {name} quartile ({n} seeds):")
    for q in range(4):
        seg = rows[q * n // 4:(q + 1) * n // 4]
        if not seg:
            continue
        c = sum(1 for _, ok in seg if ok)
        print(f"  {name} [{seg[0][0]:8.1f}..{seg[-1][0]:8.1f}]: "
              f"{c}/{len(seg)} = {100*c/len(seg):.0f}%")


def main():
    sxx_rows, lmin_rows = [], []
    for _ in range(PAIRS):
        key("keydown", "Right")
        time.sleep(0.8)
        A, sw, sh = grab()
        time.sleep(0.11)
        B, _, _ = grab()
        key("keyup", "Right")
        time.sleep(0.2)
        pan = pan_of(A, B, sw, sh)
        if not pan:
            continue
        pdx, pdy = pan
        x0, y0, x1, y1 = PLAY
        for cy in range(y0, y1 - P, 64):
            for cx in range(x0, x1 - P, 80):
                box = (cx, cy, cx + P - 1, cy + P - 1)
                patch, pw, ph = osctl.crop_rgb(A, (sw, sh), box)
                L = luma_patch(patch, pw, ph)
                if lvar_of(L, pw, ph) < MIN_VAR:
                    continue
                sxx, lmin = structure(L, pw, ph)
                ex, ey = cx + int(round(pdx)), cy + int(round(pdy))
                s = (max(0, ex - 16), max(0, ey - 12),
                     min(sw - 1, ex + P + 15), min(sh - 1, ey + P + 11))
                m = osctl.match_unique(patch, pw, ph, rgb=B, size=(sw, sh), search=s)
                ok = bool(m) and abs(m["x"] - (cx + pw // 2) - pdx) <= PANTOL \
                    and abs(m["y"] - (cy + ph // 2) - pdy) <= PANTOL
                sxx_rows.append((sxx, ok))
                lmin_rows.append((lmin, ok))
    overall = sum(1 for _, ok in sxx_rows if ok)
    print(f"overall track correctness: {overall}/{len(sxx_rows)} = "
          f"{100*overall/max(len(sxx_rows),1):.0f}%")
    report("Sxx (x-gradient energy)", sxx_rows)
    report("lmin (Shi-Tomasi)", lmin_rows)


if __name__ == "__main__":
    main()
