"""SuperTux (SDL2/OpenGL) driven entirely by the agentctl floor.

SuperTux self-draws every pixel: AT-SPI exposes **0 elements**, so there is no
semantic channel at all — geometry *and* state are pixels only (F231 taken to its
limit). And because it samples key *state* per frame rather than latching on the
X event, a zero-duration ``tap`` is invisible to it (F232): every press here is a
held one, ``tap(vk, hold=...)`` / ``key_hold``.

This driver is the F232 exerciser, not a game AI: it walks the zero-AT-SPI menu
with held presses and tracks the Tux sprite on the worldmap by vision to confirm
a real-time perceive -> act loop on an OpenGL surface.
"""
import os
os.environ.setdefault('DBUS_SESSION_BUS_ADDRESS', 'unix:abstract=/tmp/dbus-JksQnYX22L')
import sys, time
sys.path.insert(0, '.')
import osctl

TITLE = 'SuperTux'
# Tux's beak/feet are a saturated orange that nothing else on the icy worldmap
# wears — the cleanest colour key for the sprite against snow/sea/brown paths.
TUX_ORANGE = (235, 150, 30)


def focus():
    """Bring SuperTux to the front so the keyboard floor acts on it."""
    return osctl.focus_window(TITLE, settle=0.4)


def press(vk, hold=0.12, gap=0.3):
    """One *observed* discrete press for the frame-polled surface (F232).

    ``hold`` keeps the key down across at least one input tick so SuperTux samples
    it; ``gap`` then lets the menu's repeat-debounce reset before the next press.
    A plain ``osctl.tap(vk)`` (hold=0) is silently dropped here — that is the
    whole friction this driver demonstrates."""
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


def window_box():
    """Return the SuperTux window rect ``(x, y, w, h)`` for region-scoped vision."""
    for w in osctl.list_windows():
        if TITLE in (w.get('title') or '') and w.get('rect'):
            return w['rect']
    return None


def find_tux(region=None):
    """Locate Tux by his orange beak/feet; returns ``(x, y)`` centroid or None.

    ``region`` (x,y,w,h) scopes the scan to the game window so worldmap chrome
    elsewhere on the desktop can't be mistaken for the sprite."""
    if region is None:
        region = window_box()
    if region:
        x, y, w, h = region
        W, H, rgb = osctl.capture_rgb(x, y, w, h)
        hit = osctl.find_color(TUX_ORANGE, tol=40, rgb=rgb, size=(W, H))
        if hit:
            return (x + hit['x'], y + hit['y'])
        return None
    hit = osctl.find_color(TUX_ORANGE, tol=40)
    return (hit['x'], hit['y']) if hit else None


def walk(vk, hold=0.15):
    """Held directional press on the worldmap; returns Tux's (dx, dy) displacement
    as measured by vision — the closed real-time loop on a self-drawn surface."""
    before = find_tux()
    osctl.key_hold(vk, hold)
    time.sleep(0.6)
    after = find_tux()
    if not before or not after:
        return None
    return (after[0] - before[0], after[1] - before[1], before, after)


def into_story():
    """From the main menu: Start Game -> Story Mode -> (worldmap). All via held
    presses, since taps don't register (F232)."""
    focus()
    # main menu top entry is "Start Game"
    activate(settle=1.2)            # Start Game -> submenu (Story Mode highlighted)
    activate(settle=2.5)            # Story Mode  -> intro / worldmap


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'tux'
    focus()
    if cmd == 'tux':
        print('window:', window_box())
        print('tux at:', find_tux())
    elif cmd == 'walk':
        vk = {'up': osctl.VK_UP, 'down': osctl.VK_DOWN,
              'left': osctl.VK_LEFT, 'right': osctl.VK_RIGHT}[sys.argv[2]]
        print('displacement:', walk(vk))
    elif cmd == 'tapfail':
        # F232 demo: a zero-hold tap moves nothing; a held one moves the menu.
        osctl.tap(osctl.VK_DOWN)            # hold=0 -> dropped
        print('sent tap(hold=0) — menu should be UNMOVED')
