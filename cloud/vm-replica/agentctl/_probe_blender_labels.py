#!/usr/bin/env python3
"""F181 probe — operate a native OpenGL-canvas app (Blender) by meaning.

The friction: the semantic floor (AT-SPI) is blind to Blender's custom canvas
(uia_* honestly empty), and the OCR path cannot help either — every reader needs
a glyph ``atlas`` and the only atlas-builder renders glyphs in the browser, a font
Blender does not use. Harvesting an atlas from Blender's own ~9px proportional
anti-aliased text founders on *glyph* segmentation (only "File" cuts into its 4
letters; "Render" shatters into 12). So the floor could not act on Blender at all.

The primitive: ``locate_labels`` — a menu bar / dropdown / toolbar is an *ordered
list of known labels* parted by *wide* blank space (item gaps >> letter gaps), so
you can map labels -> click-rects by run-segmentation alone, no atlas. ``axis="x"``
for horizontal strips, ``axis="y"`` for vertical dropdowns. It commits only on an
exact run/label count match (else {} — truthful degradation).

This probe asserts the friction and the primitive against a live Blender window.
It does not click (read-only); the end-to-end Add>Mesh>Cube drive + headless mesh
count is recorded separately (see F181_TEST_REPORT.md).
"""
import sys
import time

import osctl

MENU_BAR = "File Edit Render Window Help".split()
HEADER = ["View", "Select", "Add", "Object"]
# Empirically-true for this Blender's dark theme (the menu-bar ink is a near-white
# (222,224,226) at y38-50; capture_rgb is the real 1600x1200 frame).
BAR_BOX = (28, 38, 235, 50)
BAR_FG = (222, 224, 226)


def _find_blender_win():
    for w in osctl.list_windows():
        if "Blender" in (w.get("title") or ""):
            return w["id"]
    return None


def main() -> int:
    win = _find_blender_win()
    if win is None:
        print("SKIP: no Blender window found")
        return 0
    print("Blender window:", win, repr(osctl.window_text(win)))
    osctl.activate_window(win)          # raise above any occluding window
    time.sleep(0.4)

    ok = True

    # (1) Friction: the semantic floor is blind to the OpenGL canvas — and says so.
    nm = osctl.uia_name(win)
    kids = osctl.uia_children(win)
    blind = (nm == "" and kids == [])
    print("[friction] uia_name=%r uia_children=%d -> blind&honest=%s"
          % (nm, len(kids), blind))
    ok &= blind

    # (2) Primitive, axis='x': the top menu bar maps to its known labels.
    w, h, rgb = osctl.capture_rgb()
    bar = osctl.locate_labels(rgb, (w, h), BAR_BOX, MENU_BAR,
                              fg=BAR_FG, tol=70, gap=4)
    print("[x] menu bar:", {k: bar[k][0] for k in MENU_BAR} if bar else bar)
    bar_ok = (len(bar) == len(MENU_BAR)
              and bar["File"][0] < bar["Edit"][0] < bar["Render"][0]
              < bar["Window"][0] < bar["Help"][0])
    ok &= bar_ok

    # (3) Truthful degradation: wrong label count -> {} (never a mis-pairing).
    wrong = osctl.locate_labels(rgb, (w, h), BAR_BOX,
                                MENU_BAR + ["Phantom"], fg=BAR_FG,
                                tol=70, gap=4)
    print("[degrade] 6 labels vs 5 runs ->", wrong, "(expect {})")
    ok &= (wrong == {})

    # (4) Count-driven path is CORRECT, not just a fallback: break the fast path
    #     (gap=1 over-segments) and confirm it recovers the *identical* map.
    recovered = osctl.locate_labels(rgb, (w, h), BAR_BOX, MENU_BAR,
                                    fg=BAR_FG, tol=70, gap=1)

    def cx(r):
        return (r[0] + r[2]) // 2
    same = (len(recovered) == len(MENU_BAR)
            and all(abs(cx(recovered[k]) - cx(bar[k])) <= 3 for k in MENU_BAR))
    print("[count-driven] gap=1 fast-path broken -> same click targets:", same)
    ok &= same

    # (5) Honest sliver-rejection: a count match with a *displaced* cut (a band
    #     hugging a 2-3px sliver, as Blender's File menu produces) must yield {}.
    #     Exercised directly on _reject_thin: three fat bands + one sliver -> [].
    fat = [(0, 0, 50, 8), (0, 12, 48, 20), (0, 24, 52, 32)]
    sliver = fat + [(60, 36, 62, 44)]      # last band only 3px wide
    rej = osctl._reject_thin(sliver, cross="x", min_w=4)
    keep = osctl._reject_thin(fat, cross="x", min_w=4)
    print("[reject_thin] sliver ->", rej, "| clean ->", len(keep), "bands")
    ok &= (rej == [] and len(keep) == 3)

    print("PROBE", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
