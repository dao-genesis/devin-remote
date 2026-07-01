"""AssaultCube combat loop v2 — feed-forward, lead-compensated aim.

Why not servo/appearance feedback (v1): on this 2-CPU software renderer the only
single-frame enemy locator is match_template (SAD) — O(search*patch), minutes per
frame; and frame-diff (the fast locator) is blinded the instant the camera turns
to aim. So a per-frame feedback loop cannot close. The realtime answer is
FEED-FORWARD with a brief still confirm:

  acquire+track : hold still, several static diffs (F136) -> the moving bot's
                  centroid at several instants (union-find over changed px, fast).
  predict       : lead (F264) fits velocity, predicts the intercept point.
  aim           : ONE move_rel (F261) turn, gain calibrated so feature slides to
                  crosshair: move_rel = +K*(aim - centre)  (K>0; the feature moves
                  opposite the view turn, so this drives it toward the crosshair).
  confirm       : hold still, one more diff near centre -> is the bot now centred?
  fire          : click() (F120) burst; reload (tap R) when the clip runs down.

All existing rungs. If this lands kills it is a composition proof; if the single
calibrated turn cannot be made accurate enough, that is the honest gap.

Run: DISPLAY=:0 python3 -u _game_fps2.py [seconds]
"""
import sys
import time
import osctl

CX, CY = 800, 590
ROI = (40, 90, 1560, 660)
RADAR = (1315, 25, 1600, 335)
WEAP = (540, 425, 1170, 665)
K = (0.77, 0.77)               # counts/px; turn = +K*(aim-centre)  (sign: feature slides opposite turn)
LAT = 0.22                     # turn+settle latency lead must cover
BOT_MIN, BOT_MAX = 90, 13000   # reject HUD specks and full-scene (death/camera) floods
VMAX = 700.0                   # px/s; faster "velocity" is two unrelated blobs -> noise
VK_W, VK_A, VK_S, VK_D, VK_R = 0x57, 0x41, 0x53, 0x44, 0x52


def _in(x, y, b):
    return b[0] <= x <= b[2] and b[1] <= y <= b[3]


def _clampx(v):
    return max(ROI[0], min(ROI[2], v))


def _clampy(v):
    return max(ROI[1], min(ROI[3], v))


def _cap():
    w, h, rgb = osctl.capture_rgb()
    return (w, h), rgb


def _diff(a, b, size, near=None, radius=380):
    bl = osctl.locate_change_blobs(a, b, size, tol=18, min_count=BOT_MIN, search=ROI)
    out = []
    for z in bl:
        if z["count"] > BOT_MAX:
            continue
        x0, y0, x1, y1 = z["bbox"]
        if (x1 - x0) > 720 or (y1 - y0) > 560:          # smear / merged floods
            continue
        if _in(z["x"], z["y"], RADAR) or _in(z["x"], z["y"], WEAP):
            continue
        if near is not None and (z["x"] - near[0]) ** 2 + (z["y"] - near[1]) ** 2 > radius * radius:
            continue
        z["ay"] = y0 + 0.45 * (y1 - y0)   # mid-torso aim: robust between leg-biased centroid and head
        out.append(z)
    out.sort(key=lambda z: -z["count"])   # biggest mover = closest bot = most reliable
    return out


def track(n=3, dt=0.12):
    """Hold still; capture n+1 frames; diff consecutive pairs -> position samples
    of the dominant moving bot, associated by proximity."""
    frames = []
    for _ in range(n + 1):
        t = time.time()
        size, rgb = _cap()
        frames.append((t, rgb))
        time.sleep(dt)
    samples, near = [], None
    for i in range(n):
        (ta, a), (tb, b) = frames[i], frames[i + 1]
        mv = _diff(a, b, size, near=near)
        if not mv:
            continue
        m = mv[0]
        near = (m["x"], m["y"])
        samples.append(((ta + tb) / 2.0, m["x"], m["ay"]))
    return samples, size


def confirm(radius=230):
    """One still diff; return the mover nearest centre within radius, else None."""
    size, a = _cap()
    time.sleep(0.11)
    _, b = _cap()
    mv = _diff(a, b, size, near=(CX, CY), radius=radius)
    if not mv:
        return None
    mv.sort(key=lambda z: (z["x"] - CX) ** 2 + (z["ay"] - CY) ** 2)
    return mv[0]


def fire(n):
    for _ in range(n):
        osctl.click()
        time.sleep(0.05)


def main(budget=60.0):
    t0 = time.time()
    log = []
    scans = shots = confirmed = 0
    fired_since_reload = empty = 0
    while time.time() - t0 < budget:
        samples, size = track()
        scans += 1
        if len(samples) < 2:
            empty += 1
            if empty % 3 == 0:
                osctl.click()                                # respawn if dead (attack), else harmless
                osctl.key_hold(VK_W, 0.35)                   # walk out of corners into bot traffic
            else:
                osctl.move_rel(220, 0, steps=6, delay=0.01)  # patrol yaw to find action
            time.sleep(0.08)
            continue
        empty = 0
        pred = osctl.lead(samples, horizon=LAT)
        if pred is not None and pred["speed"] <= VMAX:
            aim = (pred["px"], pred["py"])
            vx, vy = pred["vx"], pred["vy"]
        else:
            aim = (samples[-1][1], samples[-1][2])          # too-fast lead = noise: use last
            vx = vy = 0.0
        aim = (_clampx(aim[0]), _clampy(aim[1]))
        ex, ey = aim[0] - CX, aim[1] - CY
        # PURE FEED-FORWARD: one calibrated turn (both axes), then spray immediately.
        # Re-confirming re-locks a *fresh* running bot at the same standing height, so
        # the loop chased a moving population forever (vertical err pinned ~-185). At
        # ~2Hz the only realtime shot is: commit the turn, spray to cover residual+motion.
        osctl.move_rel(int(round(K[0] * ex)), int(round(K[1] * ey)), steps=6, delay=0.006)
        time.sleep(0.04)
        osctl.screenshot(f"/tmp/fps2_hit_{scans}.png")
        fire(10); fired_since_reload += 10
        # sidestep so a bot that was shooting back loses the bead while I reacquire
        osctl.key_hold(VK_D if scans % 2 else VK_A, 0.18)
        shots += 1
        tag = f"FF turn=({K[0]*ex:.0f},{K[1]*ey:.0f})"
        if fired_since_reload >= 16:
            osctl.tap(VK_R, hold=0.12); time.sleep(0.9); fired_since_reload = 0
        log.append(f"[{time.time()-t0:5.1f}s] n={len(samples)} aim=({aim[0]:.0f},{aim[1]:.0f}) "
                   f"v=({vx:.0f},{vy:.0f}) turn=({K[0]*ex:.0f},{K[1]*ey:.0f}) {tag}")
    print("\n".join(log))
    print(f"\nscans={scans} shots={shots} confirmed={confirmed} in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main(float(sys.argv[1]) if len(sys.argv) > 1 else 60.0)
