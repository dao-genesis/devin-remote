"""SuperTux (SDL2/OpenGL) driven entirely by the agentctl floor.

SuperTux self-draws every pixel: AT-SPI exposes **0 elements**, so there is no
semantic channel at all — geometry *and* state are pixels only (F231 taken to its
limit). And because it samples key *state* per frame rather than latching on the
X event, a zero-duration ``tap`` is invisible to it (F232): every press here is a
held one, ``tap(vk, hold=...)`` / ``key_hold``.

Localising Tux defeats the easy channels (F233): colour keying fails (his
anti-aliased sprite has no dominant hue; red nodes and the brown path swamp any
warm key), and frame differencing fails because the **camera follows** him, so a
directional press scrolls the whole background and ``locate_change`` lights up the
entire viewport instead of the screen-centred avatar. The channel that works is
*appearance* — :func:`osctl.match_template` against a one-shot crop of the sprite —
once it is fast enough to track with (F233 made it ~6.5x faster by precomputing
source luma and early-abandoning). :func:`locate` does scoped template matching
around the last-known position; :func:`walk` still reports raw motion as a coarse
"did anything happen" signal.

This driver is the F232/F233 exerciser, not a game AI.
"""
import os
os.environ.setdefault('DBUS_SESSION_BUS_ADDRESS', 'unix:abstract=/tmp/dbus-JksQnYX22L')
import sys, time
sys.path.insert(0, '.')
import osctl

TITLE = 'SuperTux'


def window_id():
    for w in osctl.list_windows():
        if TITLE in (w.get('title') or ''):
            return w['id']
    return None


def window_box():
    """SuperTux window rect ``(x, y, w, h)`` in *screen* pixels via the floor's
    ``window_geometry`` (list_windows carries only id/title/desktop)."""
    wid = window_id()
    if wid is None:
        return None
    g = osctl.window_geometry(wid)
    return (g['x'], g['y'], g['w'], g['h']) if g else None


def focus():
    """Bring SuperTux to the front so the keyboard floor acts on it."""
    return osctl.focus_window(TITLE, settle=0.4)


def press(vk, hold=0.12, gap=0.3):
    """One *observed* discrete press for the frame-polled surface (F232).

    ``hold`` keeps the key down across at least one input tick so SuperTux samples
    it; ``gap`` lets the menu's repeat-debounce reset before the next press. A
    plain ``osctl.tap(vk)`` (hold=0) is silently dropped here — the friction this
    driver demonstrates."""
    osctl.tap(vk, hold=hold)
    time.sleep(gap)


def menu_down(n=1, **kw):
    for _ in range(n):
        press(osctl.VK_DOWN, **kw)


def menu_up(n=1, **kw):
    for _ in range(n):
        press(osctl.VK_UP, **kw)


def activate(settle=1.0):
    """Confirm the highlighted menu entry (held Return)."""
    osctl.tap(osctl.VK_RETURN, hold=0.13)
    time.sleep(settle)


def _capture_box(box):
    x, y, w, h = box
    W, H, rgb = osctl.capture_rgb(x, y, w, h)
    return W, H, rgb


def walk(vk, hold=0.18, settle=0.5, box=None):
    """Held directional press on the worldmap, localised by *motion*.

    Captures the window before and after the press and runs the floor's
    ``locate_change``; the moving region is Tux. Returns ``{moved, centroid,
    bbox, count}`` with the centroid in *screen* coordinates (region origin added
    back), or ``{moved: False}`` if nothing changed — the honest signal that the
    press did not register or Tux is blocked."""
    if box is None:
        box = window_box()
    if box is None:
        return {"moved": False, "reason": "no window"}
    ox, oy, w, h = box
    Wb, Hb, before = _capture_box(box)
    osctl.key_hold(vk, hold)
    time.sleep(settle)
    Wa, Ha, after = _capture_box(box)
    ch = osctl.locate_change(before, after, (Wb, Hb), tol=18, min_count=40)
    if not ch:
        return {"moved": False, "centroid": None, "count": 0}
    return {"moved": True,
            "centroid": (ox + ch["x"], oy + ch["y"]),
            "bbox": ch["bbox"], "count": ch["count"]}


def locate(template, pw, ph, last=None, pad=120, step=1, box=None):
    """Find Tux by *appearance* (F233): scoped :func:`osctl.match_template` of his
    sprite ``template`` (``pw``x``ph`` RGB), constrained to a ``pad``-pixel box
    around ``last`` (his last-known *screen* centre) so the slide stays cheap and
    real-time. Returns ``{x, y, score, bbox}`` in *screen* coordinates, or ``None``.

    This is the robust localiser where colour and frame-diff both fail — the
    camera-follow worldmap is exactly that surface."""
    if box is None:
        box = window_box()
    if box is None:
        return None
    x, y, w, h = box
    W, H, rgb = osctl.capture_rgb(x, y, w, h)
    search = None
    if last is not None:
        lx, ly = last[0] - x, last[1] - y          # screen -> window-local
        search = (lx - pad, ly - pad, lx + pad, ly + pad)
    m = osctl.match_template(template, pw, ph, rgb=rgb, size=(W, H),
                             search=search, step=step)
    if not m:
        return None
    return {"x": x + m["x"], "y": y + m["y"], "score": m["score"],
            "bbox": m["bbox"]}


def into_story():
    """Main menu -> Start Game -> Story Mode -> worldmap, all via held presses
    (taps don't register here — F232)."""
    focus()
    activate(settle=1.2)            # Start Game -> submenu (Story Mode highlighted)
    activate(settle=2.5)            # Story Mode  -> intro / worldmap


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'box'
    focus()
    if cmd == 'box':
        print('window box:', window_box())
    elif cmd == 'walk':
        vk = {'up': osctl.VK_UP, 'down': osctl.VK_DOWN,
              'left': osctl.VK_LEFT, 'right': osctl.VK_RIGHT}[sys.argv[2]]
        print('walk result:', walk(vk))
    elif cmd == 'tapfail':
        # F232 demo: a zero-hold tap moves nothing; a held one moves the menu.
        box = window_box()
        Wb, Hb, before = _capture_box(box)
        osctl.tap(osctl.VK_DOWN)            # hold=0 -> dropped
        time.sleep(0.4)
        Wa, Ha, after = _capture_box(box)
        ch = osctl.locate_change(before, after, (Wb, Hb), tol=18, min_count=40)
        print('tap(hold=0) change:', ch, '(None/tiny => press was dropped)')
