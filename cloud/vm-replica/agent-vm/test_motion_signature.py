"""Round-26 deterministic proof (no live lab): the action->response motion_signature separates a rigid
TRANSLATION from a ROTATION, and -- threaded as a second calibration dimension `dyn` -- it stops a
translational surface from borrowing a rotational surface's gain even when their static appearance keys
are identical. Synthetic frames make the kinematics exact, so the claim stands independent of drag timing.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vmodel as V

N = 24


def _base(i, j):
    # deterministic, texture-rich pattern (two non-axis-aligned sinusoids) so block-matching has signal
    return 128 + 60 * math.sin(0.7 * i + 0.3 * j) + 50 * math.cos(0.4 * i - 0.9 * j)


def translate_frames(steps=6, dx=1.0, dy=0.0):
    frames = []
    for k in range(steps):
        g = [0.0] * (N * N)
        for j in range(N):
            for i in range(N):
                g[j * N + i] = _base(i - dx * k, j - dy * k)
        frames.append(g)
    return frames


def rotate_frames(steps=6, dtheta=0.12):
    frames = []
    c = (N - 1) / 2.0
    for k in range(steps):
        th = dtheta * k; ct = math.cos(th); st = math.sin(th)
        g = [0.0] * (N * N)
        for j in range(N):
            for i in range(N):
                x = i - c; y = j - c
                si = ct * x + st * y; sj = -st * x + ct * y  # sample source rotated back
                g[j * N + i] = _base(si, sj)
        frames.append(g)
    return frames


def test_translation_is_coherent_rotation_is_not():
    mt = V.motion_signature(translate_frames(), N, N)
    mr = V.motion_signature(rotate_frames(), N, N)
    print('  translation: coherence=%.3f sig=%s shift=%s' % (mt['coherence'], mt['sig'], mt['shift']))
    print('  rotation:    coherence=%.3f sig=%s shift=%s' % (mr['coherence'], mr['sig'], mr['shift']))
    assert mt['coherence'] > 0.8, mt
    assert mr['coherence'] < 0.5, mr
    assert abs(mt['shift'][0] - 1.0) < 0.3 and abs(mt['shift'][1]) < 0.3, mt
    cos = V.cos(mt['sig'], mr['sig'])
    print('  dynamic cross-cosine translate~rotate = %.3f' % cos)
    assert cos < 0.6, cos
    print('  [ok] translation coherent (re-aligns by a rigid shift); rotation incoherent; dyn cos < 0.6')


def test_dyn_blocks_cross_surface_gain_borrow():
    """Same static appearance key for both surfaces, different gains, different dyn. Without dyn the
    translational probe borrows the rotational surface's gain (round-25 look-alike leak); with dyn the
    borrow is gated off because min(static_cos, dynamic_cos) falls below cal_thr."""
    ctx = [1.0, 2.0, 3.0, 4.0]          # identical static appearance for both surfaces
    dyn_rot = V.motion_signature(rotate_frames(), N, N)['sig']
    dyn_tr = V.motion_signature(translate_frames(), N, N)['sig']
    wm = V.WorldModel()
    # the rotational surface (orbit-like) calibrates a gain under the shared appearance key + its dyn
    wm.calibrate('drag', None, {'mag': 40.0}, cal_ctx=ctx, dyn=dyn_rot)

    # round-25 behaviour (no dyn on the probe): the translational probe DOES borrow the rotational gain
    g25, s25 = wm._best_cal('drag', ctx, dyn=None)
    print('  round-25 (no dyn): borrowed gain=%s sim=%.3f' % (g25, s25))
    assert g25 == 40.0 and s25 >= 0.98, (g25, s25)

    # round-26 (probe carries its translational dyn): the borrow is gated off
    g26, s26 = wm._best_cal('drag', ctx, dyn=dyn_tr)
    print('  round-26 (with dyn): borrowed gain=%s combined_sim=%.3f' % (g26, s26))
    assert s26 < 0.6, s26
    print('  [ok] identical appearance, opposite dynamics -> gain NOT borrowed a priori (no self-heal needed)')


if __name__ == '__main__':
    print('=== round-26 unit proof: action->response motion signature separates translate vs rotate ===')
    test_translation_is_coherent_rotation_is_not()
    test_dyn_blocks_cross_surface_gain_borrow()
    print('ALL PASS')
