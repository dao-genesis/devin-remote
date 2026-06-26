"""Round-36 unit lock: STATIC-OVERLAY (occlusion / partial-field) robustness of the honest 3-way class.

Freezes the MEASURED truth from _diag_occlusion.py so any future drift is caught:

  A. occlusion model is faithful & non-destructive -- occlude_rect freezes a rectangle to frame[0] (exactly
     zero inter-frame delta), leaves every other cell untouched, and does not mutate its input.
  B. ASYMMETRIC robustness (the measured, hypothesis-overturning finding): the structure-keyed classes
     rotation & zoom are HIGHLY occlusion-robust (keep their class at 50% corner occlusion), while PAN -- the
     coherence-keyed class -- is the FRAGILE one: a static island defeats the single GLOBAL shift, so plain
     classify() flips pan away from 'pan' by ~37.5% corner occlusion.
  C. the principled fix RESTORES pan: classify_occ (stage-1 coherence over MOVING cells only) keeps pan='pan'
     through 50% corner AND 50% centre occlusion, WITHOUT manufacturing coherence for genuinely incoherent
     motion (rotation stays 'rotation', zoom stays 'zoom').
  D. clean-frame PARITY: with no occlusion the robust path is behaviourally identical to the locked one
     (pan coherent, rotation/zoom incoherent), so the fix is inert when there is nothing static to mask.

vmodel.py / flow_roi.py / motion_class.py are byte-for-byte untouched; this only exercises the additive
occlusion.py + occ_signature.py over the locked stack.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import motion_class as M
import occ_signature as OS
import occlusion as O

COLS = ROWS = 48
FRAMES = 7
SEARCH = 4
BLOCKS = 12


def _texture(x, y):
    return (128.0 + 55.0 * math.sin(x * 0.35) + 55.0 * math.sin(y * 0.45)
            + 35.0 * math.sin((x + y) * 0.22) + 25.0 * math.cos((x - y) * 0.30))


def _sample(m):
    g = [0.0] * (COLS * ROWS)
    for j in range(ROWS):
        for i in range(COLS):
            sx, sy = m(i, j)
            g[j * COLS + i] = _texture(sx, sy)
    return g


def make_translation(k, sx=1.0, sy=0.0):
    return _sample(lambda i, j: (i - k * sx, j - k * sy))


def make_rotation(k, theta=0.05):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0
    a = -k * theta; ca, sa = math.cos(a), math.sin(a)
    return _sample(lambda i, j: (cx + ca * (i - cx) - sa * (j - cy), cy + sa * (i - cx) + ca * (j - cy)))


def make_zoom(k, s=1.05):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0; f = s ** k
    return _sample(lambda i, j: (cx + (i - cx) / f, cy + (j - cy) / f))


def run():
    pan = [make_translation(k) for k in range(FRAMES)]
    rot = [make_rotation(k) for k in range(FRAMES)]
    zoom = [make_zoom(k) for k in range(FRAMES)]

    checks = []

    # --- A. faithful, non-destructive occlusion model ---
    i0, j0, i1, j1 = O.rect_corner(COLS, ROWS, 0.25, 'tl')
    src = [list(f) for f in pan]
    occ = O.occlude_rect(pan, COLS, ROWS, i0, j0, i1, j1)
    frozen_zero = True
    for k in range(1, len(occ)):
        for j in range(j0, j1):
            for i in range(i0, i1):
                if abs(occ[k][j * COLS + i] - occ[0][j * COLS + i]) > 1e-9:
                    frozen_zero = False
    checks.append(("occluded region has zero inter-frame delta", frozen_zero))
    outside_intact = all(
        abs(occ[k][j * COLS + i] - pan[k][j * COLS + i]) < 1e-9
        for k in range(len(pan)) for j in range(ROWS) for i in range(COLS)
        if not (i0 <= i < i1 and j0 <= j < j1)
    )
    checks.append(("cells outside the overlay are untouched", outside_intact))
    checks.append(("occlude_rect does not mutate its input", all(pan[k] == src[k] for k in range(len(pan)))))

    # --- D. clean-frame parity (fix inert with nothing static to mask) ---
    cp, cr, cz = (M.classify(f, COLS, ROWS, search=SEARCH, blocks=BLOCKS) for f in (pan, rot, zoom))
    op, orr, oz = (OS.classify_occ(f, COLS, ROWS, search=SEARCH, blocks=BLOCKS) for f in (pan, rot, zoom))
    print("clean   plain pan/rot/zoom = %s/%s/%s   robust = %s/%s/%s"
          % (cp['cls'], cr['cls'], cz['cls'], op['cls'], orr['cls'], oz['cls']))
    checks.append(("clean: plain classifies pan/rotation/zoom correctly",
                   cp['cls'] == 'pan' and cr['cls'] == 'rotation' and cz['cls'] == 'zoom'))
    checks.append(("clean: robust matches plain exactly",
                   op['cls'] == 'pan' and orr['cls'] == 'rotation' and oz['cls'] == 'zoom'))
    checks.append(("clean: robust pan coherence == plain (>= gate)",
                   op['coherence'] >= op['coh_thr'] and abs(op['coherence'] - cp['coherence']) < 1e-3))

    # --- B. asymmetric robustness: rotation/zoom robust, pan fragile (plain) ---
    ci0, cj0, ci1, cj1 = O.rect_corner(COLS, ROWS, 0.5, 'tl')
    rot50 = O.occlude_rect(rot, COLS, ROWS, ci0, cj0, ci1, cj1)
    zoom50 = O.occlude_rect(zoom, COLS, ROWS, ci0, cj0, ci1, cj1)
    checks.append(("plain: rotation robust at 50% corner occlusion",
                   M.classify(rot50, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['cls'] == 'rotation'))
    checks.append(("plain: zoom robust at 50% corner occlusion",
                   M.classify(zoom50, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['cls'] == 'zoom'))
    fi0, fj0, fi1, fj1 = O.rect_corner(COLS, ROWS, 0.375, 'tl')
    pan37 = O.occlude_rect(pan, COLS, ROWS, fi0, fj0, fi1, fj1)
    cpan37 = M.classify(pan37, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    print("pan @37.5%% corner: plain cls=%s coh=%.3f" % (cpan37['cls'], cpan37['coherence']))
    checks.append(("plain: pan is FRAGILE -- flips away from pan by 37.5% corner occlusion",
                   cpan37['cls'] != 'pan'))

    # --- C. principled fix restores pan, without faking coherence for incoherent motion ---
    pan50c = O.occlude_rect(pan, COLS, ROWS, ci0, cj0, ci1, cj1)
    xi0, xj0, xi1, xj1 = O.rect_center(COLS, ROWS, 0.5)
    pan50ctr = O.occlude_rect(pan, COLS, ROWS, xi0, xj0, xi1, xj1)
    rp_c = OS.classify_occ(pan50c, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    rp_ctr = OS.classify_occ(pan50ctr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    print("pan @50%% corner: robust cls=%s coh=%.3f | @50%% center: robust cls=%s coh=%.3f"
          % (rp_c['cls'], rp_c['coherence'], rp_ctr['cls'], rp_ctr['coherence']))
    checks.append(("robust: pan restored to 'pan' at 50% corner occlusion", rp_c['cls'] == 'pan'))
    checks.append(("robust: pan restored to 'pan' at 50% center occlusion", rp_ctr['cls'] == 'pan'))
    checks.append(("robust: rotation stays incoherent (not faked to pan) at 50% corner",
                   OS.classify_occ(rot50, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['cls'] == 'rotation'))
    checks.append(("robust: zoom stays incoherent (not faked to pan) at 50% corner",
                   OS.classify_occ(zoom50, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['cls'] == 'zoom'))

    print("\n=== checks ===")
    ok = True
    for name, c in checks:
        print(("  PASS " if c else "  FAIL ") + name)
        ok = ok and c
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(run())
