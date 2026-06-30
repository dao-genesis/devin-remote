"""F247 regression: sample_grid classifies a regular cols x rows lattice from ONE
capture — the grid generalisation of sample_color. It must (1) map cell (r,c) to
the right screen region, (2) return each cell's *centre* mean (so the grid lines /
borders between cells never pollute a cell), (3) equal a centred sample_color for
a solid cell, (4) read fewer pixels than the whole cell (the loss it cuts), and
(5) validate its args. Pure-Python: capture_rgb is faked with a synthetic screen,
so this runs without live X11."""
import time
import osctl

CELL = 28
COLS, ROWS = 10, 20            # a real Tetris-sized lattice (200 cells)
GW, GH = COLS * CELL, ROWS * CELL
LO = int(CELL * 0.18)          # centre fill spans [LO, CELL-LO); contains the
HI = CELL - LO                 # inset=0.25 window [CELL*.25, CELL*.75)


def _center_color(r, c):
    # distinct, bright per cell so occupancy (>90) and identity are unambiguous
    # (all channels <=255: c<=9, r<=19)
    return (40 + c * 20, 30 + r * 10, 200)


def _build_screen():
    """Each cell: a BORDER colour over the whole cell, then a different CENTRE
    colour filling the central [LO, CELL-LO) window. inset=0.25 samples
    [CELL*.25, CELL*.75) — strictly inside the centre fill — so a correct
    sample_grid returns the centre colour, while a buggy whole-cell average would
    be pulled toward the border."""
    buf = bytearray(GW * GH * 3)
    for r in range(ROWS):
        for c in range(COLS):
            cr, cg, cb = _center_color(r, c)
            for yy in range(CELL):
                for xx in range(CELL):
                    X, Y = c * CELL + xx, r * CELL + yy
                    if LO <= xx < HI and LO <= yy < HI:
                        col = (cr, cg, cb)
                    else:
                        col = (250, 250, 250)        # bright border / grid line
                    i = (Y * GW + X) * 3
                    buf[i], buf[i + 1], buf[i + 2] = col
    return bytes(buf)


SCREEN = _build_screen()
osctl.capture_rgb = lambda x=0, y=0, w=None, h=None: (GW, GH, SCREEN)

BBOX = (0, 0, GW - 1, GH - 1)
grid = osctl.sample_grid(BBOX, COLS, ROWS, inset=0.25)

# 1) shape is rows x cols
assert len(grid) == ROWS and all(len(row) == COLS for row in grid), "wrong shape"

# 2)+3) every cell is its CENTRE colour (border ignored), exactly, and equals a
#        centred sample_color over the same inset window
W, H, rgb = osctl.capture_rgb()
for r in range(ROWS):
    for c in range(COLS):
        cell = grid[r][c]
        assert (cell["r"], cell["g"], cell["b"]) == _center_color(r, c), \
            ("cell centre wrong (border bled in?)", r, c, cell)
        # the inset window sample_grid used: [c*CELL+5, c*CELL+15) x [r*CELL+5, ...)
        ix0 = int(c * CELL + CELL * 0.25); ix1 = int(c * CELL + CELL * 0.75)
        iy0 = int(r * CELL + CELL * 0.25); iy1 = int(r * CELL + CELL * 0.75)
        sc = osctl.sample_color((ix0, iy0, ix1 - 1, iy1 - 1), rgb=rgb, size=(W, H))
        assert (sc["r"], sc["g"], sc["b"]) == (cell["r"], cell["g"], cell["b"]), \
            ("sample_grid != centred sample_color", r, c, sc, cell)

# 4) it reads only the central window, not the whole cell (the loss it cuts)
assert grid[0][0]["count"] < CELL * CELL, "did not reduce pixels"
# inset=0.0 must read the whole cell (and then the border dominates, != centre)
full = osctl.sample_grid(BBOX, COLS, ROWS, inset=0.0)
assert full[0][0]["count"] == CELL * CELL, ("inset 0 should be whole cell", full[0][0])
assert (full[0][0]["r"], full[0][0]["g"], full[0][0]["b"]) != _center_color(0, 0), \
    "whole-cell average should differ from centre when a border exists"

# 5) arg validation
for bad in (lambda: osctl.sample_grid(BBOX, 0, ROWS),
            lambda: osctl.sample_grid(BBOX, COLS, 0),
            lambda: osctl.sample_grid(BBOX, COLS, ROWS, inset=0.5),
            lambda: osctl.sample_grid(BBOX, COLS, ROWS, inset=-0.1),
            lambda: osctl.sample_grid(BBOX, COLS, ROWS, rgb=rgb)):  # rgb w/o size
    try:
        bad(); raise AssertionError("expected ValueError")
    except ValueError:
        pass

# 6) one sample_grid is faster than COLS*ROWS centred sample_color calls
def t_grid(reps=200):
    s = time.time()
    for _ in range(reps):
        osctl.sample_grid(BBOX, COLS, ROWS, rgb=rgb, size=(W, H), inset=0.25)
    return (time.time() - s) / reps

def t_percell(reps=200):
    # the existing idiom (sudoku/mines): one sample_color over the WHOLE cell
    s = time.time()
    for _ in range(reps):
        for r in range(ROWS):
            for c in range(COLS):
                osctl.sample_color((c * CELL, r * CELL,
                                    (c + 1) * CELL - 1, (r + 1) * CELL - 1),
                                   rgb=rgb, size=(W, H))
    return (time.time() - s) / reps

tg, tp = t_grid(), t_percell()
# the win is the inset: sample_grid reads each cell's centre (~a quarter of the
# pixels) instead of averaging the whole cell, so it beats the per-cell full-cell
# sample_color loop the grid games run today.
assert tg < tp, ("sample_grid not faster than per-cell full-cell loop", tg, tp)

print("F247 OK: sample_grid maps each cell to its region, returns the centre mean "
      "(border/grid-line ignored) exactly equal to a centred sample_color, reads "
      "only the central window, validates args, and is %.1fx faster than the "
      "per-cell whole-cell sample_color loop the grid games use today"
      % (tp / tg if tg else 0))
