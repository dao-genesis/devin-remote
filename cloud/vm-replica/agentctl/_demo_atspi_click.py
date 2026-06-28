"""F179 visual demo — the two floors become one.

The agent locates a control purely by MEANING (the editor text region, which the
toolkit exposes with geometry but NO Action), flies the real cursor there so the
journey is visible, then acts on it through the gesture floor and types into it
through the keyboard floor — and reads the result straight back out of the
toolkit through the semantic floor. Eye guides hand, no seam.
"""
import sys
import time

sys.path.insert(0, ".")
import osctl


def win_by(substr):
    for w in osctl.list_windows():
        if substr.lower() in (w.get("title", "") or "").lower():
            return w
    return None


def glide(x, y, steps=30, dwell=0.02):
    cx, cy = osctl.cursor_pos()
    for i in range(1, steps + 1):
        osctl.move(int(cx + (x - cx) * i / steps), int(cy + (y - cy) * i / steps))
        time.sleep(dwell)


def center(rect):
    x, y, w, h = rect
    return x + w // 2, y + h // 2


def main():
    kw = win_by("KWrite")
    if not kw:
        print("open kwrite first"); return 1
    win = kw["id"]
    osctl.activate_window(win); time.sleep(1.0)

    region = osctl.uia_find(win, ctype="text")
    print(f"located the editor region BY MEANING (role=text): {region['rect']}")
    print("  (this region exposes geometry but NO Action — uia_invoke alone could not act)")
    time.sleep(1.2)

    # Phase A: fly the cursor to the semantically-located region, corner then centre.
    x, y, w, h = region["rect"]
    glide(x + 40, y + 30); time.sleep(0.6)
    glide(*center(region["rect"])); time.sleep(0.9)

    # Phase B: act on the no-Action surface through the gesture floor — by meaning.
    print("uia_click(ctype='text') — semantics chose the target, a real click delivers it")
    osctl.uia_click(win, ctype="text"); time.sleep(1.0)

    # Phase C: type into it through the keyboard floor; read it back through meaning.
    osctl.mod_taps(osctl.VK_CONTROL, keys=(osctl.VK_A,)); time.sleep(0.3)
    msg = "两floor合一 — located by meaning, acted by gesture 道法自然"
    osctl.type_unicode(msg); time.sleep(1.2)
    back = osctl.uia_get_value(win, ctype="text")
    print(f"the toolkit's own text now reads (via uia_get_value): {back.strip()!r}")
    time.sleep(1.5)
    return 0


if __name__ == "__main__":
    sys.exit(main())
