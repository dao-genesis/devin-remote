"""F179 — the union of the two floors.

F178 grew the semantic floor (AT-SPI): the agent can name and actuate controls
a toolkit wired for accessibility. But a toolkit only wires *some* controls: a
text region, a canvas, a custom widget expose geometry through AT-SPI yet no
Action — `uia_invoke` finds them and then has nothing to fire. The honest answer
is not a second blindness but a bridge: locate by MEANING, deliver by a real
CLICK on the rect the semantic tree handed us. Semantics choose *what*; the pixel
floor delivers the *where*. This probe reproduces that exact friction on KWrite's
editor region (role=text, no Action) and proves the bridge carries it.

Run with the a11y bus reachable:
    DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=... python3 _probe_atspi_click.py
"""
import sys
import time

sys.path.insert(0, ".")
import osctl


def _kwrite():
    for w in osctl.list_windows():
        if "kwrite" in (w.get("title") or "").lower():
            return w["id"]
    return None


def _inside(rect, pt):
    x, y, w, h = rect
    return x <= pt[0] <= x + w and y <= pt[1] <= y + h


def main():
    win = _kwrite()
    if not win:
        print("NO KWRITE WINDOW — open kwrite on a file first")
        return 1

    passes = []

    # The friction: the editor text region has geometry but no Action.
    region = osctl.uia_find(win, ctype="text")
    assert region and region.get("rect"), "uia_find could not locate the editor region"
    rect = region["rect"]
    print(f"[ctx] editor region located by MEANING (role=text) -> rect={rect}")

    # Park the cursor far from the region so any landing is unambiguous.
    osctl.move(rect[0] - 5 if rect[0] > 10 else 5, rect[1] - 5 if rect[1] > 10 else 5)
    time.sleep(0.2)
    start = osctl.cursor_pos()
    assert not _inside(rect, start), f"cursor not parked outside region: {start}"

    # PROOF 1: uia_invoke on a control with NO Action now succeeds — it falls
    # through to a real click on the rect that meaning located.
    ok = osctl.uia_invoke(win, ctype="text")
    time.sleep(0.3)
    landed = osctl.cursor_pos()
    assert ok, "uia_invoke returned False on the no-Action region"
    assert _inside(rect, landed), f"click did not land inside the region: {landed}"
    print(f"[PASS] uia_invoke falls through to a click on the no-Action region — "
          f"cursor {start} -> {landed} (inside rect)")
    passes.append("invoke-fallback")

    # PROOF 2: uia_click is the same bridge made explicit — click into the editor
    # by meaning, then the universal keyboard floor types and the TOOLKIT receives
    # it. Ground truth: read the content straight back out of the toolkit through
    # the semantic floor (uia_get_value on the same region).
    marker = "F179 union-of-floors 道法自然"
    assert osctl.uia_click(win, ctype="text"), "uia_click failed on the editor region"
    time.sleep(0.3)
    osctl.mod_taps(osctl.VK_CONTROL, keys=(osctl.VK_A,))   # select all
    time.sleep(0.1)
    osctl.type_unicode(marker)                              # replace via keyboard floor
    time.sleep(0.4)
    back = osctl.uia_get_value(win, ctype="text")
    assert marker in back, f"toolkit did not receive the typed text; region holds {back!r}"
    print(f"[PASS] uia_click placed the caret by meaning; keyboard floor typed; "
          f"the toolkit's own text reads back — {back.strip()!r}")
    passes.append("click+type round-trip")

    print(f"\n{len(passes)}/2 — the semantic floor and the gesture floor are one: "
          f"meaning chooses the target, pixels deliver the act.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
