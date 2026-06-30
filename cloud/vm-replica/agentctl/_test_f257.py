"""F257 — sample_grid(stat="mode"): the mark-immune fill colour.

sample_grid's `stat="mean"` averages a cell's pixels, so a foreground mark drags
the cell's colour toward the mark in proportion to how much of the cell it covers.
Two cells with the *same* fill but differently sized marks then read as different
colours, and the discriminating signal -- the fill -- is lost. A minesweeper theme
that tints the cell by its count (1 = green, 2 = tan) carries a dark digit whose
ink grows with the count, so the mean of a "2" is dragged further from its fill
than a "1", and the means of the two counts can smear together or even cross.

`stat="mode"` buckets each cell's central window into a coarse colour histogram,
takes the most-populated bin (the fill always outvotes a minority mark) and returns
the exact mean of that bin -- a precise fill colour that ignores the glyph. This
test paints fills under marks of growing size and asserts mode recovers the fill
while mean does not. Pure-Python, no display and no capture.
"""
import osctl


def _dist(a, b):
    return abs(a["r"] - b[0]) + abs(a["g"] - b[1]) + abs(a["b"] - b[2])


def _paint(w, h, bbox, cols, rows, cells):
    """w*h RGB buffer. `cells[(r,c)] = (fill, mark, frac)` fills the whole cell
    with `fill`, then stamps a centred square of `mark` covering `frac` of the
    cell's area (the "glyph"). Cells absent from the map stay mid-grey."""
    buf = bytearray(bytes((128,)) * (w * h * 3))
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    for (r, c), (fill, mark, frac) in cells.items():
        cx0, cx1 = int(x0 + c * cw), int(x0 + (c + 1) * cw)
        cy0, cy1 = int(y0 + r * ch), int(y0 + (r + 1) * ch)
        for yy in range(cy0, cy1):
            for xx in range(cx0, cx1):
                i = (yy * w + xx) * 3
                buf[i], buf[i + 1], buf[i + 2] = fill
        if frac > 0:
            side = (((cx1 - cx0) * (cy1 - cy0) * frac) ** 0.5)
            mx, my = (cx0 + cx1) // 2, (cy0 + cy1) // 2
            hx, hy = int(side / 2), int(side / 2)
            for yy in range(my - hy, my + hy):
                for xx in range(mx - hx, mx + hx):
                    i = (yy * w + xx) * 3
                    buf[i], buf[i + 1], buf[i + 2] = mark
    return bytes(buf)


def main():
    w, h = 240, 120
    bbox = (10, 10, 229, 109)
    cols, rows = 4, 1
    GREEN = (110, 200, 90)   # the "1" fill
    TAN = (210, 200, 120)    # the "2" fill
    INK = (30, 30, 30)       # the dark digit, same hue on both
    # col0: green fill, light mark (a "1"); col1: green fill, heavy mark
    # col2: tan fill, light mark; col3: tan fill, heavy mark (a "2"). The heavy
    # mark still stays a minority of the inset window -- a real digit never
    # fills its cell; once a mark covers most of the window there is no fill
    # left to read and mode correctly reports the mark.
    buf = _paint(w, h, bbox, cols, rows, {
        (0, 0): (GREEN, INK, 0.04),
        (0, 1): (GREEN, INK, 0.12),
        (0, 2): (TAN, INK, 0.04),
        (0, 3): (TAN, INK, 0.12),
    })

    mode = osctl.sample_grid(bbox, cols, rows, rgb=buf, size=(w, h),
                             inset=0.18, stat="mode")[0]
    mean = osctl.sample_grid(bbox, cols, rows, rgb=buf, size=(w, h),
                             inset=0.18, stat="mean")[0]

    # 1) mode recovers each true fill within a tight tolerance, regardless of how
    #    much ink sits on it.
    assert _dist(mode[0], GREEN) <= 12, ("mode green/small", mode[0])
    assert _dist(mode[1], GREEN) <= 12, ("mode green/big", mode[1])
    assert _dist(mode[2], TAN) <= 12, ("mode tan/small", mode[2])
    assert _dist(mode[3], TAN) <= 12, ("mode tan/big", mode[3])

    # 2) mode is mark-immune: the two green cells (different mark sizes) read as
    #    essentially the SAME colour, and likewise the two tan cells.
    assert _dist(mode[0], (mode[1]["r"], mode[1]["g"], mode[1]["b"])) <= 6, \
        "mode: same fill -> same colour regardless of mark size"
    assert _dist(mode[2], (mode[3]["r"], mode[3]["g"], mode[3]["b"])) <= 6, \
        "mode: same fill -> same colour regardless of mark size"

    # 3) mean is NOT mark-immune: the heavily-inked cell drifts far from its fill,
    #    so the two same-fill cells read as clearly different colours -- exactly
    #    the smear that makes mean unable to read a tinted cell under a glyph.
    assert _dist(mean[1], GREEN) > _dist(mode[1], GREEN) + 20, \
        "mean of inked cell drifts from fill far more than mode"
    same_fill_mean = _dist(mean[0], (mean[1]["r"], mean[1]["g"], mean[1]["b"]))
    assert same_fill_mean > 20, ("mean smears same-fill cells", same_fill_mean)

    # 4) mode's within-class spread (two cells of the SAME fill, different mark
    #    sizes) is far smaller than mean's: mode collapses a class to a point
    #    while mean smears it, which is exactly what lets a fill-colour read
    #    classify reliably under mode and unreliably under mean.
    def within(g, i, j):
        return _dist(g[i], (g[j]["r"], g[j]["g"], g[j]["b"]))
    mode_spread = max(within(mode, 0, 1), within(mode, 2, 3))
    mean_spread = max(within(mean, 0, 1), within(mean, 2, 3))
    assert mode_spread + 20 < mean_spread, ("mode collapses a class, mean smears it",
                                            mode_spread, mean_spread)

    # 5) count is the modal bin's dominance: a near-solid cell's modal bin holds
    #    most of the window; the heavily-inked cell's fill still wins but with a
    #    smaller share than the lightly-inked one.
    assert mode[0]["count"] > mode[1]["count"], "less ink -> larger modal share"
    assert mode[1]["count"] > 0

    # 6) on a solid (mark-free) cell, mode and mean agree -- mode adds nothing
    #    when there is nothing to be immune to.
    solid = _paint(w, h, bbox, cols, rows, {(0, 0): (GREEN, INK, 0.0)})
    sm = osctl.sample_grid(bbox, cols, rows, rgb=solid, size=(w, h),
                           inset=0.18, stat="mode")[0][0]
    sa = osctl.sample_grid(bbox, cols, rows, rgb=solid, size=(w, h),
                           inset=0.18, stat="mean")[0][0]
    assert _dist(sm, (sa["r"], sa["g"], sa["b"])) <= 4, "solid: mode == mean"

    # 7) backward compatibility: default stat is mean.
    d = osctl.sample_grid(bbox, cols, rows, rgb=buf, size=(w, h), inset=0.18)[0]
    assert d == mean, "default stat must remain mean (backward compatible)"

    # 8) argument validation.
    for bad in (("stat", "median"), ("quant", 0), ("quant", 257)):
        try:
            osctl.sample_grid(bbox, cols, rows, rgb=buf, size=(w, h),
                              **{bad[0]: bad[1]})
            raise AssertionError(f"expected ValueError for {bad}")
        except ValueError:
            pass

    print("F257 OK: sample_grid(stat='mode') returns the modal fill colour, "
          "immune to a foreground mark (the mean of the largest colour bin) -- "
          "recovers a tinted cell's fill under a growing glyph where stat='mean' "
          "smears same-fill cells apart and lets tint classes cross; count is the "
          "modal bin's dominance, mode==mean on solid cells, default stays mean, "
          "args validated")


if __name__ == "__main__":
    main()
