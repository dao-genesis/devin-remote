"""F264 live proof — `lead` on real OpenArena pixels.

Pans the camera at a constant rate so a real wall feature translates across the
view at a steady image-plane velocity (a controlled stand-in for a moving
target: the relative motion between observer and feature is what an aim loop
must predict, whichever side moves). Each frame the feature is re-found with
`match_unique`; the (t, x, y) history is fed to `osctl.lead`, which fits the
velocity and predicts the next frame's position. We compare that lead against
the "assume it stays" model that a relocating servo implicitly uses.

Run with the ioquake3 window visible on DISPLAY=:0.
"""
import sys
import time
sys.path.insert(0, ".")
import osctl

VX, VY, VW, VH = 288, 245, 995, 746
PW = PH = 44


def grab():
    _w, _h, rgb = osctl.capture_rgb(VX, VY, VW, VH)
    return bytes(rgb)


def cut(rgb, w, cx, cy, pw, ph):
    x0, y0 = cx - pw // 2, cy - ph // 2
    out = bytearray(pw * ph * 3)
    for ry in range(ph):
        s = ((y0 + ry) * w + x0) * 3
        out[ry * pw * 3:(ry + 1) * pw * 3] = rgb[s:s + pw * 3]
    return bytes(out)


def main():
    osctl.focus_window("ioquake3")
    time.sleep(0.4)
    osctl.click(VX + VW // 2, VY + VH // 2)
    time.sleep(0.3)

    A = grab()
    cx, cy = int(VW * 0.66), int(VH * 0.42)
    patch = cut(A, VW, cx, cy, PW, PH)

    samples = []          # (t, x, y) history, exactly what lead() consumes
    px, py = cx, cy
    t0 = time.time()
    print("tracking a wall feature under constant pan:")
    for i in range(7):
        osctl.move_rel(26, 0, steps=3, delay=0.003)     # steady pan right
        time.sleep(0.04)
        B = grab()
        sr = (max(0, px - 90), max(0, py - 60),
              min(VW, px + 90), min(VH, py + 60))
        m = osctl.match_unique(patch, PW, PH, rgb=B, size=(VW, VH),
                               search=sr, step=2, require_unique=False)
        t = time.time() - t0
        if not m:
            samples.append((t, None, None))             # lost frame -> lead skips it
            print(f"  step{i}: lost")
            continue
        px, py = m["x"], m["y"]
        samples.append((t, px, py))
        print(f"  step{i}: t={t:.3f} pos=({px:>3},{py:>3}) margin={m['margin']:.2f}")

    # one-step-ahead: at each frame predict the NEXT with history so far
    naive = lead_err = 0.0
    cnt = 0
    valid = [s for s in samples if s[1] is not None]
    for k in range(2, len(valid)):
        hist = valid[:k]
        dt = valid[k][0] - valid[k - 1][0]
        est = osctl.lead(hist, horizon=dt)
        if est is None:
            continue
        actual = valid[k][1]
        naive += abs(actual - valid[k - 1][1])          # assume it stays
        lead_err += abs(actual - est["px"])             # predicted lead
        cnt += 1

    final = osctl.lead(valid, horizon=0.0)
    print()
    if final:
        print(f"fitted velocity = ({final['vx']:.1f}, {final['vy']:.1f}) px/s, "
              f"speed {final['speed']:.1f} px/s over {final['n']} samples")
    if cnt:
        print(f"mean 1-step error: naive(assume-stays)={naive / cnt:.1f}px  "
              f"lead(v*dt)={lead_err / cnt:.1f}px")
        print("F264 live: lead turns a track history into velocity and aims at "
              "the interception, not the trail")


if __name__ == "__main__":
    main()
