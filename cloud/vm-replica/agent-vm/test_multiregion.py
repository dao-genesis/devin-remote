"""Round-37 unit lock: CONCURRENT MULTI-REGION detection via a quantization-robust residual-DROP gain.

Freezes the MEASURED truth from _diag_multiregion.py / _diag_mr_rootcause.py so any future drift is caught:

  A. compositing is faithful & non-destructive -- compose_lr/compose_tb take genuine per-region pixels from
     each source sequence (left|right, top|bottom) and do not mutate their inputs.
  B. the RAW single-model residual r_norm is a CONFOUNDED diagnostic, NOT a detector: a pure pan is fit
     exactly (r_norm ~ 0), but a pure rotation/zoom carries a LARGE r_norm (>0.3) purely from integer-
     displacement quantization of its sub-pixel curved flow -- so r_norm alone cannot separate single from
     composite. (This is the hypothesis-overturning finding; locking it prevents anyone "rediscovering"
     r_norm as a gate.)
  C. the quantization-ROBUST residual-drop gain SEPARATES on the synthetic sweep: every pure motion reads a
     LOW gain (a coherent field cannot lower its residual by being cut along a mid-line), while every two-
     region composite reads a HIGHER gain (splitting along its boundary collapses the residual the single
     model could not), with a clean floor between them -> is_composite is False for singles, True for
     composites at the MEASURED 0.15 gate.
  D. the gate sits strictly inside the measured gap (max single gain < gate < min composite gain), so the
     verdict is data-separated, not threshold-forced (為者敗之).

vmodel.py / flow_roi.py / motion_class.py are byte-for-byte untouched; this only exercises the additive
multiregion.py over the locked stack.
"""
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
    pan_v = [make_translation(k, sx=0.0, sy=1.0) for k in range(FRAMES)]
    rot = [make_rotation(k) for k in range(FRAMES)]
    zoom = [make_zoom(k) for k in range(FRAMES)]

    checks = []

    # --- A. faithful, non-destructive compositing ---
    src_pan = [list(f) for f in pan]; src_zoom = [list(f) for f in zoom]
    comp = MR.compose_lr(pan, zoom, COLS, ROWS)
    xc = COLS // 2
    left_from_a = all(comp[k][j * COLS + i] == pan[k][j * COLS + i]
                      for k in range(FRAMES) for j in range(ROWS) for i in range(0, xc))
    right_from_b = all(comp[k][j * COLS + i] == zoom[k][j * COLS + i]
                       for k in range(FRAMES) for j in range(ROWS) for i in range(xc, COLS))
    checks.append(("compose_lr: left region carries source-A pixels", left_from_a))
    checks.append(("compose_lr: right region carries source-B pixels", right_from_b))
    comp_tb = MR.compose_tb(zoom, rot, COLS, ROWS)
    yc = ROWS // 2
    top_from_a = all(comp_tb[k][j * COLS + i] == zoom[k][j * COLS + i]
                     for k in range(FRAMES) for j in range(0, yc) for i in range(COLS))
    bot_from_b = all(comp_tb[k][j * COLS + i] == rot[k][j * COLS + i]
                     for k in range(FRAMES) for j in range(yc, ROWS) for i in range(COLS))
    checks.append(("compose_tb: top region carries source-A pixels", top_from_a))
    checks.append(("compose_tb: bottom region carries source-B pixels", bot_from_b))
    checks.append(("compose_* does not mutate its inputs",
                   all(pan[k] == src_pan[k] and zoom[k] == src_zoom[k] for k in range(FRAMES))))

    # --- B. raw r_norm is a CONFOUNDED diagnostic (quantization), not a detector ---
    rp = MR.single_model_residual(pan, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['r_norm']
    rr = MR.single_model_residual(rot, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['r_norm']
    rz = MR.single_model_residual(zoom, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['r_norm']
    print("raw r_norm  pan=%.4f rotation=%.4f zoom=%.4f  (rotation/zoom high = quantization, not composite)"
          % (rp, rr, rz))
    checks.append(("r_norm: pure pan fit ~exactly (r_norm < 0.05)", rp < 0.05))
    checks.append(("r_norm: pure rotation carries LARGE quantization residual (> 0.3)", rr > 0.3))
    checks.append(("r_norm: pure zoom carries LARGE quantization residual (> 0.3)", rz > 0.3))
    checks.append(("r_norm: a single curved motion's r_norm exceeds pan's -> r_norm is NOT a detector",
                   min(rr, rz) > rp + 0.2))

    # --- C/D. quantization-robust residual-drop gain SEPARATES single from composite ---
    singles = [('pan', pan), ('rotation', rot), ('zoom', zoom)]
    composites = [
        ('pan|pan_v', MR.compose_lr(pan, pan_v, COLS, ROWS)),
        ('pan|rotation', MR.compose_lr(pan, rot, COLS, ROWS)),
        ('pan|zoom', MR.compose_lr(pan, zoom, COLS, ROWS)),
        ('rotation|zoom', MR.compose_lr(rot, zoom, COLS, ROWS)),
        ('zoom|rotation TB', MR.compose_tb(zoom, rot, COLS, ROWS)),
    ]
    s_gmax = 0.0
    print("\nsingle gains:")
    for name, fr in singles:
        res = MR.is_composite(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        s_gmax = max(s_gmax, res['gain'])
        print("  %-16s gain=%.4f composite=%s" % (name, res['gain'], res['composite']))
        checks.append(("single '%s' is NOT flagged composite" % name, not res['composite']))
    c_gmin = 1e9
    print("composite gains:")
    for name, fr in composites:
        res = MR.is_composite(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        c_gmin = min(c_gmin, res['gain'])
        print("  %-16s gain=%.4f composite=%s split=%s" % (name, res['gain'], res['composite'], res['best_split']))
        checks.append(("composite '%s' IS flagged composite" % name, res['composite']))
    print("\nseparation: max single gain=%.4f < gate 0.15 < min composite gain=%.4f" % (s_gmax, c_gmin))
    checks.append(("gate sits strictly inside the measured gap (single < 0.15 < composite)",
                   s_gmax < MR.COMPOSITE_GAIN_THR < c_gmin))

    print("\n=== checks ===")
    ok = True
    for name, c in checks:
        print(("  PASS " if c else "  FAIL ") + name)
        ok = ok and c
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(run())
