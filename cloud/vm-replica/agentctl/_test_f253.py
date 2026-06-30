"""F253 — detect_cascade: locate the face-up card of each overlapping pile.

The cascade counterpart of detect_grid. detect_grid fits a *uniform* lattice —
the right shape for a ruled board (sudoku, a spreadsheet). A solitaire tableau is
the opposite shape: columns of cards that *overlap* and run to *different* depths
(one pile 1 card, another 7), only the bottom card of each fully shown. Forcing a
lattice on it yields a phantom cols x maxdepth grid whose cells mostly miss real
cards, so every cascade game hand-rolls its own pile walk. Segmenting *every*
overlapped card is theme-brittle (back patterns / court frames mimic card tops);
the robust invariant is that a pile is one contiguous non-felt run, so its
top/bottom are unambiguous and the face-up card is the bottom card_h px. Depth
needn't be segmented — piles one card apart differ in height by one overlap
pitch — and card_h / pitch are inferred from the columns themselves.

Pure-Python, no display: detect_cascade is self-contained pixel maths, so the
test paints a felt buffer with overlapping piles and asserts on the geometry.
"""
import osctl

FELT = (0, 110, 40)
BORDER = (30, 30, 30)
FACE = (245, 245, 245)


def _paint(w, h, xs, top, depths, card_h, pitch):
    """w*h RGB felt buffer with one overlapping pile per column: `depths[c]`
    cards drawn top-to-bottom (so the bottom card lands on top, fully shown),
    each a face-coloured rect with a dark border, stacked at `pitch`."""
    buf = bytearray()
    for _ in range(w * h):
        buf += bytes(FELT)

    def fill(x0, y0, x1, y1, col):
        for yy in range(y0, y1):
            for xx in range(x0, x1):
                if 0 <= xx < w and 0 <= yy < h:
                    i = (yy * w + xx) * 3
                    buf[i], buf[i + 1], buf[i + 2] = col

    for c, d in enumerate(depths):
        cx0, cx1 = xs[c] + 8, xs[c + 1] - 8
        for k in range(d):
            cy0 = top + k * pitch
            cy1 = cy0 + card_h
            fill(cx0, cy0, cx1, cy1, BORDER)            # 2px dark outline
            fill(cx0 + 2, cy0 + 2, cx1 - 2, cy1 - 2, FACE)
    return bytes(buf)


def main():
    w, h = 400, 340
    xs = [20, 110, 200, 290, 380]                       # 4 columns
    top, card_h, pitch = 30, 90, 24
    depths = [2, 1, 3, 0]                                # col3 is empty

    buf = _paint(w, h, xs, top, depths, card_h, pitch)
    search = (20, 20, 380, 330)

    # 1) ragged depths read off pile *height*, with card_h/pitch inferred from
    #    the columns (shortest pile = a lone card; modal height step = pitch).
    r = osctl.detect_cascade(search, 4, rgb=buf, size=(w, h), xs=xs)
    assert r is not None, "cascade detected"
    assert r["card_h"] == card_h, f"card_h inferred {r['card_h']} != {card_h}"
    assert r["pitch"] == pitch, f"pitch inferred {r['pitch']} != {pitch}"
    got = [c["depth"] for c in r["cells"]]
    assert got == depths, f"depths {got} != {depths}"

    # 2) the empty column is reported present=False, not a phantom pile.
    assert r["cells"][3]["present"] is False, "empty column not present"
    assert r["cells"][3]["faceup"] is None and r["cells"][3]["depth"] == 0

    # 3) faceup is the *bottom* card's box: its bottom hugs the pile bottom and it
    #    is ~card_h tall regardless of how many cards sit above it.
    for c in (0, 1, 2):
        cell = r["cells"][c]
        fx0, fy0, fx1, fy1 = cell["faceup"]
        pile_bottom = top + (depths[c] - 1) * pitch + card_h - 1
        assert abs(fy1 - pile_bottom) <= 2, f"col{c} faceup bottom {fy1} vs {pile_bottom}"
        assert abs((fy1 - fy0 + 1) - card_h) <= 3, f"col{c} faceup height ~card_h"
        assert (fx0, fx1) == (xs[c], xs[c + 1]), f"col{c} faceup spans the column"
        # the deepest pile's face-up card starts well below the pile top (it does
        # not span the whole stack) -- the overlap is real, not collapsed.
        if depths[c] > 1:
            assert fy0 >= cell["top"] + pitch - 2, f"col{c} faceup is the bottom card only"

    # 4) caller may pin card_h/pitch (e.g. measured from the stock pile) instead
    #    of inferring; depths must still come out right.
    r2 = osctl.detect_cascade(search, 4, rgb=buf, size=(w, h), xs=xs,
                              card_h=card_h, pitch=pitch)
    assert [c["depth"] for c in r2["cells"]] == depths, "pinned card_h/pitch depths"

    # 5) bg auto-detect: with no xs and no bg the felt is still found (it
    #    dominates the area) and the four even columns recover the same depths.
    r3 = osctl.detect_cascade(search, 4, rgb=buf, size=(w, h))
    assert abs(r3["bg"][1] - FELT[1]) < 16, f"felt auto-detected: {r3['bg']}"
    assert [c["depth"] for c in r3["cells"]] == depths, "even-split columns"

    # 6) arg validation
    bad = [
        dict(cols=0),                                   # cols < 1
        dict(cols=4, xs=[1, 2, 3]),                     # xs wrong length
        dict(cols=4, rgb=buf, size=None),               # rgb without size
    ]
    for kw in bad:
        try:
            osctl.detect_cascade(search, **kw)
            assert False, f"expected ValueError for {kw}"
        except ValueError:
            pass
    # a degenerate search returns None, not an exception.
    assert osctl.detect_cascade((10, 10, 11, 11), 4, rgb=buf, size=(w, h)) is None

    print("F253 OK: detect_cascade reads ragged overlapping piles -- per-column "
          "depth off pile height with card_h/pitch inferred from the columns, the "
          "face-up (bottom) card boxed for read/click, empty columns flagged, and "
          "args validated")


if __name__ == "__main__":
    main()
