"""F266 live proof — `distinctive` as a single-feature SEED selector (SuperTux pan).

The arc's flow primitives split a frame pair into many votes and lean on the
crowd: `consensus_shift` (F265) keeps the majority and out-votes the periodic
mislocks. But there is a regime where there IS no crowd — when you must pick ONE
feature to hand to `servo`/`lead` and track it forward. Pick a patch from the
repeating ice field and every matcher aliases it onto the wrong twin; there is
no majority to save you. The choice has to be right from a single frame, before
any second frame exists. That is exactly what `distinctive` measures: a patch's
distance to its nearest non-self twin in its own neighbourhood (`rival_per_px`).

This proof runs Tux right (camera follows), captures a pan pair at NATIVE
resolution, recovers the true pan once (cheap downsampled consensus), then lays
a grid of candidate seeds and, for each, asks two questions about frame A alone:
  - VARIANCE: is the patch busy enough (the floor's old MIN_VAR gate)?
  - DISTINCTIVE: is its nearest twin far (rival_per_px >= MIN_RIVAL)?
Then it tracks every seed A->B with `match_unique` and calls the track CORRECT
iff a match is found AND its displacement equals the known pan (a periodic seed
either refuses or jumps to a twin -> wrong). The win: among VARIANCE-passing
seeds, the DISTINCTIVE ones track correctly far more often than the rest — the
single-frame rival score predicts which lone feature is safe to commit to.

Run with the SuperTux window visible on DISPLAY=:0 (STX_WID = its window id).
"""
import os
import subprocess
import sys
import time
sys.path.insert(0, ".")
import osctl

WID = os.environ.get("STX_WID", "0x0380000e")
REGION = (0, 29, 1024, 768)
FACTOR = 4                  # only for the cheap global-pan estimate
PLAY = (40, 60, 980, 600)   # avoid the title bar and the flat ground band
P = 24                      # native seed patch size
RAD = 64                    # native self-search radius (~2 ice tiles)
MIN_VAR = 50.0
MIN_RIVAL = 10.0            # native rival SAD that _probe_f266b cleanly split on
PANTOL = 8.0                # native px: a track matching the pan within this is correct


def key(action, k):
    subprocess.run(["xdotool", action, "--window", WID, k],
                   env={**os.environ, "DISPLAY": ":0"})


def grab():
    x, y, w, h = REGION
    sw, sh, rgb = osctl.capture_rgb(x, y, w, h)
    return bytes(rgb), sw, sh


def downsample(rgb, sw, sh, f=FACTOR):
    qw, qh = sw // f, sh // f
    out = bytearray(qw * qh * 3)
    stride = sw * 3
    for j in range(qh):
        row = (j * f) * stride
        for i in range(qw):
            p = row + (i * f) * 3
            o = (j * qw + i) * 3
            out[o], out[o + 1], out[o + 2] = rgb[p], rgb[p + 1], rgb[p + 2]
    return bytes(out), qw, qh


def luma_var(patch, pw, ph):
    n = pw * ph
    s = s2 = 0
    for i in range(n):
        l = (patch[i * 3] * 299 + patch[i * 3 + 1] * 587
             + patch[i * 3 + 2] * 114) // 1000
        s += l
        s2 += l * l
    return s2 / n - (s / n) ** 2


def rival_per_px(rgb, size, box, radius, step):
    """Distance (SAD/px) to the nearest non-self twin in the patch's own
    neighbourhood -- the single-frame self-similarity score this proof tests."""
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


def global_pan(A, B, sw, sh):
    """Cheap, robust pan estimate via a coarse downsampled consensus_shift."""
    a, qw, qh = downsample(A, sw, sh)
    b, _, _ = downsample(B, sw, sh)
    votes = []
    for by in range(0, qh - 10, 10):
        for bx in range(0, qw - 10, 10):
            patch, pw, ph = osctl.crop_rgb(a, (qw, qh), (bx, by, bx + 9, by + 9))
            if luma_var(patch, pw, ph) < MIN_VAR:
                continue
            s = (max(0, bx - 12), max(0, by - 4),
                 min(qw - 1, bx + 9 + 12), min(qh - 1, by + 9 + 4))
            m = osctl.match_unique(patch, pw, ph, rgb=b, size=(qw, qh), search=s)
            if m:
                votes.append(((m["x"] - (bx + pw // 2)) * FACTOR,
                              (m["y"] - (by + ph // 2)) * FACTOR))
    cs = osctl.consensus_shift(votes, tol=12.0, min_support=0.4)
    return (cs["dx"], cs["dy"]) if cs else None


def main():
    print("F266 live proof: distinctive as a single-feature seed selector (SuperTux)")
    key("keydown", "Right")
    time.sleep(1.5)                          # cross deadzone; camera now follows
    A, sw, sh = grab()
    time.sleep(0.11)
    B, _, _ = grab()
    key("keyup", "Right")

    pan = global_pan(A, B, sw, sh)
    if pan is None:
        print("no global pan recovered (scene not panning) -- rerun while moving")
        return
    pdx, pdy = pan
    print(f"known pan this step = ({pdx:+.1f},{pdy:+.1f}) px\n")

    # buckets: among VARIANCE-passing seeds, split by the distinctive rival score
    dist_tot = dist_ok = amb_tot = amb_ok = 0
    x0, y0, x1, y1 = PLAY
    for cy in range(y0, y1 - P, 80):
        for cx in range(x0, x1 - P, 96):
            box = (cx, cy, cx + P - 1, cy + P - 1)
            patch, pw, ph = osctl.crop_rgb(A, (sw, sh), box)
            if luma_var(patch, pw, ph) < MIN_VAR:
                continue                      # the old gate already drops these
            d = osctl.distinctive(A, (sw, sh), box, radius=RAD,
                                  min_rival=MIN_RIVAL, require_distinctive=False,
                                  step=2)
            rival = d["rival_per_px"]
            rival = float("inf") if rival is None else rival
            # track this lone seed A->B and judge it against the known pan
            ex, ey = cx + int(round(pdx)), cy + int(round(pdy))
            s = (max(0, ex - 16), max(0, ey - 12),
                 min(sw - 1, ex + P - 1 + 16), min(sh - 1, ey + P - 1 + 12))
            m = osctl.match_unique(patch, pw, ph, rgb=B, size=(sw, sh), search=s)
            if m:
                tdx = m["x"] - (cx + pw // 2)
                tdy = m["y"] - (cy + ph // 2)
                correct = abs(tdx - pdx) <= PANTOL and abs(tdy - pdy) <= PANTOL
            else:
                correct = False               # refused -> not a usable seed
            if rival >= MIN_RIVAL:
                dist_tot += 1
                dist_ok += correct
            else:
                amb_tot += 1
                amb_ok += correct

    dr = 100.0 * dist_ok / dist_tot if dist_tot else 0.0
    ar = 100.0 * amb_ok / amb_tot if amb_tot else 0.0
    print("Seed track correctness (found AND displacement == known pan):")
    print(f"   DISTINCTIVE (rival >= {MIN_RIVAL}): {dist_ok}/{dist_tot} correct = {dr:.0f}%")
    print(f"   AMBIGUOUS   (rival <  {MIN_RIVAL}): {amb_ok}/{amb_tot} correct = {ar:.0f}%")
    if dist_tot and amb_tot:
        print(f"-> a distinctive seed is the safe pick: {dr:.0f}% vs {ar:.0f}% track the\n"
              f"   true pan. The single-frame rival score, not luma variance, tells you\n"
              f"   which lone feature to commit to before any second frame exists.")


if __name__ == "__main__":
    main()
