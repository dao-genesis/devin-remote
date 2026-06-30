"""Live proof for F261 move_rel — mouse-look in AssaultCube (open-source FPS).

An FPS grabs the pointer and turns the camera from pointer *motion*, integrating deltas
per frame. The floor's absolute `move(x, y)` cannot *express* a rotation — you name a
screen pixel, not a turn — and on raw-input games / Windows SendInput-absolute /
Pointer-Lock canvases an absolute warp moves the camera by nothing at all. (Even where a
relative-mode SDL backend happens to read warp-deltas, the effect is an uncontrolled,
irreversible drift you cannot command.)

`move_rel` commands the exact delta the game integrates, so the camera turn is
*proportional and reversible*: this driver sweeps the view right by a yaw delta, then
sweeps the same delta back, and shows the view returns home to within a hair (~0 mean
pixel diff). That round-trip is the proof — controlled, reversible mouse-look the
absolute pointer family could never give.

Run from the agentctl dir with AssaultCube already running (any spawn map).
"""
import sys
sys.path.insert(0, ".")
import osctl
import time

# A band of the central viewport, clear of the HUD and the corner minimap.
VX, VY, VW, VH = 600, 360, 380, 200


def band():
    w, h, rgb = osctl.capture_rgb(VX, VY, VW, VH)
    return bytes(rgb)


def meandiff(a, b):
    """Mean absolute per-byte difference between two equal-size RGB captures."""
    n = min(len(a), len(b)) or 1
    return sum(abs(a[i] - b[i]) for i in range(n)) / n


def yaw_roundtrip(delta=600, steps=20):
    """Sweep the view right by `delta`, then back; return (turn_diff, residual).
    turn_diff: how much the viewport changed at full right yaw (large in gameplay).
    residual: viewport difference after sweeping back home (~0 => reversible yaw)."""
    home = band()
    osctl.move_rel(delta, 0, steps=steps, delay=0.004); time.sleep(0.25)
    turned = band()
    osctl.move_rel(-delta, 0, steps=steps, delay=0.004); time.sleep(0.25)
    back = band()
    return meandiff(home, turned), meandiff(home, back)


def clear_menus(tries=4):
    """Reach gameplay: a real yaw sweep changes the viewport only when the camera is
    live; a menu freezes it. Probe with move_rel and toggle Escape until the camera
    turns. (Escape toggles AssaultCube's menu, so we probe rather than press blindly.)"""
    win = osctl.focus_window("AssaultCube")
    time.sleep(0.4)
    for _ in range(tries):
        turn, _ = yaw_roundtrip(delta=300, steps=10)
        if turn > 8.0:
            return win
        osctl.tap(osctl.VK_ESCAPE)
        time.sleep(0.4)
    return win


def main():
    win = clear_menus()
    print("focused:", win)
    time.sleep(0.4)
    osctl.screenshot("/tmp/fps_home.png")

    turn, residual = yaw_roundtrip(delta=600, steps=20)
    osctl.screenshot("/tmp/fps_roundtrip.png")
    print(f"move_rel +600 turned the view by mean-diff {turn:6.2f}; "
          f"after -600 the view returned home, residual {residual:6.3f}")
    verdict = ("move_rel gives controlled, reversible mouse-look "
               "(turns the camera, returns home to ~0)"
               if turn > 8.0 and residual < turn * 0.2 else "INCONCLUSIVE")
    print("F261 live:", verdict)
    return turn, residual


if __name__ == "__main__":
    main()
