"""F275 frame_consensus live proof on Human Benchmark — Visual Memory.

F274 flattened every white detection of a flash into one bag and voted per cell
by total detection count — which cannot tell "one tile seen in five frames" from
"five phantoms in one frame". F275 keeps the frame boundary: record each frame's
occupied cells separately (grid_index per frame), then frame_consensus keeps the
cells lit in at least half the frames — a tile held through the flash survives,
a one- or two-frame anti-alias phantom is voted out.

Run: DISPLAY=:0 python3 _game_f275.py
"""
import sys, time
sys.path.insert(0, ".")
import osctl

BOARD = (520, 235, 1035, 665)
TILE = (36, 114, 192)
WHITE = (250, 250, 250)


def blobs(color, tol, min_count, step=1):
    return osctl.find_color_blobs(color, tol=tol, search=BOARD,
                                  min_count=min_count, step=step)


def read_grid():
    tb = blobs(TILE, 14, 150)
    return osctl.grid_lattice([(b["x"], b["y"]) for b in tb])


def catch_flash_frames(max_s):
    """Return a LIST OF FRAMES, each the white-blob centroids seen that frame."""
    osctl.move(300, 400)
    frames, phase = [], "blue"
    end = time.monotonic() + max_s
    while time.monotonic() < end:
        wb = blobs(WHITE, 40, 200, step=3)
        pts = [(b["x"], b["y"]) for b in wb]
        if phase == "blue":
            if not pts:
                phase = "flash"
        elif phase == "flash":
            if pts:
                frames.append(pts); phase = "record"
        else:
            if pts:
                frames.append(pts)
            else:
                break
    return frames


def main():
    osctl.omnibox_go("https://humanbenchmark.com/tests/memory"); time.sleep(2.0)
    osctl.click(792, 540); time.sleep(0.1)

    reached = 0
    for level in range(1, 12):
        frame_pts = catch_flash_frames(2.0 + level * 0.4)
        time.sleep(0.7)
        g = read_grid()
        if g["rows"] * g["cols"] == 0:
            print(f"level {level}: lost the grid; stopping"); break
        px, py = g["pitch"]
        # per-frame occupied cells (grid_index snaps + drops off-board strays)
        per_frame = [osctl.grid_index(g, fr, max_dist=(px / 2, py / 2))["occupied"]
                     for fr in frame_pts]
        con = osctl.frame_consensus(per_frame, min_frac=0.5)
        cells = con["kept"]
        print(f"level {level}: grid {g['rows']}x{g['cols']} {len(frame_pts)} frames "
              f"-> consensus {sorted(cells)} (counts "
              f"{ {c: con['counts'][c] for c in sorted(cells)} })")
        for (r, c) in sorted(cells):
            osctl.click(int(g["xs"][c]), int(g["ys"][r])); time.sleep(0.22)
        osctl.move(300, 400)
        reached = level

    time.sleep(0.5)
    osctl.screenshot("/tmp/vm_f275.png")
    print(f"reached level {reached}; frame_consensus picked the stable flash cells")


if __name__ == "__main__":
    main()
