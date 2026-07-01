"""F276 click_verify live proof on Human Benchmark — Visual Memory.

F273/F274/F275 nailed *reading* the board (recover the lattice, snap the flash
onto it, vote out flicker). But a correctly-read tile still failed to advance the
level: one click — reliably the top row — simply dropped, tile staying blue, no
life lost. That is an actuation miss, not a perception one. F276 closes it: each
recall click goes through click_verify, whose `check` watches that very cell for
white and re-presses until the tile actually lights.

Run: DISPLAY=:0 python3 _game_f276.py
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


def lit(cx, cy, half):
    """A recall tile turned white: white pixels present in its own cell box."""
    box = (int(cx - half), int(cy - half), int(cx + half), int(cy + half))
    return bool(osctl.find_color_blobs(WHITE, tol=40, search=box, min_count=120))


def main():
    osctl.omnibox_go("https://humanbenchmark.com/tests/memory"); time.sleep(2.0)
    osctl.click(792, 540); time.sleep(0.1)

    reached, flaky = 0, 0
    for level in range(1, 12):
        frame_pts = catch_flash_frames(2.0 + level * 0.4)
        g = read_grid()
        if g["rows"] * g["cols"] == 0:
            print(f"level {level}: lost the grid; stopping"); break
        px, py = g["pitch"]
        per = [osctl.grid_index(g, fr, max_dist=(px / 2, py / 2))["occupied"]
               for fr in frame_pts]
        cells = osctl.frame_consensus(per, min_frac=0.5)["kept"]
        half = min(px, py) * 0.28
        # wait for the flash to fully clear to blue (recall phase armed) so a
        # click actually counts and click_verify measures the click's own effect
        osctl.move(300, 400)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if not any(lit(g["xs"][c], g["ys"][r], half) for (r, c) in cells):
                break
            time.sleep(0.15)
        report = []
        for (r, c) in sorted(cells):
            tx, ty = int(g["xs"][c]), int(g["ys"][r])
            res = osctl.click_verify(tx, ty, check=lambda tx=tx, ty=ty: lit(tx, ty, half),
                                     tries=4, settle=0.35)
            osctl.move(300, 400)
            report.append((r, c, res["clicks"], res["ok"]))
            if res["clicks"] > 1:
                flaky += 1
        print(f"level {level}: {g['rows']}x{g['cols']} cells "
              f"{[(r,c) for r,c,_,_ in report]} -> "
              f"clicks {[(r,c,n,ok) for r,c,n,ok in report]}")
        reached = level

    time.sleep(0.5)
    osctl.screenshot("/tmp/vm_f276.png")
    print(f"reached level {reached}; click_verify re-pressed {flaky} dropped clicks")


if __name__ == "__main__":
    main()
