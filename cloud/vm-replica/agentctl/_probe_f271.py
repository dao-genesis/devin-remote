"""Probe (F271): where does per-target time go on the Aim Trainer?

Idiomatic floor play of a multi-target click game: each frame, segment the target
colour into blobs (`find_color_blobs`) over the play field, take the largest blob,
hand its centroid back to the caller, then `click` it. Measure how that time splits
between the full-field blob scan and the move+click, and check whether a coarse
(subsampled) scan would find the same centroid for a fraction of the cost.
"""
import sys, time
sys.path.insert(0, ".")
import osctl

TARGET = (149, 195, 232)         # the reticle's light-blue fill
FIELD = (20, 240, 1590, 1235)    # blue play field, below the "Remaining" header


def largest(blobs):
    return blobs[0] if blobs else None


def main():
    w, h, rgb = osctl.capture_rgb()
    # 1) cost of one full-acuity full-field blob scan
    t0 = time.monotonic()
    blobs = osctl.find_color_blobs(TARGET, tol=34, rgb=rgb, size=(w, h),
                                   search=FIELD, min_count=40)
    scan_ms = (time.monotonic() - t0) * 1000.0
    print(f"full-field blob scan: {scan_ms:.1f} ms, blobs={len(blobs)}")
    if blobs:
        b = largest(blobs)
        print(f"  largest centroid=({b['x']:.0f},{b['y']:.0f}) count={b['count']}")

    # 2) play up to N targets the idiomatic way; split scan vs act
    N = 12
    scan_tot = act_tot = 0.0
    hits = 0
    for _ in range(N):
        ts = time.monotonic()
        w, h, rgb = osctl.capture_rgb()
        blobs = osctl.find_color_blobs(TARGET, tol=34, rgb=rgb, size=(w, h),
                                       search=FIELD, min_count=40)
        scan_tot += (time.monotonic() - ts) * 1000.0
        b = largest(blobs)
        if not b:
            break
        ta = time.monotonic()
        osctl.click(int(b["x"]), int(b["y"]))   # move + 20ms settle + press
        act_tot += (time.monotonic() - ta) * 1000.0
        hits += 1
        time.sleep(0.12)                          # let next target spawn
    if hits:
        print(f"played {hits} targets: avg scan {scan_tot/hits:.1f} ms, "
              f"avg act {act_tot/hits:.1f} ms")

    # 3) would a coarse scan land the same centroid? emulate step=4 by hand
    w, h, rgb = osctl.capture_rgb()
    t0 = time.monotonic()
    blobs = osctl.find_color_blobs(TARGET, tol=34, rgb=rgb, size=(w, h),
                                   search=FIELD, min_count=40)
    full_ms = (time.monotonic() - t0) * 1000.0
    print(f"(post-play) full scan {full_ms:.1f} ms, blobs={len(blobs)}")


if __name__ == "__main__":
    main()
