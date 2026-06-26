"""Round-30 unit test: flow_structure decomposes a local flow field into [translation, divergence,
curl] so a SCROLL-ZOOM earns a distinct class instead of leaking into 'rotation' the way the binary
motion_signature key forces it to.

These are SYNTHETIC, deterministic frames (no GUI, no network): we sample a fixed continuous texture
under three pure transforms and assert the dominant component is the right one. This locks the math
the same way test_motion_signature.py locks the coherence invariant -- the external map harness
(practice_webzoom.py) then checks the SAME function survives real rendering."""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vmodel as V

COLS = ROWS = 24
FRAMES = 7


def _texture(x, y):
    # a smooth, structured field so block-matching has gradient to lock onto
    return (128.0 + 55.0 * math.sin(x * 0.7) + 55.0 * math.sin(y * 0.9)
            + 35.0 * math.sin((x + y) * 0.45) + 25.0 * math.cos((x - y) * 0.6))


def _sample(map_pt):
    """Build a frame by sampling the texture through an inverse coordinate map (cell -> source point)."""
    g = [0.0] * (COLS * ROWS)
    for j in range(ROWS):
        for i in range(COLS):
            sx, sy = map_pt(i, j)
            g[j * COLS + i] = _texture(sx, sy)
    return g


def make_translation(k, sx=1.0, sy=0.0):
    return _sample(lambda i, j: (i - k * sx, j - k * sy))


def make_rotation(k, theta=0.10):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0
    a = -k * theta  # inverse rotation
    ca, sa = math.cos(a), math.sin(a)
    def m(i, j):
        dx = i - cx; dy = j - cy
        return (cx + ca * dx - sa * dy, cy + sa * dx + ca * dy)
    return _sample(m)


def make_zoom(k, s=1.10):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0
    f = s ** k  # forward scale; inverse divides
    def m(i, j):
        return (cx + (i - cx) / f, cy + (j - cy) / f)
    return _sample(m)


def run():
    trans = [make_translation(k) for k in range(FRAMES)]
    rot = [make_rotation(k) for k in range(FRAMES)]
    zoom = [make_zoom(k) for k in range(FRAMES)]

    st = V.flow_structure(trans, COLS, ROWS)
    sr = V.flow_structure(rot, COLS, ROWS)
    sz = V.flow_structure(zoom, COLS, ROWS)

    print("translation:", st['sig'], "trans=%.2f div=%.2f curl=%.2f" % (st['trans'], st['div'], st['curl']))
    print("rotation:   ", sr['sig'], "trans=%.2f div=%.2f curl=%.2f" % (sr['trans'], sr['div'], sr['curl']))
    print("zoom:       ", sz['sig'], "trans=%.2f div=%.2f curl=%.2f" % (sz['trans'], sz['div'], sz['curl']))

    PAN = [1.0, 0.0, 0.0]; ZOO = [0.0, 1.0, 0.0]; ROT = [0.0, 0.0, 1.0]
    checks = []
    # each motion's signature should point closest to its own ideal axis
    checks.append(("translation is translation-dominant", st['sig'][0] > st['sig'][1] and st['sig'][0] > st['sig'][2]))
    checks.append(("zoom is divergence-dominant", sz['sig'][1] > sz['sig'][0] and sz['sig'][1] > sz['sig'][2]))
    checks.append(("rotation is curl-dominant", sr['sig'][2] > sr['sig'][0] and sr['sig'][2] > sr['sig'][1]))
    # zoom and rotation, which motion_signature CANNOT tell apart, separate here
    zr = V.cos(sz['sig'], sr['sig'])
    checks.append(("zoom separates from rotation (cos < 0.6)", zr < 0.6))
    # each is nearest its own ideal axis
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
