"""F244 regression: wait_for_change / wait_until_stable must measure sameness
through region_diff(tol, min_count). Defaults (tol=0, min_count=1) reproduce the
old byte-exact behaviour exactly; raised thresholds reject sub-threshold noise
(a hover ring, a blinking caret, the mouse cursor) that the byte-exact compare
mistook for "it happened" / "it never settles". Pure-Python: the screen-capture
stream is faked, no live X11."""
import itertools

import osctl

W = H = 10
N = W * H


def frame(changes):
    """A WxH RGB frame: black, with `changes` = {pixel_index: delta} applied."""
    buf = bytearray(N * 3)
    for idx, delta in changes.items():
        for c in range(3):
            buf[idx * 3 + c] = min(255, delta)
    return bytes(buf)


def fake_stream(frames):
    it = itertools.cycle(frames)
    osctl.capture_rgb = lambda: (W, H, next(it))


BBOX = (0, 0, W - 1, H - 1)
base = frame({})
noise = frame({i: 100 for i in range(10)})    # 10 px changed hard (< min_count)
subpx = frame({i: 2 for i in range(N)})        # every px +2 (< tol)
realchg = frame({i: 100 for i in range(40)})   # 40 px changed hard (>= min_count)

# --- wait_for_change: default is exact byte-equality (old behaviour) ---
fake_stream([noise])
r = osctl.wait_for_change(BBOX, baseline=base, interval=0, timeout=0.2)
assert r["changed"] and r["pixels"] == 10, ("default must fire on any pixel", r)

# tol gating: a uniform +2 wobble must NOT count as change.
fake_stream([subpx, subpx, subpx])
r = osctl.wait_for_change(BBOX, baseline=base, interval=0, timeout=0.2,
                          tol=24, min_count=30)
assert not r["changed"], ("tol must look past sub-pixel wobble", r)

# min_count gating: 10 changed px is below threshold; 40 px is the real onset.
fake_stream([noise, noise, realchg])
r = osctl.wait_for_change(BBOX, baseline=base, interval=0, timeout=0.5,
                          tol=24, min_count=30)
assert r["changed"] and r["pixels"] == 40, ("must wait for meaningful change", r)

# --- wait_until_stable: default exact; tolerant settles past noise ---
# Exact: a strictly alternating flicker resets the settle counter every step,
# so it never reaches `settle` consecutive identical captures.
fake_stream([base, noise])
r = osctl.wait_until_stable(BBOX, settle=2, interval=0, timeout=0.2)
assert not r["stable"] and r["changes"] >= 1, ("exact must see the flicker", r)

# Tolerant: the same 10px flicker is "at rest" -> settles.
fake_stream([base, noise, base, base])
r = osctl.wait_until_stable(BBOX, settle=2, interval=0, timeout=0.5,
                            tol=24, min_count=30)
assert r["stable"], ("tolerant must settle past sub-threshold flicker", r)

print("F244 OK: waits measure sameness via region_diff; defaults byte-exact, "
      "tol/min_count reject sub-threshold noise")
