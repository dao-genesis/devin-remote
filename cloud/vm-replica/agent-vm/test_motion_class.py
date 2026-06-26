"""Round-33 unit test: the END-TO-END cascade classifier motion_class.classify routes each motion to the
correct honest class on clean synthetic frames -- a pan -> 'pan', a zoom -> 'zoom', a rotation -> 'rotation'.

This LOCKS the cascade (coherence gate -> interior div-vs-curl) on deterministic frames so that when the
live external harness (practice_webclass.py) measures whether a FRESH external drag is routed correctly,
any miss is attributable to the rendering geometry, not to a buggy classifier. Same texture/transform
family and grid as test_flow_roi.py.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import motion_class as M

COLS = ROWS = 48
FRAMES = 7
SEARCH = 4
BLOCKS = 12


def _texture(x, y):
    return (128.0 + 55.0 * math.sin(x * 0.35) + 55.0 * math.sin(y * 0.45)
            + 35.0 * math.sin((x + y) * 0.22) + 25.0 * math.cos((x - y) * 0.30))


def _sample(map_pt):
    g = [0.0] * (COLS * ROWS)
    for j in range(ROWS):
        for i in range(COLS):
            sx, sy = map_pt(i, j)
            g[j * COLS + i] = _texture(sx, sy)
    return g


def make_translation(k, sx=1.0, sy=0.0):
    return _sample(lambda i, j: (i - k * sx, j - k * sy))


def make_rotation(k, theta=0.05):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0
    a = -k * theta
    ca, sa = math.cos(a), math.sin(a)
    def m(i, j):
        dx = i - cx; dy = j - cy
        return (cx + ca * dx - sa * dy, cy + sa * dx + ca * dy)
    return _sample(m)


def make_zoom(k, s=1.05):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0
    f = s ** k
    def m(i, j):
        return (cx + (i - cx) / f, cy + (j - cy) / f)
    return _sample(m)


def run():
    trans = [make_translation(k) for k in range(FRAMES)]
    rot = [make_rotation(k) for k in range(FRAMES)]
    zoom = [make_zoom(k) for k in range(FRAMES)]

    ct = M.classify(trans, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    cr = M.classify(rot, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    cz = M.classify(zoom, COLS, ROWS, search=SEARCH, blocks=BLOCKS)

    print("translation ->", ct['cls'], "coh=%.3f sig=%s conf=%.3f" % (ct['coherence'], ct['roi_sig'], ct['confidence']))
    print("rotation    ->", cr['cls'], "coh=%.3f sig=%s conf=%.3f" % (cr['coherence'], cr['roi_sig'], cr['confidence']))
    print("zoom        ->", cz['cls'], "coh=%.3f sig=%s conf=%.3f" % (cz['coherence'], cz['roi_sig'], cz['confidence']))

    checks = [
        ("translation classifies as pan", ct['cls'] == 'pan'),
        ("rotation classifies as rotation", cr['cls'] == 'rotation'),
        ("zoom classifies as zoom", cz['cls'] == 'zoom'),
        ("pan is coherent (>= gate)", ct['coherence'] >= ct['coh_thr']),
        ("rotation is incoherent (< gate)", cr['coherence'] < cr['coh_thr']),
        ("zoom is incoherent (< gate)", cz['coherence'] < cz['coh_thr']),
    ]

    print("\n=== checks ===")
    ok = True
    for name, c in checks:
        print(("  PASS " if c else "  FAIL ") + name)
        ok = ok and c
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(run())
