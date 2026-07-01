"""AssaultCube Bot-Deathmatch combat loop, composed from EXISTING floor rungs
only — no new primitive unless honest friction demands one.

  acquire  : locate_change_blobs on a static camera (F136) -> a moving bot is
             the dominant change cluster; HUD/radar/weapon corners post-filtered.
  aim      : servo (F262) drives that cluster onto the crosshair via move_rel
             (F261), self-calibrating the unknown mouse->pixel scale.
  fire     : click() (F120) presses the button WITHOUT warping the grabbed pointer.
  verify   : the engaged mover should vanish on the next static diff; frag count
             on the scoreboard (Tab) is the human-checkable ground truth.

Run: DISPLAY=:0 python3 -u _game_fps.py [seconds]
"""
import sys
import time
import osctl

CX, CY = 800, 590                      # crosshair centre, real px
ROI = (40, 90, 1560, 660)              # play area (HUD row below excluded)
RADAR = (1315, 25, 1600, 335)          # top-right minimap animates
WEAP = (540, 425, 1170, 665)           # weapon model corner (moves only on fire)
GAIN = (-0.77, -0.77)                  # counts/px, from the servo docstring (~1.3px/count)


def _in(x, y, b):
    return b[0] <= x <= b[2] and b[1] <= y <= b[3]


def _capture():
    w, h, rgb = osctl.capture_rgb()
    return (w, h), rgb


def movers(wait=0.20, tol=18, min_count=45, near=None, radius=320):
    """One static-camera change read -> candidate movers, largest first.
    Holds the camera still across two frames; the world doesn't change, a bot does."""
    size, a = _capture()
    time.sleep(wait)
    _, b = _capture()
    bl = osctl.locate_change_blobs(a, b, size, tol=tol, min_count=min_count, search=ROI)
    out = []
    for z in bl:
        if _in(z["x"], z["y"], RADAR) or _in(z["x"], z["y"], WEAP):
            continue
        if near is not None:
            if (z["x"] - near[0]) ** 2 + (z["y"] - near[1]) ** 2 > radius * radius:
                continue
        out.append(z)
    return out


def fire(bursts=2):
    for _ in range(bursts):
        osctl.click()
        time.sleep(0.06)


def engage(m, log):
    """servo the mover onto the crosshair, then fire. locate = fresh static diff
    tracking the same mover (nearest to its last seen position)."""
    last = [(m["x"], m["y"])]

    def locate():
        mv = movers(wait=0.14, near=last[0], radius=360)
        if not mv:
            return None
        p = (mv[0]["x"], mv[0]["y"])
        last[0] = p
        return p

    r = osctl.servo(locate, (CX, CY), gain=GAIN, tol=26.0,
                    max_iter=5, settle=0.09, damping=0.7, max_step=260.0)
    log.append(f"    servo hit={r['hit']} iters={r['iters']} "
               f"err={r['err']:.0f} reason={r['reason']} pos={r['pos']}")
    osctl.screenshot(f"/tmp/fps_aim_{len(log)}.png")
    fire(2)
    # verify: is the mover still there next tick?
    gone = not movers(wait=0.18, near=last[0], radius=200)
    log.append(f"    fired; mover_gone={gone}")
    return r["hit"], gone


def main(budget=30.0):
    t0 = time.time()
    log = []
    scans = engages = hits = gone = 0
    while time.time() - t0 < budget:
        mv = movers()
        scans += 1
        if not mv:
            osctl.move_rel(240, 0, steps=6, delay=0.01)   # patrol yaw to find a bot
            time.sleep(0.12)
            continue
        m = mv[0]
        log.append(f"[{time.time()-t0:5.1f}s] mover ({m['x']},{m['y']}) n={m['count']} "
                   f"of {len(mv)}")
        engages += 1
        h, g = engage(m, log)
        hits += int(h); gone += int(g)
    print("\n".join(log))
    print(f"\nscans={scans} engages={engages} servo_hits={hits} movers_gone={gone} "
          f"in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main(float(sys.argv[1]) if len(sys.argv) > 1 else 30.0)
