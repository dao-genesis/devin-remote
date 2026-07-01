"""F272 detect_sequence — ordered rising-edge events across several regions.

Pure, no display. Validates: single flash, ordered multi-flash, edge-trigger
(a flash spanning frames is one event), refractory re-arm (a tile flashing twice
is two), per-region dynamic range, flat region silence, dict input & key order,
explicit baseline/peak, tie-break by region order, empty input, refractory clamp.
"""
import sys
sys.path.insert(0, ".")
import osctl

ds = osctl.detect_sequence
LO, HI = 100.0, 255.0
n = 0


def ck(cond, msg):
    global n
    assert cond, msg
    n += 1


# 1) single region flashes once -> one event on the rising frame
lv = [[LO, LO, LO], [LO, HI, LO], [LO, HI, LO], [LO, LO, LO]]
e = ds(lv)
ck(len(e) == 1, e)
ck(e[0]["region"] == 1 and e[0]["frame"] == 1, e)
ck(e[0]["level"] == HI, e)

# 2) three regions flash in order 2,0,1 -> events recovered in that order
lv = [[LO, LO, LO],
      [LO, LO, HI],   # region 2
      [LO, LO, LO],
      [HI, LO, LO],   # region 0
      [LO, LO, LO],
      [LO, HI, LO],   # region 1
      [LO, LO, LO]]
e = ds(lv)
ck([x["region"] for x in e] == [2, 0, 1], e)
ck([x["frame"] for x in e] == [1, 3, 5], e)

# 3) edge-trigger: a flash held high across many frames is ONE event
lv = [[LO], [HI], [HI], [HI], [HI], [LO]]
e = ds(lv)
ck(len(e) == 1 and e[0]["frame"] == 1, e)

# 4) refractory re-arm: same region flashes twice -> two events
lv = [[LO], [HI], [LO], [HI], [LO]]
e = ds(lv)
ck(len(e) == 2, e)
ck([x["frame"] for x in e] == [1, 3], e)

# 4b) with refractory=2, a single-frame gap is NOT enough to re-arm -> one event
e2 = ds(lv, refractory=2)
ck(len(e2) == 1, e2)

# 5) per-region dynamic range: a dim region (span 100->140) still fires on its
#    own scale while a bright neighbour (100->255) is judged on its own.
lv = [[100.0, 100.0], [140.0, 100.0], [100.0, 255.0]]
e = ds(lv, thresh=0.4)   # dim gate=116, bright gate=162
ck([x["region"] for x in e] == [0, 1], e)

# 6) flat region never fires (peak == base -> no span, strict >)
lv = [[LO, LO], [LO, LO], [LO, LO]]
ck(ds(lv) == [], "flat should be silent")

# 7) dict input: keys preserved, order follows first frame's keys
lv = [{"a": LO, "b": LO}, {"a": LO, "b": HI}, {"a": HI, "b": LO}]
e = ds(lv)
ck([x["region"] for x in e] == ["b", "a"], e)

# 8) explicit baseline/peak override the per-series min/max (as a dict here)
lv = [[120.0], [180.0]]     # auto: base=120 peak=180 gate=144 -> fires at f1
e = ds(lv, baseline=[0.0], peak=[400.0], thresh=0.5)  # gate=200 -> never
ck(e == [], e)

# 9) tie-break within a frame is by region order
lv = [[LO, LO, LO], [HI, HI, LO]]
e = ds(lv)
ck([x["region"] for x in e] == [0, 1] and all(x["frame"] == 1 for x in e), e)

# 10) empty input -> empty; refractory<=0 clamps to 1 (still edge-triggers)
ck(ds([]) == [], "empty")
lv = [[LO], [HI], [LO], [HI]]
ck(len(ds(lv, refractory=0)) == 2, "refractory clamp")

# 11) ragged frames rejected
try:
    ds([[LO, LO], [LO]])
    ck(False, "ragged not rejected")
except ValueError:
    ck(True, "")

print(f"F272 OK: detect_sequence recovers ordered rising-edge events across "
      f"regions — order, edge-trigger, refractory re-arm, per-region gate, flat "
      f"silence, dict keys, explicit base/peak, tie-break, clamp ({n} checks)")
