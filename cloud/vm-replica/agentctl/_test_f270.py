"""F270 synthetic regression for `link_tracks` — no display required.

`link_tracks` associates per-frame point detections into temporal tracks: the
discriminator F269 proved a single frame-pair cannot give. The tests assert it:
  - links a straight-line mover across frames into ONE track with correct
    length / net translation, and a constant point into ONE pinned track,
  - keeps a one-off detection as a length-1 track (a flicker the caller drops),
  - bridges a one-frame drop-out when max_skip=1 and splits it when max_skip=0,
  - keeps two well-separated movers as two distinct tracks,
  - resolves a contested step one-to-one (nearest detection wins the track, the
    other starts its own) rather than double-assigning,
  - refuses to link across a gap larger than max_gap (a teleport starts anew),
  - honours min_len, preserves the original detection under 'det', accepts both
    dict and (x,y) inputs, and handles empty frames.
"""
import sys
sys.path.insert(0, ".")
import osctl

n = 0


def ok(cond, msg):
    global n
    assert cond, msg
    n += 1


def D(x, y, **kw):
    d = {"x": float(x), "y": float(y)}
    d.update(kw)
    return d


# --- a straight-line mover -> one track, correct net translation ------------
mover = [[D(100 + 20 * t, 200 + 10 * t)] for t in range(5)]
tr = osctl.link_tracks(mover, max_gap=60, max_skip=0)
ok(len(tr) == 1 and tr[0]["length"] == 5, f"one 5-frame track: {len(tr)}")
ok(abs(tr[0]["net"][0] - 80) < 1e-6 and abs(tr[0]["net"][1] - 40) < 1e-6,
   f"net translation (80,40): {tr[0]['net']}")
ok(tr[0]["span"] > 80, f"a mover's span is large: {tr[0]['span']:.1f}")

# --- a constant point -> one pinned track (span ~ 0) ------------------------
pin = [[D(300, 300)] for _ in range(5)]
trp = osctl.link_tracks(pin, max_gap=60)
ok(len(trp) == 1 and trp[0]["length"] == 5, "pinned point is one track")
ok(trp[0]["span"] < 1e-6, f"pinned span ~0 (overlay signature): {trp[0]['span']}")

# --- a one-off detection -> length-1 flicker --------------------------------
mixed = [[D(100, 100)], [D(110, 100)], [D(400, 400)], [D(120, 100)], [D(130, 100)]]
tm = osctl.link_tracks(mixed, max_gap=40, max_skip=0)
flick = [t for t in tm if t["length"] == 1]
ok(len(flick) == 1 and abs(flick[0]["points"][0]["x"] - 400) < 1e-6,
   f"the lone (400,400) is a length-1 flicker: {[t['length'] for t in tm]}")

# --- one-frame drop-out: bridged at max_skip=1, split at max_skip=0 ---------
drop = [[D(100, 100)], [D(108, 100)], [], [D(124, 100)], [D(132, 100)]]
b = osctl.link_tracks(drop, max_gap=40, max_skip=1)
ok(len(b) == 1 and b[0]["length"] == 4, f"max_skip=1 bridges the gap: {[t['length'] for t in b]}")
s = osctl.link_tracks(drop, max_gap=40, max_skip=0)
ok(len(s) == 2, f"max_skip=0 splits across the gap: {len(s)}")

# --- two well-separated movers -> two tracks --------------------------------
two = [[D(50 + 15 * t, 80), D(500 - 15 * t, 400)] for t in range(5)]
t2 = osctl.link_tracks(two, max_gap=40)
ok(len(t2) == 2 and all(t["length"] == 5 for t in t2),
   f"two movers -> two 5-frame tracks: {[t['length'] for t in t2]}")

# --- contested step resolved one-to-one -------------------------------------
# frame 0 has one track at (200,200); frame 1 has two detections, one near, one
# far. The near one continues the track; the far one opens its own.
con = [[D(200, 200)], [D(205, 200), D(245, 200)]]
tc = osctl.link_tracks(con, max_gap=60, max_skip=0)
cont = [t for t in tc if t["length"] == 2]
ok(len(tc) == 2 and len(cont) == 1, f"contested -> 1 continued + 1 new: {[t['length'] for t in tc]}")
ok(abs(cont[0]["points"][1]["x"] - 205) < 1e-6,
   "the NEAREST detection (205) continues the track, not the far one (245)")

# --- a teleport beyond max_gap starts a new track ---------------------------
tele = [[D(100, 100)], [D(300, 100)]]
tt = osctl.link_tracks(tele, max_gap=60, max_skip=0)
ok(len(tt) == 2, f"a >max_gap jump is not linked: {len(tt)}")

# --- min_len filter ---------------------------------------------------------
ml = osctl.link_tracks(mixed, max_gap=40, max_skip=0, min_len=2)
ok(all(t["length"] >= 2 for t in ml) and len(ml) < len(tm),
   "min_len drops the short tracks")

# --- payload preserved; tuple input; empty input ----------------------------
pl = osctl.link_tracks([[D(10, 10, tag="bot", speed=9)]], max_gap=40)
ok(pl[0]["points"][0]["det"]["tag"] == "bot" and pl[0]["points"][0]["det"]["speed"] == 9,
   "the original detection is preserved under 'det'")
tup = osctl.link_tracks([[(10.0, 10.0)], [(14.0, 10.0)]], max_gap=40, max_skip=0)
ok(len(tup) == 1 and tup[0]["length"] == 2, "accepts (x,y) tuple detections")
ok(osctl.link_tracks([], max_gap=40) == [], "no frames -> no tracks")
ok(osctl.link_tracks([[], [], []], max_gap=40) == [], "all-empty frames -> no tracks")

print(f"F270 link_tracks: {n} assertions passed")
