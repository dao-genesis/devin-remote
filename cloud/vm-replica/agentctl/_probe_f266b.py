"""F266 probe (b) — self-ambiguity / "good feature to track" on real pixels.

Every flow failure in this arc (F263 phantom locks, F265 vote scatter, F266a
residual-mover artifacts) shares one root cause: periodic ice texture. A patch
cut from the middle of a repeating tile field has many near-identical twins, so
ANY matcher that's handed it will lock confidently to the wrong twin. match_unique
(F263) gates a match against the *target* frame's search region; but a patch's
trackability is an intrinsic property of the patch in its OWN neighbourhood,
knowable from a single frame before any second frame exists.

This probe measures, for a grid of textured blocks on one SuperTux frame, the
distance from the patch to the nearest OTHER (non-self) location in a local window
of the same frame -- its "rival" distance. A distinctive corner/edge has a far
rival (one sharp self-match peak); a periodic ice tile has a near rival (twins).
If this cleanly separates ice from features, a `distinctive` gate is warranted.
"""
import os
import sys
import time
sys.path.insert(0, ".")
import osctl

WID = os.environ.get("STX_WID", "0x0380000e")
REGION = (0, 29, 1024, 768)
P = 24            # patch size in real px
RAD = 64          # local self-search radius in real px


def luma_var(patch, pw, ph):
    n = pw * ph
    s = s2 = 0
    for i in range(n):
        l = (patch[i * 3] * 299 + patch[i * 3 + 1] * 587
             + patch[i * 3 + 2] * 114) // 1000
        s += l
        s2 += l * l
    return s2 / n - (s / n) ** 2


def rival_dist(rgb, w, h, cx, cy):
    """SAD to the nearest non-self location within +/-RAD (lower = more
    ambiguous / periodic). Self-peak at (cx,cy) is excluded by blanking a small
    exclusion zone around it in the score search."""
    x0, y0 = cx - P // 2, cy - P // 2
    patch, pw, ph = osctl.crop_rgb(rgb, (w, h), (x0, y0, x0 + P - 1, y0 + P - 1))
    sx0, sy0 = max(0, x0 - RAD), max(0, y0 - RAD)
    sx1, sy1 = min(w - 1, x0 + P - 1 + RAD), min(h - 1, y0 + P - 1 + RAD)
    best = None
    for ty in range(sy0, sy1 - ph + 2, 4):
        for tx in range(sx0, sx1 - pw + 2, 4):
            if abs(tx - x0) < P and abs(ty - y0) < P:   # skip self & overlap
                continue
            s = 0
            for ry in range(0, ph, 2):
                a = ((y0 + ry) * w + x0) * 3
                b = ((ty + ry) * w + tx) * 3
                for k in range(0, pw * 3, 6):
                    d = patch[ry * pw * 3 + k] - rgb[b + k]
                    s += d if d >= 0 else -d
            if best is None or s < best:
                best = s
    return best


def main():
    x, y, w, h = REGION
    w0, h0, rgb = osctl.capture_rgb(x, y, w, h)
    rgb = bytes(rgb)
    print(f"F266b probe: self-ambiguity on a {w0}x{h0} SuperTux frame")
    print("col legend: var=luma variance  rival=SAD to nearest twin (norm/px)")
    rows = []
    for cy in range(P, h0 - P, 80):
        for cx in range(P, w0 - P, 96):
            patch, pw, ph = osctl.crop_rgb(rgb, (w0, h0),
                                           (cx - P // 2, cy - P // 2,
                                            cx + P // 2 - 1, cy + P // 2 - 1))
            v = luma_var(patch, pw, ph)
            if v < 20:
                continue
            rd = rival_dist(rgb, w0, h0, cx, cy)
            if rd is None:
                continue
            norm = rd / ((P // 2) * (pw // 2) * 3)   # per sampled channel
            rows.append((cx, cy, v, norm))
    rows.sort(key=lambda r: r[3])
    print("  most AMBIGUOUS (smallest rival distance) -- periodic/flat:")
    for cx, cy, v, norm in rows[:8]:
        print(f"    @({cx:4d},{cy:4d}) var={v:6.0f} rival={norm:5.1f}")
    print("  most DISTINCTIVE (largest rival distance) -- corners/edges:")
    for cx, cy, v, norm in rows[-8:]:
        print(f"    @({cx:4d},{cy:4d}) var={v:6.0f} rival={norm:5.1f}")


if __name__ == "__main__":
    main()
