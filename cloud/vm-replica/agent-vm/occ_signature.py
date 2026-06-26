"""Round-36: an OCCLUSION-AWARE coherence -- a faithful masked twin of vmodel.motion_signature -- and a
robust classifier built on it, motivated by a MEASURED failure (not a guessed one).

The pre-registered hypothesis for round-36 was "graceful degradation": occluded blocks carry ~zero weight
(base = SSD-at-zero-shift ~0), so the locked classifier's block weighting should down-weight them and the
honest 3-way class should survive partial occlusion. The synthetic sweep (_diag_occlusion.py) FALSIFIED that
hypothesis in an asymmetric way, and the measurement -- not preference -- dictates this module:

  * rotation and zoom (the INCOHERENT, structure-keyed classes) are HIGHLY occlusion-robust: they keep their
    class out past ~50% corner/centre occlusion, because the surviving blocks still carry the curl/div signal
    and flow_structure_roi already weights + drops near-zero-delta blocks.
  * PAN (the COHERENCE-keyed class) is the FRAGILE one -- the OPPOSITE of the naive guess. A static overlay
    is an island of EXACTLY-zero inter-frame delta. motion_signature asks "does ONE rigid GLOBAL shift
    re-align the whole frame?" -- but shifting the whole frame DRAGS the frozen island off itself, injecting
    large SSD into SSD_best that no global shift can remove. So pan coherence COLLAPSES (1.0 -> 0.58 -> 0.17
    -> 0.02 as corner occlusion grows 0->50%), and pan flips to a spurious rotation/zoom by ~25-37% occlusion.

The honest root cause is therefore specific and principled: the failure is the GLOBAL single-shift, defeated
by a zero-delta island. The fix is NOT a new threshold (為者敗之) -- it is to EXCLUDE from the global-shift
SSD exactly those cells whose inter-frame delta is ~0, i.e. the overlay itself and nothing else. A static
overlay's DEFINING signature is delta==0; genuinely moving content essentially never has exactly-zero delta,
so on clean frames this mask is empty and occ_coherence is byte-identical in behaviour to motion_signature
(verified: clean pan 1.000, rotation 0.000, zoom 0.000 -- unchanged). Under occlusion it restores pan
coherence (0.91/0.74/0.96 at 25/37.5/50% corner) WITHOUT manufacturing coherence for genuinely incoherent
rotation/zoom (they stay ~0). This is additive: vmodel.py / flow_roi.py / motion_class.py are byte-for-byte
untouched; the production classify() is unchanged; classify_occ() is an OPT-IN robust variant that swaps
ONLY stage-1 coherence for the masked twin and reuses motion_class for the (already-robust) stage-2 split.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import flow_roi as R
import motion_class as M

EPS = 1e-6


def _ssd_shift_masked(pre, cur, cols, rows, dx, dy, mask):
    """vmodel._ssd_shift's faithful twin, but summing ONLY over cells flagged moving in `mask` (the overlay's
    exactly-static cells are skipped). Per-cell mean over counted overlap, so sizes stay comparable."""
    ss = 0.0; n = 0
    for j in range(rows):
        jj = j - dy
        if jj < 0 or jj >= rows:
            continue
        for i in range(cols):
            ii = i - dx
            if ii < 0 or ii >= cols:
                continue
            if not mask[j * cols + i]:
                continue
            d = cur[j * cols + i] - pre[jj * cols + ii]
            ss += d * d; n += 1
    return (ss / n) if n else None


def occ_coherence(frames, cols, rows, search=4, eps=EPS):
    """Occlusion-aware coherence: motion_signature's global-shift coherence computed over MOVING cells only.

    For each consecutive pair, a cell is 'moving' iff |cur-pre| at zero shift exceeds eps; the static overlay
    (delta==0 by construction) is excluded. Coherence = 1 - SSD_best/SSD_zero over moving cells, motion-
    weighted across pairs -- identical math to vmodel.motion_signature, identical on clean frames (empty
    mask), but no longer defeated by a zero-delta island fighting the single global shift."""
    coh_w = 0.0; w_sum = 0.0
    for k in range(1, len(frames)):
        pre = frames[k - 1]; cur = frames[k]
        mask = [abs(cur[c] - pre[c]) > eps for c in range(cols * rows)]
        base = _ssd_shift_masked(pre, cur, cols, rows, 0, 0, mask)
        if base is None or base < eps:
            continue
        best = base
        for dy in range(-search, search + 1):
            for dx in range(-search, search + 1):
                if dx == 0 and dy == 0:
                    continue
                ss = _ssd_shift_masked(pre, cur, cols, rows, dx, dy, mask)
                if ss is not None and ss < best:
                    best = ss
        coh = max(0.0, 1.0 - best / base)
        coh_w += coh * base; w_sum += base
    return (coh_w / w_sum) if w_sum > 0 else 0.0


def classify_occ(frames, cols, rows, search=4, blocks=12, coh_thr=M.COH_THR, px_w=1.0, px_h=1.0):
    """Occlusion-robust twin of motion_class.classify: identical 2-stage cascade and gate, but stage 1 uses
    occ_coherence (masked global shift) instead of vmodel.motion_signature. Stage 2 (interior div-vs-curl)
    is reused from flow_roi unchanged -- it was MEASURED already occlusion-robust, so it is left alone."""
    coh = float(occ_coherence(frames, cols, rows, search=search))
    roi = R.flow_structure_roi(frames, cols, rows, search=search, blocks=blocks)
    sig = roi.get('sig') or [0.0, 0.0, 0.0]
    div, curl = float(sig[1]), float(sig[2])

    if coh >= coh_thr:
        cls = 'pan'
        conf = round(min(1.0, (coh - coh_thr) / max(1e-6, 1.0 - coh_thr)), 3)
    else:
        denom = div + curl
        cls = 'zoom' if div > curl else 'rotation'
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
