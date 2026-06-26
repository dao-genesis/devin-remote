"""Round-37 root-cause probe: WHY does a PURE rotation/zoom leave a large single-model residual r_norm
(0.53 / 0.64) -- as large as a composite? Pre-registered suspicion: it is INTEGER-DISPLACEMENT QUANTIZATION
of small sub-pixel curved flow, NOT genuine multi-region model misfit. A rotation/zoom IS a linear conformal
field, so the conformal model should fit it exactly; the only residual source left is rounding each block's
true sub-pixel displacement to the nearest integer in +/-search. If so, r_norm should FALL as we make the
single motion BIGGER (larger displacements -> rounding is a smaller fraction). This file just sweeps and
prints; asserts nothing."""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
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


def make_rotation(k, theta):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0
    a = -k * theta; ca, sa = math.cos(a), math.sin(a)
    return _sample(lambda i, j: (cx + ca * (i - cx) - sa * (j - cy), cy + sa * (i - cx) + ca * (j - cy)))


def make_zoom(k, s):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0; f = s ** k
    return _sample(lambda i, j: (cx + (i - cx) / f, cy + (j - cy) / f))


def run():
    print("If r_norm is quantization noise, it FALLS as the single motion grows larger.\n")
    print("ROTATION  theta -> r_norm / flow_scale")
    for theta in (0.02, 0.05, 0.10, 0.20, 0.35):
        fr = [make_rotation(k, theta) for k in range(FRAMES)]
        res = MR.single_model_residual(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        print("  %.2f  ->  r_norm=%.4f  flow_scale=%.4f" % (theta, res['r_norm'], res['flow_scale']))

    print("\nZOOM  s -> r_norm / flow_scale")
    for s in (1.02, 1.05, 1.10, 1.20, 1.35):
        fr = [make_zoom(k, s) for k in range(FRAMES)]
        res = MR.single_model_residual(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        print("  %.2f  ->  r_norm=%.4f  flow_scale=%.4f" % (s, res['r_norm'], res['flow_scale']))
    return 0


if __name__ == '__main__':
    sys.exit(run())
