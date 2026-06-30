"""Synthetic test for F262 `servo` — closed-loop visual servoing through a
relative actuator of unknown, possibly anisotropic, locally-nonlinear scale.

No display, no backend: a fake world holds a feature's pixel position and slides
it opposite each relative actuation (as an FPS camera slides the world opposite
the view turn). servo must *measure* the scale and converge the feature onto a
target — never told the scale or its sign. Run: python3 _test_f262.py
"""
import sys
sys.path.insert(0, ".")
import osctl


class World:
    """A feature at a pixel position; actuate(dx,dy) turns the 'view', so the
    feature slides opposite by `scale` px per unit (anisotropic if sx != sy)."""
    def __init__(self, pos=(260.0, 90.0), sx=1.3, sy=1.3, drift=(0.0, 0.0)):
        self.x, self.y = float(pos[0]), float(pos[1])
        self.sx, self.sy, self.drift = sx, sy, drift
        self.acts = []
        self.max_abs = 0
    def actuate(self, dx, dy):
        self.acts.append((dx, dy))
        self.max_abs = max(self.max_abs, abs(dx), abs(dy))
        self.x -= dx * self.sx
        self.y -= dy * self.sy
        self.x += self.drift[0]
        self.y += self.drift[1]
    def locate(self):
        return (int(round(self.x)), int(round(self.y)))


def approx(a, b, t=1e-9):
    return abs(a - b) <= t


def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        raise SystemExit(1)


def main():
    target = (130, 160)

    # 1. Basic converge: unknown isotropic scale, feature off-target -> on target.
    w = World(pos=(260, 90), sx=1.3, sy=1.3)
    r = osctl.servo(w.locate, target, actuate=w.actuate, tol=3.0)
    check("basic converge hits", r["hit"] and r["reason"] == "hit")
    check("basic within tol", r["err"] <= 3.0)
    check("gain sign learned negative (feature slides opposite)",
          r["gain"][0] < 0 and r["gain"][1] < 0)
    check("gain magnitude ~ 1/scale", approx(abs(r["gain"][0]), 1 / 1.3, 0.3))

    # 2. Anisotropic scale: x and y have different units-per-pixel; still converges.
    w = World(pos=(300, 40), sx=0.7, sy=2.6)
    r = osctl.servo(w.locate, target, actuate=w.actuate, tol=3.0, max_iter=24)
    check("anisotropic converge", r["hit"])
    check("anisotropic gains differ", abs(r["gain"][0] - r["gain"][1]) > 0.1)

    # 3. Pre-supplied gain skips calibration (no probe moves spent calibrating).
    w = World(pos=(260, 90), sx=1.3, sy=1.3)
    g = (-1 / 1.3, -1 / 1.3)
    r = osctl.servo(w.locate, target, actuate=w.actuate, gain=g, tol=3.0)
    check("provided gain converges", r["hit"])
    check("provided gain returned unchanged", r["gain"] == g)

    # 4. Lost at start -> reason 'lost', no crash.
    r = osctl.servo(lambda: None, target, actuate=lambda dx, dy: None)
    check("lost at start", (not r["hit"]) and r["reason"] == "lost")

    # 5. Lost mid-flight (feature disappears after the loop has begun steering).
    class LostWorld(World):
        def __init__(self, *a, **k):
            super().__init__(*a, **k); self.calls = 0
        def locate(self):
            self.calls += 1
            return None if self.calls > 2 else super().locate()
    w = LostWorld(pos=(260, 90), sx=1.3, sy=1.3)
    r = osctl.servo(w.locate, target, actuate=w.actuate, gain=(-1 / 1.3, -1 / 1.3))
    check("lost mid-flight", (not r["hit"]) and r["reason"] == "lost")

    # 6. Calibration with zero displacement -> ValueError (can't learn scale).
    raised = False
    try:
        osctl.servo(lambda: (100, 100), target, actuate=lambda dx, dy: None)
    except ValueError:
        raised = True
    check("zero-displacement calibration raises", raised)

    # 7. Already on target (gain known, so no calibration perturbs it) ->
    #    immediate hit, zero steering steps, no actuation at all.
    w = World(pos=target, sx=1.3, sy=1.3)
    r = osctl.servo(w.locate, target, actuate=w.actuate, gain=(-1 / 1.3, -1 / 1.3),
                    tol=3.0)
    check("already on target hits at 0 iters", r["hit"] and r["iters"] == 0)
    check("already on target made no move", w.acts == [])

    # 8. max_step clamps every emitted step (a wild gain can't fling the feature).
    w = World(pos=(900, 700), sx=1.3, sy=1.3)
    r = osctl.servo(w.locate, target, actuate=w.actuate, tol=3.0,
                    max_step=50.0, max_iter=80)
    check("max_step respected", w.max_abs <= 50)
    check("clamped run still converges", r["hit"])

    # 9. Locally-nonlinear scale (scale grows with distance) still converges:
    #    one calibration near the start, damped proportional control rides it in.
    class NLWorld(World):
        def actuate(self, dx, dy):
            d = ((self.x - 130) ** 2 + (self.y - 160) ** 2) ** 0.5
            k = 1.0 + d / 400.0           # 1.0 near target, larger far away
            self.acts.append((dx, dy)); self.max_abs = max(self.max_abs, abs(dx), abs(dy))
            self.x -= dx * k
            self.y -= dy * k
    w = NLWorld(pos=(300, 60))
    r = osctl.servo(w.locate, target, actuate=w.actuate, tol=4.0, max_iter=40)
    check("nonlinear-scale converge", r["hit"])

    # 10. Tracking a mover: re-call servo as the feature drifts; error stays bounded.
    w = World(pos=(200, 200), sx=1.2, sy=1.2, drift=(6.0, -4.0))
    g = None
    worst = 0.0
    for _ in range(8):
        r = osctl.servo(w.locate, target, actuate=w.actuate, gain=g,
                        tol=3.0, max_iter=12)
        g = r["gain"]
        worst = max(worst, r["err"])
    check("tracking keeps error bounded under drift", worst < 30.0)

    # 11. Arg validation.
    for bad in (dict(probe=0), dict(max_iter=0), dict(damping=0)):
        raised = False
        try:
            osctl.servo(lambda: (1, 1), target, actuate=lambda dx, dy: None, **bad)
        except ValueError:
            raised = True
        check(f"validates {list(bad)[0]}", raised)

    print("\nF262 servo: all synthetic checks passed.")


if __name__ == "__main__":
    main()
