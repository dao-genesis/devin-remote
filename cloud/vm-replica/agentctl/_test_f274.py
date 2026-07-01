"""F274 grid_index — snap a foreign point bag onto an already-known lattice.

Pure, no display. Validates: indexing a separate reading onto a grid_lattice
result, de-duping repeat detections into one per-cell centroid, row-major cell
map shape matching grid_lattice, occupied-cell listing, dict key passthrough,
bare {"xs","ys"} lattice, max_dist stray rejection (scalar and per-axis),
snapping off-centre points to the nearest line, and degenerate inputs.
"""
import sys
sys.path.insert(0, ".")
import osctl

gl = osctl.grid_lattice
gi = osctl.grid_index
n = 0


def ck(cond, msg=""):
    global n
    assert cond, msg
    n += 1


def full_grid(rows, cols, ox, oy, pitch):
    return [(ox + c * pitch, oy + r * pitch) for r in range(rows) for c in range(cols)]


# a 3x3 lattice built once from the resting cell centres
lat = gl(full_grid(3, 3, 100, 100, 60))       # xs=[100,160,220], ys=[100,160,220]
ck(lat["xs"] == [100, 160, 220] and lat["ys"] == [100, 160, 220], lat)

# 1) a foreign reading of three tiles snaps onto the fixed lattice (diagonal)
r = gi(lat, [(101, 99), (161, 159), (219, 221)])
ck(r["rows"] == 3 and r["cols"] == 3, (r["rows"], r["cols"]))
ck(r["occupied"] == [(0, 0), (1, 1), (2, 2)], r["occupied"])
ck(all(p["row"] == p["col"] for p in r["points"]), r["points"])

# 2) cells shape matches grid_lattice (row-major, None where untouched)
ck(len(r["cells"]) == 3 and all(len(row) == 3 for row in r["cells"]), r["cells"])
ck(r["cells"][0][0] is not None and r["cells"][0][1] is None, r["cells"])

# 3) repeat detections of ONE tile collapse to a single averaged centroid
r = gi(lat, [(98, 102), (102, 98), (100, 100), (222, 218)])
ck(r["occupied"] == [(0, 0), (2, 2)], r["occupied"])       # two distinct cells
agg = r["cells"][0][0]
ck(agg["n"] == 3, agg)                                     # three folded into one
ck(abs(agg["x"] - 100) < 1e-6 and abs(agg["y"] - 100) < 1e-6, agg)  # centroid

# 4) points list keeps every kept detection (not de-duped), each indexed
ck(len(r["points"]) == 4 and all("row" in p for p in r["points"]), r["points"])

# 5) off-centre point snaps to the NEAREST line, not floored/truncated
r = gi(lat, [(140, 100)])          # x=140 is nearer 160 (d=20) than 100 (d=40)
ck(r["occupied"] == [(0, 1)], r["occupied"])

# 6) dict points: extra keys preserved through indexing
r = gi(lat, [{"x": 100, "y": 100, "tag": "a"}, {"x": 220, "y": 220, "tag": "b"}])
ck({p["tag"] for p in r["points"]} == {"a", "b"}, r["points"])
ck(r["points"][0]["row"] == 0 and r["points"][0]["col"] == 0, r["points"][0])

# 7) bare {"xs","ys"} lattice (not a full grid_lattice result) works
r = gi({"xs": [0, 100], "ys": [0, 100]}, [(2, 98), (99, 1)])
ck(r["occupied"] == [(0, 1), (1, 0)], r["occupied"])

# 8) max_dist scalar drops a stray beyond the guard on either axis
r = gi(lat, [(100, 100), (100, 500)], max_dist=50)   # y=500 is 280 from nearest (220)
ck(r["occupied"] == [(0, 0)], r["occupied"])
ck(len(r["dropped"]) == 1 and abs(r["dropped"][0]["y"] - 500) < 1e-6, r["dropped"])

# 9) same point kept when max_dist is generous
r = gi(lat, [(100, 100), (100, 250)], max_dist=200)
ck(len(r["dropped"]) == 0 and len(r["points"]) == 2, r)

# 10) per-axis max_dist tuple: tight on x, loose on y (dx to nearest col 160 = 20)
r = gi(lat, [(140, 250)], max_dist=(10, 200))   # dx=20>10 -> drop
ck(len(r["dropped"]) == 1 and r["occupied"] == [], r)
r = gi(lat, [(140, 250)], max_dist=(40, 200))   # dx=20<=40 -> keep
ck(r["occupied"] == [(2, 1)], r["occupied"])

# 11) empty reading -> empty result but lattice dims reported
r = gi(lat, [])
ck(r["rows"] == 3 and r["cols"] == 3 and r["occupied"] == [] and r["points"] == [], r)

# 12) empty / line-less lattice -> everything empty, nothing crashes
r = gi({"xs": [], "ys": []}, [(1, 2), (3, 4)])
ck(r["rows"] == 0 and r["cols"] == 0 and r["cells"] == [] and r["occupied"] == [], r)

# 13) composes with grid_lattice on a real re-centred/grown board:
#     idle 4x4 lattice, then index a 3-tile flash reading onto it
lat4 = gl(full_grid(4, 4, 300, 200, 132))
flash = [(301, 201), (300, 200),          # cell (0,0) seen twice
         (300 + 3 * 132, 200 + 132),      # cell (1,3)
         (300 + 132, 200 + 2 * 132)]      # cell (2,1)
r = gi(lat4, flash)
ck(r["rows"] == 4 and r["cols"] == 4, (r["rows"], r["cols"]))
ck(r["occupied"] == [(0, 0), (1, 3), (2, 1)], r["occupied"])
ck(r["cells"][0][0]["n"] == 2, r["cells"][0][0])

print(f"F274 OK: grid_index snaps a foreign reading onto a known lattice, "
      f"de-dupes repeats into one per-cell centroid, lists occupied cells, "
      f"rejects strays via max_dist, preserves dict keys, composes with "
      f"grid_lattice; degenerate cases safe ({n} checks)")
