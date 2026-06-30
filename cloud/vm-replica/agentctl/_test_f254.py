"""F254 — classify_boxes: read a *list of arbitrary boxes* against a library.

The lattice-free sibling of classify_grid. classify_grid reads a sprite board
only when it is a cols x rows lattice; many boards are not -- a mahjongg layout
is tiles stacked in offset 3-D layers, a klondike spread is cards at ragged
depths, a diffed frame yields change regions wherever they fell. The boxes are
already in hand (find_color_blobs segments the faces, detect_cascade gives the
faceup box per pile, locate_change_blobs gives each changed region) but reading
them re-rolled the same match_template loop classify_grid already owns. This is
that loop over an explicit box list: detect_* answers *where*, classify_boxes
answers *what*. The two share one pixel core (_classify_box), so a library
harvested once reads both a lattice and a scatter, and the inclusive-box
convention (matching *_blobs / crop_rgb) keeps harvest and read pixel-aligned.

Pure-Python, no display: classify_boxes is self-contained pixel maths, so the
test paints buffers and asserts on the labels directly.
"""
import osctl


def _draw(buf, w, cx, cy, shape, ink=(25, 25, 25)):
    """Paint one sprite centred on (cx, cy) with internal contrast so the ink
    gate trips: a vertical bar, a horizontal bar, a hollow box, or a diagonal."""
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


def _harvest(buf, w, h, box, label):
    """(label, patch, pw, ph) from an inclusive box -- the crop_rgb idiom."""
    patch, pw, ph = osctl.crop_rgb(buf, (w, h), box)
    return (label, patch, pw, ph)


def main():
    w, h = 240, 240
    bg = 200
    tw, th = 38, 38  # sprite tile size (inclusive box spans tw x th)

    # Scatter sprites at *arbitrary, irregular* positions -- not a lattice. Each
    # (label, cx, cy): two of each shape so matches can be proven.
    placed = [
        ("vbar", 30, 28), ("hbar", 110, 40), ("box", 200, 33),
        ("hbar", 45, 120), ("vbar", 150, 135),
        ("box", 95, 205), ("vbar", 205, 200),
    ]
    buf = bytearray(bytes((bg,)) * (w * h * 3))
    boxes = []
    for shape, cx, cy in placed:
        _draw(buf, w, cx, cy, shape)
        boxes.append((cx - tw // 2, cy - th // 2,
                      cx - tw // 2 + tw - 1, cy - th // 2 + th - 1))
    buf = bytes(buf)

    # Harvest a one-of-each library from the first occurrence of each shape.
    seen = {}
    for (shape, _, _), box in zip(placed, boxes):
        seen.setdefault(shape, box)
    templates = [_harvest(buf, w, h, seen[s], s) for s in ("vbar", "hbar", "box")]

    # 1) every scattered box reads back to its painted shape, in input order.
    labels = osctl.classify_boxes(boxes, templates, rgb=buf, size=(w, h),
                                  empty_label=".")
    want = [s for s, _, _ in placed]
    assert labels == want, f"scatter read: want {want} got {labels}"

    # 2) inclusive-box self-match: classifying the exact box a template was
    #    harvested from returns that template's label at near-zero cost. This is
    #    the regression guard for the 1-px inclusive/exclusive frame bug -- a
    #    sharp glyph shifted one pixel fails its own self-match.
    for s in ("vbar", "hbar", "box"):
        self_lab = osctl.classify_boxes([seen[s]], templates, rgb=buf,
                                        size=(w, h), max_score=2.0)[0]
        assert self_lab == s, f"self-match {s!r} (1-px alignment) got {self_lab!r}"

    # 3) a blank box (no ink) gates out to empty_label, never scored.
    empty = bytes(bytes((bg,)) * (w * h * 3))
    blank = [(5, 5, 5 + tw - 1, 5 + th - 1)]
    g = osctl.classify_boxes(blank, templates, rgb=empty, size=(w, h),
                             empty_label=".")
    assert g == ["."], f"blank box -> empty_label: {g!r}"

    # 4) max_score: an off-library sprite is flagged unknown when strict, and
    #    forced to its nearest label when max_score is None.
    buf2 = bytearray(bytes((bg,)) * (w * h * 3))
    _draw(buf2, w, 40, 40, "diag")
    buf2 = bytes(buf2)
    dbox = [(40 - tw // 2, 40 - th // 2, 40 - tw // 2 + tw - 1, 40 - th // 2 + th - 1)]
    strict = osctl.classify_boxes(dbox, templates, rgb=buf2, size=(w, h),
                                  max_score=6.0, unknown_label="?")
    assert strict == ["?"], f"off-library sprite flagged unknown: {strict!r}"
    loose = osctl.classify_boxes(dbox, templates, rgb=buf2, size=(w, h))
    assert loose[0] in ("vbar", "hbar", "box"), \
        f"with no threshold an argmin label is forced: {loose[0]!r}"

    # 5) parity with classify_grid: the same library over the *same cells*, read
    #    once as a lattice and once as an explicit inclusive-box list, must agree
    #    -- they share the one pixel core.
    cols, rows = 3, 3
    gb = (12, 12, 12 + cols * 40 - 1, 12 + rows * 40 - 1)  # 40px cells
    cells = {(0, 0): "vbar", (0, 2): "hbar", (1, 1): "box", (2, 0): "hbar"}
    lbuf = bytearray(bytes((bg,)) * (w * h * 3))
    for (r, c), shape in cells.items():
        _draw(lbuf, w, 12 + c * 40 + 20, 12 + r * 40 + 20, shape)
    lbuf = bytes(lbuf)
    grid = osctl.classify_grid(gb, cols, rows, templates, rgb=lbuf, size=(w, h),
                               empty_label=".")
    cell_boxes = [(12 + c * 40, 12 + r * 40, 12 + c * 40 + 39, 12 + r * 40 + 39)
                  for r in range(rows) for c in range(cols)]
    flat = osctl.classify_boxes(cell_boxes, templates, rgb=lbuf, size=(w, h),
                                empty_label=".")
    grid_flat = [grid[r][c] for r in range(rows) for c in range(cols)]
    assert flat == grid_flat, f"classify_boxes != classify_grid: {flat} vs {grid_flat}"

    # 6) empty box list returns [], and arg validation mirrors classify_grid.
    assert osctl.classify_boxes([], templates, rgb=buf, size=(w, h)) == []
    bad = [
        dict(boxes=boxes, templates=templates, inset=0.5),
        dict(boxes=boxes, templates=templates, ink_min=0),
        dict(boxes=boxes, templates=templates, norm=0),
        dict(boxes=boxes, templates=templates, max_score=-1),
        dict(boxes=boxes, templates=[]),                          # empty library
        dict(boxes=boxes, templates=[("x", b"\0\0\0", 2, 2)]),    # bad patch len
        dict(boxes=[(1, 2, 3)], templates=templates),             # box not 4-tuple
        dict(boxes=boxes, templates=templates, rgb=buf, size=None),  # rgb w/o size
    ]
    for kw in bad:
        try:
            osctl.classify_boxes(**kw)
            assert False, f"expected ValueError for {kw}"
        except ValueError:
            pass

    print("F254 OK: classify_boxes reads an arbitrary box list against a shared "
          "library (scatter, not lattice), self-matches a crop_rgb-harvested box "
          "pixel-for-pixel (inclusive-box convention), gates blanks to "
          "empty_label, flags off-library sprites via max_score, agrees with "
          "classify_grid on the same cells, and validates args")


if __name__ == "__main__":
    main()
