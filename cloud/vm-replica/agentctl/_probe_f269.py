"""F269 probe — is flow_residual's panning false-positive proportional to the
local field flow magnitude (first-order curvature error), and is a real mover an
outlier to that relation?

F268 found that under a pan the residual clusters are reproducible across trials
(not bots) — the structural leftover of a *first-order* affine field that
under-fits perspective yaw curvature. Hypothesis: that leftover residual grows
with the local flow magnitude |field(x,y)| (curvature error scales with flow),
so a residual whose size is *explained by* local flow is model error, while a
real independent mover has residual that local flow does NOT explain. This probe
measures, per seed, residual vs local-flow magnitude in the panning regime and
bins it — if residual rises monotonically with local flow, the curvature
hypothesis holds and the F269 gate is a flow-normalised residual.
"""
import sys
import time
sys.path.insert(0, ".")
import osctl
import _game_f268 as g

YAW = 70


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
        fld = osctl.consensus_affine(v, min_votes=12)
        if not fld:
            print(f"[{trial}] field unfittable")
            continue
        ax, ay = fld["ax"], fld["ay"]
        rows = []
        for (x, y, dx, dy) in v:
            px = ax[0] + ax[1] * x + ax[2] * y
            py = ay[0] + ay[1] * x + ay[2] * y
            flow = (px * px + py * py) ** 0.5
            res = ((dx - px) ** 2 + (dy - py) ** 2) ** 0.5
            rows.append((flow, res, x, y))
        rows.sort()
        n = len(rows)
        print(f"[{trial}] {n} seeds; field grad={ax[2]:+.3f} rms={fld['rms']:.1f}")
        # bin by local flow magnitude (quartiles), report median residual
        for q in range(4):
            seg = rows[q * n // 4:(q + 1) * n // 4]
            if not seg:
                continue
            fl = sorted(s[0] for s in seg)
            re = sorted(s[1] for s in seg)
            print(f"    flow[{fl[0]:5.1f}..{fl[-1]:5.1f}] "
                  f"median_resid={re[len(re)//2]:5.1f} "
                  f"max_resid={re[-1]:5.1f}")
        # the discriminator: ratio residual / local-flow. A curvature artifact
        # has bounded ratio; a real mover spikes it. Report the top-5 ratios.
        ratio = sorted(((r[1] / (r[0] + 1e-6), r[1], r[0], r[2], r[3])
                        for r in rows), reverse=True)[:5]
        print("    top resid/flow ratios (mover candidates):")
        for (ra, re, fl, x, y) in ratio:
            print(f"      ratio={ra:4.1f} resid={re:5.1f} flow={fl:5.1f} @({x:.0f},{y:.0f})")


if __name__ == "__main__":
    main()
