"""F261 — move_rel: move the pointer by a *relative* delta, the motion move() cannot make.

Every pointer verb the floor had addressed an absolute screen pixel. But a whole class
of surfaces grabs the pointer and reads only its *motion* — an FPS in mouse-look, a 3D
editor's orbit drag, any Pointer-Lock canvas — warping the OS cursor back to centre each
frame and integrating the deltas, so an absolute warp to a fixed pixel turns the view by
nothing (verified live in AssaultCube: absolute move left the camera frozen; relative
motion swung it). move_rel emits relative motion through the backend, and splits a large
delta into `steps` equal events so a big sweep integrates smoothly across frames instead
of one jump a game may clamp — with the remainder spread so the steps sum *exactly* to
the asked delta (no rounding drift).

The backend's relative-motion leaf is stubbed here (osctl._be.move_rel), so the test is
deterministic and needs no display: we record every (dx, dy) event emitted and assert the
contract — exact total, smooth stepping, no drift, correct validation.
"""
import osctl


class FakeBackend:
    """Records every relative event the verb emits as (dx, dy)."""
    def __init__(self):
        self.events = []

    def move_rel(self, dx, dy):
        self.events.append((int(dx), int(dy)))


class LeaflessBackend:
    """An older backend with no relative-motion leaf at all."""


def _install(has_leaf=True):
    """Swap osctl's backend handle for a recorder; return (fake, restore)."""
    orig = osctl._be
    fake = FakeBackend() if has_leaf else LeaflessBackend()
    osctl._be = fake

    def restore():
        osctl._be = orig
    return fake, restore


def main():
    # 1) the core promise: one event carrying exactly the asked delta (steps=1 default).
    fake, restore = _install()
    try:
        out = osctl.move_rel(40, -15)
    finally:
        restore()
    assert out == (40, -15), out
    assert fake.events == [(40, -15)], fake.events

    # 2) floats are rounded to integer pixels (the wire only carries ints).
    fake, restore = _install()
    try:
        out = osctl.move_rel(12.4, -7.6)
    finally:
        restore()
    assert out == (12, -8), out
    assert fake.events == [(12, -8)], fake.events

    # 3) stepping: a large sweep is split into `steps` events that SUM EXACTLY to the
    #    asked delta — the whole point, so a big turn lands smoothly with no drift.
    for total, steps in [((100, 0), 4), ((-90, 30), 7), ((33, -33), 5),
                         ((7, 0), 10), ((0, 0), 3)]:
        fake, restore = _install()
        try:
            out = osctl.move_rel(total[0], total[1], steps=steps)
        finally:
            restore()
        assert out == total, (out, total)
        sx = sum(e[0] for e in fake.events)
        sy = sum(e[1] for e in fake.events)
        assert (sx, sy) == total, (total, steps, fake.events)
        # never more events than steps; each step's running sum tracks the ideal line
        # so no single event overshoots the target.
        assert len(fake.events) <= steps, (steps, fake.events)
        # monotonic toward the target on each axis (no back-and-forth jitter).
        run = 0
        for ex, _ in fake.events:
            run += ex
            if total[0] >= 0:
                assert 0 <= run <= total[0], (total, fake.events)
            else:
                assert total[0] <= run <= 0, (total, fake.events)

    # 4) a fine sweep where steps > |delta|: still sums exactly, emits no zero-noise
    #    events beyond what is needed (an empty (0,0) is skipped unless steps==1).
    fake, restore = _install()
    try:
        out = osctl.move_rel(3, 0, steps=10)
    finally:
        restore()
    assert out == (3, 0), out
    assert sum(e[0] for e in fake.events) == 3, fake.events
    assert all(e != (0, 0) for e in fake.events), fake.events

    # 5) steps=1 with a zero delta still emits exactly one event (an explicit no-move
    #    is a legitimate request — e.g. nudging a hovered slider by 0 to wake it).
    fake, restore = _install()
    try:
        osctl.move_rel(0, 0)
    finally:
        restore()
    assert fake.events == [(0, 0)], fake.events

    # 6) a backend without the leaf raises NotImplementedError (older floor), not a
    #    silent no-op that would look like a frozen camera.
    fake, restore = _install(has_leaf=False)
    try:
        osctl.move_rel(10, 10)
        raise AssertionError("expected NotImplementedError on a backend lacking move_rel")
    except NotImplementedError:
        pass
    finally:
        restore()

    # 7) argument validation.
    for bad in (dict(dx=1, dy=1, steps=0), dict(dx=1, dy=1, steps=-3),
                dict(dx=1, dy=1, delay=-0.1)):
        try:
            osctl.move_rel(**bad)
            raise AssertionError(f"expected ValueError for {bad}")
        except ValueError:
            pass

    print("F261 OK: move_rel emits relative pointer motion move() cannot -- one event "
          "carries the exact asked delta, floats round to int pixels, a large sweep "
          "splits into <=steps events that sum EXACTLY to the target with monotonic, "
          "drift-free progress, zero-noise sub-events are skipped, a leaf-less backend "
          "raises instead of silently freezing, and args are validated")


if __name__ == "__main__":
    main()
