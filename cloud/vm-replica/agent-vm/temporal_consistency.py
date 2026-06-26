"""Round-35: temporal consistency of the honest motion classifier.

Rounds 29-34 each asked a SINGLE-SHOT question: "what kind of motion was this WHOLE drag?" The classifier
(motion_class.classify) consumes the entire sampled frame sequence at once and returns one label. That left
an untested axis: WITHIN one continuous gesture, is the label STABLE frame-to-frame, or does it flicker at
the low-displacement ends of the drag (where the per-frame signal sinks toward the noise floor)? A robust
classifier of a single coherent gesture should read the SAME class on every sub-window of that gesture; a
genuinely changing gesture (pan that becomes a rotation) should switch label at the right moment.

This module adds NO new estimator math -- it slides a window of `win` consecutive frames (=> win-1 deltas)
across the sequence with stride `step`, calls the LOCKED motion_class.classify on each sub-window, and
reports the per-window labels plus stability metrics. vmodel.py / flow_roi.py / motion_class.py are all
byte-for-byte untouched; this is a pure temporal wrapper over the round-33 cascade.

Metrics (glass-box, measurement decides -- 為者敗之):
  * labels       : the class on each sliding window, in order
  * modal        : the most common label
  * agreement    : fraction of windows equal to the modal label (1.0 == perfectly stable)
  * transitions  : number of adjacent label CHANGES (0 == no flicker)
  * windows      : per-window evidence dicts (coherence, roi_sig) so any flicker is auditable
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import motion_class as M

# round-35c: the minimum window length (in FRAMES) below which per-window coherence is evidence-starved.
# Measured, not chosen (_diag_winlen.py): holding the gesture fixed and sweeping ONLY the window length,
# flicker incidence falls MONOTONICALLY as more deltas are pooled -- a 4-frame window (3 deltas) flickers
# 1-2/5 modes every run, while a 5-frame window (4 deltas) is stable in almost every run (rare bursts need
# more). The flicker is therefore short-window coherence VARIANCE, not a real motion edge -- the locked
# whole-drag classifier (rounds 29-34) always pools every delta and was never affected. 5 frames is the
# shortest window that is reliably stable; it is a measured evidence floor, NOT a tuned cutoff (為者敗之).
MIN_EVIDENCE_FRAMES = 5


def classify_windows(frames, cols, rows, win=4, step=1, search=4, blocks=12, coh_thr=M.COH_THR,
                     px_w=1.0, px_h=1.0):
    """Slide a `win`-frame window (stride `step`) over `frames`; classify each sub-window with the locked
    round-33 cascade. Returns the ordered labels and stability metrics. `win` is a FRAME count (>=2); a
    window of W frames feeds W-1 deltas to the coherence + interior-structure keys."""
    if win < 2:
        raise ValueError("win must be >= 2 frames (>= 1 delta)")
    n = len(frames)
    out_windows = []
    labels = []
    i = 0
    while i + win <= n:
        sub = frames[i:i + win]
        c = M.classify(sub, cols, rows, search=search, blocks=blocks, coh_thr=coh_thr,
                       px_w=px_w, px_h=px_h)
        labels.append(c['cls'])
        out_windows.append({
            'span': [i, i + win - 1],
            'cls': c['cls'],
            'coherence': c['coherence'],
            'roi_sig': c['roi_sig'],
            'confidence': c['confidence'],
        })
        i += step

    transitions = sum(1 for a, b in zip(labels, labels[1:]) if a != b)
    modal = None
    agreement = 0.0
    if labels:
        modal = max(set(labels), key=labels.count)
        agreement = round(labels.count(modal) / len(labels), 3)

    # round-35b: principled temporal smoother (median/majority over a centred neighbourhood). This is NOT a
    # threshold move (為者敗之) -- it adds no tunable cutoff and touches no estimator; it only resolves the
    # single-window flicker the live data exposed (an isolated label flip whose neighbours all disagree),
    # while leaving genuine multi-window transitions intact. Justified ONLY because the measurement showed it.
    voted = temporal_vote(labels)
    voted_transitions = sum(1 for a, b in zip(voted, voted[1:]) if a != b)
    voted_modal = None
    voted_agreement = 0.0
    if voted:
        voted_modal = max(set(voted), key=voted.count)
        voted_agreement = round(voted.count(voted_modal) / len(voted), 3)

    return {
        'labels': labels,
        'modal': modal,
        'agreement': agreement,
        'transitions': transitions,
        'voted_labels': voted,
        'voted_modal': voted_modal,
        'voted_agreement': voted_agreement,
        'voted_transitions': voted_transitions,
        'n_windows': len(labels),
        'win': win,
        'step': step,
        'evidence_ok': win >= MIN_EVIDENCE_FRAMES,
        'windows': out_windows,
    }


def temporal_vote(labels, radius=1):
    """Median/majority smoother: replace each window's label by the most common label in the centred
    neighbourhood [i-radius, i+radius]. With radius=1 (3-window vote) an ISOLATED single-window flip (a
    label whose two neighbours both disagree) is corrected, while any run of >= 2 like labels -- i.e. a
    genuine mid-gesture transition -- survives unchanged. No tunable threshold; radius is a fixed window."""
    n = len(labels)
    out = []
    for i in range(n):
        lo = max(0, i - radius); hi = min(n, i + radius + 1)
        nb = labels[lo:hi]
        out.append(max(set(nb), key=nb.count))
    return out


def transition_points(result):
    """Indices (into the window list) where the label changes from the previous window -- the frames at
    which a gesture's class flips. Useful for confirming a deliberate mid-drag motion switch is detected
    at the right place (temporal RESOLUTION), not just that a steady gesture is stable."""
    labels = result['labels']
    return [k for k in range(1, len(labels)) if labels[k] != labels[k - 1]]
