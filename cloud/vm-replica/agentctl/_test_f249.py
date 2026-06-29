"""F249 — ocr_text region must not crash on a degenerate/off-frame crop.

A cell crop computed by insetting a fixed pixel margin goes *negative* on a
small cell (the F237 trap: a 48px cell inset by 25px/side → width -2), and the
old code fell straight into ``bytearray(rw*rh*3)`` with a negative product and
died with the opaque ``ValueError: negative count``. The floor must instead
clamp a crop to the frame and reject only a truly empty one with a message that
names the offender. Pure-Python, no tesseract (the error paths fire first).
"""
import osctl


def main():
    cr = osctl._clamp_region

    # 1) a fully-inside region is returned unchanged
    assert cr(10, 20, 30, 40, 200, 200, None) == (10, 20, 30, 40)

    # 2) the F237 trap: a 48px cell inset 25px/side → width -2. Old path crashed
    #    with "negative count"; now it raises a clear, named error.
    for bad in [(25, 20, -2, 8), (10, 10, 0, 10), (10, 10, 10, -5), (10, 10, 10, 0)]:
        try:
            cr(*bad, 200, 200, bad)
            assert False, f"expected ValueError for {bad}"
        except ValueError as e:
            assert "empty" in str(e), str(e)

    # 3) partly off-frame (past the right/bottom edge) clamps to what is on-frame
    assert cr(190, 0, 30, 10, 200, 200, None) == (190, 0, 10, 10)
    assert cr(0, 195, 10, 30, 200, 200, None) == (0, 195, 10, 5)
    # negative origin clamps the start to 0 and keeps the visible remainder
    assert cr(-5, -5, 20, 20, 200, 200, None) == (0, 0, 15, 15)

    # 4) fully off-frame → nothing left → clear error, not a wrong slice
    for off in [(250, 10, 10, 10), (10, 250, 10, 10), (-50, 10, 30, 10)]:
        try:
            cr(*off, 200, 200, off)
            assert False, f"expected ValueError for {off}"
        except ValueError as e:
            assert "empty" in str(e), str(e)

    # 5) ocr_text's capture branch (no rgb) rejects a non-positive region up
    #    front with a clear message — before any tesseract call.
    for bad in [(10, 10, -2, 8), (10, 10, 10, 0)]:
        try:
            osctl.ocr_text(bad)
            assert False, f"expected ValueError for {bad}"
        except ValueError as e:
            assert "positive width/height" in str(e), str(e)
        except RuntimeError:
            # tesseract genuinely absent — only reachable if validation passed,
            # which would itself be the bug; so treat as failure.
            assert False, f"region {bad} reached capture without validation"

    print("F249 OK: _clamp_region trims an off-frame crop and rejects an empty "
          "one with a named error; ocr_text no longer crashes with "
          "'negative count' on a margin wider than the cell (F237 trap)")


if __name__ == "__main__":
    main()
