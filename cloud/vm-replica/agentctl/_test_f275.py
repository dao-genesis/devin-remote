"""F275 frame_consensus — which observations persist across a burst of frames.

Pure, no display. Validates: majority keep by frame count, within-frame dedup
(a doubled detection is one vote), threshold = ceil(min_frac*F), min_frac clamp,
kept ordering (most-persistent first), counts/items bookkeeping, a custom key
mapping raw items to identities, empty / single-frame inputs, and composition
with grid_index (feeding per-frame occupied cells to vote away transients).
"""
import sys
sys.path.insert(0, ".")
import osctl

fc = osctl.frame_consensus
n = 0


def ck(cond, msg=""):
    global n
    assert cond, msg
    n += 1


# 1) A in all 3 frames, B in 2, C in 1; default min_frac=0.5 -> threshold 2
r = fc([["A", "B"], ["A", "B", "C"], ["A"]])
ck(r["frames"] == 3 and r["threshold"] == 2, r)
ck(r["kept"] == ["A", "B"], r["kept"])           # C (1 frame) dropped
ck(r["counts"] == {"A": 3, "B": 2, "C": 1}, r["counts"])

# 2) kept ordered by descending count, then identity
r = fc([["x", "y"], ["y", "z"], ["y"], ["x"]], min_frac=0.25)
ck(r["kept"] == ["y", "x", "z"], r["kept"])       # y:3, x:2, z:1

# 3) within-frame duplicates count once (no ballot stuffing)
r = fc([["A", "A", "A"], ["A"], []], min_frac=0.9)
ck(r["counts"]["A"] == 2, r["counts"])            # seen in 2 of 3 frames, not 4
ck(r["threshold"] == 3 and r["kept"] == [], r)    # ceil(0.9*3)=3 > 2

# 4) threshold is ceil(min_frac*F)
ck(fc([[1]] * 4, min_frac=0.5)["threshold"] == 2, "ceil(2.0)")
ck(fc([[1]] * 5, min_frac=0.5)["threshold"] == 3, "ceil(2.5)=3")
ck(fc([[1]] * 3, min_frac=0.34)["threshold"] == 2, "ceil(1.02)=2")

# 5) min_frac clamps: >1 -> needs all frames; <=0 -> everything seen kept
allf = fc([["A", "B"], ["A"]], min_frac=5.0)
ck(allf["threshold"] == 2 and allf["kept"] == ["A"], allf)   # only A in both
anyf = fc([["A", "B"], ["C"]], min_frac=0.0)
ck(sorted(anyf["kept"]) == ["A", "B", "C"], anyf)            # thr clamps to 1

# 6) custom key: raw points bucketed by identity, items kept for centroiding
pts_frames = [
    [(101, 200), (400, 100)],     # cell (0,0)-ish and (0,3)-ish
    [(99, 201), (402, 98)],
    [(100, 199)],                 # only the first cell this frame
]
def cell(p):
    return (round(p[1] / 100), round(p[0] / 100))   # (row,col) at 100px pitch
r = fc(pts_frames, min_frac=0.6, key=cell)
ck(r["threshold"] == 2, r["threshold"])             # ceil(0.6*3)=2
# (2,1) in all 3 frames; (1,4) in frames 1&2 (count 2>=2) -> both kept, (2,1) first
ck(r["kept"] == [(2, 1), (1, 4)], r["kept"])
ck(r["counts"][(2, 1)] == 3 and r["counts"][(1, 4)] == 2, r["counts"])
# items let the caller average a stable click target
xs = [p[0] for p in r["items"][(2, 1)]]
ck(len(xs) == 3 and abs(sum(xs) / 3 - 100) < 1.0, r["items"][(2, 1)])

# 7) single frame: threshold 1, everything seen kept
r = fc([["A", "B", "B"]])
ck(r["frames"] == 1 and r["threshold"] == 1 and sorted(r["kept"]) == ["A", "B"], r)

# 8) empty input -> empty, no crash
r = fc([])
ck(r["frames"] == 0 and r["kept"] == [] and r["counts"] == {}, r)
r = fc([[], [], []])
ck(r["kept"] == [] and r["threshold"] == 2, r)

# 9) composition with grid_index: vote away a phantom that shows in one frame
lat = osctl.grid_lattice([(c * 60, rr * 60) for rr in range(3) for c in range(3)])
frame_cells = []
for reading in ([(0, 0), (120, 60)],               # cells (0,0),(1,2)
                [(0, 0), (120, 60)],
                [(0, 0), (120, 60), (60, 120)]):    # phantom (2,1) once
    gi = osctl.grid_index(lat, reading)
    frame_cells.append(gi["occupied"])
r = fc(frame_cells, min_frac=0.6)                   # ceil(0.6*3)=2
ck(r["kept"] == [(0, 0), (1, 2)], r["kept"])        # phantom (2,1) seen once -> dropped

print(f"F275 OK: frame_consensus keeps observations by frame count, dedups "
      f"within a frame, threshold=ceil(min_frac*F) with clamp, orders by "
      f"persistence, custom key + items for centroiding, composes with "
      f"grid_index to vote away transients; degenerate cases safe ({n} checks)")
