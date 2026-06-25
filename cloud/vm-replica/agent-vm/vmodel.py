"""Visual world model -- a model-free, PIXEL-ONLY forward model that GROWS from practice.

Motivation (the root critique): semantic adapters (HWND/UIA/DOM) are blind to strong-GUI apps
-- 3D modelling, video editing, painting, games -- whose whole surface is a custom-drawn canvas
with no accessibility tree and CONTINUOUS control. There the only universal channel is what a
human actually uses: a mouse + keyboard acting on PIXELS. The hard part is not the action set
(it is tiny and universal) but the KERNEL: predict what an action will do, act to verify/approach
a goal, and update when surprised.

This module is the seed of that kernel. It does NOT hard-code any app. It accumulates episodes
of (perceptual context, action, observed local visual change) and, from that growing experience,
predicts the change a proposed action SHOULD produce and scores the actual outcome against it.
The architecture is meant to grow out of practice, not be fixed up front -- so this stays small
and empirical (nearest-neighbour over episodes), pure stdlib, zero deps, EXE-freezable.

Perception feature: a region's block-averaged gray grid (the same cheap signal the agent already
computes). Change descriptor: magnitude + centroid + an L2-normalised down-pooled |delta| field
("change fingerprint"). Prediction: average the fingerprints of past episodes with the same
action, weighted by context similarity. Verification: cosine similarity of predicted vs observed
fingerprint + magnitude agreement. High residual = genuine surprise (the only time we escalate).
"""
import json, math, os


def _pool(vec, cols, rows, out=4):
    """Average-pool a cols*rows field into out*out, returned flat (length out*out)."""
    res = [0.0] * (out * out)
    for oj in range(out):
        j0 = oj * rows // out; j1 = max(j0 + 1, (oj + 1) * rows // out)
        for oi in range(out):
            i0 = oi * cols // out; i1 = max(i0 + 1, (oi + 1) * cols // out)
            s = 0.0; n = 0
            for j in range(j0, j1):
                for i in range(i0, i1):
                    s += vec[j * cols + i]; n += 1
            res[oj * out + oi] = s / max(1, n)
    return res


def _l2(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def cos(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def _grad_mag(gray, cols, rows):
    """Per-cell gradient magnitude (|dx|+|dy|): an edge/structure map. Two surfaces with the same
    average brightness but different LAYOUT (a centred cube vs a full grid vs a bottom strip) differ
    here even when their pooled grays look alike."""
    g = [0.0] * (cols * rows)
    for j in range(rows):
        for i in range(cols):
            o = j * cols + i
            dx = gray[o + 1] - gray[o] if i + 1 < cols else 0.0
            dy = gray[o + cols] - gray[o] if j + 1 < rows else 0.0
            g[o] = abs(dx) + abs(dy)
    return g


def _center(v):
    m = sum(v) / len(v) if v else 0.0
    return [x - m for x in v]


def context_fp(gray, cols, rows, out=6):
    """A discriminative perceptual fingerprint of the current region: pooled grays (WHERE it is bright)
    plus pooled edge energy (WHERE the structure/layout is), each MEAN-CENTRED, then L2-normalised
    together. The earlier 4x4 gray-only fingerprint saturated (every dark canvas shares the same dark
    DC level, so cosine ~1 and the transfer/provenance signal was meaningless). Mean-centring removes
    that shared background so only STRUCTURE drives similarity: a centred cube, a full grid, a bottom
    timeline strip and a node box now read as different surfaces, making 'how familiar is this surface'
    a real signal instead of always ~1."""
    return _l2(_center(_pool(gray, cols, rows, out)) + _center(_pool(_grad_mag(gray, cols, rows), cols, rows, out)))


def _lk_flow(pre, cur, cols, rows):
    """Global Lucas-Kanade optical flow between two gray grids: least-squares motion (u,v) from
    spatial gradients (Ix,Iy) and the temporal difference (It). Returns (u,v,conf) where conf is the
    smaller eigenvalue proxy (gradient structure strength). Principled motion estimate, not a shape
    heuristic. u in cell-widths, v in cell-heights (caller may rescale to pixels for isotropy)."""
    sxx = sxy = syy = sxt = syt = 0.0
    for j in range(1, rows - 1):
        for i in range(1, cols - 1):
            o = j * cols + i
            ix = (cur[o + 1] - cur[o - 1]) * 0.5
            iy = (cur[o + cols] - cur[o - cols]) * 0.5
            it = cur[o] - pre[o]
            sxx += ix * ix; sxy += ix * iy; syy += iy * iy
            sxt += ix * it; syt += iy * it
    det = sxx * syy - sxy * sxy
    if abs(det) < 1e-6:
        return None
    u = -(syy * sxt - sxy * syt) / det
    v = -(sxx * syt - sxy * sxt) / det
    tr = sxx + syy
    conf = 0.5 * (tr - math.sqrt(max(0.0, tr * tr - 4 * det)))  # smaller eigenvalue
    return u, v, conf


def flow_axis(frames, cols, rows, px_w=1.0, px_h=1.0):
    """The honest fix for the rotate-vs-tilt boundary: a TEMPORAL cue. Given a sequence of gray grids
    captured DURING a continuous drag, accumulate per-sub-frame optical flow (Lucas-Kanade) and
    report the dominant motion AXIS.

    A single before/after pair cannot tell a horizontal rotate from a vertical tilt (same size, same
    locus; signed delta is phase-dependent). Across sub-frames the true motion has a stable axis:
    rotate moves features horizontally (|u| dominates), tilt vertically (|v|). px_w/px_h rescale cell
    units to pixels so non-square cells do not bias the axis. Returns axis in [-1,1]: >0 horizontal
    (rotate), <0 vertical (tilt); |axis| near 0 = ambiguous."""
    sx = sy = 0.0; pairs = 0
    for k in range(1, len(frames)):
        fl = _lk_flow(frames[k - 1], frames[k], cols, rows)
        if fl is None:
            continue
        u, v, conf = fl
        sx += abs(u * px_w) * conf; sy += abs(v * px_h) * conf; pairs += 1
    axis = (sx - sy) / (sx + sy) if (sx + sy) > 0 else 0.0
    return {'axis': round(axis, 3), 'sx': round(sx, 2), 'sy': round(sy, 2), 'pairs': pairs}


def change_descriptor(pre, cur, cols, rows, out=4):
    """Describe the local visual change between two gray grids: how much (mag), where (centroid),
    a magnitude fingerprint 'fp' (down-pooled |delta|, says SOMETHING happened here), and a SIGNED
    fingerprint 'sfp' (down-pooled cur-pre) -- the signed field encodes the DIRECTION/shape of the
    motion, so a horizontal rotate and a vertical tilt (same magnitude, different motion) separate.
    Practice on the canvas showed magnitude alone is direction-blind; the signed field fixes that."""
    d = [abs(c - p) for c, p in zip(cur, pre)]
    s = [c - p for c, p in zip(cur, pre)]
    mag = sum(d) / len(d) if d else 0.0
    sx = sy = sw = 0.0
    for j in range(rows):
        for i in range(cols):
            w = d[j * cols + i]
            sx += w * i; sy += w * j; sw += w
    cxc = (sx / sw) if sw > 0 else 0.0
    cyc = (sy / sw) if sw > 0 else 0.0
    cx = cxc / max(1, cols - 1)
    cy = cyc / max(1, rows - 1)
    # anisotropy of the change distribution: is the motion spread more horizontally or vertically?
    # This is PHASE-STABLE (depends on the motion axis, not the rotation phase) unlike signed delta,
    # so it can tell a horizontal rotate from a vertical tilt across the whole cycle.
    vx = vy = 0.0
    for j in range(rows):
        for i in range(cols):
            w = d[j * cols + i]
            vx += w * (i - cxc) ** 2; vy += w * (j - cyc) ** 2
    sdx = math.sqrt(vx / sw) if sw > 0 else 0.0
    sdy = math.sqrt(vy / sw) if sw > 0 else 0.0
    aniso = (sdx - sdy) / (sdx + sdy) if (sdx + sdy) > 0 else 0.0
    return {'mag': round(mag, 3), 'cx': round(cx, 3), 'cy': round(cy, 3), 'aniso': round(aniso, 3),
            'fp': [round(v, 4) for v in _l2(_pool(d, cols, rows, out))],
            'sfp': [round(v, 4) for v in _l2(_pool(s, cols, rows, out))]}


class WorldModel:
    """Growing episodic memory of (action -> visual effect), conditioned on perceptual context."""

    def __init__(self, path=None):
        self.path = path
        self.ep = []
        if path and os.path.exists(path):
            try:
                self.ep = json.load(open(path, 'r', encoding='utf-8'))
            except Exception:
                self.ep = []

    def record(self, action_key, ctx, desc):
        self.ep.append({'a': action_key, 'ctx': ctx, 'd': desc})

    def save(self):
        if self.path:
            json.dump(self.ep, open(self.path, 'w', encoding='utf-8'))

    def seen(self, action_key):
        return sum(1 for e in self.ep if e['a'] == action_key)

    def predict(self, action_key, ctx=None, k=8):
        """Expected change descriptor for an action in a context: context-weighted average of the
        fingerprints/magnitudes of past episodes with that action. None if never seen.

        For UNIVERSAL adaptability the action_key is a GENERIC gesture (e.g. 'drag', not
        'drag_right_in_app_X'), so episodes from every surface pool into one affordance. The returned
        'ctx_sim' (max cosine to any remembered context) is the honest provenance signal: high => this
        surface resembles ones already practiced (interpolation); low => the prediction is a TRANSFER
        extrapolated from dissimilar surfaces. We never fake certainty -- we report how far we reach."""
        cand = [e for e in self.ep if e['a'] == action_key]
        if not cand:
            return None
        ctx_sim = 1.0
        if ctx is not None:
            sims = [cos(ctx, e.get('ctx') or []) for e in cand]
            ctx_sim = max(sims) if sims else 0.0
            cand = [c for _, c in sorted(zip(sims, cand), key=lambda z: -z[0])][:k]
        n = len(cand)
        L = len(cand[0]['d']['fp'])
        fp = [0.0] * L; sfp = [0.0] * L
        mag = cx = cy = aniso = 0.0
        for e in cand:
            for i in range(L):
                fp[i] += e['d']['fp'][i]
                sfp[i] += e['d'].get('sfp', [0.0] * L)[i]
            mag += e['d']['mag']; cx += e['d']['cx']; cy += e['d']['cy']; aniso += e['d'].get('aniso', 0.0)
        fp = _l2([v / n for v in fp]); sfp = _l2([v / n for v in sfp])
        return {'mag': mag / n, 'cx': cx / n, 'cy': cy / n, 'aniso': aniso / n, 'fp': fp, 'sfp': sfp,
                'n': n, 'ctx_sim': round(ctx_sim, 3)}

    def verify(self, action_key, ctx, obs, fp_thr=0.8, mag_tol=0.5, locus_tol=0.18, mag_floor=0.0):
        """Score an observed outcome against the learned expectation for this action, using only the
        features practice proved PHASE-STABLE: magnitude (how much), fp (the |delta| footprint), and
        centroid (where). 'present' = an effect of the expected footprint occurred; 'match' also
        requires the SAME LOCUS. Both survive the full rotation cycle, so they reliably tell rotate
        (big, on the cube) from a no-op (nothing) from a paint elsewhere (different locus).

        GAIN INVARIANCE (the round-23 honesty fix): magnitude is an ABSOLUTE pixel-change amount and
        is therefore SURFACE-SPECIFIC GAIN -- the same drag yields a bright stroke on a paint canvas
        and a subtle shade shift on a 3D cube. A GENERIC affordance pools episodes from every surface,
        so its predicted magnitude is an average of incommensurable gains that matches no single
        surface; requiring obs to match it is provably wrong and was why cross-surface presence read
        0/5 even when the footprint clearly transferred. The footprint 'fp' is already L2-normalised,
        i.e. GAIN-INVARIANT: it says an effect of the right SHAPE happened regardless of sensitivity.
        So we split by regime: on a FAMILIAR surface (interpolation, high ctx_sim) the predicted
        magnitude is meaningful and a wrong size IS surprise -> presence still requires it. On a
        TRANSFER (low ctx_sim, extrapolating gain across unlike surfaces) presence is gain-invariant
        (shape + a non-noise effect) and the gain is flagged unknown rather than faked.

        Honest boundary found on the canvas: direction of a continuous motion (rotate vs tilt -- same
        size, same locus) is NOT decidable from one before/after pair by cheap features -- the signed
        delta is phase-DEPENDENT and anisotropy tracks object shape not motion. So 'direction' is
        reported advisory-only (sfp_sim/aniso_diff); deciding it needs temporal/flow or a vision
        escalation. known=False (novel action) is itself the genuine-surprise/escalation signal."""
        pred = self.predict(action_key, ctx)
        if pred is None:
            return {'known': False, 'match': False, 'reason': 'novel-action'}
        fp_sim = cos(pred['fp'], obs['fp'])
        sfp_sim = cos(pred.get('sfp') or [], obs.get('sfp') or [])
        denom = max(pred['mag'], obs['mag'], 1e-6)
        mag_ratio = abs(pred['mag'] - obs['mag']) / denom
        locus_diff = math.hypot(pred['cx'] - obs['cx'], pred['cy'] - obs['cy'])
        aniso_diff = abs(pred.get('aniso', 0.0) - obs.get('aniso', 0.0))
        ctx_sim = pred.get('ctx_sim', 1.0)
        transfer = ctx_sim < 0.6  # prediction extrapolated from surfaces unlike this one
        # gain-invariant: the right-shaped footprint occurred AND it was a real (non-noise) effect
        effect_happened = obs['mag'] >= mag_floor
        shape_present = (fp_sim >= fp_thr) and effect_happened
        gain_known = not transfer
        if transfer:
            present = shape_present
        else:
            present = shape_present and (mag_ratio <= mag_tol)
        match = present and (locus_diff <= locus_tol)
        return {'known': True, 'match': match, 'present': present, 'transfer': transfer,
                'shape_present': shape_present, 'gain_known': gain_known,
                'ctx_sim': ctx_sim, 'fp_sim': round(fp_sim, 3),
                'locus_diff': round(locus_diff, 3), 'mag_ratio': round(mag_ratio, 3),
                'aniso_diff': round(aniso_diff, 3), 'sfp_sim': round(sfp_sim, 3),
                'pred_mag': round(pred['mag'], 3), 'obs_mag': round(obs['mag'], 3), 'n': pred['n']}


def escalation_decision(v):
    """Turn a verify() result into the act-loop's perceive-more decision: WHEN is a cheap pixel check
    enough, and WHEN must we spend vision? This is the 'only escalate on genuine surprise' gate the
    whole pivot rests on -- not every step, only the ones the world model can't vouch for.
      surprise            : never seen this gesture here -> escalate (the real novelty trigger)
      low_confidence      : gesture recognised but the outcome is OFF its learned prior (size/footprint
                            wrong) -> escalate to look at what actually happened
      transfer_unverified : recognised AND the prior held, but extrapolated from unlike surfaces and we
                            could not confirm the precise outcome -> escalate (honest about reaching far)
      confident           : present on a familiar surface -> trust, ZERO vision
    Returns (label, escalate_bool)."""
    if not v.get('known'):
        return ('surprise', True)
    if not v.get('present'):
        return ('low_confidence', True)
    if v.get('transfer') and not v.get('match'):
        return ('transfer_unverified', True)
    return ('confident', False)
