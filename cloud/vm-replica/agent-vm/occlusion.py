"""Round-36: a faithful pixel model of a STATIC OVERLAY (HUD / popup / toolbar) covering part of the field.

Rounds 29-35 settled the honest external taxonomy {pan, rotation, zoom}, locked the interior-ROI keys,
wired them into the live act() path and proved them temporally consistent. The next untouched axis is
PARTIAL-FIELD ROBUSTNESS: real GUIs are not clean -- a fixed overlay (a floating toolbar, a tooltip, a
modal, the OS cursor) sits on top of the moving content and covers part of the observation window. Does
the honest 3-way class DEGRADE GRACEFULLY as more of the field is occluded, or does it BREAK -- and if so,
exactly where and why?

What IS a static overlay, in pixels? It is a region whose content is IDENTICAL in every frame -- it does
not move with the gesture underneath it. So its DEFINING property is ZERO inter-frame delta. We model it
faithfully by overwriting a rectangle of cells with frame[0]'s values in EVERY frame: that region then has
exactly zero change frame-to-frame, which is precisely what a fixed DOM overlay produces in the captured
pixels. (We use frame[0] rather than a flat constant so the occluded patch still carries realistic texture
/ DC level -- a flat fill would be a SECOND artificial signal; copying real pixels keeps it honest.)

This is PURELY ADDITIVE and READ-ONLY over the locked stack: it only rewrites a copy of the captured frame
buffers before they reach the byte-for-byte-unchanged vmodel / flow_roi / motion_class. No estimator math
or threshold is touched. The classifier already WEIGHTS every block by base = SSD-at-zero-shift and
flow_structure_roi DROPS any block with base < 1e-6, so an occluded (zero-delta) block contributes ~zero
weight and is naturally excluded -- this module exists to FALSIFIABLY measure whether that built-in
down-weighting really protects the class, and to find the occlusion geometry/fraction at which it fails.
"""


def occlude_rect(frames, cols, rows, i0, j0, i1, j1):
    """Return a DEEP COPY of `frames` with the cell rectangle [i0,i1) x [j0,j1) frozen to frame[0]'s values
    in every frame (zero inter-frame delta there) -- a faithful static-overlay model. Inputs unchanged."""
    i0 = max(0, int(i0)); j0 = max(0, int(j0)); i1 = min(cols, int(i1)); j1 = min(rows, int(j1))
    base = frames[0]
    out = [list(f) for f in frames]
    for f in out:
        for j in range(j0, j1):
            row = j * cols
            for i in range(i0, i1):
                f[row + i] = base[row + i]
    return out


def rect_corner(cols, rows, frac, corner='tl'):
    """A square occluder anchored in a CORNER, covering `frac` of the total area (side = sqrt(frac)*min)."""
    frac = max(0.0, min(1.0, float(frac)))
    side_i = int(round((frac ** 0.5) * cols)); side_j = int(round((frac ** 0.5) * rows))
    if 'l' in corner:
        i0, i1 = 0, side_i
    else:
        i0, i1 = cols - side_i, cols
    if 't' in corner:
        j0, j1 = 0, side_j
    else:
        j0, j1 = rows - side_j, rows
    return i0, j0, i1, j1


def rect_center(cols, rows, frac):
    """A square occluder CENTRED on the field (covers the transform anchor) -- the predicted worst case for
    curl/div, since removing the anchor surround leaves a one-sided field that mimics a pure translation."""
    frac = max(0.0, min(1.0, float(frac)))
    side_i = int(round((frac ** 0.5) * cols)); side_j = int(round((frac ** 0.5) * rows))
    i0 = (cols - side_i) // 2; j0 = (rows - side_j) // 2
    return i0, j0, i0 + side_i, j0 + side_j


def rect_band(cols, rows, frac, axis='left'):
    """A full-height / full-width BAND covering `frac` of the field from one edge (a docked side panel)."""
    frac = max(0.0, min(1.0, float(frac)))
    if axis in ('left', 'right'):
        w = int(round(frac * cols))
        return (0, 0, w, rows) if axis == 'left' else (cols - w, 0, cols, rows)
    h = int(round(frac * rows))
    return (0, 0, cols, h) if axis == 'top' else (0, rows - h, cols, rows)


def occluded_cell_count(cols, rows, i0, j0, i1, j1):
    """Cells actually frozen by this rectangle (clamped) -- for reporting the realised occlusion fraction."""
    i0 = max(0, i0); j0 = max(0, j0); i1 = min(cols, i1); j1 = min(rows, j1)
    return max(0, i1 - i0) * max(0, j1 - j0)
