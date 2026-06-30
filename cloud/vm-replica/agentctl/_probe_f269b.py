"""F269b — does a boundary gate (drop residual seeds whose predicted
correspondence leaves the captured frame) remove the panning false clusters,
and does the surviving residual vary across trials (real mover) or repeat
(artifact)? Decides whether F269 is a shippable robustness gate or a pure
honest negative.
"""
import sys
import time
sys.path.insert(0, ".")
import osctl
import _game_f268 as g

YAW = 70


def objs(v, sw, sh, gate):
    fld = osctl.consensus_affine(v, min_votes=12)
    if not fld:
        return None, []
    ax, ay = fld["ax"], fld["ay"]
    keep = []
    for (x, y, dx, dy) in v:
        if gate:
            px = ax[0] + ax[1] * x + ax[2] * y
            py = ay[0] + ay[1] * x + ay[2] * y
            # predicted correspondence position; drop if it leaves the frame
            if not (8 <= x + px <= sw - 8 and 8 <= y + py <= sh - 8):
                continue
        keep.append((x, y, dx, dy))
    r = osctl.flow_residual(keep, field=fld, min_resid=7.0,
                            cluster_radius=45.0, min_cluster=3)
    return fld, (r["objects"] if r else [])


def main():
    vx, vy, vw, vh = g.win_viewport()
    osctl.click(vx + vw // 2, vy + vh // 2)
    time.sleep(0.3)
    for trial in range(3):
        A, sw, sh = g.grab(vx, vy, vw, vh)
        osctl.move_rel(YAW, 0, steps=14, delay=0.003)
        time.sleep(0.18)
        B, _, _ = g.grab(vx, vy, vw, vh)
        osctl.move_rel(-YAW, 0, steps=14, delay=0.003)
        time.sleep(0.18)
        v = g.votes(A, B, sw, sh)
        _, raw = objs(v, sw, sh, False)
        _, gated = objs(v, sw, sh, True)
        print(f"[{trial}] raw objects={len(raw)} gated objects={len(gated)}")
        for tag, lst in (("raw", raw), ("gated", gated)):
            for o in lst:
                print(f"    {tag}: @({o['x']:.0f},{o['y']:.0f}) "
                      f"vel=({o['rdx']:+.0f},{o['rdy']:+.0f}) n={o['n']}")


if __name__ == "__main__":
    main()
