"""F255 — ocr_grid(invert="auto"): per-cell ink-polarity for mixed boards.

ocr_grid's `invert` was one bool for the whole board. But a single board can mix
polarities within itself -- a tetravex tile carries white digits on its dark
triangles and black digits on its light ones -- and tesseract wants dark-on-light,
so no single bool reads them all: the wrong-polarity cells come back empty.
`invert="auto"` decides per cell from the gate's own measurement (is the ink
brighter or darker than the cell mean?), reads that cell at the matching polarity,
and retries the opposite when the first read is empty. So a mixed-polarity board
reads in one call without the caller pre-sorting cells by colour.

Pure-Python, no display and no tesseract: ocr_text is stubbed to mimic the engine
(it only "reads" an image that ends up dark-on-light after `invert` is applied),
so the test verifies the per-cell polarity decision and the retry, not the OCR.
"""
import osctl


def _luma(c):
    return (c[0] * 299 + c[1] * 587 + c[2] * 114) // 1000


def _paint(w, h, bbox, cols, rows, cells):
    """w*h RGB buffer. `cells[(r,c)] = (bg, ink)` paints that cell's background
    over its whole tile and a central ink block; cells absent stay mid-grey."""
    buf = bytearray(bytes((128,)) * (w * h * 3))
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    for (r, c), (bg, ink) in cells.items():
        cx0, cx1 = int(x0 + c * cw), int(x0 + (c + 1) * cw)
        cy0, cy1 = int(y0 + r * ch), int(y0 + (r + 1) * ch)
        for yy in range(cy0, cy1):
            for xx in range(cx0, cx1):
                i = (yy * w + xx) * 3
                buf[i], buf[i + 1], buf[i + 2] = bg
        mx, my = (cx0 + cx1) // 2, (cy0 + cy1) // 2
        for yy in range(my - 7, my + 7):
            for xx in range(mx - 7, mx + 7):
                i = (yy * w + xx) * 3
                buf[i], buf[i + 1], buf[i + 2] = ink
    return bytes(buf)


def _stub_engine(retval="7"):
    """ocr_text that mimics tesseract: it reads the region from the buffer, and
    succeeds (returns `retval`) only when the image, after `invert` is applied,
    is dark-on-light -- exactly the polarity a real engine needs. Returns
    (calls, restore)."""
    calls = []
    orig = osctl.ocr_text

    def stub(region, **kw):
        calls.append((region, kw.get("invert")))
        rx, ry, rw, rh = region
        rgb, (w, h) = kw["rgb"], kw["size"]
        lums = []
        for yy in range(ry, ry + rh):
            for xx in range(rx, rx + rw):
                i = (yy * w + xx) * 3
                lums.append(_luma((rgb[i], rgb[i + 1], rgb[i + 2])))
        mean = sum(lums) / len(lums)
        ink = [v for v in lums if abs(v - mean) > 50]
        dark_on_light = (sum(ink) / len(ink)) < mean   # glyph darker than bg
        if kw["invert"]:
            dark_on_light = not dark_on_light            # invert flips it
        return f" {retval} " if dark_on_light else ""
    osctl.ocr_text = stub
    return calls, (lambda: setattr(osctl, "ocr_text", orig))


def main():
    w, h = 200, 200
    cols, rows = 2, 2
    bbox = (10, 10, 169, 169)
    DOL = ((210, 210, 210), (35, 35, 35))   # dark glyph on light bg
    LOD = ((35, 35, 35), (220, 220, 220))   # light glyph on dark bg

    # 1) headline: a board mixing both polarities. invert=False reads only the
    #    dark-on-light cells; invert=True only the light-on-dark; invert="auto"
    #    reads *both* in one call.
    cells = {(0, 0): DOL, (0, 1): LOD, (1, 0): LOD, (1, 1): DOL}
    buf = _paint(w, h, bbox, cols, rows, cells)

    calls, restore = _stub_engine()
    try:
        g_false = osctl.ocr_grid(bbox, cols, rows, rgb=buf, size=(w, h), invert=False)
    finally:
        restore()
    assert g_false[0][0] == "7" and g_false[1][1] == "7", "upright reads the DOL cells"
    assert g_false[0][1] == "" and g_false[1][0] == "", "upright misses the LOD cells"

    calls, restore = _stub_engine()
    try:
        g_true = osctl.ocr_grid(bbox, cols, rows, rgb=buf, size=(w, h), invert=True)
    finally:
        restore()
    assert g_true[0][1] == "7" and g_true[1][0] == "7", "inverted reads the LOD cells"
    assert g_true[0][0] == "" and g_true[1][1] == "", "inverted misses the DOL cells"

    calls, restore = _stub_engine()
    try:
        g_auto = osctl.ocr_grid(bbox, cols, rows, rgb=buf, size=(w, h), invert="auto")
    finally:
        restore()
    assert all(g_auto[r][c] == "7" for r in range(rows) for c in range(cols)), \
        f"auto reads every cell regardless of polarity: {g_auto}"

    # 2) auto picks the right polarity *first try* (no wasted second read): each
    #    cell is OCR'd exactly once because the heuristic guessed correctly.
    assert len(calls) == 4, f"auto OCRs each cell once when its guess is right: {len(calls)}"
    # cells are visited row-major: (0,0)=DOL, (0,1)=LOD, (1,0)=LOD, (1,1)=DOL, so
    # the per-cell invert chosen by auto is upright/inverted/inverted/upright.
    chosen = [inv for _, inv in calls]
    assert chosen == [False, True, True, False], \
        f"auto picks the matching polarity per cell first try: {chosen}"

    # 3) retry: when the heuristic's first polarity reads nothing, the opposite is
    #    tried. Stub here only ever succeeds inverted; a dark-on-light cell makes
    #    auto guess upright first (empty), so it must fall back to inverted.
    buf2 = _paint(w, h, cols=1, rows=1, bbox=bbox, cells={(0, 0): DOL})

    def _stub_only_inverted():
        calls = []
        orig = osctl.ocr_text
        def stub(region, **kw):
            calls.append(kw.get("invert"))
            return " 9 " if kw["invert"] else ""    # only succeeds inverted
        osctl.ocr_text = stub
        return calls, (lambda: setattr(osctl, "ocr_text", orig))

    rcalls, restore = _stub_only_inverted()
    try:
        g_retry = osctl.ocr_grid(bbox, 1, 1, rgb=buf2, size=(w, h), invert="auto")
    finally:
        restore()
    assert g_retry[0][0] == "9", f"auto retries the opposite polarity on empty: {g_retry}"
    assert rcalls == [False, True], f"auto tried upright then inverted: {rcalls}"

    # 4) a blank cell is still gated out -- auto never reaches OCR for it.
    buf3 = _paint(w, h, bbox, 1, 1, {})    # mid-grey, no ink
    bcalls, restore = _stub_engine()
    try:
        g_blank = osctl.ocr_grid(bbox, 1, 1, rgb=buf3, size=(w, h), invert="auto")
    finally:
        restore()
    assert g_blank[0][0] == "" and bcalls == [], "blank cell gated before OCR even in auto"

    # 5) arg validation: invert must be a bool or the string "auto".
    try:
        osctl.ocr_grid(bbox, 1, 1, rgb=buf, size=(w, h), invert="bogus")
        assert False, "expected ValueError for invert='bogus'"
    except ValueError:
        pass

    print("F255 OK: ocr_grid(invert=\"auto\") decides ink polarity per cell from "
          "the gate's own measurement, reads a board that mixes dark-on-light and "
          "light-on-dark glyphs in one call (where neither bool can), retries the "
          "opposite polarity on an empty read, still gates blanks before OCR, and "
          "validates the invert argument")


if __name__ == "__main__":
    main()
