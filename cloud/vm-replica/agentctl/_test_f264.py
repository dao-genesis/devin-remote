"""F264 synthetic regression for `lead` — no display required.

`lead` turns a short history of (t, x, y) locations into an image-plane
velocity and a predicted lead point. The tests assert that it:
  - recovers exact velocity and prediction on a clean constant-velocity track,
  - reduces one-step-ahead error vs the "assume it stays" model on a noisy track,
  - skips None observations (a lost/refused frame) and counts only valid points,
  - refuses (None) on too few points or a single time instant,
  - honours horizon=0 (predict == last) and negative velocity / 2-D motion.
"""
import sys
sys.path.insert(0, ".")
import osctl

n = 0


def ok(cond, msg):
    global n
    assert cond, msg
    n += 1


# --- clean constant-velocity track: exact recovery ----------------------------
# x(t) = 100 + 30 t , y(t) = 50 - 12 t , sampled every 0.1 s
s = [(0.1 * i, 100 + 30 * (0.1 * i), 50 - 12 * (0.1 * i)) for i in range(6)]
r = osctl.lead(s, horizon=0.0)
ok(r is not None, "clean track must resolve")
ok(abs(r["vx"] - 30.0) < 1e-6, f"vx exact: {r['vx']}")
ok(abs(r["vy"] - (-12.0)) < 1e-6, f"vy exact: {r['vy']}")
ok(r["n"] == 6, f"n counts all valid: {r['n']}")
ok(abs(r["speed"] - (30.0 ** 2 + 12.0 ** 2) ** 0.5) < 1e-6, "speed = |v|")
# horizon=0 -> predict equals latest observation
ok(abs(r["px"] - r["x"]) < 1e-9 and abs(r["py"] - r["y"]) < 1e-9,
   "horizon=0 predicts the last point")
ok(abs(r["x"] - (100 + 30 * 0.5)) < 1e-6, f"x is latest sample: {r['x']}")

# --- prediction leads into the future ----------------------------------------
r2 = osctl.lead(s, horizon=0.2)
ok(abs(r2["px"] - (r2["x"] + 30.0 * 0.2)) < 1e-6, "px = x + vx*horizon")
ok(abs(r2["py"] - (r2["y"] - 12.0 * 0.2)) < 1e-6, "py = y + vy*horizon")

# --- lead beats 'assume it stays' on a noisy track ---------------------------
# straight x = 200 + 120 t line with small locate jitter (motion dominates
# jitter, the regime live practice measured: ~12 px/step vs ~2 px matcher noise)
jit = [2, -1, 1, -2, 1, -1, 2, -1]
track = [(0.1 * i, 200 + 120 * (0.1 * i) + jit[i], 0.0) for i in range(8)]
naive = lead_err = 0.0
cnt = 0
for i in range(2, len(track)):
    hist = track[:i]                       # everything observed so far
    est = osctl.lead(hist, horizon=(track[i][0] - track[i - 1][0]))
    actual_x = track[i][1]
    naive += abs(actual_x - track[i - 1][1])     # assume target stays put
    lead_err += abs(actual_x - est["px"])        # predicted lead
    cnt += 1
ok(lead_err / cnt < naive / cnt,
   f"lead error {lead_err / cnt:.2f} < naive {naive / cnt:.2f}")

# --- skips None observations (lost / refused frames) -------------------------
gappy = [(0.0, 10.0, 5.0), (0.1, None, 5.0), (0.2, 16.0, 5.0),
         (0.3, 19.0, None), (0.4, 22.0, 5.0)]
rg = osctl.lead(gappy)
ok(rg is not None and rg["n"] == 3, f"None rows skipped, n=3: {rg and rg['n']}")
ok(abs(rg["vx"] - 30.0) < 1e-6, f"vx from surviving points: {rg['vx']}")

# --- refusals -----------------------------------------------------------------
ok(osctl.lead([(0.0, 1.0, 2.0)]) is None, "one point -> None")
ok(osctl.lead([]) is None, "empty -> None")
ok(osctl.lead([(5.0, 1.0, 2.0), (5.0, 9.0, 2.0)]) is None,
   "single time instant -> None (no time base)")
ok(osctl.lead([(0.0, 1.0, 2.0), (0.1, 2.0, 2.0)], min_samples=5) is None,
   "fewer than min_samples -> None")

# --- two-sample slope & negative / 2-D velocity ------------------------------
r3 = osctl.lead([(0.0, 100.0, 100.0), (0.5, 90.0, 130.0)])
ok(abs(r3["vx"] - (-20.0)) < 1e-6, f"2-sample vx: {r3['vx']}")
ok(abs(r3["vy"] - 60.0) < 1e-6, f"2-sample vy: {r3['vy']}")

print(f"F264 lead: {n} assertions passed")
