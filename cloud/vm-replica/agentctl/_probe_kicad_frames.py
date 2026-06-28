"""F182 probe — disambiguate one app's several AT-SPI frames by geometry.

Friction (found driving KiCad/eeschema on this VM): a wxWidgets/GTK app can own
two top-level accessibles at once — a main *frame* and a modal *alert* — under a
single process id. The floor maps an X window to its AT-SPI frame by pid, then
by an exact title match. But a dialog's window-manager title and its accessible
frame name routinely disagree: KiCad's create-file prompt is the X window
``"Confirmation"`` while the AT-SPI alert names itself ``"Question"``. The title
compare then misses and the floor falls back to the *main* frame, so every
``uia_*`` verb reads the wrong window (``uia_find('Yes')`` -> ``None``).

Primitive: when the title doesn't match, disambiguate by *screen geometry* — the
frame whose accessible extents best overlap the X window's rect is the one those
pixels belong to (``_iou`` + the ``>= 0.25`` gate in ``_atspi_frame_for``). This
probe pins the behaviour deterministically with the real rectangles measured on
this machine, so it needs no live KiCad to prove the choice is unambiguous.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _osbackend_x11 as be

ok = True

# --- _iou: the pixel-space "are these the same window" measure -------------- #
assert be._iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0          # identical
assert be._iou((0, 0, 10, 10), (100, 100, 10, 10)) == 0.0      # disjoint
assert be._iou(None, (0, 0, 1, 1)) == 0.0                      # missing extents
half = be._iou((0, 0, 10, 10), (5, 0, 10, 10))                 # 50% overlap in x
ok &= abs(half - (50 / 150)) < 1e-9
print("[iou] identical=1, disjoint=0, half-overlap=%.3f" % half)

# --- the real KiCad case, measured live on this VM -------------------------- #
# X window "Confirmation" geometry, and the two same-pid AT-SPI frames.
WIN = (474, 565, 652, 112)           # window_geometry of the dialog's X window
ALERT = (474, 536, 652, 141)         # AT-SPI alert  "Question"  (the dialog)
MAIN = (0, 0, 1600, 1156)            # AT-SPI frame  "[no schematic…]" (main)

iou_alert = be._iou(WIN, ALERT)
iou_main = be._iou(WIN, MAIN)
print("[kicad] IoU(win,alert)=%.3f  IoU(win,main)=%.3f" % (iou_alert, iou_main))

# The alert wins decisively, clears the gate, and the main frame is far below it
# — so _atspi_frame_for resolves "Confirmation" to the dialog, not the main win.
ok &= iou_alert >= 0.25            # passes the gate -> a real geometry match
ok &= iou_main < 0.25             # main frame rejected by the gate
ok &= iou_alert > iou_main * 5    # not a close call: unambiguous winner

chosen = "alert" if iou_alert >= iou_main and iou_alert >= 0.25 else "main/none"
ok &= chosen == "alert"
print("[kicad] chosen frame ->", chosen)

# --- honest fallback: no geometry signal -> first same-pid frame ------------ #
# When the X window exposes no geometry (wrect is None), the verb must not crash;
# _atspi_frame_for keeps the existing first-same-pid-frame fallback. We can't
# easily fake a live desktop here, so assert the gate's contract on a near-miss:
# a sliver overlap below the gate must NOT be accepted as a geometry match.
sliver = be._iou(WIN, (474, 690, 652, 30))    # barely touches the bottom edge
ok &= sliver < 0.25
print("[gate] sliver overlap=%.3f rejected (<0.25), fallback stays honest" % sliver)

print("PROBE", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
