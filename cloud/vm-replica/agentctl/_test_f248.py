"""F248 — detect_grid: recover a ruled lattice's origin/pitch/dims from edges.

Pure-Python, no X11: build RGB buffers with known lattices and assert
detect_grid recovers geometry exactly, is robust to off-comb cell content,
rejects non-grids, validates args, and composes with sample_grid.
"""
import osctl

BG = (238, 238, 238)
LINE = (40, 40, 40)


def _img(w, h, xs, ys, fills=None, lw=2):
    """White canvas with dark separator lines at xs/ys; optional cell fills.

    ``fills`` maps (row, col) -> (r,g,b) painting that cell's interior — content
    that sits *off* the line comb, to prove the chain ignores it."""
    buf = bytearray(BG * (w * h))

    def put(x, y, rgb):
        if 0 <= x < w and 0 <= y < h:
            j = (y * w + x) * 3
            buf[j], buf[j + 1], buf[j + 2] = rgb

    x0, x1, y0, y1 = xs[0], xs[-1], ys[0], ys[-1]
    for x in xs:
        for d in range(lw):
            for y in range(y0, y1 + 1):
                put(x + d, y, LINE)
    for y in ys:
        for d in range(lw):
            for x in range(x0, x1 + 1):
                put(x, y + d, LINE)
    if fills:
        for (r, c), rgb in fills.items():
            cx0, cx1 = xs[c], xs[c + 1]
            cy0, cy1 = ys[r], ys[r + 1]
            m = 6
            for y in range(cy0 + m, cy1 - m):
                for x in range(cx0 + m, cx1 - m):
                    put(x, y, rgb)
    return bytes(buf)


def _lattice(x0, y0, cw, ch, cols, rows):
    return ([x0 + i * cw for i in range(cols + 1)],
            [y0 + i * ch for i in range(rows + 1)])


def main():
    W, H = 520, 480

    # 1) exact recovery across several geometries
    for x0, y0, cw, ch, cols, rows in [
        (40, 30, 44, 44, 9, 9),
        (12, 60, 30, 50, 8, 5),
        (100, 20, 26, 26, 6, 6),
    ]:
        xs, ys = _lattice(x0, y0, cw, ch, cols, rows)
        rgb = _img(W, H, xs, ys)
        g = osctl.detect_grid((x0 - 8, y0 - 8, xs[-1] + 8, ys[-1] + 8),
                              rgb=rgb, size=(W, H))
        assert g is not None, (x0, y0, cw, ch, cols, rows)
        assert g["cols"] == cols and g["rows"] == rows, (g["cols"], g["rows"])
        assert abs(g["bbox"][0] - x0) <= 2 and abs(g["bbox"][1] - y0) <= 2, g["bbox"]
        assert abs(g["cw"] - cw) <= 1 and abs(g["ch"] - ch) <= 1, (g["cw"], g["ch"])

    # 2) robust to off-comb cell content (glyphs): a few filled cells must not
    #    shift the recovered lattice — their edges fall off the comb.
    xs, ys = _lattice(40, 30, 44, 44, 9, 9)
    fills = {(0, 0): (10, 10, 10), (2, 5): (200, 30, 30),
             (5, 2): (30, 30, 200), (8, 8): (10, 120, 10)}
    rgb = _img(W, H, xs, ys, fills=fills)
    g = osctl.detect_grid((30, 20, xs[-1] + 8, ys[-1] + 8), rgb=rgb, size=(W, H))
    assert g is not None and g["cols"] == 9 and g["rows"] == 9, g
    assert abs(g["bbox"][0] - 40) <= 2 and abs(g["cw"] - 44) <= 1, g

    # 3) composes with sample_grid: detected geometry reads planted cell colours
    cells = osctl.sample_grid(g["bbox"], g["cols"], g["rows"],
                              rgb=rgb, size=(W, H), inset=0.28)
    for (r, c), (er, eg, eb) in fills.items():
        cell = cells[r][c]
        assert abs(cell["r"] - er) <= 6 and abs(cell["g"] - eg) <= 6 \
            and abs(cell["b"] - eb) <= 6, (r, c, cell)

    # 4) rejection: a blank region is not a grid
    blank = bytes(BG * (W * H))
    assert osctl.detect_grid((20, 20, 300, 300), rgb=blank, size=(W, H)) is None

    # 5) rejection: too few lines for min_cells
    xs2, ys2 = _lattice(40, 40, 60, 60, 2, 2)
    rgb2 = _img(W, H, xs2, ys2)
    assert osctl.detect_grid((30, 30, xs2[-1] + 8, ys2[-1] + 8),
                             rgb=rgb2, size=(W, H), min_cells=3) is None

    # 6) arg validation + degenerate search
    try:
        osctl.detect_grid((0, 0, 100, 100), rgb=rgb)  # size missing
        assert False, "expected ValueError"
    except ValueError:
        pass
    assert osctl.detect_grid((0, 0, 5, 5), rgb=rgb, size=(W, H)) is None

    print("F248 OK: detect_grid recovers ruled-lattice origin/pitch/dims exactly, "
          "ignores off-comb cell content via the longest arithmetic chain, "
          "composes with sample_grid, rejects blank/too-small regions, "
          "and validates args")


if __name__ == "__main__":
    main()
