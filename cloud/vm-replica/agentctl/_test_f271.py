"""F271 — find_color_blobs gains `step` acuity (the trade find_color already had).

find_color_blobs segments a colour into separate clickable regions, but unlike
find_color it scanned every pixel — so a tight perceive->act loop over distinct
same-coloured targets paid a full-resolution segmentation every frame (measured
~130 ms on a 1.5 MP field, ~6x the move+click it gated). `step=n` samples every
n-th pixel on every n-th row (~1/n^2 the work), judging connectivity on the sample
lattice. These checks pin the semantics with no display: step=1 is byte-identical
to before; a solid blob's centroid is unbiased under subsampling and its count
scales ~area/n^2; well-separated blobs stay separate; coarse acuity can miss a
thin feature (the documented cost); and no spurious union wraps across rows.
"""
import osctl


def _canvas(w, h, rects, fill, bg=(0, 0, 0)):
    """w*h RGB buffer filled with bg; each (x0,y0,x1,y1) in rects painted fill."""
    buf = bytearray(bytes(bg) * (w * h))
    fr, fg, fb = fill
    for (x0, y0, x1, y1) in rects:
        for yy in range(y0, y1 + 1):
            base = yy * w
            for xx in range(x0, x1 + 1):
                i = (base + xx) * 3
                buf[i] = fr; buf[i + 1] = fg; buf[i + 2] = fb
    return bytes(buf)


def main():
    w, h = 200, 120
    T = (150, 200, 230)
    # two well-separated solid blobs: A 21x21 at (20,20), B 31x31 at (120,60)
    A = (20, 20, 40, 40)
    B = (120, 60, 150, 90)
    buf = _canvas(w, h, [A, B], T)
    sz = (w, h)

    # --- 1) step=1 is exactly the old behaviour: two blobs, full-area counts ---
    b1 = osctl.find_color_blobs(T, tol=10, rgb=buf, size=sz, min_count=1)
    assert len(b1) == 2, b1
    big, small = b1[0], b1[1]
    assert big["count"] == 31 * 31, big["count"]      # B is larger
    assert small["count"] == 21 * 21, small["count"]
    # centroids at the geometric centres
    assert big["x"] == 135 and big["y"] == 75, big
    assert small["x"] == 30 and small["y"] == 30, small
    assert big["bbox"] == B and small["bbox"] == A

    # default step is 1 (omitting it == passing 1)
    assert osctl.find_color_blobs(T, tol=10, rgb=buf, size=sz, step=1) == b1

    # --- 2) step=4: still two blobs; centroid unbiased; count ~ area/16 ---
    b4 = osctl.find_color_blobs(T, tol=10, rgb=buf, size=sz, min_count=1, step=4)
    assert len(b4) == 2, b4
    by_pos = sorted(b4, key=lambda d: d["x"])
    sA, sB = by_pos[0], by_pos[1]
    assert abs(sA["x"] - 30) <= 2 and abs(sA["y"] - 30) <= 2, sA   # centroid held
    assert abs(sB["x"] - 135) <= 2 and abs(sB["y"] - 75) <= 2, sB
    # count is matched *samples* (~area/n^2), far below the pixel count
    assert sA["count"] < 21 * 21 and sA["count"] >= 16, sA["count"]
    assert abs(sB["count"] - (31 * 31) / 16) <= 12, sB["count"]
    # bbox rounded to the sample grid stays inside the true extent
    ax0, ay0, ax1, ay1 = sA["bbox"]
    assert ax0 >= 20 and ay0 >= 20 and ax1 <= 40 and ay1 <= 40, sA["bbox"]

    # --- 3) min_count is in sample units, so it must account for step ---
    # B has ~60 samples at step=4, A has ~30; a threshold of 40 keeps only B
    only_big = osctl.find_color_blobs(T, tol=10, rgb=buf, size=sz,
                                      min_count=40, step=4)
    assert len(only_big) == 1 and abs(only_big[0]["x"] - 135) <= 2, only_big

    # --- 4) acuity loss is real: a 1px-thin line vanishes at coarse step ---
    line = _canvas(w, h, [(10, 100, 180, 100)], T)   # one-row horizontal line
    assert len(osctl.find_color_blobs(T, tol=10, rgb=line, size=sz)) == 1
    # rows 0,4,8,... are sampled; row 100 is sampled but its single-row samples
    # never connect vertically -> they survive as a thin run; at step=7 (100 not
    # a multiple) the line is skipped entirely
    assert osctl.find_color_blobs(T, tol=10, rgb=line, size=sz,
                                  min_count=1, step=7) == []

    # --- 5) connectivity is on the sample lattice: a gap wider than step splits,
    #         a gap narrower than step bridges (two near rects merge at step=8) --
    near = _canvas(w, h, [(20, 20, 40, 40), (46, 20, 66, 40)], T)  # 5px gap
    assert len(osctl.find_color_blobs(T, tol=10, rgb=near, size=sz)) == 2  # full res
    merged = osctl.find_color_blobs(T, tol=10, rgb=near, size=sz, min_count=1, step=8)
    assert len(merged) == 1, merged   # step=8 strides across the 5px gap -> one blob

    # --- 6) no spurious union wraps from a row's end to the next row's start ---
    # paint the last sampled column of row 0 and the first column of row 4; at
    # step=4 key-s of the (0,4) pixel must not reach the (196,0) pixel
    wrap = bytearray(bytes((0, 0, 0)) * (w * h))
    for (xx, yy) in ((196, 0), (0, 4)):
        i = (yy * w + xx) * 3
        wrap[i] = 150; wrap[i + 1] = 200; wrap[i + 2] = 230
    wb = osctl.find_color_blobs(T, tol=10, rgb=bytes(wrap), size=sz,
                                min_count=1, step=4)
    assert len(wb) == 2, wb   # two isolated points, never one wrapped blob

    # --- 7) step<=0 is clamped to 1 (no crash, full acuity) ---
    assert osctl.find_color_blobs(T, tol=10, rgb=buf, size=sz, step=0) == b1
    assert osctl.find_color_blobs(T, tol=10, rgb=buf, size=sz, step=-3) == b1

    # --- 8) step composes with a search window (coords stay absolute) ---
    win = osctl.find_color_blobs(T, tol=10, rgb=buf, size=sz, min_count=1,
                                 step=4, search=(100, 40, 199, 119))
    assert len(win) == 1 and abs(win[0]["x"] - 135) <= 2, win  # only B in window

    print("F271 OK: find_color_blobs gains step acuity — step=1 byte-identical, "
          "coarse step holds each blob's centroid for ~1/n^2 the scan, count is in "
          "sample units, separation/merge follow the sample lattice, thin features "
          "are the documented acuity cost, no cross-row union wrap, step<=0 clamps")


if __name__ == "__main__":
    main()
