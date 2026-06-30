"""F263 synthetic regression for `match_unique` — no display required.

Builds an RGB frame with a *repeated* motif (two identical tiles → ambiguous,
the false-lock trap) and a *unique* motif, then asserts that match_unique:
  - refuses the ambiguous match (returns None under require_unique),
  - exposes unique/margin/rival when require_unique=False,
  - trusts the distinctive match and reports its coords,
  - is disambiguated by a search window (locality prior),
  - respects the min_margin knob and validates arguments.
"""
import sys
sys.path.insert(0, ".")
import osctl

W, H = 220, 160
GRAY = (90, 92, 95)
RED = (200, 40, 40)
BLUE = (40, 60, 200)
TW = TH = 20


def _lcg(seed):
    s = seed & 0xFFFFFFFF
    while True:
        s = (1103515245 * s + 12345) & 0xFFFFFFFF
        yield (s >> 16) & 0x1F            # small deterministic noise 0..31


def make_frame():
    buf = bytearray(W * H * 3)
    g = _lcg(7)
    for i in range(W * H):
        n = next(g)
        buf[i*3] = min(255, GRAY[0] + n)
        buf[i*3+1] = min(255, GRAY[1] + n)
        buf[i*3+2] = min(255, GRAY[2] + n)
    return buf


def put(buf, x0, y0, bw, bh, color):
    for y in range(y0, y0 + bh):
        for x in range(x0, x0 + bw):
            o = (y * W + x) * 3
            buf[o], buf[o+1], buf[o+2] = color


def solid(color, bw, bh):
    return bytes(bytearray(color) * (bw * bh))


def main():
    n = 0
    frame = make_frame()
    # two IDENTICAL red tiles (ambiguous) + one unique blue tile
    put(frame, 30, 40, TW, TH, RED)
    put(frame, 150, 40, TW, TH, RED)      # 120 px apart, a true duplicate
    put(frame, 95, 110, TW, TH, BLUE)
    frame = bytes(frame)

    red = solid(RED, TW, TH)
    blue = solid(BLUE, TW, TH)

    # --- 1) ambiguous motif: require_unique (default) refuses it -------------
    r = osctl.match_unique(red, TW, TH, rgb=frame, size=(W, H))
    assert r is None, f"ambiguous red should be refused, got {r}"; n += 1

    # --- 2) same query, require_unique=False exposes the ambiguity ------------
    r = osctl.match_unique(red, TW, TH, rgb=frame, size=(W, H),
                           require_unique=False)
    assert r is not None; n += 1
    assert r["unique"] is False, r; n += 1
    assert r["margin"] < 0.05, f"tied rival -> margin~0, got {r['margin']}"; n += 1
    # best is one of the two red centres (centre = corner + TW//2)
    centres = {(40, 50), (160, 50)}
    assert (r["x"], r["y"]) in centres, (r["x"], r["y"]); n += 1
    assert r["rival"] is not None, "a duplicate exists -> rival populated"; n += 1
    assert (r["rival"]["x"], r["rival"]["y"]) in centres; n += 1
    # best and rival are the two DIFFERENT instances
    assert (r["x"], r["y"]) != (r["rival"]["x"], r["rival"]["y"]); n += 1

    # --- 3) min_margin=0.0 accepts even a tie (knob floor) -------------------
    r0 = osctl.match_unique(red, TW, TH, rgb=frame, size=(W, H), min_margin=0.0)
    assert r0 is not None and r0["unique"] is True, r0; n += 1

    # --- 4) distinctive motif: trusted, correct coords, big margin -----------
    b = osctl.match_unique(blue, TW, TH, rgb=frame, size=(W, H))
    assert b is not None, "unique blue should be trusted"; n += 1
    assert b["unique"] is True; n += 1
    assert (b["x"], b["y"]) == (105, 120), (b["x"], b["y"]); n += 1
    assert b["margin"] > 0.5, f"blue stands alone -> large margin, got {b['margin']}"; n += 1
    assert b["score"] == 0, f"exact tile -> SAD 0, got {b['score']}"; n += 1
    # blue occurs once: rival (if any) is a far worse non-blue region
    if b["rival"] is not None:
        assert b["rival"]["score"] > b["score"]; n += 1
    else:
        assert b["margin"] == 1.0; n += 1

    # --- 5) locality prior: a search window around ONE red tile -> unique ----
    win = osctl.match_unique(red, TW, TH, rgb=frame, size=(W, H),
                             search=(10, 20, 70, 90))
    assert win is not None and win["unique"] is True, win; n += 1
    assert (win["x"], win["y"]) == (40, 50), (win["x"], win["y"]); n += 1

    # --- 6) high min_margin still trusts a truly-alone match -----------------
    bb = osctl.match_unique(blue, TW, TH, rgb=frame, size=(W, H), min_margin=0.95)
    assert bb is not None and bb["unique"] is True, bb; n += 1

    # --- 7) search smaller than the patch -> no match ------------------------
    none = osctl.match_unique(blue, TW, TH, rgb=frame, size=(W, H),
                              search=(0, 0, 5, 5))
    assert none is None; n += 1

    # --- 8) coarse step still locates the distinctive motif ------------------
    bs = osctl.match_unique(blue, TW, TH, rgb=frame, size=(W, H), step=2)
    assert bs is not None and bs["unique"] is True; n += 1

    # --- 9) argument validation ---------------------------------------------
    for bad in (1.0, -0.1, 2.0):
        try:
            osctl.match_unique(blue, TW, TH, rgb=frame, size=(W, H), min_margin=bad)
            assert False, f"min_margin={bad} should raise"
        except ValueError:
            n += 1

    print(f"F263 match_unique: {n} assertions passed")


if __name__ == "__main__":
    main()
