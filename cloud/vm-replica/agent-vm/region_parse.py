"""Round-38: HONEST BOUNDARY LOCALIZATION + per-region PARSE -- turn round-37's yes/no composite flag into
an actual SCENE PARSE, without reintroducing the free search round-37 warned against.

Round-37 answered only the meta-question "is the single-global-model assumption violated?" using a FIXED
set of four mid-line partitions, and DELIBERATELY refused to search the boundary position: a free continuous
search inflates the quantization-robust residual-drop gain by overfitting the cut to the data (為者敗之).
But the human-level payoff is not the bare flag -- a person watching a split screen does not just notice
"two things are moving", they read the PARSE: "the LEFT pane is scrolling, the RIGHT pane is zooming, split
about 60% across". This round recovers that parse while keeping round-37's no-overfit discipline:

  1) localize_boundary -- over a FIXED, SMALL dyadic ladder of candidate cut positions (fractions
     {1/4, 3/8, 1/2, 5/8, 3/4}) along each axis (vertical | horizontal), pick the (orientation, position)
     that MAXIMISES the SAME gain = 1 - RSS_two/RSS_one round-37 locked. Ten candidates total (5 positions x
     2 axes); the ladder is fixed and small, so the gain still cannot be inflated by scanning a continuum --
     the honest cost is only that the recovered boundary is quantised to the ladder.
  2) the boundary is DECLARED only when its best gain clears round-37's MEASURED gate COMPOSITE_GAIN_THR; a
     genuine single motion never clears it (round-37 sweep: single gain <=0.057), so no boundary is
     hallucinated -- the pre-registered false-segmentation guard.
  3) parse_regions -- once a boundary is declared, CROP each side to its own rectangle and run the LOCKED
     round-33 motion_class.classify on each crop, so each region gets the same auditable 3-way label
     {pan, rotation, zoom} the whole-frame classifier produces (motion_class is byte-for-byte untouched).

PRE-REGISTERED EXPECTATION (written before measuring): on pan-involved composites the recovered orientation
matches the true split axis, the recovered position lands within one ladder step of ground truth, and each
crop classifies to its true source motion. PRE-REGISTERED HONEST CAVEATS (measurement decides, not
preference -- 為者敗之):
  (a) cropping halves a region's extent -> fewer interior blocks -> the per-region classifier may weaken,
      especially for the curved classes (zoom/rotation need the round-32 interior structure key);
  (b) curved|curved composites that round-37 already could not DETECT (rotation|zoom alias low) equally
      cannot be LOCALISED here -- reported, not forced.

PURELY ADDITIVE: a NEW module reusing multiregion._block_flow / _conformal_rss / _split_rss and the locked
motion_class.classify. vmodel.py / flow_roi.py / motion_class.py / multiregion.py are byte-for-byte
untouched, so every locked invariant (rounds 29-37) stands.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import multiregion as MR
import motion_class as MC

# Fixed dyadic ladder of candidate boundary fractions -- small and FIXED (no free continuum search), so the
# residual-drop gain still cannot be inflated by hunting a continuum. The boundary resolution is the ladder
# step (1/8 of the axis); a true split between rungs lands on the nearest rung (reported, not hidden).
LADDER = (0.25, 0.375, 0.5, 0.625, 0.75)


def _candidates(cols, rows):
    """The fixed candidate set: each dyadic fraction along the vertical axis (x>=frac*cols) and the
    horizontal axis (y>=frac*rows). Returns (orientation, frac, key) triples; key(b_x, b_y) in {0, 1}
    induces the two-region partition for the round-37 split RSS."""
    cands = []
    for f in LADDER:
        xc = f * cols
        cands.append(('vert', f, (lambda c: (lambda x, y: x >= c))(xc)))
    for f in LADDER:
        yc = f * rows
        cands.append(('horz', f, (lambda c: (lambda x, y: y >= c))(yc)))
    return cands


def localize_boundary(frames, cols, rows, search=4, blocks=12):
    """Recover the single best (orientation, position) boundary over the fixed dyadic ladder, by the
    round-37 quantization-robust gain. Glass-box: returns the full per-candidate gain grid so the choice is
    auditable, not a bare answer."""
    bx, by, fx, fy, wt = MR._block_flow(frames, cols, rows, search=search, blocks=blocks)
    rss_one, w_sum, flow_scale = MR._conformal_rss(bx, by, fx, fy, wt)
    if w_sum <= 0 or rss_one <= MR.EPS:
        return {'gain': 0.0, 'orientation': None, 'frac': None, 'rss_one': round(rss_one, 4),
                'rss_two': round(rss_one, 4), 'grid': [], 'blocks': len(wt), 'degenerate': True}
    best_gain = 0.0; best_orient = None; best_frac = None; best_rss2 = rss_one
    grid = []
    for orient, f, key in _candidates(cols, rows):
        rss_two = MR._split_rss(bx, by, fx, fy, wt, key)
        gain = 1.0 - rss_two / rss_one
        grid.append((orient, f, round(max(0.0, gain), 4)))
        if gain > best_gain:
            best_gain = gain; best_orient = orient; best_frac = f; best_rss2 = rss_two
    return {'gain': round(max(0.0, best_gain), 4), 'orientation': best_orient, 'frac': best_frac,
            'rss_one': round(rss_one, 4), 'rss_two': round(best_rss2, 4),
            'flow_scale': round(flow_scale, 4), 'grid': grid, 'blocks': len(wt), 'degenerate': False}


def _crop(frames, cols, rows, i0, i1, j0, j1):
    """Extract the rectangular sub-frame [i0:i1) x [j0:j1) from every frame; returns (frames, w, h). Pure
    row-slice copy, inputs untouched -- each crop carries ONLY its region's genuine pixels (hence motion)."""
    w = i1 - i0; h = j1 - j0
    out = []
    for fr in frames:
        g = [0.0] * (w * h)
        for j in range(h):
            src = (j0 + j) * cols + i0
            g[j * w:(j + 1) * w] = fr[src:src + w]
        out.append(g)
    return out, w, h


def parse_regions(frames, cols, rows, search=4, blocks=12, thr=MR.COMPOSITE_GAIN_THR):
    """The full honest parse. If no boundary clears round-37's gate, classify the WHOLE frame with the
    locked classifier (single field). Otherwise crop along the recovered boundary and classify each side
    with the SAME locked motion_class, yielding e.g. {left: pan, right: zoom, split: vert@0.5}."""
    loc = localize_boundary(frames, cols, rows, search=search, blocks=blocks)
    res = dict(loc)
    res['thr'] = thr
    res['composite'] = (not loc['degenerate']) and loc['gain'] >= thr
    if not res['composite']:
        whole = MC.classify(frames, cols, rows, search=search, blocks=blocks)
        res['regions'] = [{'span': 'whole', 'cls': whole['cls'], 'confidence': whole['confidence'],
                           'coherence': whole['coherence']}]
        return res
    orient = loc['orientation']; f = loc['frac']
    if orient == 'vert':
        xc = max(1, min(cols - 1, int(round(f * cols))))
        a, wa, ha = _crop(frames, cols, rows, 0, xc, 0, rows)
        b, wb, hb = _crop(frames, cols, rows, xc, cols, 0, rows)
        span_a, span_b = 'left', 'right'
    else:
        yc = max(1, min(rows - 1, int(round(f * rows))))
        a, wa, ha = _crop(frames, cols, rows, 0, cols, 0, yc)
        b, wb, hb = _crop(frames, cols, rows, 0, cols, yc, rows)
        span_a, span_b = 'top', 'bottom'
    ca = MC.classify(a, wa, ha, search=search, blocks=blocks)
    cb = MC.classify(b, wb, hb, search=search, blocks=blocks)
    res['regions'] = [
        {'span': span_a, 'cls': ca['cls'], 'confidence': ca['confidence'], 'coherence': ca['coherence']},
        {'span': span_b, 'cls': cb['cls'], 'confidence': cb['confidence'], 'coherence': cb['coherence']},
    ]
    return res
