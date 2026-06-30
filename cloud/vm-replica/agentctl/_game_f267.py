"""F267 live proof — consensus_affine on a real OpenArena yaw.

The F267 probe established that a fixed yaw produces a smooth depth-graded ramp
of horizontal displacement down the frame, which consensus_shift (F265) honestly
refuses (no single shift). This harness closes the loop on the real game: it
yaws the live view, extracts position-tagged displacement votes with
match_unique, and feeds them to consensus_affine — showing it recovers the flow
*as one global affine field* (a centre shift + a real dx/dy gradient) on the very
same vote-bag where consensus_shift returns None. Run on the live ioquake3
window (software GL, 1024x768 windowed).
"""
import sys
import time
sys.path.insert(0, ".")
import osctl
from _probe_f267 import grab, votes, VX, VY, VW, VH, YAW


def main():
    osctl.focus_window("ioquake3")
    time.sleep(0.4)
    osctl.click(VX + VW // 2, VY + VH // 2)
    time.sleep(0.3)
    ok_trials = 0
    for trial in range(3):
        A, sw, sh = grab()
        osctl.move_rel(YAW, 0, steps=14, delay=0.003)
        time.sleep(0.10)
        B, _, _ = grab()
        osctl.move_rel(-YAW, 0, steps=14, delay=0.003)   # undo, keep view put
        time.sleep(0.25)
        v = votes(A, B, sw, sh)
        if len(v) < 12:
            print(f"[trial {trial}] only {len(v)} votes (view static?) — skip")
            continue

        cs = osctl.consensus_shift([(d[2], d[3]) for d in v],
                                   tol=4.0, min_support=0.3)
        af = osctl.consensus_affine(v, min_votes=12)

        cs_s = (f"dx={cs['dx']:+.1f} ({cs['support']*100:.0f}%)"
                if cs else "None")
        print(f"\n[trial {trial}] {len(v)} seeds")
        print(f"  consensus_shift  -> {cs_s}")
        if not af:
            print("  consensus_affine -> None (unexpected)")
            continue
        ax, bx = af["ax"], af["bx"]
        # predicted dx at the top and bottom of the viewport from the fitted field
        top = ax[0] + ax[2] * 0.0
        bot = ax[0] + ax[2] * float(VH)
        print(f"  consensus_affine -> centre dx={bx[0]:+.1f} "
              f"gradient d(dx)/dy={ax[2]:+.4f} px/px  "
              f"support={af['support']*100:.0f}% rms={af['rms']:.1f}px")
        print(f"      predicted dx: top={top:+.0f}px  bottom={bot:+.0f}px  "
              f"(ramp {abs(top)-abs(bot):+.0f}px across the frame)")

        # the live claim: a uniform shift can't represent this, an affine field can
        if cs is None and ax[2] > 0.02 and af["rms"] < 8.0:
            print("  PASS: shift refuses; affine recovers the depth-graded ramp")
            ok_trials += 1
        elif cs is not None and abs(ax[2]) < 0.02:
            print("  PASS: uniform pan; affine degrades to consensus_shift")
            ok_trials += 1
        else:
            print("  (inconclusive trial)")
    print(f"\nF267 live: {ok_trials}/3 trials confirmed affine flow recovery")


if __name__ == "__main__":
    main()
