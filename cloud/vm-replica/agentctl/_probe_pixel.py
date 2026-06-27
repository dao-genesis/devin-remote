"""Standalone live reproduction of F159 on Windows: pixel(x,y) atomic colour read
(cross-validated against a full capture_rgb at the same coordinate) and wait_pixel
matching + timeout. Deterministic — reads the live screen, changes nothing."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl


def main():
    w, h, full = osctl.capture_rgb()
    x, y = w // 2, h // 2
    off = (y * w + x) * 3
    ref = (full[off], full[off + 1], full[off + 2])
    p = osctl.pixel(x, y)
    print(f"[{'PASS' if p == ref else 'FAIL'}] pixel() matches the same coord in a "
          f"full capture_rgb -> {p} vs {ref}")

    t0 = time.monotonic()
    hit = osctl.wait_pixel(x, y, ref, tol=12, timeout=2.0)
    dt = time.monotonic() - t0
    print(f"[{'PASS' if hit and dt < 0.5 else 'FAIL'}] wait_pixel returns at once "
          f"for the colour already there -> hit={hit} dt={dt:.3f}s")

    impossible = ((ref[0] + 128) % 256, (ref[1] + 128) % 256, (ref[2] + 128) % 256)
    t0 = time.monotonic()
    miss = osctl.wait_pixel(x, y, impossible, tol=2, timeout=1.0)
    dt = time.monotonic() - t0
    print(f"[{'PASS' if (not miss) and 0.9 < dt < 1.6 else 'FAIL'}] wait_pixel times "
          f"out for a colour that never appears -> miss={not miss} dt={dt:.3f}s")


if __name__ == "__main__":
    main()
