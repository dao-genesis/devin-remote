"""Live proof for F273 grid_lattice — Human Benchmark Visual Memory.

Every level flashes a set of tiles white; you memorize them, the board resets to
blue, and you click them back. The board *grows and re-centres* each level (3x3,
then more), so cell coordinates cannot be hard-coded — the layout has to be read
off the screen each level. The loop: catch the white flash (find_color_blobs with
F271 `step` for a cheap scan), then when the board resets read the blue tiles into
a grid with grid_lattice, map each remembered flash onto a (row, col) — which
de-duplicates several white detections of one tile — and click those cells.
"""
import sys, time
sys.path.insert(0, ".")
import osctl

BOARD = (520, 235, 1035, 665)          # the tile field, excludes the white HUD text
TILE = (36, 114, 192)                  # idle tile blue
WHITE = (250, 250, 250)


def blobs(target, tol, minc, step=1):
    w, h, rgb = osctl.capture_rgb()
    return osctl.find_color_blobs(target, tol=tol, rgb=rgb, size=(w, h),
                                  search=BOARD, min_count=minc, step=step)


def vote_cells(flashes, g):
    """Bucket flash centroids into cells and keep the ones held across the flash.

    The memorise flash holds its tiles white for ~1s (many frames); a stray blob
    (anti-alias edge, a click-feedback frame) shows for one or two. Group the
    remembered centroids by grid cell and keep cells seen in at least a third of
    the busiest cell's frames — a majority vote that drops the transients that
    otherwise get mis-clicked as wrong tiles. Returns {(row,col): (x,y)}.
    """
    buckets: dict = {}
    for (fx, fy) in flashes:
        c = min(range(g["cols"]), key=lambda i: abs(g["xs"][i] - fx))
        r = min(range(g["rows"]), key=lambda i: abs(g["ys"][i] - fy))
        buckets.setdefault((r, c), []).append((fx, fy))
    if not buckets:
        return {}
    top = max(len(v) for v in buckets.values())
    keep = max(3, (top + 1) // 2)              # held through >=~half the flash; drops fade transients
    out = {}
    for cell, pts in buckets.items():
        if len(pts) >= keep:
            out[cell] = (sum(p[0] for p in pts) / len(pts),
                         sum(p[1] for p in pts) / len(pts))
    return out


def read_grid():
    tb = blobs(TILE, 14, 150)
    return osctl.grid_lattice([(b["x"], b["y"]) for b in tb])


def catch_flash(max_s):
    """union of white tile centres of the NEXT memorise flash.

    My own correct clicks leave tiles white, so first wait for an all-blue frame
    (board reset), then record the flash that follows until it clears again.
    """
    osctl.move(300, 400)                       # park cursor off-board: no hover-highlight, no arrow blob
    seen, phase = [], "blue"
    end = time.monotonic() + max_s
    while time.monotonic() < end:
        wb = blobs(WHITE, 40, 200, step=3)     # F271 coarse scan, min_count drops text/noise
        if phase == "blue":
            if not wb:
                phase = "flash"
        elif phase == "flash":
            if wb:
                seen.extend((b["x"], b["y"]) for b in wb)
                phase = "record"
        else:
            if wb:
                seen.extend((b["x"], b["y"]) for b in wb)
            else:
                break
    return seen


def main():
    osctl.omnibox_go("https://humanbenchmark.com/tests/memory"); time.sleep(2.0)
    osctl.click(792, 540); time.sleep(0.1)      # Start

    reached = 0
    for level in range(1, 12):
        flashes = catch_flash(2.0 + level * 0.4)
        time.sleep(0.7)                          # let the input phase open
        g = read_grid()
        if g["rows"] * g["cols"] == 0:
            print(f"level {level}: lost the grid; stopping"); break
        # grid_lattice indexes the remembered flashes to cells; a majority vote
        # keeps the tiles held through the flash and drops transients.
        cells = vote_cells(flashes, g)
        print(f"level {level}: grid {g['rows']}x{g['cols']} pitch "
              f"{tuple(round(p) for p in g['pitch'])} -> click {sorted(cells)}")
        for (r, c) in sorted(cells):
            osctl.click(int(g["xs"][c]), int(g["ys"][r]))   # lattice cell centre
            time.sleep(0.22)
        osctl.move(300, 400)                     # park off-board before next flash
        reached = level                          # next flash caught at loop top

    time.sleep(0.5)
    osctl.screenshot("/tmp/vm_f273.png")
    print(f"cleared through level {reached} via grid_lattice")


if __name__ == "__main__":
    main()
