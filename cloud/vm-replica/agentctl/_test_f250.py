"""F250 — grid_changes: which lattice cells changed between two captures.

The per-cell locate_change for grids. Incremental grid games move one or a few
cells per step (sudoku fills one, mines reveals a handful, a chess move touches
two), yet the reader re-classifies every cell every step. grid_changes returns
just the moved cells from two captures so the caller re-reads only the deltas —
the F245/F246 "don't redo unchanged work" lesson, applied to grids. Pure-Python,
no display.
"""
import osctl


def _solid(w, h, cells, cols, rows, bbox, fill):
    """Paint a w*h RGB buffer: each (r,c) in `cells` gets colour fill[(r,c)],
    everything else mid-grey. Cells tile bbox exactly like sample_grid."""
    buf = bytearray(b"\x80" * (w * h * 3))
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    for (r, c), (cr, cg, cb) in fill.items():
        cx0 = int(x0 + c * cw); cx1 = int(x0 + (c + 1) * cw)
        cy0 = int(y0 + r * ch); cy1 = int(y0 + (r + 1) * ch)
        for yy in range(cy0, cy1):
            for xx in range(cx0, cx1):
                i = (yy * w + xx) * 3
                buf[i] = cr; buf[i + 1] = cg; buf[i + 2] = cb
    return bytes(buf)


def main():
    w, h = 200, 200
    cols, rows = 4, 4
    bbox = (10, 10, 169, 169)   # 160x160, 40px cells

    base_fill = {(r, c): (200, 200, 200) for r in range(rows) for c in range(cols)}
    prev = _solid(w, h, None, cols, rows, bbox, base_fill)

    # 1) nothing changed -> empty
    assert osctl.grid_changes(prev, prev, bbox, cols, rows, (w, h)) == []

    # 2) flip exactly two cells -> exactly those two (r,c), in row-major order
    f2 = dict(base_fill); f2[(1, 2)] = (10, 200, 10); f2[(3, 0)] = (200, 10, 10)
    cur = _solid(w, h, None, cols, rows, bbox, f2)
    assert osctl.grid_changes(prev, cur, bbox, cols, rows, (w, h)) == [(1, 2), (3, 0)]

    # 3) tol ignores a small wobble: nudge one cell by 8/channel, tol=12 hides it
    f3 = dict(base_fill); f3[(0, 0)] = (208, 208, 208)
    cur3 = _solid(w, h, None, cols, rows, bbox, f3)
    assert osctl.grid_changes(prev, cur3, bbox, cols, rows, (w, h), tol=0) == [(0, 0)]
    assert osctl.grid_changes(prev, cur3, bbox, cols, rows, (w, h), tol=12) == []

    # 4) min_count: a single changed pixel marks a cell at min_count=1, but not
    #    at a higher threshold. Paint one pixel of cell (2,2).
    cur4 = bytearray(prev)
    px = ((10 + int(2 * 40 + 20)) + (10 + int(2 * 40 + 20)) * w) * 3
    cur4[px] = 0; cur4[px + 1] = 0; cur4[px + 2] = 0
    cur4 = bytes(cur4)
    assert osctl.grid_changes(prev, cur4, bbox, cols, rows, (w, h), min_count=1) == [(2, 2)]
    assert osctl.grid_changes(prev, cur4, bbox, cols, rows, (w, h), min_count=5) == []

    # 5) the (r,c) indexing lines up one-to-one with sample_grid: the cells
    #    grid_changes flags are exactly the cells whose sample_grid mean moved.
    g_prev = osctl.sample_grid(bbox, cols, rows, rgb=prev, size=(w, h))
    g_cur = osctl.sample_grid(bbox, cols, rows, rgb=cur, size=(w, h))
    moved = [(r, c) for r in range(rows) for c in range(cols)
             if (g_prev[r][c]["r"], g_prev[r][c]["g"], g_prev[r][c]["b"])
             != (g_cur[r][c]["r"], g_cur[r][c]["g"], g_cur[r][c]["b"])]
    assert sorted(osctl.grid_changes(prev, cur, bbox, cols, rows, (w, h))) == sorted(moved)

    # 6) arg validation
    for bad in [(0, rows), (cols, 0)]:
        try:
            osctl.grid_changes(prev, prev, bbox, bad[0], bad[1], (w, h))
            assert False, f"expected ValueError for cols/rows {bad}"
        except ValueError:
            pass
    try:
        osctl.grid_changes(prev, prev, bbox, cols, rows, (w, h), inset=0.5)
        assert False, "expected ValueError for inset 0.5"
    except ValueError:
        pass
    try:
        osctl.grid_changes(prev, prev, bbox, cols, rows, (w, h), min_count=0)
        assert False, "expected ValueError for min_count 0"
    except ValueError:
        pass
    try:
        osctl.grid_changes(prev, prev[:-3], bbox, cols, rows, (w, h))
        assert False, "expected ValueError for mismatched lengths"
    except ValueError:
        pass

    print("F250 OK: grid_changes returns exactly the lattice cells that moved "
          "(row-major), honours tol/min_count, lines up one-to-one with "
          "sample_grid's (r,c), and validates args")


if __name__ == "__main__":
    main()
