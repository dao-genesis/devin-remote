"""Round-34: recover the axis the conformal fit throws away -- the ANISOTROPIC (shear) part of the
local Jacobian -- and falsifiably test whether a PERSPECTIVE tilt carries it where a FLAT rotation
does not.

Round-29..33 settled an honest 3-way external taxonomy {pan, rotation, zoom}: pan = translation
(coherent), zoom = divergence, rotation = curl. But the 4 lab gestures collapse onto 3 classes
because flat-spin (#webspin) and perspective-tilt (#webtilt) are NOT pixel-separable at every key we
have measured (round-29 cos(flat-rot, persp-rot) = 0.999; both read as pure curl). That 3-vs-4 gap is
the standing honest boundary.

WHY they might still be separable -- a falsifiable mechanism. `vmodel.flow_structure` /
`flow_roi.flow_structure_roi` fit the field to a CONFORMAL model  f = a + s*(r-rbar) + w*perp(r-rbar):
4 DOF = translation(2) + isotropic scale s + rotation w. A conformal map has, by construction, ZERO
shear. The full local field is an AFFINE map  f = a + J*(r-rbar)  with a 2x2 Jacobian J (6 DOF). Decompose
J into its irreducible parts:
    div     = (Jxx + Jyy)/2      isotropic scale      (already measured: zoom)
    curl    = (Jyx - Jxy)/2      rotation             (already measured: rotation)
    shear_n = (Jxx - Jyy)/2      normal strain        (axial stretch difference)  <-- conformal throws away
    shear_t = (Jxy + Jyx)/2      shear strain         (off-axis shear)            <-- conformal throws away
    shear   = sqrt(shear_n^2 + shear_t^2)             the ANISOTROPIC magnitude
A flat bearing rotation IS a pure rotation matrix -> div=0, curl=theta, shear=0. A perspective PITCH
change is NOT conformal: the ground plane foreshortens -- rows near the horizon compress harder than
rows near the camera -- which is exactly a non-uniform (anisotropic) vertical scale, i.e. nonzero
shear_n. So the conformal fit is BLIND to the one thing that physically distinguishes a tilt from a
spin; the full-affine fit is not.

This module is the clean control: it reuses the round-32 INTERIOR-ONLY block field (so the round-30/31
border bias is already removed -- only blocks with full overlap at every +/-search enter the fit) and
reuses `vmodel._block_ssd`. The ONLY change from flow_structure_roi is the MODEL: a full affine LSQ
instead of a 4-DOF conformal one. The signature grows from [T,|D|,|C|] to [T,|D|,|C|,shear].

FALSIFIABLE TEST (test_flow_affine.py + practice_webtilt_aniso.py):
  - synthetic: a pure rotation reads shear ~ 0; a deliberate anisotropic scale reads shear >> 0.
  - live external: if #webtilt's interior shear is materially larger than #webspin's AND the 4-vectors
    cosine-separate (cos < 0.6) where the 3-vectors did not, the honest taxonomy recovers a 4th class
    {pan, flat-rot, persp-rot, zoom}. If the shear is noise-level for BOTH (or both tilt AND spin carry
    it equally), 3-way is the TRUE external ceiling and we report that, unforced (wei zhe bai zhi).

PURELY ADDITIVE: NEW module; vmodel.py and flow_roi.py are byte-for-byte unchanged, so every locked
invariant (footprint / gain / dyn coherence / conformal flow_structure / interior ROI) stands.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vmodel as V

_ssd = V._block_ssd


def _solve2(a11, a12, a22, b1, b2):
    """Closed-form solve of the symmetric 2x2 system [[a11,a12],[a12,a22]] x = [b1,b2]."""
    det = a11 * a22 - a12 * a12
    if abs(det) < 1e-12:
        return 0.0, 0.0
    return (b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det


def flow_structure_affine(frames, cols, rows, search=4, blocks=8):
    """Interior-only FULL-AFFINE twin of flow_structure_roi. Same interior block field (border bias
    already removed), but fit f = a + J*(r-rbar) and read the full Jacobian decomposition
    [translation, divergence, curl, shear]. `shear` is the anisotropic magnitude the conformal fit
    discards. Returns a 4-vector 'sig' plus raw components and kept/dropped counts."""
    fx = []; fy = []; bx = []; by = []; wt = []
    kept = 0; dropped = 0
    for k in range(1, len(frames)):
        pre = frames[k - 1]; cur = frames[k]
        for bj in range(blocks):
            j0 = bj * rows // blocks; j1 = max(j0 + 1, (bj + 1) * rows // blocks)
            for bi in range(blocks):
                i0 = bi * cols // blocks; i1 = max(i0 + 1, (bi + 1) * cols // blocks)
                # round-32 interior test: full overlap at every candidate shift -> zero border bias.
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
    empty = {'sig': [0.0, 0.0, 0.0, 0.0], 'trans': 0.0, 'div': 0.0, 'curl': 0.0, 'shear': 0.0,
             'shear_n': 0.0, 'shear_t': 0.0, 'blocks': len(wt), 'kept': kept, 'dropped': dropped}
    if w_sum <= 0 or not wt:
        return empty
    # Weighted centroid of positions and field (centring decouples the intercept a = field mean).
    xbar = sum(b * w for b, w in zip(bx, wt)) / w_sum
    ybar = sum(b * w for b, w in zip(by, wt)) / w_sum
    fxb = sum(f * w for f, w in zip(fx, wt)) / w_sum
    fyb = sum(f * w for f, w in zip(fy, wt)) / w_sum
    trans = math.sqrt(fxb * fxb + fyb * fyb)
    # Full affine: fit each field component to its own 2-param weighted regression on centred positions.
    #   fx - fxb = Jxx*px + Jxy*py ;  fy - fyb = Jyx*px + Jyy*py
    Sxx = Sxy = Syy = 0.0
    bxfx = byfx = bxfy = byfy = 0.0
    for f_x, f_y, b_x, b_y, w in zip(fx, fy, bx, by, wt):
        px = b_x - xbar; py = b_y - ybar
        gx = f_x - fxb; gy = f_y - fyb
        Sxx += w * px * px; Sxy += w * px * py; Syy += w * py * py
        bxfx += w * px * gx; byfx += w * py * gx
        bxfy += w * px * gy; byfy += w * py * gy
    Jxx, Jxy = _solve2(Sxx, Sxy, Syy, bxfx, byfx)
    Jyx, Jyy = _solve2(Sxx, Sxy, Syy, bxfy, byfy)
    div = (Jxx + Jyy) / 2.0
    curl = (Jyx - Jxy) / 2.0
    shear_n = (Jxx - Jyy) / 2.0
    shear_t = (Jxy + Jyx) / 2.0
    shear = math.sqrt(shear_n * shear_n + shear_t * shear_t)
    # Scale the dimensionless rate components by the field RMS radius so they share T's pixel units.
    rms = math.sqrt(max(0.0, sum(w * ((b_x - xbar) ** 2 + (b_y - ybar) ** 2)
                                 for b_x, b_y, w in zip(bx, by, wt)) / w_sum))
    D = abs(div) * rms; C = abs(curl) * rms; S = shear * rms
    return {'sig': [round(x, 4) for x in V._l2([trans, D, C, S])],
            'trans': round(trans, 3), 'div': round(D, 3), 'curl': round(C, 3), 'shear': round(S, 3),
            'shear_n': round(shear_n * rms, 3), 'shear_t': round(shear_t * rms, 3),
            'blocks': len(wt), 'kept': kept, 'dropped': dropped}
