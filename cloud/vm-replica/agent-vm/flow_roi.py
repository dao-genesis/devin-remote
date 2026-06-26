"""Round-32: attack the border geometry head-on -- an INTERIOR-ONLY (ROI) conformal flow estimator.

Round-30 measured that the conformal `vmodel.flow_structure` 3-way split [translation, |div|, |curl|] is
clean on synthetic frames but does NOT survive external rendering (a native map zoom does not cosine-
separate from a rotation). Round-31's #webscale control proved the cause is finite-frame BORDER GEOMETRY,
not MapLibre vector re-layout: a textbook image-scale still fails to separate.

The round-30 mechanism is specific: a finite-frame block-match injects a motion-INDEPENDENT *inward*
divergence, because a BORDER super-block, when test-shifted OUTWARD, loses overlap (its `cur` cells map
off the `pre` frame) -- `_block_ssd` averages over the surviving overlap only, so outward shifts look
artificially cheap and the matcher prefers inward shifts. Every mode -- even a pure pan -- then reads a
spurious inward |div|, and a zoom's real radial signal drowns in that same outer-ring noise.

This module FALSIFIABLY tests whether that border bias is DEFEATABLE: keep ONLY interior super-blocks
whose full extent, shifted by the maximum +/-search, still lands entirely inside the frame. Such blocks
have FULL overlap at EVERY candidate shift, so the overlap-shrink bias cannot act on them -- the inward
divergence injection is removed at the source. We then run the SAME centroid-centred conformal least
squares as `vmodel.flow_structure`. If the interior field now separates a zoom/scale from a rotation
(cos < 0.6) where the full-frame field could not, the round-30 border bias is the cause AND it is
defeatable by an ROI window -> the external 3-way taxonomy can be recovered. If it STILL fails, the
finite-frame limit is deeper than edge blocks (e.g. at this block resolution an interior radial field is
not linearly separable from a tangential one) and the robust external key remains round-29 coherence.

PURELY ADDITIVE: this is a NEW module; `vmodel.py` is byte-for-byte unchanged, so every locked invariant
(footprint / gain / dyn coherence / full-frame flow_structure) stands. We reuse `vmodel._block_ssd` and
`vmodel._l2` so the ONLY difference from flow_structure is WHICH blocks enter the fit -- a clean control.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vmodel as V


def flow_structure_roi(frames, cols, rows, search=4, blocks=8):
    """Interior-only twin of vmodel.flow_structure: identical conformal LSQ, but a super-block enters the
    fit ONLY if its whole extent shifted by +/-search stays inside the frame (full overlap at every shift,
    so zero border inward-matching bias). Returns the same dict shape plus 'kept'/'dropped' block counts."""
    fx = []; fy = []; bx = []; by = []; wt = []
    kept = 0; dropped = 0
    for k in range(1, len(frames)):
        pre = frames[k - 1]; cur = frames[k]
        for bj in range(blocks):
            j0 = bj * rows // blocks; j1 = max(j0 + 1, (bj + 1) * rows // blocks)
            for bi in range(blocks):
                i0 = bi * cols // blocks; i1 = max(i0 + 1, (bi + 1) * cols // blocks)
                # INTERIOR TEST: full overlap at every candidate shift <=> block stays in-frame at +/-search.
                interior = (i0 - search >= 0 and (i1 - 1) + search <= cols - 1
                            and j0 - search >= 0 and (j1 - 1) + search <= rows - 1)
                if not interior:
                    dropped += 1
                    continue
                base = _ssd(pre, cur, cols, rows, i0, i1, j0, j1, 0, 0)
                if base is None or base < 1e-6:
                    continue
                best = base; bdx = 0; bdy = 0
                for dy in range(-search, search + 1):
                    for dx in range(-search, search + 1):
                        if dx == 0 and dy == 0:
                            continue
                        ss = _ssd(pre, cur, cols, rows, i0, i1, j0, j1, dx, dy)
                        if ss is not None and ss < best:
                            best = ss; bdx = dx; bdy = dy
                bcx = (i0 + i1 - 1) / 2.0; bcy = (j0 + j1 - 1) / 2.0
                fx.append(float(bdx)); fy.append(float(bdy)); bx.append(bcx); by.append(bcy); wt.append(base)
                kept += 1
    w_sum = sum(wt)
    empty = {'sig': [0.0, 0.0, 0.0], 'trans': 0.0, 'div': 0.0, 'curl': 0.0,
             'blocks': len(wt), 'kept': kept, 'dropped': dropped}
    if w_sum <= 0 or not wt:
        return empty
    # Identical centroid-centred conformal fit f = a + s*(r-rbar) + w*perp(r-rbar) as vmodel.flow_structure.
    xbar = sum(b * w for b, w in zip(bx, wt)) / w_sum
    ybar = sum(b * w for b, w in zip(by, wt)) / w_sum
    fxb = sum(f * w for f, w in zip(fx, wt)) / w_sum
    fyb = sum(f * w for f, w in zip(fy, wt)) / w_sum
    trans = math.sqrt(fxb * fxb + fyb * fyb)
    den = 0.0; ssc = 0.0; scc = 0.0
    for f_x, f_y, b_x, b_y, w in zip(fx, fy, bx, by, wt):
        px = b_x - xbar; py = b_y - ybar
        gx = f_x - fxb; gy = f_y - fyb
        den += w * (px * px + py * py)
        ssc += w * (px * gx + py * gy)
        scc += w * (px * gy - py * gx)
    if den <= 0:
        div = 0.0; curl = 0.0
    else:
        rms = math.sqrt(den / w_sum)
        div = (ssc / den) * rms
        curl = (scc / den) * rms
    return {'sig': [round(x, 4) for x in V._l2([trans, abs(div), abs(curl)])],
            'trans': round(trans, 3), 'div': round(div, 3), 'curl': round(curl, 3),
            'blocks': len(wt), 'kept': kept, 'dropped': dropped}


# `_block_ssd` is module-private in vmodel; bind it once here (still byte-identical vmodel, just reused).
_ssd = V._block_ssd
