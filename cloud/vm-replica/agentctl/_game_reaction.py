"""Live proof for F260 react_pixel — the Human Benchmark Reaction Time test.

The whole game is a reflex: a box sits red ("wait for green"), turns green at a
random instant, and the site scores the milliseconds from the green frame to your
click. The driver's reflex is one verb: pre-position the cursor over the box, then
`react_pixel(center, GREEN, act="press")` — it spins on that one pixel and fires the
button on the very edge it sees green, with no move and no settle. For contrast it
also plays a round the old way (`wait_pixel` then `click`) so the ~20ms settle
`react_pixel` removes is visible in the site's own score.

Run from the agentctl dir with the reaction-time test open in the focused browser
tab at the standard 1280x960 window (center of the box ~ (775, 400)).
"""
import sys
sys.path.insert(0, ".")
import osctl
import time
import re

CX, CY = 775, 400
GREEN = (75, 219, 106)
RED = (206, 38, 54)


def state():
    r, g, b = osctl.pixel(CX, CY)
    if g > 150 and r < 130 and b < 150:
        return "green"
    if r > 150 and g < 120:
        return "red"
    # summary screen carries a yellow "Save score" button; start/result do not.
    sr, sg, sb = osctl.pixel(702, 569)
    if sr > 200 and sg > 150 and sb < 130:
        return "summary"
    return "blue"   # start or "click to keep going"


def site_ms():
    try:
        t = osctl.ocr_text((520, 380, 540, 130))
    except Exception:
        return None
    m = re.search(r"(\d+)\s*ms", t.replace("\n", " "))
    return int(m.group(1)) if m else None


def reach_red(timeout=12.0):
    """Advance through whatever screen we are on until the box is red (waiting)."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        s = state()
        if s == "red":
            return True
        if s == "green":          # caught a stale green: consume it
            osctl.click(CX, CY)
        elif s == "summary":
            osctl.click(857, 569)  # "Try again"
        else:
            osctl.click(CX, CY)    # start / keep-going
        time.sleep(0.5)
    return False


def main():
    rounds = []
    # one round the OLD way: wait_pixel then click (pays click's move + 20ms settle).
    if reach_red():
        osctl.move(CX, CY)
        ok = osctl.wait_pixel(CX, CY, GREEN, tol=24, timeout=8.0, interval=0.0)
        if ok:
            osctl.click(CX, CY)          # the idiomatic perceive-then-act handoff
        time.sleep(0.7)
        rounds.append(("wait_pixel+click", None, site_ms()))

    # the rest the NEW way: react_pixel presses in the same breath, no settle.
    for _ in range(4):
        if not reach_red():
            break
        osctl.move(CX, CY)               # pre-position once; press fires in place
        r = osctl.react_pixel(CX, CY, GREEN, tol=24, timeout=8.0, interval=0.0,
                              act="press")
        time.sleep(0.7)
        ms = site_ms()
        rounds.append(("react_pixel", r, ms))
        if ms is not None and ms < 60:
            osctl.screenshot("/tmp/reaction_fast.png")

    for tag, r, ms in rounds:
        if r is None:
            print(f"{tag:16s} site={ms}ms")
        else:
            print(f"{tag:16s} site={ms}ms  wait_ms={r['wait_ms']:.0f} "
                  f"act_ms={r['act_ms']:.2f} polls={r['polls']} matched={r['matched']}")


if __name__ == "__main__":
    main()
