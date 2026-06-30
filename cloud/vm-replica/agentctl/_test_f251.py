"""F251 — ocr_grid: read a glyph lattice into a 2D array, ink-gated.

The OCR counterpart of sample_grid. Reading a board of glyphs (a sudoku of
digits, a chess rank, a mahjongg face) made every caller hand-roll the same
geometry double-loop + per-cell ink gate + whitelist/psm tuning, and the naive
version both OCRs every cell (slow on a sparse board) and hallucinates a stray
glyph on the empty bordered cells. ocr_grid divides the board with the exact
sample_grid geometry (or detect_grid's true xs/ys edges), gates each cell on ink
before reading, and OCRs only inked cells — returning "" for the blanks and
never feeding them to tesseract.

Pure-Python, no display and no tesseract: ocr_text is stubbed so the test
verifies the orchestration (geometry, ink gate, skipping, edge placement),
not the OCR engine itself.
"""
import osctl


def _paint(w, h, bbox, cols, rows, glyphs, bg=180, ink=40, xs=None, ys=None):
    """w*h RGB buffer: uniform `bg`, then a central `ink` block in each (r,c) in
    `glyphs`. Cells tile bbox like sample_grid, or use xs/ys edges when given."""
    buf = bytearray(bytes((bg,)) * (w * h * 3))
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    for (r, c), col in glyphs.items():
        cx0 = xs[c] if xs else x0 + c * cw
        cx1 = xs[c + 1] if xs else x0 + (c + 1) * cw
        cy0 = ys[r] if ys else y0 + r * ch
        cy1 = ys[r + 1] if ys else y0 + (r + 1) * ch
        mx = (cx0 + cx1) / 2; my = (cy0 + cy1) / 2
        for yy in range(int(my - 7), int(my + 7)):
            for xx in range(int(mx - 7), int(mx + 7)):
                i = (yy * w + xx) * 3
                buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]
    return bytes(buf)


def _stub_ocr():
    """Replace osctl.ocr_text with a recorder; return (calls, restore)."""
    calls = []
    orig = osctl.ocr_text

    def stub(region, **kw):
        calls.append((region, kw))
        return " 7 "          # leading/trailing space -> must be stripped
    osctl.ocr_text = stub
    return calls, (lambda: setattr(osctl, "ocr_text", orig))


def main():
    w, h = 200, 200
    cols, rows = 4, 4
    bbox = (10, 10, 169, 169)            # 160x160, 40px cells

    # 1) ink gate: only inked cells are read; blanks are "" and never OCR'd.
    glyphs = {(0, 1): (40, 40, 40), (2, 3): (30, 30, 30), (3, 0): (20, 20, 20)}
    buf = _paint(w, h, bbox, cols, rows, glyphs)
    calls, restore = _stub_ocr()
    try:
        grid = osctl.ocr_grid(bbox, cols, rows, rgb=buf, size=(w, h),
                              whitelist="0123456789")
    finally:
        restore()
    assert len(grid) == rows and all(len(r) == cols for r in grid), "shape rows x cols"
    inked = set(glyphs)
    for r in range(rows):
        for c in range(cols):
            if (r, c) in inked:
                assert grid[r][c] == "7", f"inked cell ({r},{c}) -> stripped OCR, got {grid[r][c]!r}"
            else:
                assert grid[r][c] == "", f"blank cell ({r},{c}) must be '' (gated), got {grid[r][c]!r}"
    assert len(calls) == len(inked), f"OCR called once per inked cell only: {len(calls)} vs {len(inked)}"

    # 2) polarity-agnostic gate: a light glyph on a dark cell is inked too.
    buf2 = _paint(w, h, bbox, cols, rows, {(1, 1): (240, 240, 240)}, bg=30)
    calls2, restore = _stub_ocr()
    try:
        grid2 = osctl.ocr_grid(bbox, cols, rows, rgb=buf2, size=(w, h))
    finally:
        restore()
    assert grid2[1][1] == "7" and len(calls2) == 1, "light-on-dark glyph must trip the ink gate"

    # 3) ink_tol/ink_min thresholds: a faint mark below tol is treated as blank.
    buf3 = _paint(w, h, bbox, cols, rows, {(0, 0): (170, 170, 170)})  # only 10 off bg=180
    calls3, restore = _stub_ocr()
    try:
        grid3 = osctl.ocr_grid(bbox, cols, rows, rgb=buf3, size=(w, h), ink_tol=50)
    finally:
        restore()
    assert grid3[0][0] == "" and calls3 == [], "sub-tol mark is blank, not OCR'd"

    # 4) ink gate lines up with sample_grid geometry: the cells ocr_grid reads
    #    are exactly the cells whose sample_grid mean departs from the background.
    g = osctl.sample_grid(bbox, cols, rows, rgb=buf, size=(w, h))
    moved = {(r, c) for r in range(rows) for c in range(cols)
             if abs(g[r][c]["r"] - 180) > 8}
    assert moved == inked, "ink gate selects the same cells sample_grid sees as non-background"

    # 5) exact-edge mode (xs/ys): a non-uniform pitch is read off the true edges,
    #    and the crop handed to OCR sits inside the real cell, not the uniform one.
    xs = [10, 60, 95, 140, 170]          # deliberately uneven columns
    ys = [10, 50, 95, 135, 170]
    buf4 = _paint(w, h, bbox, cols, rows, {(2, 1): (30, 30, 30)}, xs=xs, ys=ys)
    calls4, restore = _stub_ocr()
    try:
        grid4 = osctl.ocr_grid(bbox, cols, rows, rgb=buf4, size=(w, h),
                               xs=xs, ys=ys, inset=0.18)
    finally:
        restore()
    assert grid4[2][1] == "7" and len(calls4) == 1, "glyph on uneven pitch is read via xs/ys"
    (rx, ry, rw, rh), _ = calls4[0]
    assert xs[1] <= rx and rx + rw <= xs[2], f"crop x {rx}..{rx + rw} must sit within true cell [{xs[1]},{xs[2]}]"
    assert ys[2] <= ry and ry + rh <= ys[3], f"crop y {ry}..{ry + rh} must sit within true cell [{ys[2]},{ys[3]}]"

    # 6) arg validation
    bad_calls = [
        dict(cols=0, rows=rows), dict(cols=cols, rows=0),
        dict(cols=cols, rows=rows, inset=0.5),
        dict(cols=cols, rows=rows, ink_min=0),
        dict(cols=cols, rows=rows, xs=[1, 2, 3]),       # wrong length (need cols+1)
        dict(cols=cols, rows=rows, ys=[1, 2, 3]),       # wrong length (need rows+1)
        dict(cols=cols, rows=rows, rgb=buf, size=None),  # rgb without size
    ]
    for kw in bad_calls:
        try:
            osctl.ocr_grid(bbox, **kw)
            assert False, f"expected ValueError for {kw}"
        except ValueError:
            pass

    print("F251 OK: ocr_grid gates each cell on ink (blanks -> '' and never "
          "OCR'd), is polarity-agnostic, honours ink_tol/ink_min, lines up with "
          "sample_grid, places crops on detect_grid's true xs/ys edges, and "
          "validates args")


if __name__ == "__main__":
    main()
