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

# 6) find_color — centroid of a colour (full frame, step, search window)
px = osctl.pixel(30, min(h - 1, 1150))
for kw in (dict(tol=10), dict(tol=10, step=3),
           dict(tol=10, search=(200, 200, 900, 900))):
    n, p = both(lambda kw=kw: osctl.find_color(px, rgb=f0, size=(w, h), **kw))
    assert n == p, ("find_color mismatch", kw, n, p)

# 7) find_color_blobs — connected components of a colour
for kw in (dict(tol=10, min_count=5), dict(tol=10, step=2, min_count=3),
           dict(tol=10, search=(200, 200, 900, 900), min_count=5)):
    n, p = both(lambda kw=kw: osctl.find_color_blobs(px, rgb=f0, size=(w, h),
                                                     **kw))
    assert n == p, ("find_color_blobs mismatch", kw, len(n), len(p))

# 8) match_template — SAD arg-min (bounded search so pure-Python is quick);
#    also step>1 and a mask, since both change which pixels are summed.
patch, pw, ph = osctl.crop_rgb(f0, (w, h), (760, 560, 809, 609))
sr = (700, 500, 900, 700)
n, p = both(lambda: osctl.match_template(patch, pw, ph, rgb=f0, size=(w, h),
                                        search=sr))
assert n == p, ("match_template mismatch", n, p)
msk = bytes([1 if (i // pw + i % pw) % 2 == 0 else 0 for i in range(pw * ph)])
n, p = both(lambda: osctl.match_template(patch, pw, ph, rgb=f0, size=(w, h),
                                        search=sr, step=2, mask=msk))
assert n == p, ("match_template (step+mask) mismatch", n, p)

# 9) match_template_all — all hits (relative ceil, fixed ceil, step+mask)
n, p = both(lambda: osctl.match_template_all(patch, pw, ph, rgb=f0, size=(w, h),
                                            search=sr, min_sep=(8, 8)))
assert n == p, ("match_template_all mismatch", len(n), len(p))
n, p = both(lambda: osctl.match_template_all(patch, pw, ph, rgb=f0, size=(w, h),
                                            search=sr, max_score=6000,
                                            min_sep=(6, 6)))
assert n == p, ("match_template_all (max_score) mismatch", len(n), len(p))
n, p = both(lambda: osctl.match_template_all(patch, pw, ph, rgb=f0, size=(w, h),
                                            search=sr, step=2, mask=msk,
                                            min_sep=(6, 6)))
assert n == p, ("match_template_all (step+mask) mismatch", len(n), len(p))

# 10) edge_map / edge_hamming — binary edge mask and its diff
eb = (300, 300, 380, 380)
n, p = both(lambda: osctl.edge_map(f0, (w, h), eb, thr=40))
assert n == p, "edge_map mismatch"
ref = osctl.edge_map(f0, (w, h), eb, thr=40)[0]
cnd = osctl.edge_map(f0, (w, h), (305, 305, 385, 385), thr=40)[0]
n, p = both(lambda: osctl.edge_hamming(ref, cnd))
assert n == p, ("edge_hamming mismatch", n, p)

# 11) match_edges — locate by shape (bounded search)
re2, ew, eh = osctl.edge_map(f0, (w, h), (760, 560, 799, 599), thr=40)
n, p = both(lambda: osctl.match_edges(re2, ew, eh, rgb=f0, size=(w, h),
                                     search=(720, 520, 860, 660), thr=40))
assert n == p, ("match_edges mismatch", n, p)

# 12) edge_signature — scale-free structural fingerprint
for eb in ((300, 300, 540, 540), (100, 100, 131, 131)):
    n, p = both(lambda eb=eb: osctl.edge_signature(f0, (w, h), eb))
    assert n == p, ("edge_signature mismatch", eb)

# 13) _luma_resample — the classify/cluster/detect_grid nearest-neighbour core
for (a, b2, c, d, nm) in ((100, 100, 231, 199, 32), (0, 0, 7, 7, 8),
                          (500, 400, 637, 533, 16), (10, 10, 11, 12, 32)):
    n, p = both(lambda a=a, b2=b2, c=c, d=d, nm=nm:
                osctl._luma_resample(f0, w, a, b2, c, d, nm))
    assert n == p, ("_luma_resample mismatch", a, b2, c, d, nm)

# 14) classify_grid — end-to-end sprite lattice classification (uses resample)
tpl = [("a", osctl.crop_rgb(f0, (w, h), (300, 300, 331, 331))[0], 32, 32),
       ("b", osctl.crop_rgb(f0, (w, h), (400, 400, 431, 431))[0], 32, 32)]
n, p = both(lambda: osctl.classify_grid((300, 300, 495, 431), 3, 2, tpl,
                                        rgb=f0, size=(w, h)))
assert n == p, ("classify_grid mismatch", n, p)

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
