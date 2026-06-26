"""Round-38 unit lock: HONEST BOUNDARY LOCALIZATION + per-region PARSE over a FIXED dyadic ladder.

Freezes the MEASURED truth from _diag_region_parse.py so any future drift is caught:

  A. cropping is faithful & non-destructive -- _crop takes genuine per-region pixels and does not mutate
     the input frames.
  B. FALSE-SEGMENTATION GUARD: a genuine single motion (pan/rotation/zoom) never clears round-37's gate, so
     NO boundary is declared, and the whole frame still classifies to its true motion via the locked
     classifier.
  C. LOCALIZATION: every pan-involved composite (and, at synthetic resolution, even the curved|curved case)
     recovers the true split AXIS and the true POSITION on the ladder (exactly, since the ground-truth
     splits sit on ladder rungs).
  D. PER-REGION PARSE: each crop classifies to its source motion via the byte-for-byte locked
     motion_class.classify (the confidence may drop on a narrow crop, but the label is correct).
  E. the localization gain SEPARATES single from composite (max single < gate < min composite), so the
     parse is data-separated, not threshold-forced (為者敗之).

vmodel.py / flow_roi.py / motion_class.py / multiregion.py are byte-for-byte untouched; this only exercises
the additive region_parse.py over the locked stack.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import multiregion as MR
import region_parse as RP

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

    # --- A. faithful, non-destructive crop ---
    src_pan = [list(f) for f in pan]
    a, wa, ha = RP._crop(pan, COLS, ROWS, 0, 24, 0, ROWS)
    crop_ok = (wa == 24 and ha == ROWS
               and all(a[k][j * wa + i] == pan[k][j * COLS + i]
                       for k in range(FRAMES) for j in range(ROWS) for i in range(wa)))
    checks.append(("_crop carries the source region's genuine pixels at the right shape", crop_ok))
    b, wb, hb = RP._crop(pan, COLS, ROWS, 12, COLS, 6, ROWS)
    off_ok = (wb == COLS - 12 and hb == ROWS - 6
              and all(b[k][j * wb + i] == pan[k][(6 + j) * COLS + (12 + i)]
                      for k in range(FRAMES) for j in range(hb) for i in range(wb)))
    checks.append(("_crop honours an offset origin (i0,j0)", off_ok))
    checks.append(("_crop does not mutate its input", all(pan[k] == src_pan[k] for k in range(FRAMES))))

    # --- B. false-segmentation guard: singles declare NO boundary, whole-frame label correct ---
    singles = [('pan', pan, 'pan'), ('rotation', rot, 'rotation'), ('zoom', zoom, 'zoom')]
    s_gmax = 0.0
    print("single localization (expect composite=False):")
    for name, fr, truth in singles:
        res = RP.parse_regions(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        s_gmax = max(s_gmax, res['gain'])
        whole = res['regions'][0]
        print("  %-10s gain=%.4f composite=%s  whole=%s(%.2f)"
              % (name, res['gain'], res['composite'], whole['cls'], whole['confidence']))
        checks.append(("single '%s' declares NO boundary" % name, not res['composite']))
        checks.append(("single '%s' whole-frame label == truth" % name,
                       len(res['regions']) == 1 and whole['cls'] == truth))

    # --- C/D. localization + per-region parse on composites ---
    comps = [
        ('pan|zoom vert@0.5', MR.compose_lr(pan, zoom, COLS, ROWS, 0.5), 'vert', 0.5, 'pan', 'zoom'),
        ('pan|zoom vert@0.625', MR.compose_lr(pan, zoom, COLS, ROWS, 0.625), 'vert', 0.625, 'pan', 'zoom'),
        ('pan|rot vert@0.5', MR.compose_lr(pan, rot, COLS, ROWS, 0.5), 'vert', 0.5, 'pan', 'rotation'),
        ('pan|panv vert@0.5', MR.compose_lr(pan, pan_v, COLS, ROWS, 0.5), 'vert', 0.5, 'pan', 'pan'),
        ('zoom|rot horz@0.5', MR.compose_tb(zoom, rot, COLS, ROWS, 0.5), 'horz', 0.5, 'zoom', 'rotation'),
        ('pan|zoom horz@0.375', MR.compose_tb(pan, zoom, COLS, ROWS, 0.375), 'horz', 0.375, 'pan', 'zoom'),
    ]
    c_gmin = 1e9
    print("composite localization + parse (expect axis+position recovered, regions labelled):")
    for name, fr, t_orient, t_frac, t_a, t_b in comps:
        res = RP.parse_regions(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        c_gmin = min(c_gmin, res['gain'])
        regs = res['regions']
        lab = ' '.join("%s=%s(%.2f)" % (r['span'], r['cls'], r['confidence']) for r in regs)
        print("  %-22s gain=%.4f axis=%s frac=%.3f  %s"
              % (name, res['gain'], res.get('orientation'), res.get('frac') or 0.0, lab))
        checks.append(("composite '%s' IS flagged" % name, res['composite']))
        checks.append(("composite '%s' axis recovered" % name, res.get('orientation') == t_orient))
        checks.append(("composite '%s' position recovered (on ladder)" % name,
                       abs((res.get('frac') or 0.0) - t_frac) <= 1e-9))
        checks.append(("composite '%s' both regions labelled correctly" % name,
                       len(regs) == 2 and regs[0]['cls'] == t_a and regs[1]['cls'] == t_b))

    # --- E. localization gain separates single from composite ---
    print("\nseparation: max single gain=%.4f < gate %.2f < min composite gain=%.4f"
          % (s_gmax, MR.COMPOSITE_GAIN_THR, c_gmin))
    checks.append(("localization gain separates single from composite (single < gate < composite)",
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
