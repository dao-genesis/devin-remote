"""F245 regression: capture_patch(bbox) must be byte-for-byte identical to
crop_rgb(capture_rgb()..., bbox) for in-bounds bboxes, while reading only the
rectangle (so the pixel waiters poll their region instead of the whole screen).

Backend-agnostic: capture_rgb is faked with a synthetic 'screen' so the test
runs without live X11. It asserts capture_patch issues a foveal sub-rect grab
(inclusive width/height) and that the bytes equal a full-grab + crop."""
import osctl

SW, SH = 64, 48


def _screen():
    """A deterministic SWxSH RGB 'screen': pixel (x,y) -> (x&255, y&255, (x+y)&255)."""
    buf = bytearray(SW * SH * 3)
    for y in range(SH):
        for x in range(SW):
            i = (y * SW + x) * 3
            buf[i], buf[i + 1], buf[i + 2] = x & 255, y & 255, (x + y) & 255
    return bytes(buf)


SCREEN = _screen()
calls = []


def fake_capture(x=0, y=0, w=None, h=None):
    """Emulate XGetImage of a sub-rect: clamp to screen, return packed (w,h,rgb)."""
    w = SW if w is None else w
    h = SH if h is None else h
    x = max(0, min(int(x), SW - 1))
    y = max(0, min(int(y), SH - 1))
    w = max(1, min(int(w), SW - x))
    h = max(1, min(int(h), SH - y))
    calls.append((x, y, w, h))
    out = bytearray(w * h * 3)
    for ry in range(h):
        src = ((y + ry) * SW + x) * 3
        out[ry * w * 3:(ry + 1) * w * 3] = SCREEN[src:src + w * 3]
    return (w, h, bytes(out))


osctl.capture_rgb = fake_capture

for BOX in [(10, 8, 40, 30), (0, 0, 0, 0), (1, 1, 2, 3), (60, 44, 63, 47), (5, 5, 5, 20)]:
    # full grab + crop (the OLD path)
    fw, fh, full = fake_capture()
    cropd, cpw, cph = osctl.crop_rgb(full, (fw, fh), BOX)
    # foveal patch (the NEW path)
    calls.clear()
    patch, pw, ph = osctl.capture_patch(BOX)
    # 1) byte-identical
    assert patch == cropd, ("capture_patch != crop for %s" % (BOX,), len(patch), len(cropd))
    assert (pw, ph) == (cpw, cph), ("dims differ", (pw, ph), (cpw, cph))
    # 2) it really did a foveal sub-rect grab (inclusive w,h), not a full-screen one
    x0, y0, x1, y1 = BOX
    assert calls == [(x0, y0, x1 - x0 + 1, y1 - y0 + 1)], ("not foveal", BOX, calls)
    # 3) and that sub-rect is strictly smaller than the whole screen (unless full)
    assert pw * ph <= SW * SH

print("F245 OK: capture_patch is byte-identical to full-grab+crop and reads "
      "only the inclusive sub-rectangle (foveal), not the whole screen")
