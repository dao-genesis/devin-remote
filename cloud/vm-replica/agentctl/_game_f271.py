"""Live proof for F271 find_color_blobs(step=) — the Human Benchmark Aim Trainer.

30 targets appear one at a time at random spots on a blue field; the site scores
the average milliseconds per target. The reflex is purely spatial: segment the
target's light-blue fill into blobs, take the largest, click its centroid, repeat.
The whole per-target cost used to be the *scan* — a full-resolution segmentation of
the ~1.5 MP field ran ~70-130 ms, dwarfing the ~20 ms move+click. F271 gives
find_color_blobs the same `step` acuity find_color always had: at step=4 the same
target is found for ~4-5 ms (~15x less), so the loop is bounded by the hand, not
the eye.

Run from the agentctl dir; it navigates to the test itself in the focused tab.
"""
import sys, time, re
sys.path.insert(0, ".")
import osctl

START = (792, 405)               # the start reticle's centre (maximised window)
TARGET = (149, 195, 232)         # the reticle's light-blue fill
FIELD = (20, 200, 1580, 645)     # blue play field (below header, above the cards)


def find_target(step):
    w, h, rgb = osctl.capture_rgb()
    blobs = osctl.find_color_blobs(TARGET, tol=34, rgb=rgb, size=(w, h),
                                   search=FIELD, min_count=60, step=step)
    return (int(blobs[0]["x"]), int(blobs[0]["y"])) if blobs else None


def main():
    osctl.omnibox_go("https://humanbenchmark.com/tests/aim")
    time.sleep(2.0)
    osctl.click(*START)          # click the start reticle
    time.sleep(0.5)

    scan_ms = []
    last = None
    hits = 0
    for _ in range(30):
        # wait until a target is present at a *new* spot, then strike it
        spot = None
        end = time.monotonic() + 4.0
        while time.monotonic() < end:
            t = time.monotonic()
            spot = find_target(step=4)
            scan_ms.append((time.monotonic() - t) * 1000.0)
            if spot and (last is None or abs(spot[0] - last[0]) +
                         abs(spot[1] - last[1]) > 20):
                break
            time.sleep(0.01)
        if not spot:
            break
        osctl.click(*spot)
        last = spot
        hits += 1
        time.sleep(0.05)

    time.sleep(1.0)
    osctl.screenshot("/tmp/aim_f271.png")
    try:
        txt = osctl.ocr_text((600, 240, 400, 220)).replace("\n", " ")
    except Exception:
        txt = ""
    m = re.search(r"(\d+)\s*ms", txt)
    avg = m.group(1) + " ms" if m else "(see /tmp/aim_f271.png)"
    n = len(scan_ms)
    print(f"hits={hits}  site avg={avg}")
    if n:
        print(f"step=4 scan: mean {sum(scan_ms)/n:.1f} ms over {n} reads "
              f"(min {min(scan_ms):.1f}, max {max(scan_ms):.1f}); "
              f"step=1 on this field measured ~70 ms")


if __name__ == "__main__":
    main()
