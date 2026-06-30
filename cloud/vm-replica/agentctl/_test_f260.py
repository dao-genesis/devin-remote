"""F260 — react_pixel: fire an action the instant a watched pixel matches.

wait_pixel watches a pixel and returns a bool; the caller must then call click(),
which moves the cursor and sleeps 20ms to let it land before pressing — pure dead
latency in a reaction game where the cursor is already on target (measured: a tight
watch + click read 34-38ms on the reaction-time test, ~20ms of it that settle).
react_pixel fuses perceive and act: spin-read one pixel until within tol of the
target, then fire in the same breath (press in place / a callable / nothing), and
report the latency budget {matched, wait_ms, act_ms, polls, rgb}.

The screen and the mouse are stubbed here (osctl.pixel / osctl._mouse_button), so
the test is deterministic and needs no display: we drive exactly when the pixel
"turns green" and record exactly when — and whether — the button fired.
"""
import osctl


class FakePixel:
    """Returns `before` for the first `flip_after` reads, then `after` forever.
    Records every action timestamp as a poll index so we can assert the action
    fired only after the match, never before."""
    def __init__(self, before, after, flip_after):
        self.before, self.after, self.flip_after = before, after, flip_after
        self.reads = 0

    def __call__(self, x, y):
        self.reads += 1
        return self.after if self.reads > self.flip_after else self.before


def _install(before=(206, 38, 54), after=(75, 219, 106), flip_after=5):
    """Swap in a fake screen + mouse; return (fake_pixel, events) and a restore fn.
    `events` collects ("down"/"up", poll_index_at_fire) so order vs. match is checkable."""
    fp = FakePixel(before, after, flip_after)
    events = []
    orig_pixel, orig_btn = osctl.pixel, osctl._mouse_button

    def fake_btn(button, down):
        events.append((button, "down" if down else "up", fp.reads))
    osctl.pixel = fp
    osctl._mouse_button = fake_btn

    def restore():
        osctl.pixel = orig_pixel
        osctl._mouse_button = orig_btn
    return fp, events, restore


def main():
    GREEN = (75, 219, 106)

    # 1) the core promise: it presses the button exactly once, and only on the read
    #    that first matches — never on any earlier (non-matching) poll.
    fp, events, restore = _install(flip_after=5)
    try:
        r = osctl.react_pixel(10, 20, GREEN, tol=24, timeout=5.0, interval=0.0)
    finally:
        restore()
    assert r["matched"] is True, r
    # the fake flips on read 6, so detection is the 6th poll.
    assert r["polls"] == 6, r
    # one full click: down then up, both fired at the matching poll, none before.
    assert events == [("left", "down", 6), ("left", "up", 6)], events
    # act_ms is the fused gap react_pixel exists to crush: with a stub mouse it is
    # essentially nothing, and is reported separately from the wait.
    assert r["act_ms"] >= 0.0 and r["wait_ms"] >= 0.0, r
    assert r["rgb"] == GREEN, r

    # 2) act="none" detects without touching the mouse — wait_pixel with a latency
    #    report instead of a bool.
    fp, events, restore = _install(flip_after=3)
    try:
        r = osctl.react_pixel(0, 0, GREEN, act="none")
    finally:
        restore()
    assert r["matched"] is True and r["polls"] == 4, r
    assert events == [], events

    # 3) a callable action is invoked exactly once, at the detection instant (so the
    #    same reflex can tap a key, click elsewhere, anything).
    fp, events, restore = _install(flip_after=2)
    fired = []
    try:
        r = osctl.react_pixel(0, 0, GREEN, act=lambda: fired.append(fp.reads))
    finally:
        restore()
    assert r["matched"] is True, r
    assert fired == [3], fired           # fired on the matching poll, once
    assert events == [], events          # callable replaces the built-in press

    # 4) timeout: a pixel that never matches returns matched=False having fired
    #    nothing, after polling more than once.
    fp, events, restore = _install(flip_after=10 ** 9)
    try:
        r = osctl.react_pixel(0, 0, GREEN, tol=10, timeout=0.05, interval=0.005)
    finally:
        restore()
    assert r["matched"] is False, r
    assert r["polls"] > 1, r
    assert events == [], events
    assert r["act_ms"] == 0.0, r

    # 5) tolerance is honoured per channel: a colour within tol of target matches,
    #    one just outside does not (so an anti-aliased near-miss won't false-fire).
    near = (75 + 20, 219 - 20, 106 + 20)   # within tol=24
    far = (75 + 40, 219, 106)              # outside tol=24 on the red channel
    fp, events, restore = _install(before=far, after=near, flip_after=3)
    try:
        r = osctl.react_pixel(0, 0, GREEN, tol=24)
    finally:
        restore()
    assert r["matched"] is True and r["polls"] == 4, r   # never matched `far`

    # 6) argument validation.
    for bad in (
        dict(x=0, y=0, rgb=(1, 2)),               # not a triple
        dict(x=0, y=0, rgb=(1, 2, 3), timeout=-1),
        dict(x=0, y=0, rgb=(1, 2, 3), interval=-1),
        dict(x=0, y=0, rgb=(1, 2, 3), act="poke"),  # unknown action
    ):
        try:
            osctl.react_pixel(**bad)
            raise AssertionError(f"expected ValueError for {bad}")
        except ValueError:
            pass

    print("F260 OK: react_pixel spin-watches a pixel and fires in the same breath "
          "the instant it matches -- one press at the matching poll and never before, "
          "act='none' detects mouse-free, a callable fires once at detection, timeout "
          "returns matched=False having fired nothing, per-channel tol gates a "
          "near-miss, and {wait_ms,act_ms,polls,rgb} report the latency budget the "
          "verb exists to crush; args validated")


if __name__ == "__main__":
    main()
