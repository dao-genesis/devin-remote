"""Round-37 diagnostic: measure the single-global-model residual r_norm on SINGLE motions vs CONCURRENT
multi-region composites, falsifiably, against a PRE-REGISTERED expectation.

PRE-REGISTERED EXPECTATION (written BEFORE running): pure pan/rotation/zoom sit near r_norm ~ 0 (one
conformal model explains them); composites of two independent sub-fields rise well above, so a single floor
separates single from composite. PRE-REGISTERED CAVEAT: two OPPOSITE pans across a vertical split form an
x-monotone field that a linear divergence term can partially fit, so that composite may read the LOWEST
r_norm of the composites -- possibly low enough to alias as single. Measurement decides; this file only
sweeps and prints, asserts nothing. The unit lock (test_multiregion.py) freezes whatever this MEASURES.
vmodel/flow_roi/motion_class untouched; composites built by multiregion.compose_* (genuine per-region pixels).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import motion_class as M
import multiregion as MR

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


def _seq(gen):
    return [gen(k) for k in range(FRAMES)]


def run():
    pan = _seq(make_translation)
    pan_opp = _seq(lambda k: make_translation(k, sx=-1.0))
    pan_v = _seq(lambda k: make_translation(k, sx=0.0, sy=1.0))
    rot = _seq(make_rotation)
    zoom = _seq(make_zoom)

    singles = [('pan', pan), ('rotation', rot), ('zoom', zoom)]
    composites = [
        ('pan | pan_opposite', MR.compose_lr(pan, pan_opp, COLS, ROWS)),
        ('pan | pan_vertical', MR.compose_lr(pan, pan_v, COLS, ROWS)),
        ('pan | rotation', MR.compose_lr(pan, rot, COLS, ROWS)),
        ('pan | zoom', MR.compose_lr(pan, zoom, COLS, ROWS)),
        ('rotation | zoom', MR.compose_lr(rot, zoom, COLS, ROWS)),
        ('zoom | rotation (TB)', MR.compose_tb(zoom, rot, COLS, ROWS)),
    ]

    print("PRE-REGISTERED: singles r_norm ~ 0; composites well above a single floor.")
    print("CAVEAT: pan|pan_opposite may alias low (linear-div partial fit).\n")

    print("--- SINGLE motions (single-model assumption holds) ---")
    print("  case                  r_norm  gain   split  class(label it forces)")
    s_rmax = 0.0; s_gmax = 0.0
    for name, fr in singles:
        res = MR.single_model_residual(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        g = MR.composite_gain(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        cls = M.classify(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['cls']
        s_rmax = max(s_rmax, res['r_norm']); s_gmax = max(s_gmax, g['gain'])
        print("  %-20s  %.4f  %.4f %-5s  %s"
              % (name, res['r_norm'], g['gain'], g['best_split'], cls))

    print("\n--- CONCURRENT composites (single-model assumption violated) ---")
    print("  case                  r_norm  gain   split  class(silently forced)")
    c_rmin = 1e9; c_gmin = 1e9
    for name, fr in composites:
        res = MR.single_model_residual(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        g = MR.composite_gain(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        cls = M.classify(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['cls']
        c_rmin = min(c_rmin, res['r_norm']); c_gmin = min(c_gmin, g['gain'])
        print("  %-20s  %.4f  %.4f %-5s  %s"
              % (name, res['r_norm'], g['gain'], g['best_split'], cls))

    print("\nVERDICT READOUT:")
    print("  raw residual r_norm  : single<=%.4f  composite>=%.4f  -> floor %s (gap %.4f)"
          % (s_rmax, c_rmin, "YES" if c_rmin > s_rmax else "NO", c_rmin - s_rmax))
    print("  residual-drop gain   : single<=%.4f  composite>=%.4f  -> floor %s (gap %.4f)"
          % (s_gmax, c_gmin, "YES" if c_gmin > s_gmax else "NO", c_gmin - s_gmax))
    return 0


if __name__ == '__main__':
    sys.exit(run())