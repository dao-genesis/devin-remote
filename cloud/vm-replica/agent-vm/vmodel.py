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


def context_inv(gray, cols, rows, out=6):
    """A rotation/translation-ROBUST perceptual fingerprint of a surface (round-25).

    `context_fp` is spatially indexed (cell i,j carries gray/edge at that location), so when a surface
    transforms ITSELF -- an orbit cube spins, a panned map slides -- the same content lands in
    different cells and the cosine to a stored fingerprint collapses. That is why a gain calibration
    keyed on `context_fp` could not be re-used on the next encounter with a self-transforming surface
    (doc 09 round-24).

    The fix is an ORDER-STATISTIC descriptor: pool to out*out, mean-centre, then SORT the values.
    Sorting is permutation-invariant, so rotating/translating the content (which, at pooled-cell
    resolution, mostly permutes which cell holds which value) leaves the sorted profile nearly
    unchanged -- while still keeping the full quantile shape, so genuinely different surfaces (a small
    bright cube on dark vs a bright full canvas vs a thin bottom strip) stay far apart. Gray quantiles
    say HOW the brightness is distributed; edge quantiles say HOW MUCH structure there is. Concatenated
    and L2-normalised, this is the key under which a measured gain survives the surface moving."""
    gq = sorted(_center(_pool(gray, cols, rows, out)))
    eq = sorted(_pool(_grad_mag(gray, cols, rows), cols, rows, out))
    return _l2(gq + eq)


def context_radial(gray, cols, rows, rings=5):
    """Round-25, second attempt: a centroid-anchored RADIAL energy profile -- invariant to a surface
    moving itself, yet still sensitive to its layout.

    The order-statistic key (`context_inv`) was measured to be TOO invariant: it discards layout
    entirely, so a small cube, a panned map and a timeline strip (similar brightness *distributions*,
    different *shapes*) collapsed to cosine ~0.9 and a gain would leak across surfaces. The opposite
    failure of `context_fp` is being too rigid (a spinning cube shifts every cell).

    The middle path: anchor at the content's own CENTRE OF MASS, then bin energy into concentric
    RINGS by distance from it. Rotating the content about its centre permutes WITHIN a ring (ring sums
    unchanged); translating it moves the centroid WITH it (rings unchanged) -- so the profile is stable
    under the surface's self-motion. But the radial SHAPE still differs by surface: a compact cube
    concentrates energy in the inner rings, a space-filling map spreads it out, a thin strip is
    lopsided -- so different surfaces stay separated. We profile both edge energy (structure) and
    |gray - mean| (contrast mass). L2-normalised. Mass for the centroid is the edge map (robust to a
    uniform background)."""
    g = _grad_mag(gray, cols, rows)
    m = sum(gray) / len(gray) if gray else 0.0
    contrast = [abs(v - m) for v in gray]
    sw = sx = sy = 0.0
    for j in range(rows):
        for i in range(cols):
            w = g[j * cols + i]
            sw += w; sx += w * i; sy += w * j
    if sw <= 0:
        return _l2([0.0] * (2 * rings))
    ccx = sx / sw; ccy = sy / sw
    rmax = math.sqrt(max((max(ccx, cols - 1 - ccx)) ** 2 + (max(ccy, rows - 1 - ccy)) ** 2, 1e-6))
    edge_r = [0.0] * rings; con_r = [0.0] * rings
    for j in range(rows):
        for i in range(cols):
            d = math.sqrt((i - ccx) ** 2 + (j - ccy) ** 2) / rmax
            b = min(rings - 1, int(d * rings))
            o = j * cols + i
            edge_r[b] += g[o]; con_r[b] += contrast[o]
    return _l2([x for x in edge_r] + [x for x in con_r])


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


def _ssd_shift(pre, cur, cols, rows, dx, dy):
    """Sum of squared differences between cur and pre shifted by (dx,dy), over the overlap only,
    returned as a per-pixel mean (so different overlap sizes stay comparable)."""
    ss = 0.0; n = 0
    for j in range(rows):
        jj = j - dy
        if jj < 0 or jj >= rows:
            continue
        for i in range(cols):
            ii = i - dx
            if ii < 0 or ii >= cols:
                continue
            d = cur[j * cols + i] - pre[jj * cols + ii]
            ss += d * d; n += 1
    return (ss / n) if n else None


def motion_signature(frames, cols, rows, px_w=1.0, px_h=1.0, search=5):
    """The action->response DYNAMIC signature (round-26): does ONE rigid global shift re-align the
    frame after the gesture, or not?

    Round-25 proved no static appearance key can separate look-alike surfaces (orbit and pan are nearly
    identical snapshots: every static descriptor reads cross-cosine >= 0.96), so a gain calibration
    keyed on appearance leaks between them and had to be healed AFTER the fact. What truly tells them
    apart is HOW THEY RESPOND to the same drag: a panned grid TRANSLATES rigidly, so a single global
    shift maps one sub-frame onto the next; an orbited cube ROTATES, so no single shift re-aligns it.

    Two earlier flow models were built and MEASURED to fail here, and the failures shaped this design:
    (1) per-block Lucas-Kanade gave residual-dominated noise on the sparse wireframe (orbit~pan dynamic
    cosine 0.962, no better than static); (2) a global differential affine fit collapsed because the
    per-sub-frame displacement is supra-pixel (~1.4 cells), which violates the brightness-constancy
    linearisation -- translation explained ~0 for BOTH. The honest fix is a NON-differential test:
    block-match. For each consecutive sub-frame pair we search integer shifts in +/- `search` cells for
    the one minimising SSD, and read coherence = 1 - SSD_best / SSD_zero (how much a rigid shift reduces
    misalignment, weighted by motion amount). A pan re-aligns almost perfectly (coherence -> 1); an orbit
    barely improves (coherence -> 0). The signature is the L2-normalised pair [coherence, incoherence]:
    a pan points to ~[1,0], an orbit to ~[0,1], so their cosine collapses well below the gain-borrow
    threshold. As a second dimension of the calibration key this separates orbit from pan a priori, so a
    gain is borrowed only across surfaces that both LOOK and MOVE alike -- no post-hoc self-heal."""
    coh_w = 0.0; w_sum = 0.0; sdx = 0.0; sdy = 0.0; pairs = 0
    for k in range(1, len(frames)):
        pre = frames[k - 1]; cur = frames[k]
        base = _ssd_shift(pre, cur, cols, rows, 0, 0)
        if base is None or base < 1e-6:
            continue
        best = base; bdx = 0; bdy = 0
        for dy in range(-search, search + 1):
            for dx in range(-search, search + 1):
                if dx == 0 and dy == 0:
                    continue
                ss = _ssd_shift(pre, cur, cols, rows, dx, dy)
                if ss is not None and ss < best:
                    best = ss; bdx = dx; bdy = dy
        coh = max(0.0, 1.0 - best / base)
        coh_w += coh * base; w_sum += base; sdx += bdx * base; sdy += bdy * base; pairs += 1
    empty = {'sig': [0.0, 0.0], 'coherence': 0.0, 'shift': [0.0, 0.0], 'pairs': pairs}
    if w_sum <= 0 or pairs == 0:
        return empty
    coh = coh_w / w_sum
    return {'sig': [round(x, 4) for x in _l2([coh, max(0.0, 1.0 - coh)])],
            'coherence': round(coh, 3), 'shift': [round(sdx / w_sum, 2), round(sdy / w_sum, 2)],
            'pairs': pairs}


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
        self.cal = []  # per-surface gain calibrations: {'a', 'ctx', 'gain'} (round-24)
        if path and os.path.exists(path):
            try:
                data = json.load(open(path, 'r', encoding='utf-8'))
                if isinstance(data, dict):  # round-24 format: episodes + calibrations
                    self.ep = data.get('ep', []); self.cal = data.get('cal', [])
                else:  # legacy format: a bare list of episodes
                    self.ep = data
            except Exception:
                self.ep = []; self.cal = []

    def record(self, action_key, ctx, desc):
        self.ep.append({'a': action_key, 'ctx': ctx, 'd': desc})

    def calibrate(self, action_key, ctx, obs, cal_ctx=None, dyn=None):
        """Record this surface's LOCAL GAIN for an action from a single observation (round-24/25/26).

        Round-23 proved magnitude is surface-specific gain, so cross-surface transfer can only trust
        the gain-invariant footprint and must flag gain_known=False. But the act of verifying ALREADY
        moved this surface and measured its response -- that one observation IS the gain. Storing it
        lets the NEXT prediction here use the measured gain instead of an incommensurable cross-surface
        average, flipping gain_known False->True with zero extra actions and zero vision: the verifying
        drag doubles as the calibration probe (active inference).

        Round-25: the calibration is keyed on `cal_ctx`, a MOTION-INVARIANT descriptor (context_radial),
        not the spatially-rigid context_fp -- so a measured gain survives the surface transforming
        ITSELF (a spinning orbit cube, a sliding pan map), which round-24 could not.

        Round-26: an optional `dyn` (the action->response motion_signature) becomes a SECOND dimension
        of the key. The radial key cannot tell look-alike surfaces apart (orbit vs pan), but their
        DYNAMICS differ, so two surfaces that look alike but move differently now get DISTINCT entries
        (dedup requires both the static key AND the dynamic signature to agree) and a gain is reused
        across an encounter only when BOTH match -- separating orbit from pan a priori, no self-heal."""
        key = cal_ctx if cal_ctx is not None else ctx
        self.cal = [c for c in self.cal
                    if not (c.get('a') == action_key and cos(key, c.get('ctx') or []) >= 0.98
                            and (dyn is None or not c.get('dyn') or cos(dyn, c.get('dyn')) >= 0.9))]
        rec = {'a': action_key, 'ctx': key, 'gain': obs['mag']}
        if dyn is not None:
            rec['dyn'] = dyn
        self.cal.append(rec)

    def _best_cal(self, action_key, ctx, dyn=None):
        """Nearest stored gain calibration for this action: (gain, combined_sim) or (None, 0.0).

        Round-26: when both the query and a stored calibration carry a motion signature `dyn`, the
        match similarity is the WEAKER of the static (appearance) and dynamic (action->response)
        cosines -- so a stored orbit gain (rotational dyn) will NOT be borrowed by a pan probe
        (translational dyn) even though their appearance keys are near-identical. Backward compatible:
        if either side lacks `dyn`, similarity is the static cosine alone (round-25 behaviour)."""
        best = None; bs = -1.0
        for c in self.cal:
            if c.get('a') != action_key:
                continue
            s = cos(ctx, c.get('ctx') or []) if ctx is not None else 1.0
            cdyn = c.get('dyn')
            if dyn is not None and cdyn:
                s = min(s, cos(dyn, cdyn))
            if s > bs:
                bs = s; best = c
        return (best['gain'], bs) if best is not None else (None, 0.0)

    def save(self):
        if self.path:
            json.dump({'ep': self.ep, 'cal': self.cal}, open(self.path, 'w', encoding='utf-8'))

    def seen(self, action_key):
        return sum(1 for e in self.ep if e['a'] == action_key)

    def predict(self, action_key, ctx=None, cal_ctx=None, dyn=None, k=8, cal_thr=0.6):
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
        pred = {'mag': mag / n, 'cx': cx / n, 'cy': cy / n, 'aniso': aniso / n, 'fp': fp, 'sfp': sfp,
                'n': n, 'ctx_sim': round(ctx_sim, 3)}
        # round-24: if this surface has been locally gain-calibrated, replace the (incommensurable)
        # cross-surface average magnitude with the MEASURED surface gain, so a transfer can be held to
        # a real size again. ctx_sim still reflects episode provenance (transfer stays honest); the
        # calibration only supplies the gain we physically measured here.
        cal_gain, cal_sim = (None, 0.0)
        cal_key = cal_ctx if cal_ctx is not None else ctx
        if cal_key is not None and self.cal:
            cal_gain, cal_sim = self._best_cal(action_key, cal_key, dyn=dyn)
        calibrated = cal_gain is not None and cal_sim >= cal_thr
        if calibrated:
            pred['mag'] = cal_gain
        pred['calibrated'] = calibrated; pred['cal_sim'] = round(cal_sim, 3)
        return pred

    def verify(self, action_key, ctx, obs, cal_ctx=None, dyn=None, fp_thr=0.8, mag_tol=0.5, locus_tol=0.18, mag_floor=0.0):
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
        pred = self.predict(action_key, ctx, cal_ctx=cal_ctx, dyn=dyn)
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
        # round-24: gain is known on a FAMILIAR surface (interpolation) OR once a transfer surface has
        # been locally calibrated. When gain is known we hold the effect to a real SIZE again; on an
        # un-calibrated transfer presence stays gain-invariant (shape only) and gain is flagged unknown.
        calibrated = bool(pred.get('calibrated'))
        gain_known = (not transfer) or calibrated
        if gain_known:
            present = shape_present and (mag_ratio <= mag_tol)
        else:
            present = shape_present
        match = present and (locus_diff <= locus_tol)
        return {'known': True, 'match': match, 'present': present, 'transfer': transfer,
                'shape_present': shape_present, 'gain_known': gain_known,
                'calibrated': calibrated, 'cal_sim': pred.get('cal_sim', 0.0),
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
