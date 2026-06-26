"""Round-36 diagnostic: sweep STATIC-OVERLAY occlusion fraction on synthetic pan/rotation/zoom and watch
the honest 3-way class, falsifiably, against a PRE-REGISTERED verdict.

PRE-REGISTERED HYPOTHESIS (written BEFORE running): graceful degradation. Occluded blocks have ~zero motion
weight (base = SSD-at-zero-shift ~0), so the locked classifier's weighting should down-weight them and the
class should survive partial occlusion; if anything breaks first it should be the structure-keyed classes
(rotation/zoom) as their anchor surround is starved.

This file just sweeps and prints; it makes NO assertion. The unit lock (test_occlusion.py) freezes whatever
this MEASURES. vmodel/flow_roi/motion_class untouched; occlusion via occlusion.occlude_rect (a faithful
static-overlay model: a rectangle frozen to frame[0], i.e. exactly-zero inter-frame delta)."""
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
    gens = {
        'pan': [make_translation(k) for k in range(FRAMES)],
        'rotation': [make_rotation(k) for k in range(FRAMES)],
        'zoom': [make_zoom(k) for k in range(FRAMES)],
    }
    geoms = [
        ('corner-tl', lambda f: O.rect_corner(COLS, ROWS, f, 'tl')),
        ('center', lambda f: O.rect_center(COLS, ROWS, f)),
    ]
    fracs = [0.0, 0.125, 0.25, 0.375, 0.5, 0.625]

    print("PRE-REGISTERED: graceful degradation; structure-keyed (rotation/zoom) expected to break first.\n")
    for gname, gfn in geoms:
        print("=== occluder geometry: %s ===" % gname)
        print("  frac   gesture    plain_cls coh    | robust_cls coh")
        for frac in fracs:
            for n, fr in gens.items():
                i0, j0, i1, j1 = gfn(frac)
                occ = O.occlude_rect(fr, COLS, ROWS, i0, j0, i1, j1)
                cp = M.classify(occ, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
                cr = OS.classify_occ(occ, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
                pf = "" if cp['cls'] == n else " FLIP"
                rf = "" if cr['cls'] == n else " FLIP"
                print("  %.3f  %-9s  %-9s %.3f%-5s| %-9s %.3f%s"
                      % (frac, n, cp['cls'], cp['coherence'], pf, cr['cls'], cr['coherence'], rf))
            print("")
    return 0


if __name__ == '__main__':
    sys.exit(run())
