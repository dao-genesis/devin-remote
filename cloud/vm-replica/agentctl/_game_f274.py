"""F274 grid_index live proof on Human Benchmark — Visual Memory.

The F273 harness hand-rolled the "snap a foreign flash reading onto the idle
lattice and collapse repeats into one click per cell" bookkeeping (bucket by
nearest row/col, average the centroids, majority-vote away transients). F274
owns that: build the lattice ONCE from the idle blue tiles (grid_lattice), then
snap each memorise flash onto it with grid_index — its per-cell centroid IS the
click target and its `n` (how many frames held that cell) is the vote.

Run: DISPLAY=:0 python3 _game_f274.py
"""
import sys, time
sys.path.insert(0, ".")
import osctl

BOARD = (520, 235, 1035, 665)
TILE = (36, 114, 192)
WHITE = (250, 250, 250)


def blobs(color, tol, min_count, step=1):
    fb = osctl.find_color_blobs(color, tol=tol, search=BOARD,
                                min_count=min_count, step=step)
    return fb


def read_grid():
    tb = blobs(TILE, 14, 150)
    return osctl.grid_lattice([(b["x"], b["y"]) for b in tb])


def catch_flash(max_s):
    osctl.move(300, 400)
    seen, phase = [], "blue"
    end = time.monotonic() + max_s
    while time.monotonic() < end:
        wb = blobs(WHITE, 40, 200, step=3)
        if phase == "blue":
            if not wb:
                phase = "flash"
        elif phase == "flash":
            if wb:
                seen.extend((b["x"], b["y"]) for b in wb); phase = "record"
        else:
            if wb:
                seen.extend((b["x"], b["y"]) for b in wb)
            else:
                break
    return seen


def main():
    osctl.omnibox_go("https://humanbenchmark.com/tests/memory"); time.sleep(2.0)
    osctl.click(792, 540); time.sleep(0.1)

    reached = 0
    for level in range(1, 12):
        flashes = catch_flash(2.0 + level * 0.4)
        time.sleep(0.7)
        g = read_grid()
        if g["rows"] * g["cols"] == 0:
            print(f"level {level}: lost the grid; stopping"); break
        # F274: snap the flash reading onto the idle lattice, half-pitch stray
        # guard, and keep the cells held through most of the flash (n vote).
        px, py = g["pitch"]
        idx = osctl.grid_index(g, flashes, max_dist=(px / 2, py / 2))
        top = max((c["n"] for row in idx["cells"] for c in row if c), default=0)
        keep = max(3, (top + 1) // 2)
        cells = [(r, c) for (r, c) in idx["occupied"]
                 if idx["cells"][r][c]["n"] >= keep]
        print(f"level {level}: grid {g['rows']}x{g['cols']} "
              f"snapped {len(flashes)} pts -> {len(idx['occupied'])} cells, "
              f"click {sorted(cells)}")
        for (r, c) in sorted(cells):
            osctl.click(int(g["xs"][c]), int(g["ys"][r])); time.sleep(0.22)
        osctl.move(300, 400)
        reached = level

    time.sleep(0.5)
    osctl.screenshot("/tmp/vm_f274.png")
    print(f"reached level {reached}; grid_index snapped every flash onto the lattice")


if __name__ == "__main__":
    main()
