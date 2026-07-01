"""Timing budget for the perception loop on this VM: full capture vs ROI
capture vs diff cost. Decides whether a live moving-bot track is feasible."""
import time
import osctl

CX, CY = 800, 598  # crosshair centre in real px (measured from screenshot)
# play ROI: drop bottom HUD (y>660), we post-filter radar/weapon by box.
ROI = (40, 90, 1560, 660)
RADAR = (1330, 30, 1600, 320)   # top-right minimap animates -> exclude
WEAP = (560, 430, 1160, 660)    # weapon model corner (only moves on fire)


def cap():
    return osctl.capture_rgb()


def t(fn, n=5):
    s = time.time()
    for _ in range(n):
        fn()
    return (time.time() - s) / n


def in_box(x, y, b):
    return b[0] <= x <= b[2] and b[1] <= y <= b[3]


def movers(a, b, size):
    bl = osctl.locate_change_blobs(a, b, size, tol=18, min_count=40, search=ROI)
    return [z for z in bl if not in_box(z["x"], z["y"], RADAR)
            and not in_box(z["x"], z["y"], WEAP)]


def main():
    w, h, a = cap()
    size = (w, h)
    print(f"full capture avg = {t(lambda: cap()):.3f}s")
    dt = t(lambda: osctl.locate_change_blobs(a, a, size, search=ROI))
    print(f"ROI diff avg = {dt:.3f}s")

    # one real loop tick: A, wait, B, diff -> movers; report wall time
    for i in range(4):
        s = time.time()
        _, _, a = cap()
        time.sleep(0.28)
        _, _, b = cap()
        mv = movers(a, b, size)
        print(f"tick {i}: {time.time()-s:.3f}s wall, {len(mv)} movers "
              + "; ".join(f"({m['x']},{m['y']} n={m['count']})" for m in mv[:4]))


if __name__ == "__main__":
    main()
