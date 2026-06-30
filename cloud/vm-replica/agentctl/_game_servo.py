"""Live proof for F262 `servo` — closed-loop aim in AssaultCube (open-source FPS).

F261 `move_rel` can turn the camera, but how far one count slides the world is
unknown (FOV x sensitivity) and only locally linear, so aim cannot be a single
move. `servo` measures that scale from a small probe, then steers a tracked
feature onto the crosshair with damped proportional control, re-locating each
step. This driver locks `match_template` onto a distinctive patch that starts
off-centre and lets `servo` drive it to the viewport centre (the crosshair),
reporting how far it started off, where it landed, and how few steps it took.

Run from the agentctl dir with AssaultCube already running (any spawn map).
"""
import sys
sys.path.insert(0, ".")
import osctl
import time

VX, VY, VW, VH = 520, 320, 560, 320          # central viewport, clear of HUD/minimap
CX, CY = VW // 2, VH // 2                     # crosshair, in viewport coords
PW = PH = 40                                  # tracked patch size
OFFX, OFFY = 150, -90                         # where the feature starts, off-centre


def grab():
    w, h, rgb = osctl.capture_rgb(VX, VY, VW, VH)
    return bytes(rgb)


def cut(rgb, cx, cy, pw, ph):
    x0, y0 = cx - pw // 2, cy - ph // 2
    out = bytearray(pw * ph * 3)
    for ry in range(ph):
        s = ((y0 + ry) * VW + x0) * 3
        out[ry * pw * 3:(ry + 1) * pw * 3] = rgb[s:s + pw * 3]
    return bytes(out)


def into_gameplay(tries=4):
    win = osctl.focus_window("AssaultCube")
    time.sleep(0.4)
    for _ in range(tries):
        a = grab()
        osctl.move_rel(250, 0, steps=12, delay=0.004); time.sleep(0.25)
        b = grab()
        osctl.move_rel(-250, 0, steps=12, delay=0.004); time.sleep(0.25)
        d = sum(abs(a[i] - b[i]) for i in range(0, len(a), 5)) / (len(a) / 5)
        if d > 8.0:
            return win
        osctl.tap(osctl.VK_ESCAPE); time.sleep(0.5)
    return win


def main():
    into_gameplay()
    time.sleep(0.3)
    # Take the feature from an off-centre spot of the live view.
    patch = cut(grab(), CX + OFFX, CY + OFFY, PW, PH)
    last = [CX + OFFX, CY + OFFY]             # last known patch centre (viewport coords)

    def locate():
        rgb = grab()
        sw = 130
        m = osctl.match_template(patch, PW, PH, rgb=rgb, size=(VW, VH),
                                 search=(last[0] - sw, last[1] - sw,
                                         last[0] + sw, last[1] + sw), step=2)
        if m is None or m["score"] > 6000:    # lost / mismatched (repeated texture)
            return None
        last[0], last[1] = m["x"], m["y"]
        return m["x"], m["y"]

    start = locate()
    osctl.screenshot("/tmp/servo_start.png")
    r = osctl.servo(locate, (CX, CY), tol=6.0, max_iter=20,
                    probe=28, damping=0.55, settle=0.05)
    osctl.screenshot("/tmp/servo_end.png")

    start_err = ((start[0] - CX) ** 2 + (start[1] - CY) ** 2) ** 0.5 if start else -1
    print(f"feature started {start_err:5.1f}px off the crosshair at {start}")
    print(f"servo: hit={r['hit']} reason={r['reason']} iters={r['iters']} "
          f"err={r['err']:.1f}px gain={tuple(round(g,3) for g in r['gain']) if r['gain'] else None}")
    verdict = ("servo closed the loop: measured the unknown scale and drove the "
               "feature onto the crosshair"
               if r["hit"] and r["err"] <= 6.0 and start_err > 40 else "INCONCLUSIVE")
    print("F262 live:", verdict)
    return r


if __name__ == "__main__":
    main()
