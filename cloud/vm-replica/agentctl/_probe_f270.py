"""F270 probe — temporal persistence as the real-mover-vs-artifact discriminator.

F269 closed: under a single frame-pair there is no clean geometric gate that
tells a real mover from a deterministic match artifact (both make a residual
cluster). The data pointed at TIME: a real mover persists across consecutive
frames and translates coherently; a transient mismatch flickers (one frame); a
camera-locked overlay persists but stays pinned at a fixed screen position. This
probe captures a short live sequence, runs flow_residual on each consecutive
pair, links the per-pair objects by nearest-neighbour, and reports how long each
track survives and whether it translates — to decide whether persistence is a
real discriminator before building a tracking primitive.
"""
import sys
import time
sys.path.insert(0, ".")
import osctl
import _game_f268 as g

N = 6          # frames in the sequence
DT = 0.20      # seconds between frames
LINK = 60.0    # px: max gap to link an object across consecutive pairs


def detect(A, B, sw, sh):
    v = g.votes(A, B, sw, sh)
    r = osctl.flow_residual(v, min_resid=7.0, cluster_radius=45.0, min_cluster=3)
    return (r["objects"] if r else [])


def link_tracks(frames):
    """frames: list of object-lists (one per consecutive pair). Greedy NN link."""
    tracks = []  # each: list of (pair_index, obj)
    for pi, objs in enumerate(frames):
        for o in objs:
            best, bd = None, LINK
            for tr in tracks:
                lpi, lo = tr[-1]
                if lpi != pi - 1:
                    continue
                d = ((o["x"] - lo["x"]) ** 2 + (o["y"] - lo["y"]) ** 2) ** 0.5
                if d < bd:
                    best, bd = tr, d
            if best is not None:
                best.append((pi, o))
            else:
                tracks.append([(pi, o)])
    return tracks


def main():
    vx, vy, vw, vh = g.win_viewport()
    osctl.click(vx + vw // 2, vy + vh // 2)
    time.sleep(0.3)
    for regime, pan in (("STILL camera", False), ("slow PAN", True)):
        print(f"\n==== {regime} ====")
        seq = []
        prev = None
        for k in range(N):
            if pan and prev is not None:
                osctl.move_rel(18, 0, steps=6, delay=0.003)  # small same-dir pan
            cur, _, _ = g.grab(vx, vy, vw, vh)
            if prev is not None:
                seq.append(detect(prev, cur, vw, vh))
            prev = cur
            time.sleep(DT)
        tracks = link_tracks(seq)
        tracks.sort(key=len, reverse=True)
        print(f"{len(seq)} pairs; {len(tracks)} tracks")
        for tr in tracks:
            xs = [o["x"] for _, o in tr]
            ys = [o["y"] for _, o in tr]
            span = ((xs[-1] - xs[0]) ** 2 + (ys[-1] - ys[0]) ** 2) ** 0.5
            kind = ("FLICKER" if len(tr) == 1 else
                    "PINNED(overlay?)" if span < 8 else "MOVER")
            print(f"  len={len(tr)} span={span:5.1f}px {kind:16s} "
                  f"path={[(int(x), int(y)) for x, y in zip(xs, ys)]}")


if __name__ == "__main__":
    main()
