"""F273 grid_lattice — structure an unordered bag of cell centres into a grid.

Pure, no display. Validates: clean NxN recovery + ordering, jitter tolerance,
missing cells (fewer points than R*C), non-square grids, row-major cell map,
per-axis adaptive tol, explicit tol, dict passthrough, single row / single point,
empty input, pitch estimate, and that blank-slot centres are reconstructable.
"""
import sys
sys.path.insert(0, ".")
import osctl

gl = osctl.grid_lattice
n = 0


def ck(cond, msg=""):
    global n
    assert cond, msg
    n += 1


def full_grid(rows, cols, ox, oy, pitch):
    return [(ox + c * pitch, oy + r * pitch) for r in range(rows) for c in range(cols)]


# 1) clean 3x3
g = gl(full_grid(3, 3, 100, 200, 60))
ck(g["rows"] == 3 and g["cols"] == 3, g)
ck(g["xs"] == [100, 160, 220], g["xs"])
ck(g["ys"] == [200, 260, 320], g["ys"])
ck(abs(g["pitch"][0] - 60) < 1e-6 and abs(g["pitch"][1] - 60) < 1e-6, g["pitch"])
ck(all(g["cells"][r][c] is not None for r in range(3) for c in range(3)), "full")

# 2) every point indexed to the right (row, col)
pts = [{"x": x, "y": y} for (x, y) in full_grid(3, 3, 100, 200, 60)]
g = gl(pts)
idx = {(p["row"], p["col"]) for p in g["points"]}
ck(idx == {(r, c) for r in range(3) for c in range(3)}, idx)

# 3) sub-pixel jitter does not split lines
import random
random.seed(1)
jit = [(x + random.uniform(-4, 4), y + random.uniform(-4, 4))
       for (x, y) in full_grid(4, 4, 80, 90, 50)]
g = gl(jit)
ck(g["rows"] == 4 and g["cols"] == 4, (g["rows"], g["cols"]))

# 4) missing cells: drop two tiles, lattice still 3x3, those slots None
pts = full_grid(3, 3, 0, 0, 40)
del pts[4]          # centre
del pts[0]          # top-left (index shifts, fine)
g = gl(pts)
ck(g["rows"] == 3 and g["cols"] == 3, (g["rows"], g["cols"]))
none_ct = sum(g["cells"][r][c] is None for r in range(3) for c in range(3))
ck(none_ct == 2, none_ct)

# 5) non-square grid (2 rows x 5 cols)
g = gl(full_grid(2, 5, 10, 10, 30))
ck(g["rows"] == 2 and g["cols"] == 5, (g["rows"], g["cols"]))

# 6) blank-slot centre reconstructable from xs/ys even with no blob there
pts = full_grid(3, 3, 100, 100, 50)
del pts[5]          # remove (row1,col2)
g = gl(pts)
ck(g["cells"][1][2] is None, "slot should be empty")
ck(g["xs"][2] == 200 and g["ys"][1] == 150, (g["xs"], g["ys"]))  # centre still known

# 7) explicit scalar tol
g = gl(full_grid(2, 2, 0, 0, 100), tol=40)
ck(g["rows"] == 2 and g["cols"] == 2, g)

# 8) explicit per-axis tol tuple
g = gl(full_grid(2, 3, 0, 0, 100), tol=(40, 40))
ck(g["rows"] == 2 and g["cols"] == 3, g)

# 9) dict extra keys preserved through indexing
g = gl([{"x": 0, "y": 0, "count": 7}, {"x": 50, "y": 0, "count": 9}])
ck(g["rows"] == 1 and g["cols"] == 2, g)
ck({p["count"] for p in g["points"]} == {7, 9}, g["points"])

# 10) single point -> 1x1
g = gl([(5, 5)])
ck(g["rows"] == 1 and g["cols"] == 1 and g["cells"][0][0] is not None, g)

# 11) empty input -> 0x0
g = gl([])
ck(g["rows"] == 0 and g["cols"] == 0 and g["cells"] == [], g)

print(f"F273 OK: grid_lattice recovers R/C, line centres, pitch, row-major cell "
      f"map; tolerates jitter & missing tiles; non-square; blank-slot centres "
      f"reconstructable; dict passthrough; degenerate cases ({n} checks)")
