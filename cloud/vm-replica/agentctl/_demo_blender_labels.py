#!/usr/bin/env python3
"""F181 visual demo — add a Cube to Blender entirely by meaning.

No pixel coordinates are hard-coded for the targets: every click is located by
naming the label (locate_labels) and segmenting the live strip/dropdown. The
floor is blind to Blender's OpenGL canvas via AT-SPI (uia_* empty) and its glyph
OCR cannot read Blender's ~9px proportional font — yet it still operates the app,
because a menu is an *ordered list of known labels* parted by wide blank space.

Drives: header "Add" (horizontal) -> "Mesh" (vertical dropdown) -> "Cube"
(vertical submenu). The independent oracle (headless mesh count == 2) is run by
the harness after a Save As; this script is the on-screen story for the recording.
"""
import time

import osctl

PAUSE = 1.1


def click_label(bbox, labels, want, fg, gap=4, tol=90, axis="x"):
    w, h, rgb = osctl.capture_rgb()
    rects = osctl.locate_labels(rgb, (w, h), bbox, labels, fg=fg, tol=tol,
                                gap=gap, axis=axis)
    if want not in rects:
        raise SystemExit("locate_labels could not map %r in %s" % (want, labels))
    r = rects[want]
    cx, cy = (r[0] + r[2]) // 2, (r[1] + r[3]) // 2
    print("located %-8r by meaning -> rect %s, click (%d,%d)" % (want, r, cx, cy))
    osctl.click(cx, cy)
    time.sleep(PAUSE)


def main():
    time.sleep(PAUSE)
    # 1) header bar (horizontal, white text): open the Add menu by meaning
    click_label((160, 60, 405, 76), ["View", "Select", "Add", "Object"],
                "Add", fg=(220, 220, 220), axis="x")
    # 2) Add dropdown (vertical, teal text): open the Mesh submenu by meaning
    add_items = ["Mesh", "Curve", "Surface", "Metaball", "Text", "Volume",
                 "Grease Pencil", "Armature", "Lattice", "Empty", "Image",
                 "Light", "Light Probe", "Camera", "Speaker", "Force Field",
                 "Collection Instance"]
    click_label((285, 80, 395, 520), add_items, "Mesh",
                fg=(0, 200, 200), axis="y")
    # 3) Mesh submenu (vertical, teal text): add the Cube by meaning
    mesh_items = ["Plane", "Cube", "Circle", "UV Sphere", "Ico Sphere",
                  "Cylinder", "Cone", "Torus", "Grid", "Monkey"]
    click_label((432, 78, 540, 320), mesh_items, "Cube",
                fg=(0, 200, 200), axis="y")
    print("Cube added by meaning — outliner should now hold a second mesh.")


if __name__ == "__main__":
    main()
