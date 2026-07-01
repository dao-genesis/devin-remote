"""Probe: does move_rel turn THIS AssaultCube instance, and what is the
idle-frame change noise floor (HUD/weapon sway) that enemy acquisition must
survive? Pure observation — no new primitive. Run with DISPLAY=:0."""
import time
import osctl


def frame():
    w, h, rgb = osctl.capture_rgb()
    return (w, h), rgb


def diff_blobs(a, b, size, search, tol=18, min_count=40):
    return osctl.locate_change_blobs(a, b, size, tol=tol, min_count=min_count,
                                     search=search)


def main():
    size, _ = frame()
    w, h = size
    print(f"screen = {w}x{h}")

    # 1) actuation: does a relative sweep move the view? Compare a big central
    #    ROI before/after a yaw; a turned camera changes almost every pixel.
    search_full = (0, 30, w - 1, h - 120)
    _, a = frame()
    osctl.move_rel(600, 0, steps=12, delay=0.01)   # yaw right
    time.sleep(0.25)
    _, b = frame()
    d = osctl.region_diff(a, b)
    print(f"yaw test: region_diff frac_changed={d.get('frac', d)}")

    # 2) idle noise floor: hold perfectly still, diff two frames ~0.35s apart.
    _, a = frame()
    time.sleep(0.35)
    _, b = frame()
    for name, search in [
        ("FULL", search_full),
        ("PLAY(no radar/HUD)", (0, 60, 1320, 1000)),
    ]:
        bl = diff_blobs(a, b, size, search)
        print(f"idle {name}: {len(bl)} change-blobs >=40px")
        for x in bl[:8]:
            print(f"   blob x={x['x']} y={x['y']} n={x['count']} bbox={x['bbox']}")


if __name__ == "__main__":
    main()
