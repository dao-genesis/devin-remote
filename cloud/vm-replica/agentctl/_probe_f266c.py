"""F266c — does the single-frame rival score predict live seed trackability AT ALL?

Dump (rival_per_px, correct) for every variance-passing seed across several pan
pairs, then bucket by rival decile. If correctness is flat across rival, the
distinctive gate is dead (match_unique's cross-frame margin already does the job
and self-similarity adds nothing). If high-rival seeds are reliably correct and
low-rival ones are not, there is signal at some threshold.
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
RAD = 64
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


def lvar(patch, pw, ph):
    n = pw * ph
    s = s2 = 0
    for i in range(n):
        l = (patch[i * 3] * 299 + patch[i * 3 + 1] * 587 + patch[i * 3 + 2] * 114) // 1000
        s += l
        s2 += l * l
    return s2 / n - (s / n) ** 2


def rival_per_px(rgb, size, box, radius, step):
    """Distance (SAD/px) to the nearest non-self twin of a patch in its own
    neighbourhood -- the single-frame self-similarity score this probe refutes."""
    w, h = size
    patch, pw, ph = osctl.crop_rgb(rgb, size, box)
    bx0, by0 = box[0], box[1]
    s = (max(0, bx0 - radius), max(0, by0 - radius),
         min(w - 1, bx0 + pw - 1 + radius), min(h - 1, by0 + ph - 1 + radius))
    hits = osctl.match_template_all(patch, pw, ph, rgb=rgb, size=size, search=s,
                                    step=step, max_score=255 * pw * ph,
                                    min_sep=(pw, ph), limit=8)
    cx, cy = bx0 + pw // 2, by0 + ph // 2
    for ht in hits:
        if abs(ht["x"] - cx) < pw and abs(ht["y"] - cy) < ph:
            continue
        return ht["score"] / (pw * ph)
    return None


def pan_of(A, B, sw, sh):
    a, qw, qh = downs(A, sw, sh)
    b, _, _ = downs(B, sw, sh)
    v = []
    for by in range(0, qh - 10, 10):
        for bx in range(0, qw - 10, 10):
            pt, pw, ph = osctl.crop_rgb(a, (qw, qh), (bx, by, bx + 9, by + 9))
            if lvar(pt, pw, ph) < MIN_VAR:
                continue
            s = (max(0, bx - 12), max(0, by - 4), min(qw - 1, bx + 21), min(qh - 1, by + 13))
            m = osctl.match_unique(pt, pw, ph, rgb=b, size=(qw, qh), search=s)
            if m:
                v.append(((m["x"] - (bx + pw // 2)) * FACTOR, (m["y"] - (by + ph // 2)) * FACTOR))
    cs = osctl.consensus_shift(v, tol=12.0, min_support=0.4)
    return (cs["dx"], cs["dy"]) if cs else None


def main():
    rows = []
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
                if lvar(patch, pw, ph) < MIN_VAR:
                    continue
                r = rival_per_px(A, (sw, sh), box, RAD, 1)
                r = 99.0 if r is None else r
                ex, ey = cx + int(round(pdx)), cy + int(round(pdy))
                s = (max(0, ex - 16), max(0, ey - 12),
                     min(sw - 1, ex + P + 15), min(sh - 1, ey + P + 11))
                m = osctl.match_unique(patch, pw, ph, rgb=B, size=(sw, sh), search=s)
                ok = bool(m) and abs(m["x"] - (cx + pw // 2) - pdx) <= PANTOL \
                    and abs(m["y"] - (cy + ph // 2) - pdy) <= PANTOL
                rows.append((r, ok))
    rows.sort()
    n = len(rows)
    print(f"{n} seeds across pairs; correctness by rival quartile:")
    for q in range(4):
        seg = rows[q * n // 4:(q + 1) * n // 4]
        if not seg:
            continue
        lo, hi = seg[0][0], seg[-1][0]
        c = sum(1 for _, ok in seg if ok)
        print(f"  rival [{lo:5.1f}..{hi:5.1f}]: {c}/{len(seg)} correct = {100*c/len(seg):.0f}%")
    overall = sum(1 for _, ok in rows if ok)
    print(f"  overall: {overall}/{n} = {100*overall/max(n,1):.0f}%")


if __name__ == "__main__":
    main()
