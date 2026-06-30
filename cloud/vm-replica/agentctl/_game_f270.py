"""F270 live proof — flow_residual + link_tracks on a real OpenArena sequence.

F269 proved a single frame-pair cannot tell a real mover from a deterministic
match artifact. link_tracks adds time: link each pair's flow_residual objects
into tracks, then read persistence (length) and screen span. This harness runs a
slow-pan sequence on the live ioquake3 window and reports how the persistence
gate collapses the single-pair detections — flickers (length 1) dropped, pinned
overlays (length>1, span~0) flagged, persistent translating tracks kept as the
genuine movers.
"""
import sys
import time
sys.path.insert(0, ".")
import osctl
import _game_f268 as g

N = 6
DT = 0.20
PAN = 18


def main():
    vx, vy, vw, vh = g.win_viewport()
    osctl.click(vx + vw // 2, vy + vh // 2)
    time.sleep(0.3)
    per_pair = []
    prev = None
    for k in range(N):
        if prev is not None:
            osctl.move_rel(PAN, 0, steps=6, delay=0.003)
        cur, _, _ = g.grab(vx, vy, vw, vh)
        if prev is not None:
            v = g.votes(prev, cur, vw, vh)
            r = osctl.flow_residual(v, min_resid=7.0, cluster_radius=45.0, min_cluster=3)
            per_pair.append(r["objects"] if r else [])
        prev = cur
        time.sleep(DT)

    raw = sum(len(o) for o in per_pair)
    tracks = osctl.link_tracks(per_pair, max_gap=60.0, max_skip=1)
    flick = [t for t in tracks if t["length"] == 1]
    persist = [t for t in tracks if t["length"] > 1]
    pinned = [t for t in persist if t["span"] < 8.0]
    movers = [t for t in persist if t["span"] >= 8.0]

    print(f"{len(per_pair)} pairs, {raw} single-pair detections")
    print(f"link_tracks -> {len(tracks)} tracks: "
          f"{len(flick)} flickers (dropped), {len(persist)} persistent "
          f"({len(pinned)} pinned/overlay, {len(movers)} movers)")
    for t in movers:
        p = t["points"]
        print(f"  MOVER  len={t['length']} span={t['span']:5.1f} "
              f"net={tuple(round(c) for c in t['net'])} "
              f"path={[(int(q['x']), int(q['y'])) for q in p]}")
    for t in pinned:
        p = t["points"]
        print(f"  PINNED len={t['length']} span={t['span']:5.1f} "
              f"@({int(p[0]['x'])},{int(p[0]['y'])})")

    gate_ok = raw > len(persist) and len(flick) >= 1
    print(f"\nPERSISTENCE GATE {'CONFIRMED' if gate_ok else 'inconclusive'}: "
          f"{raw} noisy single-pair detections -> {len(persist)} persistent "
          f"(flickers removed by time, which no single pair could reject).")


if __name__ == "__main__":
    main()
