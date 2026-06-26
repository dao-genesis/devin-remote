"""Round-32 unit test: the INTERIOR-ONLY (ROI) conformal estimator flow_roi.flow_structure_roi is itself
mathematically sound on clean synthetic frames -- a pan reads translation, a zoom divergence, a rotation
curl, and zoom still cosine-separates from rotation. This LOCKS the estimator so that when the live
external harness (practice_webroi.py) measures whether the ROI window defeats the round-30 border bias,
any failure is attributable to the rendering geometry, NOT to a buggy estimator.

These are deterministic synthetic frames (no GUI, no network), the same texture/transform family as
test_flow_structure.py but on a FINER grid: dropping a thin `search`-cell rim then leaves a wide,
well-conditioned interior (big lever arms) for the div/curl fit -- the regime the live harness samples.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vmodel as V
import flow_roi as R

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

    st = R.flow_structure_roi(trans, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    sr = R.flow_structure_roi(rot, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    sz = R.flow_structure_roi(zoom, COLS, ROWS, search=SEARCH, blocks=BLOCKS)

    print("interior blocks kept/dropped per pair: %d/%d" % (st['kept'] // (FRAMES - 1), st['dropped'] // (FRAMES - 1)))
    print("translation:", st['sig'], "trans=%.2f div=%.2f curl=%.2f" % (st['trans'], st['div'], st['curl']))
    print("rotation:   ", sr['sig'], "trans=%.2f div=%.2f curl=%.2f" % (sr['trans'], sr['div'], sr['curl']))
    print("zoom:       ", sz['sig'], "trans=%.2f div=%.2f curl=%.2f" % (sz['trans'], sz['div'], sz['curl']))

    PAN = [1.0, 0.0, 0.0]; ZOO = [0.0, 1.0, 0.0]; ROT = [0.0, 0.0, 1.0]
    checks = []
    checks.append(("a wide interior survives the ROI cut (>=36 blocks)", st['kept'] // (FRAMES - 1) >= 36))
    checks.append(("translation is translation-dominant", st['sig'][0] > st['sig'][1] and st['sig'][0] > st['sig'][2]))
    checks.append(("zoom is divergence-dominant", sz['sig'][1] > sz['sig'][0] and sz['sig'][1] > sz['sig'][2]))
    checks.append(("rotation is curl-dominant", sr['sig'][2] > sr['sig'][0] and sr['sig'][2] > sr['sig'][1]))
    checks.append(("zoom separates from rotation (cos < 0.6)", V.cos(sz['sig'], sr['sig']) < 0.6))
    checks.append(("translation nearest pan-axis", V.cos(st['sig'], PAN) > max(V.cos(st['sig'], ZOO), V.cos(st['sig'], ROT))))
    checks.append(("zoom nearest zoom-axis", V.cos(sz['sig'], ZOO) > max(V.cos(sz['sig'], PAN), V.cos(sz['sig'], ROT))))
    checks.append(("rotation nearest rot-axis", V.cos(sr['sig'], ROT) > max(V.cos(sr['sig'], PAN), V.cos(sr['sig'], ZOO))))

    print("\n=== checks ===")
    ok = True
    for name, c in checks:
        print(("  PASS " if c else "  FAIL ") + name)
        ok = ok and c
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(run())
