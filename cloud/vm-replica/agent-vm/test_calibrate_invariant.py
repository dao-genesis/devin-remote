"""Round-25 unit proof (no GUI): the calibration key is MOTION-INVARIANT and reuse SELF-HEALS.

Round-24 keyed a measured surface gain on context_fp, a spatially-rigid fingerprint. When a surface
transforms ITSELF mid-interaction (an orbit cube spins under the drag), context_fp drifts and the
stored gain can no longer be matched -> the calibration is lost (round-24's honest boundary).

Round-25 keys the gain on context_radial, a centroid-anchored energy profile that survives the surface
moving itself. The price of that invariance is that look-alike surfaces (orbit vs pan) cannot be told
apart statically, so a reuse is only a HYPOTHESIS -- confirmed or DISCONFIRMED by the very next verify.
On disconfirmation the agent recalibrates, so a wrong cross-surface leak self-heals in one encounter.

These two properties are proven here deterministically against WorldModel directly, so the claim does
not depend on whatever surfaces a particular lab happens to contain. Pure arithmetic, zero vision."""
import os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as _vmodel

FP = _vmodel._l2([0.0, 1.0, 2.0, 1.0, 0.0, 0.0])          # a fixed footprint SHAPE (the affordance)
SFP = _vmodel._l2([0.0, 0.5, 1.0, -0.5, 0.0, 0.0])


def desc(mag):
    return {'fp': FP, 'sfp': SFP, 'mag': mag, 'cx': 8.0, 'cy': 8.0, 'aniso': 0.1}


def obs(mag):
    return {'fp': FP, 'sfp': SFP, 'mag': mag, 'cx': 8.0, 'cy': 8.0, 'aniso': 0.1}


def fresh():
    wm = _vmodel.WorldModel(None)
    # one generic 'drag' affordance, learned on TRAINING contexts unlike either test surface, so a test
    # surface is a genuine TRANSFER (ctx_sim < 0.6 => gain unknown until locally calibrated).
    for k in range(4):
        ctxT = [0.0] * 8; ctxT[k] = 1.0
        wm.record('drag', ctxT, desc(3.0 + k))
    return wm


# context_fp keys (spatial): a self-transforming surface DRIFTS this between encounters.
CTX_A_COLD = [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]
CTX_A_WARM = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0]   # same surface, transformed -> fp drifted
# context_radial keys (motion-invariant): SAME across the self-transform, distinct but look-alike to B.
RAD_A = _vmodel._l2([5.0, 4.0, 1.0, 0.0, 0.0])
RAD_B = _vmodel._l2([3.0, 3.5, 2.5, 1.5, 0.5])          # cos(RAD_A,RAD_B) in [0.6,0.98): look-alike


def approx(a, b, t=1e-6):
    return abs(a - b) <= t


def recal_predicate(v):
    """The inner agent's round-25 recalibration trigger (mirrored here for the unit proof)."""
    return (v.get('known') and v.get('shape_present')
            and ((not v.get('gain_known'))
                 or (v.get('calibrated') and float(v.get('mag_ratio', 0.0)) > 0.5)))


def test_invariant_key_survives_self_transform():
    GAIN_A = 6.0
    # round-24 way (key on context_fp): cold probe stores gain at CTX_A_COLD; warm encounter the surface
    # has transformed itself so its context_fp is CTX_A_WARM -> the stored gain no longer matches.
    wm = fresh(); wm.calibrate('drag', CTX_A_COLD, obs(GAIN_A))   # cal_ctx defaults to ctx (fp)
    v24 = wm.verify('drag', CTX_A_WARM, obs(GAIN_A))
    assert not v24['calibrated'], 'round-24 should LOSE the calibration after a self-transform'

    # round-25 way (key on context_radial): the radial key is identical across the self-transform.
    wm = fresh(); wm.calibrate('drag', CTX_A_COLD, obs(GAIN_A), cal_ctx=RAD_A)
    v25 = wm.verify('drag', CTX_A_WARM, obs(GAIN_A), cal_ctx=RAD_A)
    assert v25['calibrated'], 'round-25 must REUSE the calibration despite the self-transform'
    assert v25['gain_known'], 'reused gain => gain_known True on a transfer surface'
    assert approx(v25['pred_mag'], GAIN_A), 'the MEASURED gain is what is held against'
    print('  [ok] invariant key reuses gain across self-transform (fp drift); fp key loses it')


def test_lookalike_leak_self_heals():
    GAIN_A, GAIN_B = 5.0, 20.0
    wm = fresh(); wm.calibrate('drag', CTX_A_COLD, obs(GAIN_A), cal_ctx=RAD_A)   # only A known so far
    sim = _vmodel.cos(RAD_A, RAD_B)
    assert 0.6 <= sim < 0.98, 'B must be a look-alike of A (shares calibration, distinct entry)'

    # B's FIRST encounter: the invariant key cannot tell B from A, so A's gain is REUSED (a hypothesis).
    v1 = wm.verify('drag', CTX_A_WARM, obs(GAIN_B), cal_ctx=RAD_B)
    assert v1['calibrated'] and approx(v1['pred_mag'], GAIN_A), 'B first reuses A gain (leak)'
    assert v1['mag_ratio'] > 0.5 and not v1['present'], 'divergent gain DISCONFIRMS the reuse (surprise)'
    assert recal_predicate(v1), 'disconfirmed reuse must trigger recalibration'

    # the agent recalibrates B from this very observation (distinct radial entry, cos<0.98 => not merged).
    wm.calibrate('drag', CTX_A_WARM, obs(GAIN_B), cal_ctx=RAD_B)

    # B's SECOND encounter now matches B's OWN entry (nearer than A) -> healed.
    v2 = wm.verify('drag', CTX_A_WARM, obs(GAIN_B), cal_ctx=RAD_B)
    assert approx(v2['pred_mag'], GAIN_B), 'B now uses its OWN measured gain'
    assert v2['mag_ratio'] <= 0.5 and v2['present'], 'healed: gain matches, present True'
    assert not recal_predicate(v2), 'no further recalibration once healed'
    print('  [ok] cross-surface leak self-heals in one encounter (nearest-match calibration)')


if __name__ == '__main__':
    print('=== round-25 unit proof: motion-invariant calibration key + self-healing reuse ===')
    test_invariant_key_survives_self_transform()
    test_lookalike_leak_self_heals()
    print('ALL PASS')
