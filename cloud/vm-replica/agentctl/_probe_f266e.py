"""F266e — is trackability per-SEED or per-FRAME-PAIR?

F266c found ~59% track correctness but the failures clustered in pair-sized
blocks; F266d caught only clean pairs and got 100% everywhere. Hypothesis: a
whole frame pair tracks or fails TOGETHER — failure is a global-motion-validity
problem (the pair is not a clean rigid translation, or the pan estimate is off),
not a per-seed quality problem. If so, the consensus_shift SUPPORT fraction (how
many seeds agree on one shift) should predict the pair's track-correctness, and
no per-seed gate (variance, rival, cornerness) is the right tool.

Prints, per pair: consensus support, recovered pan, and the fraction of
variance-passing seeds that track that pan.
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
PAIRS = 8


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
    return cs, len(v)


def main():
    print("per-pair: support | pan | seed-track-correctness")
    for idx in range(PAIRS):
        key("keydown", "Right")
        time.sleep(0.7)
        A, sw, sh = grab()
        time.sleep(0.11)
        B, _, _ = grab()
        key("keyup", "Right")
        time.sleep(0.25)
        cs, nv = pan_of(A, B, sw, sh)
        if not cs:
            print(f"[pair {idx}] no consensus pan (support<40%); votes={nv}")
            continue
        pdx, pdy = cs["dx"], cs["dy"]
        tot = ok = 0
        x0, y0, x1, y1 = PLAY
        for cy in range(y0, y1 - P, 64):
            for cx in range(x0, x1 - P, 80):
                box = (cx, cy, cx + P - 1, cy + P - 1)
                patch, pw, ph = osctl.crop_rgb(A, (sw, sh), box)
                if lvar(patch, pw, ph) < MIN_VAR:
                    continue
                ex, ey = cx + int(round(pdx)), cy + int(round(pdy))
                s = (max(0, ex - 16), max(0, ey - 12),
                     min(sw - 1, ex + P + 15), min(sh - 1, ey + P + 11))
                m = osctl.match_unique(patch, pw, ph, rgb=B, size=(sw, sh), search=s)
                tot += 1
                if m and abs(m["x"] - (cx + pw // 2) - pdx) <= PANTOL \
                        and abs(m["y"] - (cy + ph // 2) - pdy) <= PANTOL:
                    ok += 1
        rate = 100.0 * ok / tot if tot else 0.0
        print(f"[pair {idx}] support={cs['support']*100:3.0f}%  "
              f"pan=({pdx:+5.1f},{pdy:+4.1f})  seeds {ok:2d}/{tot:2d} track = {rate:3.0f}%")


if __name__ == "__main__":
    main()
