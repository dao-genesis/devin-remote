"""Round-35 unit test: lock the temporal-consistency wrapper on clean synthetic frames BEFORE the live test.

Two properties, both falsifiable on deterministic frames:
  (A) STABILITY -- a single steady gesture (continuous pan / rotation / zoom) must read the SAME class on
      EVERY sliding window (agreement == 1.0, transitions == 0). If the windowed classifier flickered even
      on noiseless frames, any live flicker would be un-attributable. This proves the wrapper is steady when
      the motion is steady.
  (B) RESOLUTION -- a gesture that genuinely CHANGES mid-drag (pan for the first half, rotation for the
      second) must produce >= 1 label transition, and that transition must land in the back half (where the
      motion actually switches). This proves the wrapper TRACKS change rather than being blind to it -- a
      stability test alone could be passed by a classifier that always returns one constant label.

Same texture/transform family and 48x48 grid as test_motion_class.py / test_flow_roi.py. vmodel.py,
flow_roi.py, motion_class.py all byte-for-byte unchanged; this only exercises temporal_consistency.py.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import temporal_consistency as T

COLS = ROWS = 48
SEARCH = 4
BLOCKS = 12
WIN = 4          # 4 frames -> 3 deltas per window
N = 11           # matches the live drag (samples=10 -> 11 frames)


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


def _pan_pt(k, sx=1.0, sy=0.0):
    return lambda i, j: (i - k * sx, j - k * sy)


def _rot_pt(k, theta=0.05):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0
    a = -k * theta; ca, sa = math.cos(a), math.sin(a)
    def m(i, j):
        dx = i - cx; dy = j - cy
        return (cx + ca * dx - sa * dy, cy + sa * dx + ca * dy)
    return m


def _zoom_pt(k, s=1.05):
    cx = (COLS - 1) / 2.0; cy = (ROWS - 1) / 2.0
    f = s ** k
    def m(i, j):
        return (cx + (i - cx) / f, cy + (j - cy) / f)
    return m


def make_steady(kind):
    if kind == 'pan':
        return [_sample(_pan_pt(k)) for k in range(N)]
    if kind == 'rotation':
        return [_sample(_rot_pt(k)) for k in range(N)]
    if kind == 'zoom':
        return [_sample(_zoom_pt(k)) for k in range(N)]
    raise ValueError(kind)


def make_switch():
    """Pan for the first half (the viewport translates), then HOLD that offset and rotate about centre for
    the second half. The label should read 'pan' early and 'rotation' late, with the flip in the back half."""
    half = N // 2
    pan_off = float(half)
    frames = []
    for k in range(N):
        if k <= half:
            frames.append(_sample(_pan_pt(k)))
        else:
            # keep the accumulated pan offset, add rotation that grows past the midpoint
            m_rot = _rot_pt(k - half)
            def m(i, j, _r=m_rot):
                sx, sy = _r(i, j)
                return (sx - pan_off, sy)
            frames.append(_sample(m))
    return frames


def run():
    checks = []

    # (A) stability of steady gestures
    for kind in ('pan', 'rotation', 'zoom'):
        r = T.classify_windows(make_steady(kind), COLS, ROWS, win=WIN, search=SEARCH, blocks=BLOCKS)
        print("%-9s windows=%-2d labels=%s modal=%s agree=%.3f trans=%d"
              % (kind, r['n_windows'], r['labels'], r['modal'], r['agreement'], r['transitions']))
        checks.append(("%s modal label is %s" % (kind, kind), r['modal'] == kind))
        checks.append(("%s perfectly stable (agreement==1.0)" % kind, r['agreement'] == 1.0))
        checks.append(("%s no flicker (transitions==0)" % kind, r['transitions'] == 0))

    # (B) resolution: a deliberate mid-drag switch is detected, in the back half
    rs = T.classify_windows(make_switch(), COLS, ROWS, win=WIN, search=SEARCH, blocks=BLOCKS)
    tp = T.transition_points(rs)
    print("switch    windows=%-2d labels=%s trans=%d at=%s voted=%s vtrans=%d"
          % (rs['n_windows'], rs['labels'], rs['transitions'], tp, rs['voted_labels'], rs['voted_transitions']))
    checks.append(("switch produces >=1 transition", rs['transitions'] >= 1))
    checks.append(("switch starts as pan", rs['labels'][0] == 'pan'))
    checks.append(("switch ends as rotation", rs['labels'][-1] == 'rotation'))
    checks.append(("switch flips in the back half", bool(tp) and tp[0] >= rs['n_windows'] // 2))

    # (C) round-35b temporal voter: removes an ISOLATED single-window flip, but PRESERVES a genuine
    # multi-window transition. This is what the live data justified (one isolated flip on pan) -- lock that
    # the smoother fixes flicker WITHOUT erasing real motion changes (over-smoothing would be dishonest).
    isolated = ['pan', 'pan', 'zoom', 'pan', 'pan']          # one bad window among agreeing neighbours
    voted_iso = T.temporal_vote(isolated)
    print("\nvoter isolated  %s -> %s" % (isolated, voted_iso))
    checks.append(("voter removes isolated flip", voted_iso == ['pan'] * 5))

    real = ['pan', 'pan', 'pan', 'rotation', 'rotation', 'rotation']   # a genuine run-of-3 transition
    voted_real = T.temporal_vote(real)
    print("voter real      %s -> %s" % (real, voted_real))
    checks.append(("voter preserves genuine transition", voted_real == real))

    # and on the synthetic switch the voter must keep exactly one transition (does not erase the real switch)
    checks.append(("voter keeps switch transition", rs['voted_transitions'] >= 1))

    # (D) round-35c minimum-evidence window: live measurement (_diag_winlen.py) showed the 4-frame window's
    # per-window coherence is evidence-starved (intermittent flicker that falls monotonically as deltas are
    # pooled), so MIN_EVIDENCE_FRAMES=5 is the measured floor. Lock that the constant exists, that
    # classify_windows reports evidence_ok against it, and that a steady gesture at the floor is stable.
    checks.append(("evidence floor is 5 frames (4 deltas)", T.MIN_EVIDENCE_FRAMES == 5))
    r_floor = T.classify_windows(make_steady('pan'), COLS, ROWS, win=T.MIN_EVIDENCE_FRAMES, search=SEARCH, blocks=BLOCKS)
    print("\nfloor     win=%-2d evidence_ok=%s labels=%s agree=%.3f trans=%d"
          % (T.MIN_EVIDENCE_FRAMES, r_floor['evidence_ok'], r_floor['labels'], r_floor['agreement'], r_floor['transitions']))
    checks.append(("evidence_ok True at floor", r_floor['evidence_ok'] is True))
    checks.append(("evidence_ok False below floor", T.classify_windows(make_steady('pan'), COLS, ROWS, win=4, search=SEARCH, blocks=BLOCKS)['evidence_ok'] is False))
    checks.append(("steady gesture stable at floor", r_floor['agreement'] == 1.0 and r_floor['transitions'] == 0))

    print("\n=== checks ===")
    ok = True
    for name, c in checks:
        print(("  PASS " if c else "  FAIL ") + name)
        ok = ok and c
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(run())
