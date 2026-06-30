"""Closed-loop GNOME Mahjongg driver built only on osctl floor primitives.

Mahjongg is the pure-vision, repeated-element case: AT-SPI exposes only the
shell, the board is pixels, and every tile face recurs many times. It exercises
the idiom end to end:
  * ``match_template_all`` groups identical tile faces (which pairs *could* match),
  * a before/after change oracle decides which tiles are actually *free*
    (clickable) -- tile content shares the selection-highlight colour, so
    free-ness must be read from change, not absolute hue,
  * select + click removes a free, same-face pair; the removal is confirmed by
    *both* faces vanishing (the ``Moves Left`` counter carries a running clock,
    so a string compare always looks changed, and the count is available-moves,
    not tiles -- neither is a reliable success signal).
"""
import os
os.environ.setdefault('DBUS_SESSION_BUS_ADDRESS', 'unix:abstract=/tmp/dbus-HCLx4cm0Ou')
import re
import sys
import time
sys.path.insert(0, '.')
import osctl

W = 1600
ROI = (470, 315, 1150, 880)
MOVES_REGION = (690, 272, 230, 24)


def moves_left() -> int | None:
    """Parse the *integer* after ``Moves Left:`` -- the title also carries a
    running clock, so a raw string compare would always look like it changed."""
    txt = osctl.ocr_text(MOVES_REGION, psm=7, scale=3)
    m = re.search(r"Left[:\s]*([0-9]+)", txt)
    return int(m.group(1)) if m else None


def _diff(a: bytes, b: bytes, bb) -> int:
    x0, y0, x1, y1 = bb
    n = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            j = (y * W + x) * 3
            if abs(a[j] - b[j]) + abs(a[j + 1] - b[j + 1]) + abs(a[j + 2] - b[j + 2]) > 60:
                n += 1
    return n


def is_free(cx: int, cy: int, deselect: bool = True) -> bool:
    """A tile is free iff clicking it makes the board change (selection border)."""
    bb = (cx - 24, cy - 30, cx + 24, cy + 30)
    _, _, r0 = osctl.capture_rgb()
    osctl.click(cx, cy)
    time.sleep(0.35)
    _, _, r1 = osctl.capture_rgb()
    changed = _diff(r0, r1, bb) > 250
    if changed and deselect:
        osctl.click(cx, cy)
        time.sleep(0.25)
    return changed


def free_tiles(centers) -> list:
    out = []
    for cx, cy in centers:
        if is_free(cx, cy):
            out.append((cx, cy))
    return out


ROWS = [360, 420, 485, 550, 613, 675, 743, 812]
COLS = list(range(478, 1010, 24))
CANDIDATES = [(x, y) for y in ROWS for x in COLS] + [(455, 585), (1090, 585)]


def _near(a, b, tol=22):
    return abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol


def find_removable_pair(free, rgb):
    """For each free seed, ``match_template_all`` its face over the board to find
    every identical copy (the slide self-aligns, so guessed centres needn't be
    exact), then keep the copies that are themselves free. First seed with two
    free copies is a removable pair. Comparing guessed-centre crops directly
    fails -- a few px of centre drift between two identical faces is enough SAD
    to miss the match -- which is exactly why alignment must come from the slide."""
    seen = []
    for s in free:
        if any(_near(s, x) for x in seen):
            continue
        patch, pw, ph = osctl.crop_rgb(rgb, (W, 1200),
                                       (s[0] - 19, s[1] - 24, s[0] + 18, s[1] + 23))
        hits = osctl.match_template_all(patch, pw, ph, rgb=rgb, size=(W, 1200),
                                        search=ROI, step=1, min_sep=(30, 28), limit=12)
        cents = [(h["x"], h["y"]) for h in hits]
        seen += cents
        if len(cents) < 2:
            continue
        frees = [c for c in cents if is_free(*c)]
        if len(frees) >= 2:
            return frees[:2]
    return None


def _bb(c):
    cx, cy = c
    return (cx - 20, cy - 26, cx + 20, cy + 26)


def remove_pair(a, b) -> bool:
    """Select ``a`` then click ``b``; a real removal makes *both* faces vanish.

    A non-matching click only moves the selection to ``b`` (``a`` returns to its
    resting face), so verifying by "both regions changed vs the resting board"
    distinguishes a true removal from a selection bounce -- the ``Moves Left``
    integer alone is unreliable since it counts available moves, not tiles."""
    _, _, r0 = osctl.capture_rgb()
    osctl.click(*a)
    time.sleep(0.4)
    osctl.click(*b)
    time.sleep(0.9)
    _, _, r1 = osctl.capture_rgb()
    return _diff(r0, r1, _bb(a)) > 250 and _diff(r0, r1, _bb(b)) > 250


def _deselect():
    osctl.click(1000, 318)
    time.sleep(0.2)


def auto_clear(max_removals=4, budget=2400):
    """Perceive -> classify -> probe-free -> remove -> verify, until no removable
    free pair remains, ``max_removals`` reached, or ``budget`` seconds elapse."""
    removed = 0
    t0 = time.time()
    for rnd in range(max_removals):
        if time.time() - t0 > budget:
            print("auto_clear: budget hit"); break
        _deselect()
        free = free_tiles(CANDIDATES)
        _deselect()
        _, _, rgb = osctl.capture_rgb()
        pair = find_removable_pair(free, rgb)
        if not pair:
            print("auto_clear: no removable free pair -> done"); break
        ok = remove_pair(*pair)
        if ok:
            removed += 1
        print("round %d pair %s removed=%s total=%d moves=%s t=%.0fs"
              % (rnd, pair, ok, removed, moves_left(), time.time() - t0))
        if not ok:
            print("auto_clear: selection bounce (no removal) -> stop"); break
    return removed


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    print("removed", auto_clear(max_removals=n))
