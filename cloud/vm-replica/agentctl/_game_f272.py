"""Live proof for F272 detect_sequence — Human Benchmark Sequence Memory.

Nine tiles flash white one after another; you must click them in the same order,
and each level appends one more flash. The whole task is exactly what the floor
could not express before: watch several fixed regions over time and recover WHICH
lit and in WHAT ORDER. Here the loop samples the 9 tiles for a window, hands the
per-frame levels to detect_sequence, and replays the returned order — no
hand-rolled edge tracking. Level L has L flashes; solving L advances to L+1.
"""
import sys, time
sys.path.insert(0, ".")
import osctl

CELLS = [(cx, cy) for cy in (316, 447, 580) for cx in (660, 792, 924)]  # row-major 0..8
R = 22


def cell_level(cx, cy):
    w, h, rgb = osctl.capture_rgb(cx - R, cy - R, 2 * R, 2 * R)
    s = 0
    for i in range(0, len(rgb), 3):
        s += rgb[i] + rgb[i + 1] + rgb[i + 2]
    return s / (len(rgb) // 3) / 3.0


def watch(seconds):
    trace = []
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        trace.append([cell_level(cx, cy) for (cx, cy) in CELLS])
    return trace


# A lit tile is white (~255); an idle tile ~114 with a few counts of sensor noise.
# Auto min/max would give a non-flashing tile a tiny span and a gate its noise
# crosses, so pin the gate to the *known* active level instead of the window's own.
BASE, WHITE = [110.0] * 9, [255.0] * 9


def main():
    osctl.omnibox_go("https://humanbenchmark.com/tests/sequence"); time.sleep(2.0)
    osctl.click(792, 540); time.sleep(0.15)   # Start

    reached = 0
    for level in range(1, 9):
        time.sleep(0.25)                       # let my last click's highlight fade
        trace = watch(0.8 + level * 0.7)       # cover this level's flashes + margin
        events = osctl.detect_sequence(trace, baseline=BASE, peak=WHITE,
                                       thresh=0.55, refractory=2)  # gate ~190
        order = [ev["region"] for ev in events]
        print(f"level {level}: {len(trace)} frames -> order {order}")
        if len(order) < level:
            print(f"  under-detected ({len(order)}<{level}); stopping")
            break
        for idx in order[:level]:
            cx, cy = CELLS[idx]
            osctl.click(cx, cy)
            time.sleep(0.14)
        reached = level

    time.sleep(0.6)
    osctl.screenshot("/tmp/seq_f272.png")
    print(f"solved through level {reached} via detect_sequence")


if __name__ == "__main__":
    main()
