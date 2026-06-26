"""Round-34 unit test: the full-AFFINE estimator flow_affine.flow_structure_affine is mathematically
sound on clean synthetic frames -- it reproduces the conformal answers (pan->translation, zoom->
divergence, rotation->curl, all with shear ~ 0) AND additionally lights up a 4th axis, `shear`, for a
deliberately ANISOTROPIC (deviatoric) strain that the conformal fit is blind to.

This LOCKS the estimator: a pure rotation has zero shear, a pure isotropic zoom has zero shear, but an
anisotropic stretch (horizontal expand + vertical compress, div ~ 0) reads shear-dominant and cosine-
separates from all three conformal axes. So when the live external harness later asks whether a
perspective TILT carries shear where a flat SPIN does not, any null result is attributable to the
rendering, not to a blind estimator.

Deterministic synthetic frames (no GUI, no network); same texture/transform family as test_flow_roi.py.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vmodel as V
import flow_affine as A

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


def make_aniso(k, s=1.06):
    """Pure deviatoric strain: horizontal expand by s^k, vertical compress by s^k. div ~ 0, shear large.
    This is the irreducible anisotropy a perspective foreshortening introduces and a conformal map cannot."""
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0
    f = s ** k
    def m(i, j):
        return (cx + (i - cx) / f, cy + (j - cy) * f)
    return _sample(m)


def run():
    trans = [make_translation(k) for k in range(FRAMES)]
    rot = [make_rotation(k) for k in range(FRAMES)]
    zoom = [make_zoom(k) for k in range(FRAMES)]
    aniso = [make_aniso(k) for k in range(FRAMES)]

    st = A.flow_structure_affine(trans, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    sr = A.flow_structure_affine(rot, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    sz = A.flow_structure_affine(zoom, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    sa = A.flow_structure_affine(aniso, COLS, ROWS, search=SEARCH, blocks=BLOCKS)

    def show(name, s):
        print("%-12s" % name, s['sig'],
              "trans=%.2f div=%.2f curl=%.2f shear=%.2f" % (s['trans'], s['div'], s['curl'], s['shear']))
    show("translation", st); show("rotation", sr); show("zoom", sz); show("aniso", sa)

    PAN = [1, 0, 0, 0]; ZOO = [0, 1, 0, 0]; ROT = [0, 0, 1, 0]; SHR = [0, 0, 0, 1]
    checks = []
    checks.append(("translation translation-dominant", max(range(4), key=lambda i: st['sig'][i]) == 0))
    checks.append(("zoom divergence-dominant", max(range(4), key=lambda i: sz['sig'][i]) == 1))
    checks.append(("rotation curl-dominant", max(range(4), key=lambda i: sr['sig'][i]) == 2))
    checks.append(("aniso shear-dominant", max(range(4), key=lambda i: sa['sig'][i]) == 3))
    # The new axis is genuinely orthogonal: rotation and zoom carry little shear; aniso carries little curl.
    checks.append(("rotation shear is small (< 0.4)", sr['sig'][3] < 0.4))
    checks.append(("zoom shear is small (< 0.4)", sz['sig'][3] < 0.4))
    checks.append(("aniso separates from rotation (cos < 0.6)", V.cos(sa['sig'], sr['sig']) < 0.6))
    checks.append(("aniso separates from zoom (cos < 0.6)", V.cos(sa['sig'], sz['sig']) < 0.6))
    checks.append(("aniso nearest shear-axis", V.cos(sa['sig'], SHR) > max(V.cos(sa['sig'], PAN), V.cos(sa['sig'], ZOO), V.cos(sa['sig'], ROT))))

    print("\n=== checks ===")
    ok = True
    for name, c in checks:
        print(("  PASS " if c else "  FAIL ") + name)
        ok = ok and c
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(run())
