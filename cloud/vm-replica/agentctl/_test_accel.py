"""Acceleration invariant: every NumPy fast path must return the *byte-identical*
result of the pure-Python fallback it replaces. Toggling osctl._np exercises both
branches on the same live captures, so the floor stays correct whether or not
NumPy is present (道法自然: faster where the ground allows, correct everywhere).

Run:  DISPLAY=:0 python3 _test_accel.py
"""
from __future__ import annotations
import time
import osctl

_NP = osctl._np
assert _NP is not None, "this box has NumPy; the test needs it to compare paths"


def both(fn):
    """Run fn() with NumPy on, then off, restore, return (np_result, py_result)."""
    osctl._np = _NP
    a = fn()
    osctl._np = None
    b = fn()
    osctl._np = _NP
    return a, b


# two DIFFERENT frames so the change paths do real work
w, h, f0 = osctl.capture_rgb()
osctl.move_rel(43, 31)
time.sleep(0.05)
w, h, f1 = osctl.capture_rgb()

roi = (40, 90, min(w - 1, 1500), min(h - 1, 800))
pa, pw, ph = osctl.crop_rgb(f0, (w, h), roi)
pb, _, _ = osctl.crop_rgb(f1, (w, h), roi)

# 1) sample_color — mean of a region
n, p = both(lambda: osctl.sample_color(roi, rgb=f0, size=(w, h)))
assert n == p, ("sample_color mismatch", n, p)

# 2) region_diff — per-channel-tol change count (differing case)
for tol in (0, 12, 40):
    n, p = both(lambda tol=tol: osctl.region_diff(pa, pb, tol))
    assert n == p, ("region_diff mismatch", tol, n, p)
# identical case still fast-paths to 0 on both
assert osctl.region_diff(pa, pa, 0)["pixels"] == 0

# 3) locate_change — centroid + bbox of change (full frame and search window)
n, p = both(lambda: osctl.locate_change(f0, f1, (w, h), tol=12, min_count=1))
assert n == p, ("locate_change (full) mismatch", n, p)
n, p = both(lambda: osctl.locate_change(f0, f1, (w, h), tol=12, min_count=1,
                                        search=roi))
assert n == p, ("locate_change (search) mismatch", n, p)

# 4) locate_change_blobs — connected components of change
n, p = both(lambda: osctl.locate_change_blobs(f0, f1, (w, h), tol=12,
                                              min_count=30, search=roi))
assert n == p, ("locate_change_blobs mismatch",
                len(n) if n else 0, len(p) if p else 0)

# 5) sample_grid mean — per-cell centre mean over a lattice
n, p = both(lambda: osctl.sample_grid((100, 100, 900, 900), 12, 12,
                                      rgb=f0, size=(w, h)))
assert n == p, "sample_grid mean mismatch"

# speed: the vectorised path must not be *slower* than pure-Python on a big ROI
osctl._np = _NP
a = time.time()
osctl.locate_change(f0, f1, (w, h), tol=12, min_count=1)
tn = time.time() - a
osctl._np = None
a = time.time()
osctl.locate_change(f0, f1, (w, h), tol=12, min_count=1)
tp = time.time() - a
osctl._np = _NP
assert tn <= tp, ("numpy locate_change not faster", tn, tp)

print(f"ACCEL OK: sample_color / region_diff / locate_change / "
      f"locate_change_blobs / sample_grid — NumPy path byte-identical to "
      f"pure-Python on live frames; locate_change {tp / tn:.0f}x faster "
      f"({tp * 1e3:.0f}ms -> {tn * 1e3:.0f}ms).")
