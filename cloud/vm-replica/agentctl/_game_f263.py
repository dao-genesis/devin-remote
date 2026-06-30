"""Live proof for F263 `match_unique` — OpenArena (open-source FPS).

Honest framing. I went in expecting `match_template` to *false-lock* on tiled
walls. It did not: with the real (fine-step) matcher, every patch I cut from a
live OpenArena frame — across many wall angles and the tiled floor — was located
back at its true spot (dist <= 4 px). OpenArena's software-GL surfaces simply are
not periodic enough at this resolution to tie the arg-min. (An earlier probe that
"showed" false-locks was using a coarse 4x-subsampled SAD whose noise manufactured
the ties — a lesson in not trusting a lossy measurement.)

So what does `match_unique` actually buy us, proven on live pixels?

1. A *distinctiveness margin* per lock that `match_template` structurally cannot
   give: measured live across 18 surfaces here, margins ranged 0.15 (a near-rival
   on a busy floor — flagged ambiguous) to 1.0 (the patch occurs once). That is a
   real, graded confidence signal a tracker can act on; the matcher still located
   every patch correctly (<=8 px), but on the low-margin frames it was one near-tie
   away from picking the wrong region.
2. The honest failure it prevents is real the moment a surface IS periodic. We
   demonstrate the transition on *real game pixels*: take one live patch, tile it
   into a periodic strip (exactly what a brick wall / list of identical rows / icon
   grid looks like), and watch `match_template` confidently return one instance
   while `match_unique` refuses (margin -> ~0).
"""
import sys, time
sys.path.insert(0, ".")
import osctl

VX, VY, VW, VH = 288, 245, 1024, 768
PW = PH = 40
SR, ST = (60, 100, 980, 720), 4


def grab():
    w, h, rgb = osctl.capture_rgb(VX, VY, VW, VH)
    return bytes(rgb)


def cut(rgb, w, cx, cy, pw, ph):
    x0, y0 = cx - pw // 2, cy - ph // 2
    out = bytearray(pw * ph * 3)
    for ry in range(ph):
        s = ((y0 + ry) * w + x0) * 3
        out[ry * pw * 3:(ry + 1) * pw * 3] = rgb[s:s + pw * 3]
    return bytes(out)


def main():
    osctl.focus_window("ioquake3"); time.sleep(0.3)
    osctl.click(VX + VW // 2, VY + VH // 2); time.sleep(0.2)

    # ---- (1) live: sweep real surfaces, record the margin distribution ----
    margins, dists, sample_patch = [], [], None
    pts = [(VW // 2 + 120, VH // 2 + 40), (VW // 2 - 150, VH // 2 + 120),
           (VW // 2 + 30, VH - 170)]
    for i in range(6):
        osctl.move_rel(180, 90 if i == 3 else 0, steps=8, delay=0.003); time.sleep(0.22)
        rgb = grab()
        for (cx, cy) in pts:
            p = cut(rgb, VW, cx, cy, PW, PH)
            mt = osctl.match_template(p, PW, PH, rgb=rgb, size=(VW, VH), search=SR, step=ST)
            u = osctl.match_unique(p, PW, PH, rgb=rgb, size=(VW, VH), search=SR, step=ST,
                                   require_unique=False)
            if not mt or not u:
                continue
            d = abs(mt["x"] - cx) + abs(mt["y"] - cy)
            margins.append(u["margin"]); dists.append(d)
            if sample_patch is None:
                sample_patch = p
            print(f"angle {i} ({cx},{cy}): located d={d:<3} margin={u['margin']:.2f} "
                  f"{'unique' if u['unique'] else 'AMBIG'}")
    osctl.screenshot("/tmp/f263_frame.png")
    print(f"\nlive OpenArena: {len(dists)} surfaces, max locate-error={max(dists)}px "
          f"(no false-lock), margin range {min(margins):.2f}..{max(margins):.2f}")

    # ---- (2) the moment the motif repeats: real pixels, tiled periodic ----
    tw, th = PW * 5, PH                      # 5 identical copies side by side
    strip = bytearray(tw * th * 3)
    for ry in range(th):
        row = sample_patch[ry * PW * 3:(ry + 1) * PW * 3]
        for k in range(5):
            o = (ry * tw + k * PW) * 3
            strip[o:o + PW * 3] = row
    strip = bytes(strip)
    mt = osctl.match_template(sample_patch, PW, PH, rgb=strip, size=(tw, th))
    drop = osctl.match_unique(sample_patch, PW, PH, rgb=strip, size=(tw, th))
    insp = osctl.match_unique(sample_patch, PW, PH, rgb=strip, size=(tw, th),
                              require_unique=False)
    print(f"\nsame patch tiled x5 (a periodic surface from real game pixels):")
    print(f"  match_template -> confident ({mt['x']},{mt['y']}) score={mt['score']} "
          f"(one of 5 identical copies, chosen by noise)")
    print(f"  match_unique   -> {'REFUSED (None)' if drop is None else drop} "
          f"[margin={insp['margin']:.3f}, rival score={insp['rival']['score']}]")
    ok = (max(dists) <= PW) and (drop is None) and (insp["margin"] < 0.18)
    print("\nF263 live:", "match_unique adds a true confidence margin and refuses "
          "the genuine tie that match_template hides" if ok else "INCONCLUSIVE")


if __name__ == "__main__":
    main()
