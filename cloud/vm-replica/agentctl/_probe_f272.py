"""Probe: Sequence Memory needs 'which of N regions fired, in what order' over time.

react_pixel waits on ONE pixel's rising edge. Here 9 tiles flash white one after
another and I must recover the ORDER. With only single-pixel tools the caller has
to poll every tile every frame, remember each tile's previous level, hand-detect
rising edges, and debounce a flash that spans several frames — bookkeeping the
floor should own. This probe does it by hand to (a) prove the friction and (b)
capture real level traces to validate the F272 design against.
"""
import sys, time
sys.path.insert(0, ".")
import osctl

CELLS = [(cx, cy) for cy in (316, 447, 580) for cx in (660, 792, 924)]  # row-major
R = 22  # half-size of the sampled patch


def level(cx, cy):
    """mean luminance of the patch at (cx,cy) from a small windowed grab."""
    w, h, rgb = osctl.capture_rgb(cx - R, cy - R, 2 * R, 2 * R)
    s = 0
    for i in range(0, len(rgb), 3):
        s += rgb[i] + rgb[i + 1] + rgb[i + 2]
    return s / (len(rgb) // 3) / 3.0


def main():
    osctl.omnibox_go("https://humanbenchmark.com/tests/sequence"); time.sleep(2.0)
    osctl.click(792, 540); time.sleep(0.25)   # Start
    T = 40
    trace = []            # T frames x 9 levels
    t0 = time.monotonic()
    for _ in range(T):
        trace.append([level(cx, cy) for (cx, cy) in CELLS])
        time.sleep(0.03)
    dt = (time.monotonic() - t0) / T * 1000.0

    base = [min(f[i] for f in trace) for i in range(9)]
    peak = [max(f[i] for f in trace) for i in range(9)]
    thr = [base[i] + 0.4 * (peak[i] - base[i]) for i in range(9)]
    # hand-rolled edge sequencer (this is the bookkeeping F272 should own)
    order, live = [], [False] * 9
    for fi, f in enumerate(trace):
        for i in range(9):
            hot = f[i] > thr[i]
            if hot and not live[i]:
                order.append((fi, i))
            live[i] = hot
    print(f"frame ms ~{dt:.1f}; base~{[round(b) for b in base]}")
    print(f"peak ~{[round(p) for p in peak]}")
    print(f"flash order (frame, cell): {order}")


if __name__ == "__main__":
    main()
