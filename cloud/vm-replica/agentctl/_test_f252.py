"""F252 — classify_grid: read a lattice of sprites against a template library.

The appearance counterpart of ocr_grid (text) and sample_grid (colour). A chess
square, a mahjongg face, a minesweeper icon is neither text nor a single colour:
sample_grid sees only that a piece is present and its shade (a black rook and a
black queen sample to the same luma), and ocr_grid reads nothing from a non-text
glyph. The floor had only the single-patch match_template, so reading a board of
sprites meant hand-rolling the same per-cell loop. classify_grid divides the
board with the exact sample_grid/ocr_grid geometry (or detect_grid's true xs/ys
edges), gates each cell on ink (blanks -> empty_label, never scored), and scores
the rest against a labelled template library by mean-abs-diff per pixel on a
fixed-size resample -- so a sprite on a light cell still matches one harvested
from a dark cell, and unequal cell sizes stay comparable.

Pure-Python, no display: classify_grid is self-contained pixel maths, so the
test paints buffers and asserts on the labels directly.
"""
import osctl


def _draw(buf, w, cx, cy, shape, ink=(25, 25, 25)):
    """Paint one sprite, centred on (cx, cy), with internal contrast so the ink
    gate trips: a vertical bar, a horizontal bar, or a hollow box."""
    def px(xx, yy):
        i = (yy * w + xx) * 3
        buf[i], buf[i + 1], buf[i + 2] = ink

    if shape == "vbar":
        for yy in range(cy - 12, cy + 12):
            for xx in range(cx - 3, cx + 4):
                px(xx, yy)
    elif shape == "hbar":
        for yy in range(cy - 3, cy + 4):
            for xx in range(cx - 12, cx + 12):
                px(xx, yy)
    elif shape == "box":
        for yy in range(cy - 10, cy + 11):
            for xx in range(cx - 10, cx + 11):
                if (xx < cx - 7 or xx > cx + 7 or yy < cy - 7 or yy > cy + 7):
                    px(xx, yy)
    elif shape == "diag":
        for d in range(-12, 12):
            for t in range(3):
                px(cx + d, cy + d + t)


def _paint(w, h, bbox, cols, rows, shapes, bg=200, ink=(25, 25, 25),
           xs=None, ys=None):
    """w*h RGB buffer: uniform `bg`, then a sprite in each (r,c) in `shapes`.
    Cells tile bbox like sample_grid, or use xs/ys edges when given."""
    buf = bytearray(bytes((bg,)) * (w * h * 3))
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    for (r, c), shape in shapes.items():
        cx0 = xs[c] if xs else x0 + c * cw
        cx1 = xs[c + 1] if xs else x0 + (c + 1) * cw
        cy0 = ys[r] if ys else y0 + r * ch
        cy1 = ys[r + 1] if ys else y0 + (r + 1) * ch
        _draw(buf, w, int((cx0 + cx1) / 2), int((cy0 + cy1) / 2), shape, ink)
    return bytes(buf)


def _templates(buf, w, h, bbox, cols, rows, spec):
    """Harvest (label, patch, pw, ph) full-cell crops from known (r,c) cells --
    the documented idiom (crop a known frame once, classify every later board)."""
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    out = []
    for label, (r, c) in spec.items():
        box = (int(x0 + c * cw), int(y0 + r * ch),
               int(x0 + (c + 1) * cw) - 1, int(y0 + (r + 1) * ch) - 1)
        patch, pw, ph = osctl.crop_rgb(buf, (w, h), box)
        out.append((label, patch, pw, ph))
    return out


def main():
    w, h = 200, 200
    cols, rows = 4, 4
    bbox = (10, 10, 169, 169)            # 160x160, 40px cells

    # 1) classify a lattice of sprites against a harvested library; blanks gate
    #    out to empty_label and only placed cells get a label.
    placed = {(0, 1): "vbar", (1, 2): "hbar", (2, 0): "box", (3, 3): "vbar"}
    buf = _paint(w, h, bbox, cols, rows, placed)
    spec = {"vbar": (0, 1), "hbar": (1, 2), "box": (2, 0)}
    templates = _templates(buf, w, h, bbox, cols, rows, spec)
    grid = osctl.classify_grid(bbox, cols, rows, templates, rgb=buf, size=(w, h),
                               empty_label=".")
    assert len(grid) == rows and all(len(r) == cols for r in grid), "shape rows x cols"
    for r in range(rows):
        for c in range(cols):
            want = placed.get((r, c), ".")
            assert grid[r][c] == want, f"cell ({r},{c}) want {want!r} got {grid[r][c]!r}"

    # 2) shade-invariance (the chess-checkerboard insight): the same sprite over a
    #    different background shade still matches the template harvested elsewhere.
    #    Row 0 is painted on a light bg (where templates come from); row 1 carries
    #    the same sprites on a much darker bg.
    buf2 = _paint(w, h, bbox, cols, rows,
                  {(0, 0): "vbar", (0, 1): "hbar"}, bg=205)
    # darken row 1's band and add the same sprites there.
    b2 = bytearray(buf2)
    y_lo = int(10 + 1 * (160 / 4)); y_hi = int(10 + 2 * (160 / 4))
    for yy in range(y_lo, y_hi):
        for xx in range(10, 170):
            i = (yy * w + xx) * 3
            if b2[i] > 120:                # only the background, not the ink
                b2[i] = b2[i + 1] = b2[i + 2] = 110
    _row1 = _paint(w, h, bbox, cols, rows, {(1, 0): "vbar", (1, 1): "hbar"}, bg=110)
    for yy in range(y_lo, y_hi):           # stamp row1 sprites onto the dark band
        for xx in range(10, 170):
            i = (yy * w + xx) * 3
            if _row1[i] < 80:
                b2[i] = b2[i + 1] = b2[i + 2] = 25
    spec2 = {"vbar": (0, 0), "hbar": (0, 1)}
    templates2 = _templates(bytes(buf2), w, h, bbox, cols, rows, spec2)
    grid2 = osctl.classify_grid(bbox, cols, rows, templates2, rgb=bytes(b2),
                                size=(w, h), empty_label=".")
    assert grid2[1][0] == "vbar", f"vbar on a dark cell still matches: {grid2[1][0]!r}"
    assert grid2[1][1] == "hbar", f"hbar on a dark cell still matches: {grid2[1][1]!r}"

    # 3) max_score: an off-library sprite is flagged unknown when the strictness
    #    is tight, but forced to its nearest label when max_score is None.
    buf3 = _paint(w, h, bbox, cols, rows, {(0, 0): "diag"})
    g_strict = osctl.classify_grid(bbox, cols, rows, templates, rgb=buf3,
                                   size=(w, h), empty_label=".",
                                   max_score=8, unknown_label="?")
    assert g_strict[0][0] == "?", f"off-library sprite flagged unknown: {g_strict[0][0]!r}"
    g_loose = osctl.classify_grid(bbox, cols, rows, templates, rgb=buf3,
                                  size=(w, h), empty_label=".")
    assert g_loose[0][0] in ("vbar", "hbar", "box"), \
        f"with no threshold an argmin label is forced, got {g_loose[0][0]!r}"

    # 4) exact-edge mode (xs/ys): a non-uniform pitch is classified off the true
    #    edges, and the fixed-size resample keeps unequal cells comparable.
    xs = [10, 60, 95, 140, 170]          # deliberately uneven columns
    ys = [10, 50, 95, 135, 170]
    buf4 = _paint(w, h, bbox, cols, rows, {(2, 1): "box", (1, 3): "vbar"},
                  xs=xs, ys=ys)
    # harvest templates off the same uneven edges so geometry matches.
    def _tmpl_xy(label, r, c):
        box = (xs[c], ys[r], xs[c + 1] - 1, ys[r + 1] - 1)
        patch, pw, ph = osctl.crop_rgb(buf4, (w, h), box)
        return (label, patch, pw, ph)
    templates4 = [_tmpl_xy("box", 2, 1), _tmpl_xy("vbar", 1, 3)]
    grid4 = osctl.classify_grid(bbox, cols, rows, templates4, rgb=buf4,
                                size=(w, h), xs=xs, ys=ys, empty_label=".")
    assert grid4[2][1] == "box", f"box on uneven pitch read via xs/ys: {grid4[2][1]!r}"
    assert grid4[1][3] == "vbar", f"vbar on uneven pitch read via xs/ys: {grid4[1][3]!r}"

    # 5) arg validation
    ok = templates
    bad = [
        dict(cols=0, rows=rows, templates=ok),
        dict(cols=cols, rows=0, templates=ok),
        dict(cols=cols, rows=rows, templates=ok, inset=0.5),
        dict(cols=cols, rows=rows, templates=ok, ink_min=0),
        dict(cols=cols, rows=rows, templates=ok, norm=0),
        dict(cols=cols, rows=rows, templates=[]),                 # empty library
        dict(cols=cols, rows=rows, templates=[("x", b"\0\0\0", 2, 2)]),  # bad patch len
        dict(cols=cols, rows=rows, templates=[("x", b"\0\0\0", 1, 1)], max_score=-1),
        dict(cols=cols, rows=rows, templates=ok, xs=[1, 2, 3]),   # wrong length
        dict(cols=cols, rows=rows, templates=ok, ys=[1, 2, 3]),   # wrong length
        dict(cols=cols, rows=rows, templates=ok, rgb=buf, size=None),  # rgb w/o size
    ]
    for kw in bad:
        try:
            osctl.classify_grid(bbox, **kw)
            assert False, f"expected ValueError for {kw}"
        except ValueError:
            pass

    print("F252 OK: classify_grid scores each inked cell against a template "
          "library (blanks -> empty_label, never scored), is shade-invariant "
          "(a sprite on a light cell matches one harvested from a dark cell), "
          "flags off-library sprites via max_score, classifies on detect_grid's "
          "true xs/ys edges, and validates args")


if __name__ == "__main__":
    main()
