"""F268 live proof — flow_residual on a real OpenArena skirmish.

The killer case the floor could not handle: while the camera pans, raw frame-diff
(locate_change_blobs) floods — every pixel changed — so it cannot point at the
bot that is strafing through the scene. flow_residual fits the camera's global
affine flow (consensus_affine, F267), subtracts it from each seed, and clusters
the seeds that still disagree into independently-moving objects. This harness
runs it on the live ioquake3 window in two regimes:
  (A) still camera, bots moving  -> field ~ 0, residual = the bots' own motion;
  (B) panning camera, bots moving -> residual isolates the bot from the swept
      world, where frame-diff sees the WHOLE viewport change.
Reports, per trial, the fitted field, the frame-diff changed-area (the flood),
and the independently-moving objects flow_residual recovers.
"""
import os
import subprocess
import sys
import time
sys.path.insert(0, ".")
import osctl

F = 3
MIN_VAR = 45.0
YAW = 70


def win_viewport():
    osctl.focus_window("ioquake3")
    time.sleep(0.4)
    env = dict(os.environ, DISPLAY=":0")
    out = subprocess.check_output(
        ["xdotool", "search", "--name", "ioquake3", "getwindowgeometry", "%@"],
        env=env).decode()
    px = py = 0
    for ln in out.splitlines():
        ln = ln.strip()
        if ln.startswith("Position:"):
            xy = ln.split()[1].split(",")
            px, py = int(xy[0]), int(xy[1])
    # central viewport, clear of HUD (bottom) and the gun (lower centre)
    return px + 180, py + 120, 660, 380


def grab(vx, vy, vw, vh):
    _w, _h, rgb = osctl.capture_rgb(vx, vy, vw, vh)
    return bytes(rgb), vw, vh


def downs(rgb, sw, sh, f=F):
    qw, qh = sw // f, sh // f
    out = bytearray(qw * qh * 3)
    st = sw * 3
    for j in range(qh):
        r = (j * f) * st
        for i in range(qw):
            p = r + (i * f) * 3
            o = (j * qw + i) * 3
            out[o], out[o + 1], out[o + 2] = rgb[p], rgb[p + 1], rgb[p + 2]
    return bytes(out), qw, qh


def lvar(patch, pw, ph):
    n = pw * ph
    s = s2 = 0
    for i in range(n):
        l = (patch[i * 3] * 299 + patch[i * 3 + 1] * 587 + patch[i * 3 + 2] * 114) // 1000
        s += l
        s2 += l * l
    return s2 / n - (s / n) ** 2


def votes(A, B, sw, sh):
    a, qw, qh = downs(A, sw, sh)
    b, _, _ = downs(B, sw, sh)
    out = []
    for by in range(0, qh - 12, 5):
        for bx in range(0, qw - 12, 5):
            pt, pw, ph = osctl.crop_rgb(a, (qw, qh), (bx, by, bx + 11, by + 11))
            if lvar(pt, pw, ph) < MIN_VAR:
                continue
            s = (max(0, bx - 28), max(0, by - 20),
                 min(qw - 1, bx + 28), min(qh - 1, by + 20))
            m = osctl.match_unique(pt, pw, ph, rgb=b, size=(qw, qh), search=s)
            if not m:
                continue
            dx = (m["x"] - (bx + pw // 2)) * F
            dy = (m["y"] - (by + ph // 2)) * F
            out.append((bx * F + 18, by * F + 18, dx, dy))
    return out


def run(vx, vy, vw, vh, pan):
    A, sw, sh = grab(vx, vy, vw, vh)
    if pan:
        osctl.move_rel(YAW, 0, steps=14, delay=0.003)
    time.sleep(0.22)
    B, _, _ = grab(vx, vy, vw, vh)
    if pan:
        osctl.move_rel(-YAW, 0, steps=14, delay=0.003)
        time.sleep(0.2)
    # frame-diff flood: how much of the viewport reads as "changed"
    blobs = osctl.locate_change_blobs(A, B, (sw, sh), tol=18, min_count=40)
    changed = sum(bl["count"] for bl in blobs)
    frac = 100.0 * changed / (sw * sh)
    v = votes(A, B, sw, sh)
    fr = osctl.flow_residual(v, min_resid=7.0, cluster_radius=45.0, min_cluster=3)
    return v, blobs, frac, fr


def main():
    vx, vy, vw, vh = win_viewport()
    osctl.click(vx + vw // 2, vy + vh // 2)
    time.sleep(0.3)
    for regime, pan in (("STILL camera", False), ("PANNING camera", True)):
        print(f"\n==== {regime} ====")
        for trial in range(3):
            v, blobs, frac, fr = run(vx, vy, vw, vh, pan)
            if fr is None:
                print(f"[{trial}] {len(v)} votes — field unfittable, skip")
                continue
            f = fr["field"]
            print(f"[{trial}] {len(v)} seeds | frame-diff: {len(blobs)} blobs, "
                  f"{frac:.0f}% of viewport 'changed' | "
                  f"field centre=({f['bx'][0]:+.0f},{f['by'][0]:+.0f}) "
                  f"grad={f['ax'][2]:+.3f} | residual-seeds={fr['n_resid']}")
            for o in fr["objects"]:
                print(f"      OBJECT @({o['x']:.0f},{o['y']:.0f}) "
                      f"rel-vel=({o['rdx']:+.0f},{o['rdy']:+.0f}) "
                      f"speed={o['speed']:.0f}px n={o['n']} bbox={tuple(int(b) for b in o['bbox'])}")
            if not fr["objects"]:
                print("      (no independent motion — just the camera)")


if __name__ == "__main__":
    main()
