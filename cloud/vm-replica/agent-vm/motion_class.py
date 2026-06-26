"""Round-33: the honest END-TO-END motion classifier, wired into the live act()/flow_probe path.

Rounds 29-32 each locked ONE measurement; this round fuses them into a SINGLE live decision -- "which
kind of motion was this drag?" -- and falsifiably tests it end-to-end on a real external renderer. It is
a two-stage cascade, each stage using the key that was PROVEN robust for exactly that split:

  Stage 1 -- round-29 binary coherence (vmodel.motion_signature): does ONE rigid global shift re-align the
    frame after the gesture? A pan answers yes (coherence high); a rotation AND a zoom both answer no
    (coherence low). Measured live on MapLibre+OSM (round-29): pan ~0.69-0.85, rotation ~0.25, zoom ~0.0.
    This is the locked, externally-survived translation-vs-(rotation|zoom) discriminator.

  Stage 2 -- round-32 interior-only conformal structure (flow_roi.flow_structure_roi): for the INCOHERENT
    branch only, is the residual interior field divergence-dominant (a zoom) or curl-dominant (a rotation)?
    The interior window defeats the finite-frame border bias that buried the radial signal full-frame
    (round-30/31), so a native map zoom finally reads divergence-dominant externally.

So:
    coherence >= coh_thr                  -> 'pan'        (translation; locked round-29 key)
    else  |div| > |curl| (interior)       -> 'zoom'       (divergence; round-32 interior key)
    else                                  -> 'rotation'   (curl)

HONEST SCOPE (measurement decides, not preference -- 為者敗之): flat-rotation and perspective-rotation are
NOT separable by these pixel keys -- round-29 measured cos(flat,persp)=0.999, both pure curl externally.
They MERGE into one 'rotation' class. We do NOT manufacture a 4th split the data does not support; the
honest external taxonomy at this layer is 3-way {pan, rotation, zoom}. The 4 lab GESTURES (pan / flat-spin
/ perspective-tilt / zoom) thus map onto 3 honest CLASSES, with both rotations sharing the rotation class.

PURELY ADDITIVE: a NEW module reusing vmodel.motion_signature and flow_roi.flow_structure_roi unchanged;
vmodel.py is byte-for-byte untouched, so every locked invariant stands. The only new thing is the cascade
that fuses the two locked keys into one label.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vmodel as V
import flow_roi as R

# Default coherence gate: midway between the live pan band (~0.69-0.85) and the rotation band (~0.25),
# well clear of zoom (~0.0). Documented, not tuned to a desired outcome; the live harness reports the
# raw coherence per mode so the boundary can be audited against the data.
COH_THR = 0.5


def classify(frames, cols, rows, search=4, blocks=12, coh_thr=COH_THR, px_w=1.0, px_h=1.0):
    """Return the honest 3-way motion class for a sampled drag, plus the raw evidence behind it.

    The output is deliberately glass-box: the caller sees the coherence value, the interior conformal
    signature and the kept/dropped block counts, so the decision is auditable rather than a bare label.
    """
    ms = V.motion_signature(frames, cols, rows, px_w, px_h, search=search)
    coh = float(ms.get('coherence', 0.0))
    roi = R.flow_structure_roi(frames, cols, rows, search=search, blocks=blocks)
    sig = roi.get('sig') or [0.0, 0.0, 0.0]
    div, curl = float(sig[1]), float(sig[2])

    if coh >= coh_thr:
        cls = 'pan'
        # how far above the gate, normalised by the gate's headroom to 1.0
        conf = round(min(1.0, (coh - coh_thr) / max(1e-6, 1.0 - coh_thr)), 3)
    else:
        denom = div + curl
        if div > curl:
            cls = 'zoom'
        else:
            cls = 'rotation'
        # margin between the two interior structure components, normalised
        conf = round((abs(div - curl) / denom) if denom > 1e-9 else 0.0, 3)

    return {
        'cls': cls,
        'confidence': conf,
        'coherence': round(coh, 3),
        'roi_sig': [round(x, 4) for x in sig],
        'roi_div': roi.get('div'), 'roi_curl': roi.get('curl'),
        'kept': roi.get('kept'), 'dropped': roi.get('dropped'),
        'coh_thr': coh_thr,
    }
