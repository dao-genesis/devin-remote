"""F246 regression: region_diff's a==b fast path. Byte-identical patches have 0
pixels exceeding any tol>=0, so region_diff returns 0 without the per-pixel loop.
This must be exact (same result as the full count) for every tol, and the full
count must still run — unchanged — whenever the patches actually differ.
Pure-Python: no live X11."""
import time

import osctl

W = H = 200
N = W * H


def frame(changes):
    buf = bytearray(N * 3)
    for idx, delta in changes.items():
        for c in range(3):
            buf[idx * 3 + c] = min(255, delta)
    return bytes(buf)


base = frame({})
same = frame({})                              # byte-identical to base
noise = frame({i: 2 for i in range(N)})       # every px +2 (sub-tol at tol>=2)
sig = frame({i: 100 for i in range(50)})      # 50 px changed hard

# 1) fast path is exact: identical buffers -> 0 for every tol
for tol in (0, 8, 24, 255):
    r = osctl.region_diff(base, same, tol=tol)
    assert r == {"pixels": 0, "total": N, "frac": 0.0}, ("fast path wrong", tol, r)

# 2) fast path must NOT change the differing-patch results (full count still runs)
assert osctl.region_diff(base, noise, tol=0)["pixels"] == N, "noise@tol0"
assert osctl.region_diff(base, noise, tol=2)["pixels"] == 0, "noise@tol2 (<=2 ignored)"
assert osctl.region_diff(base, sig, tol=8)["pixels"] == 50, "sig@tol8"
assert osctl.region_diff(base, sig, tol=0)["pixels"] == 50, "sig@tol0"

# 3) it really is faster on the identical case than the differing one
def t(a, b, tol, reps=20):
    s = time.time()
    for _ in range(reps):
        osctl.region_diff(a, b, tol=tol)
    return (time.time() - s) / reps

t_same = t(base, same, 0)
t_diff = t(base, sig, 0)
assert t_same < t_diff, ("fast path not faster", t_same, t_diff)

print("F246 OK: region_diff a==b fast path is exact for every tol, leaves the "
      "differing-patch counts unchanged, and is %.0fx faster on the idle "
      "(identical) poll" % (t_diff / t_same if t_same else 0))
