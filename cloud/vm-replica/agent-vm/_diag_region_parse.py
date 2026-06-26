"""Round-38 diagnostic: MEASURE (do not assume) how well the fixed-ladder boundary localizer recovers the
true split axis/position, and how well the LOCKED classifier labels each crop. Mirrors round-37's honest
method: print the raw numbers, let the data set the test thresholds afterwards (為者敗之)."""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import region_parse as RP
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


def main():
    pan = [make_translation(k) for k in range(FRAMES)]
    pan_v = [make_translation(k, sx=0.0, sy=1.0) for k in range(FRAMES)]
    rot = [make_rotation(k) for k in range(FRAMES)]
    zoom = [make_zoom(k) for k in range(FRAMES)]

    # --- singles: no boundary should be declared, whole-frame label should be correct ---
    print("=== SINGLES (expect composite=False, best gain below gate) ===")
    for name, fr, truth in [('pan', pan, 'pan'), ('rotation', rot, 'rotation'), ('zoom', zoom, 'zoom')]:
        res = RP.parse_regions(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        regs = ' '.join("%s=%s(%.2f)" % (r['span'], r['cls'], r['confidence']) for r in res['regions'])
        print("  %-10s gain=%.4f composite=%s  whole-truth=%s  ->  %s"
              % (name, res['gain'], res['composite'], truth, regs))

    # --- composites at several true split positions: measure orientation + position recovery + per-region ---
    print("\n=== COMPOSITES (true split axis/frac known; measure recovery) ===")
    specs = [
        # (label, builder, true_orient, true_frac, truth_a, truth_b)
        ('pan|zoom    @0.50', lambda: MR.compose_lr(pan, zoom, COLS, ROWS, 0.5), 'vert', 0.5, 'pan', 'zoom'),
        ('pan|zoom    @0.625', lambda: MR.compose_lr(pan, zoom, COLS, ROWS, 0.625), 'vert', 0.625, 'pan', 'zoom'),
        ('pan|rot     @0.50', lambda: MR.compose_lr(pan, rot, COLS, ROWS, 0.5), 'vert', 0.5, 'pan', 'rotation'),
        ('pan|panv    @0.50', lambda: MR.compose_lr(pan, pan_v, COLS, ROWS, 0.5), 'vert', 0.5, 'pan', 'pan'),
        ('zoom|rot TB @0.50', lambda: MR.compose_tb(zoom, rot, COLS, ROWS, 0.5), 'horz', 0.5, 'zoom', 'rotation'),
        ('pan|zoom TB @0.375', lambda: MR.compose_tb(pan, zoom, COLS, ROWS, 0.375), 'horz', 0.375, 'pan', 'zoom'),
        ('rot|zoom    @0.50 (curved|curved, expect HARD)', lambda: MR.compose_lr(rot, zoom, COLS, ROWS, 0.5),
         'vert', 0.5, 'rotation', 'zoom'),
    ]
    for label, build, t_orient, t_frac, t_a, t_b in specs:
        fr = build()
        res = RP.parse_regions(fr, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        orient_ok = res.get('orientation') == t_orient
        frac_err = abs((res.get('frac') or 0.0) - t_frac)
        regs = res['regions']
        if len(regs) == 2:
            lab = "%s=%s(%.2f) %s=%s(%.2f)" % (regs[0]['span'], regs[0]['cls'], regs[0]['confidence'],
                                               regs[1]['span'], regs[1]['cls'], regs[1]['confidence'])
            cls_ok = (regs[0]['cls'] == t_a and regs[1]['cls'] == t_b)
        else:
            lab = "WHOLE=%s" % regs[0]['cls']; cls_ok = False
        print("  %-44s comp=%-5s gain=%.3f  orient=%s(%s) frac=%.3f(err=%.3f) cls_ok=%s\n        regions: %s"
              % (label, res['composite'], res['gain'], res.get('orientation'),
                 'OK' if orient_ok else 'X', res.get('frac') or 0.0, frac_err, cls_ok, lab))

    # --- full localization grid for one case so the ladder behaviour is visible ---
    print("\n=== ladder grid for pan|zoom @0.625 (true vert@0.625) ===")
    loc = RP.localize_boundary(MR.compose_lr(pan, zoom, COLS, ROWS, 0.625), COLS, ROWS, SEARCH, BLOCKS)
    for orient, f, g in loc['grid']:
        mark = '  <-- picked' if (orient == loc['orientation'] and f == loc['frac']) else ''
        print("  %-5s frac=%.3f gain=%.4f%s" % (orient, f, g, mark))


if __name__ == '__main__':
    main()
