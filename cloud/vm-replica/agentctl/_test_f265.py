"""F265 synthetic regression for `consensus_shift` — no display required.

`consensus_shift` fuses a bag of noisy per-feature (dx, dy) displacement votes
into one dominant image translation with a stated confidence, and refuses when
no single shift commands a majority. The tests assert that it:
  - recovers an exact shift from clean, unanimous votes (support 1.0),
  - recovers the dominant shift from votes spread by texture noise + a couple of
    gross outliers, where a plain mean/median would be dragged off,
  - reproduces the real SuperTux pan vote-bag (a ~-26 px pan whose median read
    -20 px at 31 % agreement) as a confident shift with majority support,
  - reports true zero from the standing-still vote-bag,
  - refuses (None) on scattered votes with no dominant value (death / transition
    / motion past the search window),
  - refuses on too few votes and honours min_support / tol / None-dropping.
"""
import sys
sys.path.insert(0, ".")
import osctl

n = 0


def ok(cond, msg):
    global n
    assert cond, msg
    n += 1


# --- clean unanimous votes: exact recovery, full support ---------------------
clean = [(10.0, -4.0)] * 8
r = osctl.consensus_shift(clean, tol=8.0)
ok(r is not None, "clean votes must resolve")
ok(abs(r["dx"] - 10.0) < 1e-9 and abs(r["dy"] - (-4.0)) < 1e-9,
   f"exact shift: {r['dx']},{r['dy']}")
ok(abs(r["support"] - 1.0) < 1e-9, f"unanimous support 1.0: {r['support']}")
ok(r["inliers"] == 8 and r["n"] == 8, f"counts: {r['inliers']}/{r['n']}")

# --- dominant shift survives texture noise + gross outliers ------------------
# 10 votes near (-30, 0) within a tile of noise, plus two wild mislocks.
noisy = [(-32.0, 0.0), (-28.0, 2.0), (-30.0, -2.0), (-34.0, 0.0),
         (-30.0, 0.0), (-26.0, 1.0), (-32.0, -1.0), (-29.0, 0.0),
         (128.0, 8.0), (-128.0, -40.0)]
rn = osctl.consensus_shift(noisy, tol=8.0)
ok(rn is not None, "noisy-but-clustered votes resolve")
ok(abs(rn["dx"] - (-30.0)) < 4.0, f"dominant dx ~ -30: {rn['dx']}")
ok(rn["inliers"] == 8 and rn["n"] == 10,
   f"8 inliers, 2 outliers rejected: {rn['inliers']}/{rn['n']}")
# a plain mean is dragged toward the outliers; consensus stays on the cluster.
mean_dx = sum(v[0] for v in noisy) / len(noisy)
ok(abs(rn["dx"] - (-30.0)) < abs(mean_dx - (-30.0)),
   f"consensus {rn['dx']:.1f} closer to truth than mean {mean_dx:.1f}")

# --- the real SuperTux pan vote-bag (measured dt=110 ms, ~-26 px pan) --------
# Per-block dx histogram from live play: -48:1 -32:12 -16:10 +0:8 +128:1.
# Naive median read -20 px with only 31 % within a few px of it.
pan = ([(-48.0, 0.0)] + [(-32.0, 0.0)] * 12 + [(-16.0, 0.0)] * 10
       + [(0.0, 0.0)] * 8 + [(128.0, 0.0)])
rp = osctl.consensus_shift(pan, tol=16.0, min_support=0.5)
ok(rp is not None, "real pan vote-bag resolves with tile-scale tol")
ok(-34.0 < rp["dx"] < -18.0, f"recovers the ~-26 px pan: {rp['dx']:.1f}")
ok(rp["support"] >= 0.5, f"majority support: {rp['support']:.2f}")
ok(rp["dx"] < 0 and abs(rp["dy"]) < 1e-9, "leftward world scroll, no vertical")

# --- standing still: true zero -----------------------------------------------
still = [(0.0, 0.0)] * 36 + [(-4.0, 0.0), (-8.0, 0.0)]
rs = osctl.consensus_shift(still, tol=8.0)
ok(rs is not None and abs(rs["dx"]) < 2.0 and abs(rs["dy"]) < 1e-9,
   f"standing still -> ~zero shift: {rs and rs['dx']}")
ok(rs["support"] > 0.9, f"near-unanimous zero: {rs['support']:.2f}")

# --- scattered votes (death / transition): refuse ----------------------------
# A real over-window/death frame spreads votes across the whole range with no
# value repeating enough to form a majority.
scatter = [(-160.0, 0.0), (-120.0, 12.0), (-80.0, -16.0), (-40.0, 24.0),
           (0.0, -24.0), (40.0, 8.0), (80.0, -8.0), (120.0, 16.0),
           (160.0, -12.0), (-100.0, 4.0)]
ok(osctl.consensus_shift(scatter, tol=8.0, min_support=0.5) is None,
   "no dominant shift -> refuse")
# a high min_support makes even a moderate cluster insufficient -> refuse
ok(osctl.consensus_shift(noisy, tol=8.0, min_support=0.95) is None,
   "min_support gate refuses when cluster is not near-unanimous")

# --- refusals & input hygiene -------------------------------------------------
ok(osctl.consensus_shift([(1.0, 1.0), (1.0, 1.0)], min_votes=4) is None,
   "fewer than min_votes -> None")
ok(osctl.consensus_shift([]) is None, "empty -> None")
# None components dropped (a refused locate), counted out of survivors
gappy = [(10.0, 0.0), (None, 0.0), (10.0, 0.0), (10.0, None), (10.0, 0.0),
         (10.0, 0.0)]
rgp = osctl.consensus_shift(gappy, tol=4.0)
ok(rgp is not None and rgp["n"] == 4 and abs(rgp["dx"] - 10.0) < 1e-9,
   f"None votes dropped, n=4: {rgp and rgp['n']}")

# --- tol widens what counts as one shift -------------------------------------
spread = [(-40.0, 0.0)] * 3 + [(-24.0, 0.0)] * 3 + [(-8.0, 0.0)] * 3
# tight tol: no single value gets a majority -> refuse
ok(osctl.consensus_shift(spread, tol=4.0, min_support=0.5) is None,
   "tight tol splits the spread -> refuse")
# tile-scale tol: the whole spread is one shift -> resolve near its centre
rw = osctl.consensus_shift(spread, tol=16.0, min_support=0.5)
ok(rw is not None and -40.0 <= rw["dx"] <= -8.0,
   f"wide tol fuses the spread: {rw and rw['dx']}")

print(f"F265 consensus_shift: {n} assertions passed")
