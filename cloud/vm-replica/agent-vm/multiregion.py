"""Round-37: CONCURRENT MULTI-REGION motion -- does the single-global-model assumption that underpins
EVERY prior key break when two independent sub-fields move at once, and can that break be honestly DETECTED?

Rounds 29-36 each assumed ONE motion explains the whole frame: round-29 coherence asks "does ONE rigid
GLOBAL shift re-align the field?"; round-30/32 structure fits ONE conformal model f = a + s*(r-rbar) +
w*perp(r-rbar) to the whole field. A real GUI breaks that assumption constantly -- a split-screen with two
panes scrolled independently, a picture-in-picture video panning inside a still page, two-finger gestures
each dragging a different sub-region. Under such a field there is NO single motion; the locked classifier
will still emit ONE label (whatever the dominant / averaged field looks like), silently mislabelling a
COMPOSITE field as a pure one. The honest question is not "which of the 3 classes is it" -- it is "is the
single-model assumption even VALID here?"

The principled detector is the GOODNESS-OF-FIT of that single global model. We extract the per-block flow
field exactly as flow_roi does (interior-only blocks, reusing vmodel._block_ssd, so zero border bias and
byte-identical block matching), fit the SAME conformal model flow_structure fits, and measure the weighted
residual that the one global model leaves UNexplained, normalised by the field's own flow scale:

    r_norm = sqrt( RSS / W ) / ( flow_scale + eps )

where RSS = sum_i w_i * |f_i - model(f_i)|^2 is the residual after removing the best single conformal model
(intercept a absorbs the bulk pan; s the divergence; w the curl), W = sum_i w_i, and flow_scale =
sqrt( sum_i w_i * |f_i|^2 / W ) is the RMS flow magnitude. r_norm is SCALE-FREE: a pure pan/rotation/zoom is
fit (almost) exactly by the single conformal model so RSS ~ 0 and r_norm ~ 0; two independent sub-fields
cannot be reconciled by one model so a large fraction of the flow energy survives as residual and r_norm
rises toward O(1). A composite is then flagged iff r_norm exceeds the single-motion noise floor.

PRE-REGISTERED EXPECTATION (written before measuring): r_norm cleanly separates single (low) from composite
(high). HONEST CAVEAT also pre-registered: some composites may ALIAS onto a single conformal mode -- two
opposite pans across a vertical split form an x-monotone field a linear divergence term can PARTIALLY fit,
so that particular composite may read lower r_norm than e.g. pan|rotation. Measurement decides; we report
whatever the sweep shows and do NOT tune the gate to a desired verdict (為者敗之).

MEASURED OUTCOME (the expectation was FALSIFIED, then root-caused and resolved):
  * The raw r_norm does NOT separate: pure rotation/zoom read r_norm 0.53/0.64, ABOVE the lowest composite
    (0.56). The root-cause probe (_diag_mr_rootcause.py) shows r_norm FALLS monotonically as a pure motion
    grows (rotation 0.91->0.26 as theta 0.02->0.20; zoom 0.89->0.30) -- i.e. the residual is INTEGER-
    DISPLACEMENT QUANTIZATION noise: block matching rounds each sub-pixel curved flow to the nearest integer
    in the +/-search window, and a pure rotation/zoom (nonzero s/w terms) is sub-pixel everywhere so it
    carries quantization residual that has NOTHING to do with being composite. r_norm is therefore a
    goodness-of-fit DIAGNOSTIC, not a composite detector.
  * The fix is the quantization-ROBUST residual-DROP gain (composite_gain below): that same quantization
    noise is present in BOTH the one-region and the two-region fit, so it CANCELS in the drop ratio; only a
    genuine multi-region boundary step is removed by splitting. The synthetic sweep then separates cleanly
    (single gain <=0.057, composite >=0.267) and the gate is the MEASURED midpoint 0.15 (not a-priori).
  * HONEST LIVE CEILING (practice_webmulti.py, MapLibre+OSM real frames): pan-involved composites are
    robustly caught (gain 0.15-0.23) because a translation discontinuity at the boundary is OUTSIDE the
    conformal span, but two CURVED regions (rotation|zoom) can alias LOW (gain ~0.05) -- a single conformal
    model (intercept + divergence + curl) already spans a blend of two curved fields, so splitting recovers
    almost no residual. This is the same flavour of pixel-indistinguishability ceiling as round-34's flat-
    vs-perspective rotation: reported as measured, the gate is NOT lowered to force it (為者敗之).

PURELY ADDITIVE: a NEW module. vmodel.py / flow_roi.py / motion_class.py are byte-for-byte untouched, so
every locked invariant (footprint / gain / dyn coherence / interior structure / occlusion-aware coherence /
temporal evidence floor) stands. We reuse vmodel._block_ssd so the ONLY new thing is the residual metric.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vmodel as V

EPS = 1e-9
_ssd = V._block_ssd  # byte-identical block matcher reused (same primitive flow_roi/flow_affine reuse)


def compose_mask(frames_a, frames_b, cols, rows, in_b):
    """Spatially COMPOSITE two equal-length frame sequences into one: cell c takes frames_b's value where
    in_b(i, j) is true, else frames_a's value. A faithful model of two concurrent sub-regions -- each region
    carries the GENUINE pixels (and thus the genuine motion) of its source sequence, with a hard boundary
    between them exactly as a split-screen / PiP composites two independently-rendered surfaces."""
    n = min(len(frames_a), len(frames_b))
    out = []
    for k in range(n):
        fa = frames_a[k]; fb = frames_b[k]
        g = list(fa)
        for j in range(rows):
            row = j * cols
            for i in range(cols):
                if in_b(i, j):
                    g[row + i] = fb[row + i]
        out.append(g)
    return out


def compose_lr(frames_a, frames_b, cols, rows, split=0.5):
    """Left columns (< split*cols) from A, right from B."""
    xc = split * cols
    return compose_mask(frames_a, frames_b, cols, rows, lambda i, j: i >= xc)


def compose_tb(frames_a, frames_b, cols, rows, split=0.5):
    """Top rows (< split*rows) from A, bottom from B."""
    yc = split * rows
    return compose_mask(frames_a, frames_b, cols, rows, lambda i, j: j >= yc)


def _block_flow(frames, cols, rows, search=4, blocks=12):
    """Per-block displacement field, interior blocks only (full overlap at every +/-search shift => no
    border inward-matching bias). Identical block loop to flow_roi.flow_structure_roi; returns parallel
    lists (bx, by, fx, fy, wt) so callers can fit/measure their own models on the SAME field."""
    bx = []; by = []; fx = []; fy = []; wt = []
    for k in range(1, len(frames)):
        pre = frames[k - 1]; cur = frames[k]
        for bj in range(blocks):
            j0 = bj * rows // blocks; j1 = max(j0 + 1, (bj + 1) * rows // blocks)
            for bi in range(blocks):
                i0 = bi * cols // blocks; i1 = max(i0 + 1, (bi + 1) * cols // blocks)
                interior = (i0 - search >= 0 and (i1 - 1) + search <= cols - 1
                            and j0 - search >= 0 and (j1 - 1) + search <= rows - 1)
                if not interior:
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
                bx.append((i0 + i1 - 1) / 2.0); by.append((j0 + j1 - 1) / 2.0)
                fx.append(float(bdx)); fy.append(float(bdy)); wt.append(base)
    return bx, by, fx, fy, wt


def _conformal_rss(bx, by, fx, fy, wt):
    """Fit the SAME conformal model flow_structure fits (f = a + s*(r-rbar) + w*perp(r-rbar)) by weighted
    least squares, and return (RSS, W, flow_scale): the weighted residual energy the single model leaves,
    the total weight, and the RMS flow magnitude. RSS is computed on the FLUCTUATION about the weighted mean
    flow (the intercept a == the mean, which absorbs any bulk pan), so a pure pan leaves RSS ~ 0."""
    w_sum = sum(wt)
    if w_sum <= 0 or not wt:
        return 0.0, 0.0, 0.0
    xbar = sum(b * w for b, w in zip(bx, wt)) / w_sum
    ybar = sum(b * w for b, w in zip(by, wt)) / w_sum
    fxb = sum(f * w for f, w in zip(fx, wt)) / w_sum
    fyb = sum(f * w for f, w in zip(fy, wt)) / w_sum
    den = 0.0; ssc = 0.0; scc = 0.0
    for f_x, f_y, b_x, b_y, w in zip(fx, fy, bx, by, wt):
        px = b_x - xbar; py = b_y - ybar
        gx = f_x - fxb; gy = f_y - fyb
        den += w * (px * px + py * py)
        ssc += w * (px * gx + py * gy)
        scc += w * (px * gy - py * gx)
    s_rate = (ssc / den) if den > 0 else 0.0
    w_rate = (scc / den) if den > 0 else 0.0
    rss = 0.0; fmag = 0.0
    for f_x, f_y, b_x, b_y, w in zip(fx, fy, bx, by, wt):
        px = b_x - xbar; py = b_y - ybar
        mgx = s_rate * px - w_rate * py   # conformal model fluctuation (perp(px,py) = (-py, px))
        mgy = s_rate * py + w_rate * px
        rx = (f_x - fxb) - mgx; ry = (f_y - fyb) - mgy
        rss += w * (rx * rx + ry * ry)
        fmag += w * (f_x * f_x + f_y * f_y)
    flow_scale = math.sqrt(fmag / w_sum)
    return rss, w_sum, flow_scale


def single_model_residual(frames, cols, rows, search=4, blocks=12):
    """The honest single-global-model goodness-of-fit. Returns a glass-box dict; the headline is `r_norm` in
    [0, ~1): ~0 when ONE conformal motion explains the whole field (pan/rotation/zoom), rising toward O(1)
    when the field is a COMPOSITE that no single model can reconcile."""
    bx, by, fx, fy, wt = _block_flow(frames, cols, rows, search=search, blocks=blocks)
    rss, w_sum, flow_scale = _conformal_rss(bx, by, fx, fy, wt)
    if w_sum <= 0 or flow_scale <= EPS:
        return {'r_norm': 0.0, 'rss_rms': 0.0, 'flow_scale': round(flow_scale, 4),
                'blocks': len(wt), 'degenerate': True}
    rss_rms = math.sqrt(rss / w_sum)
    return {'r_norm': round(rss_rms / (flow_scale + EPS), 4),
            'rss_rms': round(rss_rms, 4), 'flow_scale': round(flow_scale, 4),
            'blocks': len(wt), 'degenerate': False}


def _rss_only(bx, by, fx, fy, wt):
    """RSS (weighted residual energy) of the single conformal model fit over the given blocks."""
    rss, _w, _s = _conformal_rss(bx, by, fx, fy, wt)
    return rss


def _split_rss(bx, by, fx, fy, wt, key):
    """Sum of the TWO independent conformal-fit RSS for the partition induced by key(b_x, b_y) in {0, 1}.
    Each region gets its OWN conformal model (own intercept/div/curl), so a genuine two-region field drops
    its residual to each region's single-motion level; a coherent single field cannot be helped this way."""
    g0 = ([], [], [], [], []); g1 = ([], [], [], [], [])
    for b_x, b_y, f_x, f_y, w in zip(bx, by, fx, fy, wt):
        g = g1 if key(b_x, b_y) else g0
        g[0].append(b_x); g[1].append(b_y); g[2].append(f_x); g[3].append(f_y); g[4].append(w)
    return _rss_only(*g0) + _rss_only(*g1)


def composite_gain(frames, cols, rows, search=4, blocks=12):
    """The honest multi-region detector. The single-model residual r_norm is confounded by integer-
    displacement quantization (a pure rotation/zoom leaves large residual purely from rounding small sub-
    pixel flow to integers -- round-37 root-cause probe). That quantization noise is present in BOTH the
    one-region and the two-region fits, so it CANCELS in the residual-DROP ratio below; only a genuine
    multi-region boundary step is removed by splitting:

        gain = 1 - RSS_two / RSS_one   over a FIXED candidate set of partitions (vertical mid, horizontal
                                       mid, both diagonals), taking the best.

    A coherent single motion (even a curved rotation/zoom) cannot lower its residual by being cut along a
    mid-line -- its quantization noise is diffuse, the same in each half -- so gain ~ 0. A field built from
    two independent sub-regions collapses to each region's own (low) single-motion residual once cut along
    its boundary -> gain ~ 1. The partition set is FIXED and small (no free boundary search), so the gain
    cannot be inflated by overfitting; the honest cost is that a composite whose boundary lies far from all
    tested cuts is missed (reported, not hidden -- 為者敗之)."""
    bx, by, fx, fy, wt = _block_flow(frames, cols, rows, search=search, blocks=blocks)
    rss_one, w_sum, flow_scale = _conformal_rss(bx, by, fx, fy, wt)
    if w_sum <= 0 or rss_one <= EPS:
        return {'gain': 0.0, 'rss_one': round(rss_one, 4), 'rss_two': round(rss_one, 4),
                'best_split': None, 'blocks': len(wt), 'degenerate': True}
    xc = cols / 2.0; yc = rows / 2.0
    cands = [
        ('vert', lambda x, y: x >= xc),
        ('horz', lambda x, y: y >= yc),
        ('diag', lambda x, y: (x - xc) + (y - yc) >= 0.0),
        ('anti', lambda x, y: (x - xc) - (y - yc) >= 0.0),
    ]
    best_gain = 0.0; best_name = None; best_rss2 = rss_one
    for name, key in cands:
        rss_two = _split_rss(bx, by, fx, fy, wt, key)
        gain = 1.0 - rss_two / rss_one
        if gain > best_gain:
            best_gain = gain; best_name = name; best_rss2 = rss_two
    return {'gain': round(max(0.0, best_gain), 4), 'rss_one': round(rss_one, 4),
            'rss_two': round(best_rss2, 4), 'best_split': best_name,
            'flow_scale': round(flow_scale, 4), 'blocks': len(wt), 'degenerate': False}


# Composite gate. The synthetic sweep (_diag_multiregion.py) MEASURED the separation: single pan/rotation/
# zoom cap at gain ~0.057 (a coherent field cannot lower its residual by being cut), while two-region
# composites floor at ~0.267 (rotation|zoom, the hardest -- two curved sub-fields each partially absorb into
# the conformal model). The gate is the MEASURED midpoint of that gap, not an a-priori guess; the
# diagnostics print the raw gain per case so the boundary stays auditable against the data (為者敗之).
COMPOSITE_GAIN_THR = 0.15


def is_composite(frames, cols, rows, search=4, blocks=12, thr=COMPOSITE_GAIN_THR):
    """Flag whether the field violates the single-global-model assumption, via the quantization-robust
    residual-drop gain. Additive: leaves motion_class untouched -- a caller runs this FIRST and only trusts
    the 3-way label when the field reads single."""
    res = composite_gain(frames, cols, rows, search=search, blocks=blocks)
    res['composite'] = (not res['degenerate']) and res['gain'] >= thr
    res['thr'] = thr
    return res
