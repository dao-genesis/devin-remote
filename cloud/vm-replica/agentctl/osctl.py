"""agentctl.osctl — OS-level input, clipboard and screen capture.

CDP can only reach what lives *inside* a page.  Real GUIs leak outside the DOM:
the omnibox, Chrome's own "Leave site?" / basic-auth / file-chooser dialogs,
other windows entirely (F005).  ``osctl`` is the escape hatch — it drives the
machine through trusted synthetic input, the clipboard, and a screen grab — so
the agent keeps operating where the browser channel goes blind.

The standout primitive is **atomic paste into the omnibox**: per-character typing
into Chrome's address bar loses keystrokes to history autocomplete (F003).  The
robust path is clipboard + Ctrl+V — one trusted event, nothing to race.

The OS floor is the one platform-specific layer, so it is delegated to a backend
chosen at import (F141): Win32 ``SendInput``/GDI on Windows, X11 + XTEST on Linux
(``_osbackend_win`` / ``_osbackend_x11``). Everything below this header — the
gesture vocabulary and the whole perception side — is platform-agnostic and built
only on the backend's leaf primitives. No third-party deps on either ground: the
PNG encoder is hand-rolled with ``zlib`` so a screenshot is always available.
"""

from __future__ import annotations

import struct
import sys
import time
import zlib

if sys.platform.startswith("win"):
    import _osbackend_win as _be
elif sys.platform.startswith("linux"):
    import _osbackend_x11 as _be
else:  # pragma: no cover - no OS backend for this ground yet
    raise ImportError(f"osctl: no OS backend for platform {sys.platform!r}")

# Leaf primitives supplied by the platform backend. Every gesture and reader
# below is written once, against these names only — never the raw OS calls.
screen_size = _be.screen_size
move = _be.move
key_down = _be.key_down
key_up = _be.key_up
set_clipboard = _be.set_clipboard
get_clipboard = _be.get_clipboard
_mouse_button = _be.mouse_button
_mouse_wheel = _be.mouse_wheel

# ---- pointer position (read side) ----------------------------------------- #
def cursor_pos() -> "tuple[int, int]":
    """Read where the pointer actually is, in screen pixels (F138).

    The whole pointer family *writes* position — :func:`move`, :func:`drag`,
    :func:`glide`, every click that takes ``(x, y)`` — but nothing ever *read* it
    back. That asymmetry bites in three real ways. (1) ``move`` sends *absolute*
    coordinates rescaled to the 0–65535 virtual-desktop range; on a DPI-scaled or
    multi-monitor desktop the landing pixel can differ from what was asked, and
    there was no way to confirm where the cursor truly came to rest. (2) A
    relative nudge — "5px right of wherever I am" for a slider or resize handle —
    is impossible without first knowing the current point. (3) Polite flows that
    move the cursor aside and then restore it had nothing to restore *to*. This
    reads the pointer's current position and returns ``(x, y)`` — the read-side
    dual of :func:`move`, closing the loop the pointer family left open."""
    return _be.cursor_pos()


# ---- mouse gestures (platform-agnostic, built on the backend leaves) ------- #


def click(x: int | None = None, y: int | None = None, right: bool = False) -> None:
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    button = "right" if right else "left"
    _mouse_button(button, True)
    _mouse_button(button, False)


def double_click(x: int | None = None, y: int | None = None,
                 right: bool = False, gap: float = 0.05) -> None:
    """Two presses at one point within the double-click window (F122).

    :func:`click` fires a single click; a control bound to ``dblclick`` — a
    row that opens only on double-click, double-click-to-select-a-word, a
    handle that resets on double-tap — never answers it. This presses twice
    in quick succession at the *same* point so the window pairs them into a
    ``dblclick``. ``gap`` must stay under the system double-click threshold
    (default ~500 ms); a slower pair reads as two unrelated single clicks,
    which is exactly the friction this steps over."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    click(right=right)
    time.sleep(gap)
    click(right=right)


def press_hold(x: int | None = None, y: int | None = None,
               duration: float = 0.8, right: bool = False) -> None:
    """Press a point and hold it still for ``duration``, then release (F126).

    :func:`click` is instant — down and up in the same breath — and :func:`drag`
    holds but *moves*. Neither can satisfy a control that answers only a
    *sustained, stationary* press: a hold-to-confirm button, an autorepeat
    stepper, a long-press that arms a timer. This presses the button down, waits
    ``duration`` without moving, then releases — so a timer started on
    ``mousedown`` is allowed to fire before ``mouseup`` cancels it, which a
    click never permits."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    button = "right" if right else "left"
    _mouse_button(button, True)
    time.sleep(duration)
    _mouse_button(button, False)


def triple_click(x: int | None = None, y: int | None = None,
                 gap: float = 0.05) -> None:
    """Three presses at one point — select a whole line/paragraph (F125).

    The click-multiplicity ladder: one click places the caret, two
    (:func:`double_click`) select the word under it, three select the whole
    line or paragraph. A double-click can never reach the third rung — to
    grab a full line for replacement you need the triple. This presses three
    times at the same point, each ``gap`` apart and all inside the OS
    double-click window, so the page counts up to ``detail===3``."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    click()
    time.sleep(gap)
    click()
    time.sleep(gap)
    click()


def middle_click(x: int | None = None, y: int | None = None) -> None:
    """Press the middle (wheel) button at a point (F123).

    :func:`click` only encodes left and right; the channel had no third
    button at all. Middle-click is its own verb on the web — ``button===1``,
    the ``auxclick`` event, open-link-in-a-new-background-tab, paste-on-X11,
    autoscroll. A left or right click can never stand in for it. This sends
    one ``MIDDLEDOWN``/``MIDDLEUP`` pair so the page sees a true aux click."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    _mouse_button("middle", True)
    _mouse_button("middle", False)


def mod_click(x: int | None = None, y: int | None = None,
              *mods: int, right: bool = False) -> None:
    """Click with modifier keys held down through the press (F124).

    A plain :func:`click` *replaces* a selection — click item B and item A
    lets go. To extend a selection (Ctrl-click adds one, Shift-click takes a
    range) the modifier must be held *while* the mouse goes down, so the page
    reads ``e.ctrlKey`` / ``e.shiftKey`` on the click. The channel could press
    keys and could click, but never one inside the other; this holds each
    ``mods`` VK down, clicks, then releases them in reverse — the modifier is
    down across the whole button cycle, not merely before or after it."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    for vk in mods:
        key_down(vk)
    time.sleep(0.01)
    click(right=right)
    for vk in reversed(mods):
        key_up(vk)


def drag(x0: int, y0: int, x1: int, y1: int,
         steps: int = 24, pause: float = 0.01,
         hold: float = 0.05, right: bool = False) -> None:
    """Press at (x0,y0), glide to (x1,y1) in steps, release (F121).

    :func:`click` only presses a point; a slider thumb, a canvas stroke, a
    text selection, a list reorder all need a *held* move. This is that
    stroke: button down at the start, many small moves along the line,
    button up at the end. ``steps`` makes the motion continuous so
    drag-aware listeners (``mousemove`` while the button is held) see the
    path, not just the endpoints — a single jump from start to end reads
    as a teleport and most drag handlers ignore it."""
    button = "right" if right else "left"
    move(x0, y0)
    time.sleep(0.02)
    _mouse_button(button, True)
    time.sleep(hold)
    n = max(1, steps)
    for i in range(1, n + 1):
        mx = round(x0 + (x1 - x0) * i / n)
        my = round(y0 + (y1 - y0) * i / n)
        move(mx, my)
        time.sleep(pause)
    time.sleep(hold)
    _mouse_button(button, False)


def mod_drag(x0: int, y0: int, x1: int, y1: int, *mods: int,
             steps: int = 24, pause: float = 0.01,
             hold: float = 0.05, right: bool = False) -> None:
    """Drag with modifier keys held down through the whole stroke (F129).

    A plain :func:`drag` moves a handle freely. But a held modifier changes what
    the drag *means*: Shift constrains it to an axis (a straight horizontal or
    vertical move), Ctrl/Alt turns a move into a copy, a modifier-drag extends a
    selection. The handler reads ``e.shiftKey`` / ``e.ctrlKey`` on every
    ``mousemove`` of the stroke, so the modifier must be down across the entire
    drag — not merely tapped before it. This holds each ``mods`` VK down, runs
    the same stroke as :func:`drag`, then releases them in reverse. It is to
    ``drag`` what :func:`mod_click` is to ``click`` and :func:`mod_scroll`
    is to ``scroll`` — the third member of the modifier-held family."""
    for vk in mods:
        key_down(vk)
    time.sleep(0.01)
    drag(x0, y0, x1, y1, steps=steps, pause=pause, hold=hold, right=right)
    for vk in reversed(mods):
        key_up(vk)


def glide(x0: int, y0: int, x1: int, y1: int,
          steps: int = 24, pause: float = 0.01) -> None:
    """Move the cursor along a path with NO button held (F130).

    :func:`move` jumps the cursor straight to a point — one ``mousemove`` at the
    destination, nothing in between — and :func:`drag` glides but with a button
    *down*. Neither can trace a button-less path. Yet much of a GUI answers only
    to the cursor's *journey*, not its arrival: a hover trail, a parallax that
    tracks the pointer, a slider that scrubs on bare ``mousemove``, and above all
    a nested menu that keeps its submenu open only while the cursor crosses from
    parent into child — teleport onto the child and the parent's hover lapses, so
    the submenu never opens. This glides from ``(x0,y0)`` to ``(x1,y1)`` in many
    small steps with no button, so every element along the line sees the cursor
    pass through. It is :func:`drag` without the press — the hover twin of the
    held stroke."""
    move(x0, y0)
    time.sleep(pause)
    n = max(1, steps)
    for i in range(1, n + 1):
        mx = round(x0 + (x1 - x0) * i / n)
        my = round(y0 + (y1 - y0) * i / n)
        move(mx, my)
        time.sleep(pause)


def mod_taps(*mods: int, keys: "tuple[int, ...] | list[int]" = (),
             pause: float = 0.03) -> None:
    """Hold modifier keys down across a whole *sequence* of taps (F131).

    :func:`chord` presses a modifier with one key and releases both in the same
    breath — perfect for a single combo. But some input is a *run* under one
    sustained modifier: Shift held while several Arrow taps extend a selection
    one cell at a time, Alt held across a digit sequence to compose a code, a
    modifier held while several keys are struck and the result committed only on
    the modifier's *keyup*. A loop of :func:`chord` releases the modifier between
    every key, so each keystroke looks like its own combo and the run never
    coheres. This holds each ``mods`` VK down, taps every key in ``keys`` in
    order with the modifier still down, then releases the modifiers in reverse —
    one continuous hold across the sequence. It is to :func:`chord` what a held
    stroke is to a single press."""
    for vk in mods:
        key_down(vk)
    time.sleep(0.01)
    for k in keys:
        tap(k)
        time.sleep(pause)
    for vk in reversed(mods):
        key_up(vk)


def scroll(dy: int = 0, dx: int = 0,
           x: int | None = None, y: int | None = None,
           pause: float = 0.01) -> None:
    """Mouse-wheel scroll, one notch at a time (F119).

    The agent could move and click anywhere it could *see*, but it could only ever
    see one screenful: :func:`capture_rgb` is the viewport, and every reader and
    locator searches within it. Content past the fold — the rest of a page, a list
    below the window, a result that renders lower than the screen is tall — simply
    was not in the pixels, so :func:`locate_phrase` returned ``None`` for text that
    exists but is scrolled away, and nothing in the toolkit could bring it into
    view. Sight was bounded by the window frame.

    This is the wheel. ``dy`` notches scroll vertically — ``dy < 0`` rolls the
    wheel toward the user (the page moves *up*, revealing content *below*), ``dy >
    0`` rolls away (revealing content *above*) — and ``dx`` scrolls horizontally
    the same way; each notch is one ``WHEEL_DELTA`` event, sent over ``(x, y)`` when
    given so the wheel lands on the element under the cursor (a scroll pane, not
    just the page). After scrolling, a fresh :func:`capture_rgb` shows what rolled
    into the frame, and the readers and locators work on it unchanged — the window
    can now be moved across a surface larger than itself."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)

    def wheel(notches: int, horizontal: bool) -> None:
        step = 1 if notches > 0 else -1
        for _ in range(abs(notches)):
            _mouse_wheel(step, horizontal)
            time.sleep(pause)

    if dy:
        wheel(dy, False)
    if dx:
        wheel(dx, True)


def mod_scroll(dy: int = 0, dx: int = 0, *mods: int,
               x: int | None = None, y: int | None = None,
               pause: float = 0.01) -> None:
    """Scroll the wheel with modifier keys held down through it (F128).

    A plain :func:`scroll` always *scrolls* — the page (or a pane) moves. But the
    same wheel under a held modifier means something else entirely: Ctrl+wheel
    *zooms* a browser, a map, an image viewer, an editor's font; Shift+wheel
    scrolls sideways. The page reads ``e.ctrlKey`` / ``e.shiftKey`` on each
    ``wheel`` event, so the modifier must be down *while* the notch fires —
    pressing Ctrl before and releasing after is not enough if the wheel lands in
    between with no key held. This holds each ``mods`` VK down, scrolls (the same
    wheel as :func:`scroll`, reusing its ``x``/``y`` placement), then releases
    them in reverse, so every notch carries the modifier. It is to ``scroll``
    what :func:`mod_click` is to ``click``."""
    for vk in mods:
        key_down(vk)
    time.sleep(0.01)
    scroll(dy=dy, dx=dx, x=x, y=y, pause=pause)
    for vk in reversed(mods):
        key_up(vk)


# ---- keyboard ------------------------------------------------------------- #
def tap(vk: int) -> None:
    key_down(vk)
    key_up(vk)


def chord(*vks: int) -> None:
    """Press keys in order, release in reverse (e.g. Ctrl+L, Ctrl+V)."""
    for vk in vks:
        key_down(vk)
    for vk in reversed(vks):
        key_up(vk)


def key_hold(vk: int, duration: float = 0.8) -> None:
    """Hold a key down for ``duration``, then release (F127).

    :func:`tap` presses and releases in the same breath — the key is down for
    essentially zero time. But many controls integrate over *how long* a key is
    held: a game that advances a character each frame while a direction key is
    down, a hold-to-charge action, a held modifier kept down across other
    events. For those, an instant ``tap`` accrues nothing. This holds the key
    down for ``duration`` so the time-in-state is real. It is the keyboard twin
    of :func:`press_hold`."""
    key_down(vk)
    time.sleep(duration)
    key_up(vk)


def type_unicode(text: str) -> None:
    """Inject text as trusted Unicode key events (bypasses the keyboard layout)."""
    return _be.type_unicode(text)


# Common virtual-key codes.
VK_RETURN, VK_TAB, VK_ESCAPE, VK_CONTROL, VK_MENU, VK_SHIFT = 0x0D, 0x09, 0x1B, 0x11, 0x12, 0x10
VK_L, VK_V, VK_A, VK_C = 0x4C, 0x56, 0x41, 0x43
VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN = 0x25, 0x26, 0x27, 0x28


# ---- clipboard (set_clipboard / get_clipboard come from the backend) ------- #
def paste_text(text: str) -> None:
    """F003: atomic paste — set clipboard, then Ctrl+V (one trusted event)."""
    set_clipboard(text)
    time.sleep(0.03)
    chord(VK_CONTROL, VK_V)


def omnibox_go(url: str) -> None:
    """Focus Chrome's address bar (Ctrl+L), atomic-paste a URL, Enter."""
    chord(VK_CONTROL, VK_L)
    time.sleep(0.05)
    paste_text(url)
    time.sleep(0.05)
    tap(VK_RETURN)


# ---- hand-rolled PNG encoder (stdlib only) -------------------------------- #
def _png(width: int, height: int, rgb: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)  # filter type 0
        raw += rgb[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))


def capture_rgb() -> "tuple[int, int, bytes]":
    """Grab the whole desktop into memory as ``(w, h, rgb)`` (3 bytes/pixel,
    row-major, top-down) — the raw pixel channel the agent sees.

    The dimensions match ``screen_size()`` (the same space ``click`` normalises
    against), so a pixel located here is directly clickable. The grab itself is
    the backend's job (GDI ``BitBlt`` on Windows, ``XGetImage`` on Linux); both
    return this identical byte layout, so the perception side never sees the
    difference."""
    return _be.capture_rgb()


def screenshot(path: str) -> str:
    """Capture the whole virtual desktop to a PNG via GDI BitBlt."""
    w, h, rgb = capture_rgb()
    with open(path, "wb") as f:
        f.write(_png(w, h, rgb))
    return path


def find_color(target: tuple[int, int, int], tol: int = 24,
               rgb: bytes | None = None, size: tuple[int, int] | None = None
               ) -> dict | None:
    """Locate a colour on the desktop purely by pixels (no DOM).

    Scans for pixels within ``tol`` (per-channel) of ``target`` and returns the
    centroid ``{x, y, count, bbox}`` in *screen* coordinates — exactly what
    ``osctl.click`` consumes — or ``None`` if the colour is absent. Pass an
    existing ``rgb``/``size`` to reuse one capture for several lookups."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    tr, tg, tb = target
    sx = sy = n = 0
    minx = miny = 1 << 30
    maxx = maxy = -1
    stride = w * 3
    for y in range(h):
        row = y * stride
        for x in range(w):
            i = row + x * 3
            if (abs(rgb[i] - tr) <= tol and abs(rgb[i + 1] - tg) <= tol
                    and abs(rgb[i + 2] - tb) <= tol):
                sx += x
                sy += y
                n += 1
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    if n == 0:
        return None
    return {"x": sx // n, "y": sy // n, "count": n,
            "bbox": (minx, miny, maxx, maxy)}


def find_color_blobs(target: tuple[int, int, int], tol: int = 24,
                     rgb: bytes | None = None,
                     size: tuple[int, int] | None = None,
                     min_count: int = 1) -> list[dict]:
    """Segment a colour into its *separate* regions (F052).

    ``find_color`` collapses every matching pixel into one centroid — fine for a
    lone target, but when the same colour appears twice the mean lands in the
    empty gap *between* them and clicks nothing. This labels matching pixels into
    connected components (4-connectivity, union-find over only the matched
    pixels, so cost scales with the colour's area, not the screen) and returns
    one ``{x, y, count, bbox}`` per region in *screen* coordinates, sorted by
    pixel count (largest first). Pick by size or position; each centroid is a
    real, clickable target. Regions smaller than ``min_count`` are dropped."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    tr, tg, tb = target
    stride = w * 3
    parent: dict[int, int] = {}

    def find(a: int) -> int:
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:  # path compression
            parent[a], a = root, parent[a]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for y in range(h):
        row = y * stride
        base = y * w
        up_base = base - w
        for x in range(w):
            i = row + x * 3
            if (abs(rgb[i] - tr) <= tol and abs(rgb[i + 1] - tg) <= tol
                    and abs(rgb[i + 2] - tb) <= tol):
                key = base + x
                parent[key] = key
                if x > 0 and (key - 1) in parent:
                    union(key - 1, key)
                if y > 0 and (up_base + x) in parent:
                    union(up_base + x, key)

    agg: dict[int, dict] = {}
    for key in parent:
        root = find(key)
        x, y = key % w, key // w
        a = agg.get(root)
        if a is None:
            agg[root] = {"sx": x, "sy": y, "count": 1,
                         "minx": x, "miny": y, "maxx": x, "maxy": y}
        else:
            a["sx"] += x
            a["sy"] += y
            a["count"] += 1
            if x < a["minx"]:
                a["minx"] = x
            if x > a["maxx"]:
                a["maxx"] = x
            if y < a["miny"]:
                a["miny"] = y
            if y > a["maxy"]:
                a["maxy"] = y

    blobs = [{"x": a["sx"] // a["count"], "y": a["sy"] // a["count"],
              "count": a["count"],
              "bbox": (a["minx"], a["miny"], a["maxx"], a["maxy"])}
             for a in agg.values() if a["count"] >= min_count]
    blobs.sort(key=lambda b: b["count"], reverse=True)
    return blobs


def crop_rgb(rgb: bytes, size: tuple[int, int], bbox: tuple[int, int, int, int]
             ) -> tuple[bytes, int, int]:
    """Cut a ``(patch, pw, ph)`` sub-image out of a capture.

    Turns *what the agent saw there* (e.g. a ``find_color`` bbox) into a
    reusable reference patch for ``match_template`` — the bridge between seeing
    a thing once and recognising it elsewhere. ``bbox`` is inclusive
    ``(minx, miny, maxx, maxy)`` in the capture's coordinate space."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    pw, ph = x1 - x0 + 1, y1 - y0 + 1
    stride = w * 3
    out = bytearray(pw * ph * 3)
    for py in range(ph):
        src = (y0 + py) * stride + x0 * 3
        dst = py * pw * 3
        out[dst:dst + pw * 3] = rgb[src:src + pw * 3]
    return bytes(out), pw, ph


def wait_until_stable(bbox: tuple[int, int, int, int], settle: int = 3,
                      interval: float = 0.08, timeout: float = 6.0
                      ) -> dict:
    """Wait until a screen region stops changing, by pixels (F132).

    ``wait_for_phrase`` waits for *text* to appear, but much of a GUI moves
    without ever spelling anything: a panel slides in, a spinner turns, a list
    reflows, a fade settles. Act mid-transition and the target is still in
    flight — the click lands where the thing *was*, not where it comes to rest.
    Nothing in the pixel channel waited for *motion to end*. This re-captures the
    ``bbox`` region every ``interval`` and compares it byte-for-byte to the last
    capture; once ``settle`` consecutive captures are identical, the region is
    judged at rest. Returns ``{stable, changes, captures, elapsed}`` — ``stable``
    is whether it settled before ``timeout``, ``changes`` how many times the
    region differed (proof it really was moving), so the caller can both wait and
    confirm something happened. The visual twin of ``wait_for_phrase``: one waits
    for a word, the other for stillness."""
    deadline = time.time() + timeout
    start = time.time()
    prev: bytes | None = None
    stable = changes = captures = 0
    while time.time() < deadline:
        w, h, rgb = capture_rgb()
        patch, _pw, _ph = crop_rgb(rgb, (w, h), bbox)
        captures += 1
        if prev is not None and patch == prev:
            stable += 1
            if stable >= settle:
                return {"stable": True, "changes": changes,
                        "captures": captures, "elapsed": time.time() - start}
        else:
            if prev is not None:
                changes += 1
            stable = 0
        prev = patch
        time.sleep(interval)
    return {"stable": False, "changes": changes,
            "captures": captures, "elapsed": time.time() - start}


def sample_color(bbox: tuple[int, int, int, int], rgb: bytes | None = None,
                 size: tuple[int, int] | None = None) -> dict:
    """Read the mean colour of a screen region — the inverse of find_color (F137).

    :func:`find_color` answers *where is this known colour?*; it forces you to
    name a colour up front. But often the colour is the very unknown: a status
    dot is green or red, a toggle's fill tells its state — and you cannot search
    for the answer you are trying to read. To guess and ``find_color`` each
    candidate is backwards. This crops ``bbox`` and averages it, returning
    ``{r, g, b, count}`` — the colour that is actually *there*, which the caller
    can then classify or compare. The dual of `find_color`: one maps colour→place,
    this maps place→colour. Pass an existing ``rgb``/``size`` to reuse a capture."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    patch, pw, ph = crop_rgb(rgb, (w, h), bbox)
    n = pw * ph
    if n == 0:
        raise ValueError("empty bbox")
    sr = sg = sb = 0
    for i in range(0, len(patch), 3):
        sr += patch[i]
        sg += patch[i + 1]
        sb += patch[i + 2]
    return {"r": sr // n, "g": sg // n, "b": sb // n, "count": n}


def locate_change(before: bytes, after: bytes, size: tuple[int, int],
                  tol: int = 12, min_count: int = 30) -> dict | None:
    """Find *where* the screen changed between two captures (F135).

    ``find_color`` needs the colour, ``locate_phrase`` needs the words — both
    require knowing the target in advance. But after an action the thing that
    appears is often unknown in both: a toast slides in at an unpredictable
    corner, a badge lights up somewhere on a toolbar, a newly-selected row
    highlights. You don't know its colour or text, only that *something* arrived.
    This diffs ``before`` against ``after`` pixel-by-pixel (per-channel ``tol``,
    so it ignores render noise the way :func:`region_diff` does) and returns the
    centroid and bounding box of the changed pixels — ``{x, y, count, bbox}`` in
    *screen* coordinates, exactly what :func:`click` consumes — or ``None`` if
    nothing changed past ``min_count`` pixels. It closes the loop the read stack
    left open: act, see *where* the world answered, then act there — without ever
    naming the target. The localiser to :func:`region_diff`'s counter."""
    w, h = size
    if len(before) != len(after):
        raise ValueError("captures differ in size")
    sx = sy = n = 0
    minx = miny = 1 << 30
    maxx = maxy = -1
    stride = w * 3
    for y in range(h):
        row = y * stride
        for x in range(w):
            i = row + x * 3
            if (abs(before[i] - after[i]) > tol
                    or abs(before[i + 1] - after[i + 1]) > tol
                    or abs(before[i + 2] - after[i + 2]) > tol):
                sx += x
                sy += y
                n += 1
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    if n < min_count:
        return None
    return {"x": sx // n, "y": sy // n, "count": n,
            "bbox": (minx, miny, maxx, maxy)}


def locate_change_blobs(before: bytes, after: bytes, size: tuple[int, int],
                        tol: int = 12, min_count: int = 30) -> list[dict]:
    """Segment screen change into its *separate* regions (F136).

    :func:`locate_change` collapses every changed pixel into one centroid — fine
    when a single thing arrives, but when two unrelated things change at once (a
    toast in one corner, a badge in another) the mean lands in the empty gap
    between them and clicks nothing. This is to :func:`locate_change` what
    :func:`find_color_blobs` is to :func:`find_color`: it labels the changed
    pixels into connected components (4-connectivity, union-find over only the
    changed pixels, so cost scales with the change's area, not the screen) and
    returns one ``{x, y, count, bbox}`` per region in *screen* coordinates,
    sorted by pixel count (largest first). Each centroid is a real, clickable
    target; regions smaller than ``min_count`` are dropped. The same friction
    (F052) once met on a static colour, now met on change itself."""
    w, h = size
    if len(before) != len(after):
        raise ValueError("captures differ in size")
    stride = w * 3
    parent: dict[int, int] = {}

    def find(a: int) -> int:
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:  # path compression
            parent[a], a = root, parent[a]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for y in range(h):
        row = y * stride
        base = y * w
        up_base = base - w
        for x in range(w):
            i = row + x * 3
            if (abs(before[i] - after[i]) > tol
                    or abs(before[i + 1] - after[i + 1]) > tol
                    or abs(before[i + 2] - after[i + 2]) > tol):
                key = base + x
                parent[key] = key
                if x > 0 and (key - 1) in parent:
                    union(key - 1, key)
                if y > 0 and (up_base + x) in parent:
                    union(up_base + x, key)

    agg: dict[int, dict] = {}
    for key in parent:
        root = find(key)
        x, y = key % w, key // w
        a = agg.get(root)
        if a is None:
            agg[root] = {"sx": x, "sy": y, "count": 1,
                         "minx": x, "miny": y, "maxx": x, "maxy": y}
        else:
            a["sx"] += x
            a["sy"] += y
            a["count"] += 1
            if x < a["minx"]:
                a["minx"] = x
            if x > a["maxx"]:
                a["maxx"] = x
            if y < a["miny"]:
                a["miny"] = y
            if y > a["maxy"]:
                a["maxy"] = y

    blobs = [{"x": a["sx"] // a["count"], "y": a["sy"] // a["count"],
              "count": a["count"],
              "bbox": (a["minx"], a["miny"], a["maxx"], a["maxy"])}
             for a in agg.values() if a["count"] >= min_count]
    blobs.sort(key=lambda b: b["count"], reverse=True)
    return blobs


def region_diff(a: bytes, b: bytes, tol: int = 0) -> dict:
    """Count how many pixels two equal-size RGB patches differ by (F134).

    ``wait_until_stable`` and ``wait_for_change`` judge sameness by exact
    byte-equality — and that is brittle. A real desktop jitters at the bottom
    bit: subpixel text rendering, a one-level antialiasing wobble, a gradient's
    dithering. A shift of ``+2`` per channel is invisible to the eye yet makes an
    exact compare report *every* pixel as changed, so "did it change?" fires on
    noise and "has it settled?" never settles. This compares ``a`` and ``b``
    pixel-by-pixel and counts those whose per-channel difference exceeds ``tol``,
    returning ``{pixels, total, frac}``. With ``tol=0`` it is the exact compare;
    raise ``tol`` to look past sensor/render noise and see only real change. It
    is the measured form of equality the two waits assumed — the foundation a
    robust change/settle test stands on."""
    if len(a) != len(b):
        raise ValueError("patches differ in size")
    n = 0
    for i in range(0, len(a), 3):
        if (abs(a[i] - b[i]) > tol or abs(a[i + 1] - b[i + 1]) > tol
                or abs(a[i + 2] - b[i + 2]) > tol):
            n += 1
    total = len(a) // 3
    return {"pixels": n, "total": total,
            "frac": (n / total if total else 0.0)}


def wait_for_change(bbox: tuple[int, int, int, int],
                    baseline: bytes | None = None,
                    interval: float = 0.05, timeout: float = 5.0
                    ) -> dict:
    """Wait until a screen region *first differs* from a baseline (F133).

    ``wait_until_stable`` waits for motion to *end*; ``wait_for_phrase`` waits for
    a *known word*. But the most common post-action wait is neither: after a
    click you often need to know merely that *something happened* — a button lit
    up, a badge appeared, a spinner began, a row got selected — without knowing
    the eventual text or colour, and before any of it has settled. Reading
    immediately races the change and sees the old frame, so the agent concludes
    nothing happened and acts twice. This captures (or accepts) a ``baseline``
    snapshot of the region, then re-captures every ``interval`` until a capture
    differs from it. Returns ``{changed, captures, elapsed}`` — ``changed`` is
    whether the onset arrived before ``timeout``. The idiom is
    ``baseline = crop; act(); wait_for_change(bbox, baseline)`` then optionally
    ``wait_until_stable``: catch the change beginning, then its coming to rest.
    The onset twin of ``wait_until_stable``'s cessation."""
    start = time.time()
    if baseline is None:
        w, h, rgb = capture_rgb()
        baseline, _pw, _ph = crop_rgb(rgb, (w, h), bbox)
    deadline = start + timeout
    captures = 0
    while time.time() < deadline:
        w, h, rgb = capture_rgb()
        patch, _pw, _ph = crop_rgb(rgb, (w, h), bbox)
        captures += 1
        if patch != baseline:
            return {"changed": True, "captures": captures,
                    "elapsed": time.time() - start}
        time.sleep(interval)
    return {"changed": False, "captures": captures,
            "elapsed": time.time() - start}


def wait_for_color(target: tuple[int, int, int], tol: int = 24,
                   min_count: int = 30, interval: float = 0.05,
                   timeout: float = 5.0) -> dict | None:
    """Wait until a *specific* colour appears on screen (F139).

    ``wait_for_change`` waits for *any* difference, and that is exactly its
    weakness as a done-signal: a click usually starts a spinner, a skeleton
    shimmer, a progress bar — motion that is *not* the outcome — so the first
    change fires on the busy state and the agent proceeds as if finished. The
    real signal is often a particular colour arriving: a status dot going green,
    an error turning a field red, a toggle filling in. You cannot wait for that
    with ``wait_for_change`` (the spinner trips it first) nor with a bare
    ``find_color`` (it races the change and sees the old frame). This polls
    :func:`find_color` every ``interval`` until at least ``min_count`` pixels
    within ``tol`` of ``target`` exist, then returns its ``{x, y, count, bbox}``
    — already a click target — plus ``elapsed``; ``None`` if it never arrives by
    ``timeout``. It is to ``find_color`` what ``wait_for_phrase`` is to the text
    readers: the same locate, made patient. Waits for the *meaning*, not the
    motion."""
    start = time.time()
    deadline = start + timeout
    while time.time() < deadline:
        w, h, rgb = capture_rgb()
        r = find_color(target, tol=tol, rgb=rgb, size=(w, h))
        if r is not None and r["count"] >= min_count:
            r["elapsed"] = time.time() - start
            return r
        time.sleep(interval)
    return None


def wait_for_color_gone(target: tuple[int, int, int], tol: int = 24,
                        max_count: int = 30, interval: float = 0.05,
                        timeout: float = 5.0) -> dict:
    """Wait until a colour *leaves* the screen (F140).

    The disappearance twin of :func:`wait_for_color`. The blocker is often a
    coloured surface that must *go away* before you proceed: a loading veil tinted
    a brand colour, an error banner that stays red until the input is fixed, a
    modal backdrop. ``wait_until_stable`` is the wrong tool here — a *static*
    overlay is perfectly stable, so it reports "ready" while the veil still covers
    everything; and ``wait_for_change`` trips on any unrelated motion underneath.
    What you actually mean is "wait until *this colour* is essentially absent".
    This polls :func:`find_color` every ``interval`` until at most ``max_count``
    pixels within ``tol`` of ``target`` remain, then returns ``{gone, count,
    elapsed}`` — ``gone`` is whether it cleared before ``timeout``. The same patient
    polling as ``wait_for_color``, watching for the colour to thin out rather than
    arrive: appearance and vanishing are one waiting, faced two ways."""
    start = time.time()
    deadline = start + timeout
    last = -1
    while time.time() < deadline:
        w, h, rgb = capture_rgb()
        r = find_color(target, tol=tol, rgb=rgb, size=(w, h))
        last = r["count"] if r is not None else 0
        if last <= max_count:
            return {"gone": True, "count": last, "elapsed": time.time() - start}
        time.sleep(interval)
    return {"gone": False, "count": last, "elapsed": time.time() - start}


def match_template(patch: bytes, pw: int, ph: int, rgb: bytes | None = None,
                   size: tuple[int, int] | None = None,
                   search: tuple[int, int, int, int] | None = None,
                   step: int = 1) -> dict | None:
    """Locate a reference patch by *appearance*, not colour (F053).

    ``find_color``/``find_color_blobs`` see only hue, so two regions that share
    a colour but differ in shape (a glyph, an icon, a button state) are
    indistinguishable to them — and position is an arbitrary tie-breaker. This
    slides the ``pw``x``ph`` RGB ``patch`` over the captured desktop and scores
    every offset by sum-of-absolute-difference on luma; the lowest score is the
    closest match. Returns ``{x, y, score, bbox}`` centred on the match in
    *screen* coordinates (``score`` 0 = identical), or ``None`` if the search
    area is smaller than the patch.

    Cost is ``search_area x patch_area``, so constrain ``search``
    ``(minx, miny, maxx, maxy)`` — typically a ``find_color_blobs`` bbox padded
    by a few pixels — to keep the slide cheap; raise ``step`` for a coarse pass.
    The idiom is colour to narrow the field, appearance to choose within it
    (少則得): segment by colour, then ``match_template`` each candidate and take
    the lowest score."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    if search is None:
        sx0, sy0, sx1, sy1 = 0, 0, w - 1, h - 1
    else:
        sx0, sy0, sx1, sy1 = search
        sx0, sy0 = max(0, sx0), max(0, sy0)
        sx1, sy1 = min(w - 1, sx1), min(h - 1, sy1)
    aw, ah = sx1 - sx0 + 1, sy1 - sy0 + 1
    if aw < pw or ah < ph:
        return None
    pl = bytearray(pw * ph)
    for i in range(pw * ph):
        pl[i] = (patch[i * 3] * 299 + patch[i * 3 + 1] * 587
                 + patch[i * 3 + 2] * 114) // 1000
    best: tuple[int, int, int] | None = None
    for oy in range(0, ah - ph + 1, step):
        for ox in range(0, aw - pw + 1, step):
            s = 0
            for py in range(ph):
                base = ((sy0 + oy + py) * w + (sx0 + ox)) * 3
                pbase = py * pw
                for px in range(pw):
                    j = base + px * 3
                    lum = (rgb[j] * 299 + rgb[j + 1] * 587
                           + rgb[j + 2] * 114) // 1000
                    d = lum - pl[pbase + px]
                    s += d if d >= 0 else -d
            if best is None or s < best[0]:
                best = (s, sx0 + ox, sy0 + oy)
    if best is None:
        return None
    score, tx, ty = best
    return {"x": tx + pw // 2, "y": ty + ph // 2, "score": score,
            "bbox": (tx, ty, tx + pw - 1, ty + ph - 1)}


def wait_stable(target: tuple[int, int, int], tol: int = 24, move_tol: int = 3,
                settle_frames: int = 3, interval: float = 0.12,
                timeout: float = 6.0) -> dict | None:
    """Locate a colour only once it has stopped moving (F054).

    Every other primitive here reads a *single* ``capture_rgb`` snapshot, but a
    live UI animates: by the time a synthesised click lands, an element that was
    sliding/teleporting has moved on, so the click hits where the target *used
    to be*. This samples the ``find_color`` centroid repeatedly and returns only
    after it holds within ``move_tol`` pixels for ``settle_frames`` consecutive
    samples — i.e. the motion has come to rest — yielding the *current* resting
    position to act on. The result is the usual ``find_color`` dict plus
    ``settled`` (bool) and ``samples`` (int).

    If the target never settles within ``timeout`` the last seen locate is
    returned with ``settled=False`` (or ``None`` if the colour was never found),
    so the caller can decide whether to act on a still-moving target. Do not
    poll faster than the animation's own cadence — ``interval`` should exceed a
    frame/step so two samples can actually differ (大音希聲: read the page's own
    rhythm, do not out-shout it)."""
    deadline = time.time() + timeout
    prev: tuple[int, int] | None = None
    stable = 0
    samples = 0
    last: dict | None = None
    while time.time() < deadline:
        w, h, rgb = capture_rgb()
        loc = find_color(target, tol=tol, rgb=rgb, size=(w, h))
        samples += 1
        if loc is not None:
            last = loc
            if prev is not None and abs(loc["x"] - prev[0]) <= move_tol \
                    and abs(loc["y"] - prev[1]) <= move_tol:
                stable += 1
                if stable >= settle_frames:
                    loc["samples"] = samples
                    loc["settled"] = True
                    return loc
            else:
                stable = 0
            prev = (loc["x"], loc["y"])
        time.sleep(interval)
    if last is not None:
        last["samples"] = samples
        last["settled"] = False
    return last


def edge_map(rgb: bytes, size: tuple[int, int],
             bbox: tuple[int, int, int, int], thr: int = 40
             ) -> tuple[list[int], int, int]:
    """Reduce a region to its *structure* — a binary edge mask (F055).

    ``match_template`` scores absolute luma, so a uniform colour/brightness
    shift over the whole target swamps the shape difference: the *same* shape in
    a shifted colour scores worse than a *different* shape in the reference
    colour. An edge mask keeps only where luma *changes* (the gradient), which is
    where one region meets another — and that geometry is unchanged when the
    fill colour shifts. This returns ``(edges, ew, eh)`` where ``edges`` is a
    row-major list of 0/1 over the ``bbox``: 1 where the local gradient
    magnitude (``|dL/dx| + |dL/dy|``) exceeds ``thr``. Border pixels are 0.
    Pair with :func:`match_edges` / :func:`edge_hamming` to locate by shape."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    lum = [0] * (bw * bh)
    for yy in range(bh):
        base = ((y0 + yy) * w + x0) * 3
        row = yy * bw
        for xx in range(bw):
            j = base + xx * 3
            lum[row + xx] = (rgb[j] * 299 + rgb[j + 1] * 587
                             + rgb[j + 2] * 114) // 1000
    edges = [0] * (bw * bh)
    for yy in range(1, bh - 1):
        row = yy * bw
        for xx in range(1, bw - 1):
            i = row + xx
            gx = lum[i + 1] - lum[i - 1]
            gy = lum[i + bw] - lum[i - bw]
            g = (gx if gx >= 0 else -gx) + (gy if gy >= 0 else -gy)
            if g > thr:
                edges[i] = 1
    return edges, bw, bh


def edge_hamming(a: list[int], b: list[int]) -> int:
    """Count differing pixels between two equal-length edge masks."""
    return sum(1 for i in range(len(a)) if a[i] != b[i])


def match_edges(ref_edges: list[int], ew: int, eh: int,
                rgb: bytes | None = None, size: tuple[int, int] | None = None,
                search: tuple[int, int, int, int] | None = None,
                step: int = 1, thr: int = 40) -> dict | None:
    """Locate a reference *shape* irrespective of its colour (F055).

    Companion to :func:`match_template` for targets whose colour cannot be
    relied upon (gradients, photos, theme-shifted icons, hover/active states
    that recolour but do not reshape). ``ref_edges`` is an ``ew``x``eh`` mask
    from :func:`edge_map` of the reference; this slides that window over the
    search region, recomputing each candidate's edge mask the same way, and
    scores by :func:`edge_hamming`. Lowest score wins. Returns ``{x, y, score,
    bbox}`` centred on the match in *screen* coordinates, or ``None`` if the
    search area is smaller than the window.

    Cost is ``search_area x window_area``; constrain ``search`` (a
    ``find_color_blobs`` bbox padded a little) and the idiom holds — colour to
    narrow the field, *structure* to choose within it when colour itself has
    moved."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    if search is None:
        sx0, sy0, sx1, sy1 = 0, 0, w - 1, h - 1
    else:
        sx0, sy0, sx1, sy1 = search
        sx0, sy0 = max(0, sx0), max(0, sy0)
        sx1, sy1 = min(w - 1, sx1), min(h - 1, sy1)
    aw, ah = sx1 - sx0 + 1, sy1 - sy0 + 1
    if aw < ew or ah < eh:
        return None
    best: tuple[int, int, int] | None = None
    for oy in range(0, ah - eh + 1, step):
        for ox in range(0, aw - ew + 1, step):
            cand, _, _ = edge_map(rgb, (w, h),
                                  (sx0 + ox, sy0 + oy,
                                   sx0 + ox + ew - 1, sy0 + oy + eh - 1), thr)
            s = edge_hamming(ref_edges, cand)
            if best is None or s < best[0]:
                best = (s, sx0 + ox, sy0 + oy)
    if best is None:
        return None
    score, tx, ty = best
    return {"x": tx + ew // 2, "y": ty + eh // 2, "score": score,
            "bbox": (tx, ty, tx + ew - 1, ty + eh - 1)}


def edge_signature(rgb: bytes, size: tuple[int, int],
                   bbox: tuple[int, int, int, int],
                   nw: int = 48, nh: int = 48, thr: int = 24) -> list[int]:
    """A scale-invariant structural fingerprint of a region (F056).

    :func:`edge_map` / :func:`match_edges` are translation-only: the reference
    mask is a fixed pixel size, so the *same* shape rendered larger (browser
    zoom, high-DPI, a responsive re-layout) no longer aligns — and a *different*
    shape at the reference's own size can score better. This collapses that
    dependence on size: it area-averages the region's luma down to a fixed
    ``nw``x``nh`` grid and thresholds the gradient there, so any rendering of the
    same shape — whatever its pixel dimensions — reduces to the *same* signature.
    Compare two signatures with :func:`edge_hamming` (lower = more alike).

    Segmentation already yields each candidate's true ``bbox`` (hence its size),
    so the idiom is: segment by colour, take one signature per candidate at the
    canonical grid, and pick the lowest Hamming distance to the reference —
    structure that no longer cares how big the thing was drawn."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    g = [0] * (nw * nh)
    for ny in range(nh):
        sy0 = y0 + ny * bh // nh
        sy1 = y0 + (ny + 1) * bh // nh
        if sy1 <= sy0:
            sy1 = sy0 + 1
        for nx in range(nw):
            sx0 = x0 + nx * bw // nw
            sx1 = x0 + (nx + 1) * bw // nw
            if sx1 <= sx0:
                sx1 = sx0 + 1
            s = cnt = 0
            for yy in range(sy0, sy1):
                base = yy * w * 3
                for xx in range(sx0, sx1):
                    j = base + xx * 3
                    s += (rgb[j] * 299 + rgb[j + 1] * 587
                          + rgb[j + 2] * 114) // 1000
                    cnt += 1
            g[ny * nw + nx] = s // cnt if cnt else 0
    sig = [0] * (nw * nh)
    for ny in range(1, nh - 1):
        for nx in range(1, nw - 1):
            i = ny * nw + nx
            gx = g[i + 1] - g[i - 1]
            gy = g[i + nw] - g[i - nw]
            if (gx if gx >= 0 else -gx) + (gy if gy >= 0 else -gy) > thr:
                sig[i] = 1
    return sig


def radial_profile(rgb: bytes, size: tuple[int, int],
                   bbox: tuple[int, int, int, int],
                   bins: int = 24, thr: int = 40) -> list[float]:
    """A rotation- *and* scale-invariant structural descriptor (F057).

    :func:`edge_signature` is scale-free but still orientation-bound: it
    resamples onto a fixed grid, so the *same* shape turned by 90° lights up
    entirely different cells and a *different* shape left at the reference's
    orientation can score a closer signature. This removes the angle too. It
    edges the region (:func:`edge_map`), finds the centroid of the edge pixels,
    measures each edge pixel's distance to that centroid, normalises by the
    largest such distance (kills scale), and histograms those normalised radii
    into ``bins`` buckets summed to 1. Rotating a shape about its centroid moves
    no pixel's radius, so the histogram is unchanged; rescaling divides every
    radius by the same factor, which the normalisation cancels. The histogram is
    therefore a fingerprint of the shape's *radial mass*, independent of how it
    is turned or sized. Compare two profiles with :func:`profile_l1` (lower =
    more alike). It discards angular order, so distinct shapes that happen to
    share a radial distribution can collide — pair with :func:`edge_signature`
    when orientation is in fact fixed; reach for this only when it can rotate."""
    edges, ew, _eh = edge_map(rgb, size, bbox, thr)
    pts = [(i % ew, i // ew) for i, v in enumerate(edges) if v]
    if not pts:
        return [0.0] * bins
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    ds = [((px - cx) ** 2 + (py - cy) ** 2) ** 0.5 for px, py in pts]
    mr = max(ds) or 1.0
    hist = [0] * bins
    for d in ds:
        hist[int(d / mr * (bins - 1) + 0.5)] += 1
    tot = sum(hist) or 1
    return [hc / tot for hc in hist]


def profile_l1(a: list[float], b: list[float]) -> float:
    """L1 (city-block) distance between two equal-length radial profiles."""
    return sum(abs(a[i] - b[i]) for i in range(len(a)))


def read_glyph(rgb: bytes, size: tuple[int, int],
               bbox: tuple[int, int, int, int],
               atlas: dict[str, list[int]],
               nw: int = 48, nh: int = 48, thr: int = 24) -> str:
    """Read which glyph occupies a region by matching an atlas (F058).

    The end of the perception ladder: when a control carries text the page draws
    straight onto a canvas — no DOM node, no distinguishing colour or outer shape,
    *only* the rendered character sets one button apart from its twin. Colour
    segmentation finds the tiles; structure tells them apart only if we already
    hold the target's own rendering. A fixed-size edge match against a reference
    *atlas* of candidate glyphs fails the moment the atlas was rendered at a
    different size than the live control (a `bold 80px` swatch vs a `bold 120px`
    button) — it reads every tile as the same letter. This classifies instead in
    the scale-free frame: it takes the region's :func:`edge_signature` and returns
    the ``atlas`` label whose signature is closest by :func:`edge_hamming`, so a
    glyph recognises itself however large it was drawn. ``atlas`` is
    ``{label: edge_signature(...)}`` built once from reference glyphs (rendered by
    the page itself on a scratch canvas, or captured from a known control). This
    is reading text from pixels reduced to its smallest honest form — not full
    OCR, but enough to pick the control that *says* the right thing."""
    sig = edge_signature(rgb, size, bbox, nw, nh, thr)
    return min(atlas, key=lambda k: edge_hamming(atlas[k], sig))


def read_glyph_conf(rgb: bytes, size: tuple[int, int],
                    bbox: tuple[int, int, int, int],
                    atlas: dict[str, list[int]],
                    nw: int = 48, nh: int = 48, thr: int = 24,
                    max_dist: float = 0.6, conf_k: float = 2.0,
                    unknown: str = "") -> str:
    """Read a glyph only when one atlas entry *clearly* fits (F107).

    :func:`read_glyph` returns ``min(atlas, key=…)`` — the *nearest* label, always.
    It has no way to say "I do not know this": point it at a glyph the atlas never
    held (a ``"Z"`` against an atlas of ``"ABCOKX"``) and it confidently returns the
    closest wrong letter. The closest of a bad lot is still returned as if it were
    read. ``read_glyph`` cannot express ignorance — that is its named boundary.

    The distance to the best match carries the missing signal, on two axes. A glyph
    that *is* in the atlas matches its own signature with a *small* Hamming distance
    relative to the live ink it sets, and beats every other atlas entry by a wide
    *margin*; an *unknown* glyph's nearest match is both far in absolute terms (it
    overlaps no reference well) and barely closer than the runner-up (nothing stands
    out). This reads the signature, then admits the best label only if it passes
    *both* gates: the nearest distance is ``<= max_dist`` times the live ink's set
    cells (a real fit, not the least-bad), *and* the runner-up is ``>= conf_k``
    times farther (a clear winner, not a coin-flip among look-alikes). Fail either
    and it returns ``unknown`` (``""`` by default) — it refuses to name what it
    cannot recognise.

    Honest only where the atlas entries are themselves distinguishable: hold two
    near-twins (``"O"`` and ``"0"``) and a true ``"O"`` may not clear ``conf_k`` —
    it refuses rather than guess between them, which is the honest answer when the
    reference cannot tell them apart. Empty ink → ``unknown``. Raise ``max_dist`` /
    lower ``conf_k`` to accept looser matches; lower ``max_dist`` / raise ``conf_k``
    to demand a tighter, more decisive fit before it will commit to a label."""
    sig = edge_signature(rgb, size, bbox, nw, nh, thr)
    on = sum(sig)
    if on == 0:
        return unknown
    scored = sorted((edge_hamming(atlas[k], sig), k) for k in atlas)
    best_d, best_k = scored[0]
    if best_d > max_dist * on:
        return unknown
    if len(scored) > 1 and scored[1][0] < conf_k * max(best_d, 1):
        return unknown
    return best_k


def segment_run(rgb: bytes, size: tuple[int, int],
                bbox: tuple[int, int, int, int],
                fg: tuple[int, int, int], tol: int = 60,
                gap: int = 2) -> list[tuple[int, int, int, int]]:
    """Split a horizontal text *run* into one bbox per glyph (F103).

    :func:`read_glyph` reads a *single* pre-isolated character; point it at a
    whole word and it reduces the entire ink to one ``edge_signature`` and
    returns one wrong label — you cannot read a string you have not first cut
    into letters. This cuts it: inside ``bbox`` it projects each column,
    marking the column *inked* if any pixel there is within ``tol`` of the
    foreground colour ``fg``, then walks the columns left-to-right opening a
    cell at the first inked column and closing it once ``gap`` consecutive blank
    columns prove the inter-letter space. Each cell is tightened to the actual
    inked rows so the returned bbox hugs the glyph (what ``edge_signature``
    wants). Returns the per-glyph bboxes in *reading order* (left to right).

    The cut is honest only where letters are parted by at least ``gap`` blank
    columns: glyphs that *touch* (tight kerning, script/italic overhang) share a
    column and merge into one cell — segmentation by projection cannot part what
    the rendering joined, and that is its named boundary, not a thing to fake.
    Lower ``gap`` cuts more eagerly (risking splitting a single wide glyph),
    raise it to keep close letters whole."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    tr, tg, tb = fg

    def inked_col(x: int) -> bool:
        for y in range(y0, y1 + 1):
            j = (y * w + x) * 3
            if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                    and abs(rgb[j + 2] - tb) <= tol):
                return True
        return False

    cols = [inked_col(x) for x in range(x0, x1 + 1)]
    cells: list[tuple[int, int]] = []
    start: int | None = None
    blanks = 0
    for i, ink in enumerate(cols):
        if ink:
            if start is None:
                start = i
            blanks = 0
        elif start is not None:
            blanks += 1
            if blanks >= gap:
                cells.append((x0 + start, x0 + i - blanks))
                start = None
                blanks = 0
    if start is not None:
        cells.append((x0 + start, x0 + len(cols) - 1 - blanks))

    out: list[tuple[int, int, int, int]] = []
    for cx0, cx1 in cells:
        miny, maxy = 1 << 30, -1
        for y in range(y0, y1 + 1):
            row = y * w * 3
            for x in range(cx0, cx1 + 1):
                j = row + x * 3
                if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                        and abs(rgb[j + 2] - tb) <= tol):
                    if y < miny:
                        miny = y
                    if y > maxy:
                        maxy = y
                    break
        if maxy >= 0:
            out.append((cx0, miny, cx1, maxy))
    return out


def split_run(rgb: bytes, size: tuple[int, int],
              bbox: tuple[int, int, int, int],
              fg: tuple[int, int, int], n: int, tol: int = 60,
              frac: float = 0.6) -> list[tuple[int, int, int, int]]:
    """Cut a run of ``n`` *touching* glyphs apart at the ink valleys (F104).

    :func:`segment_run` parts letters only where ``gap`` fully-blank columns
    separate them; tight kerning, an italic overhang or a script font joins two
    glyphs in a shared column and they merge into one wide cell — a blank-column
    cut cannot part what the rendering joined. The honest extra knowledge that
    *does* part them is the **glyph count** ``n``: when two letters merely touch,
    the seam between them is a local *minimum* in the per-column ink count (the
    pinch where only the overlap inks the column), shallower than either letter's
    own body. This counts the ink in every column of ``bbox``, finds the interior
    local minima, and takes the ``n - 1`` *shallowest* of them (those at or below
    ``frac`` of the peak column — a real pinch, not a letter's own waist) as the
    seams, cutting the run there and tightening each piece to its inked rows with
    :func:`segment_run`.

    This is honest only where the glyphs *touch* rather than *fuse*: it needs the
    count ``n`` (you must know how many letters to expect) and it assumes the
    inter-letter seams are the shallowest column minima — true when letters meet
    at a thin overlap, false when a stroke of one letter fully fills the seam
    column. It returns fewer than ``n`` cells when it cannot find ``n - 1`` honest
    seams: it parts what genuinely pinches and refuses to invent a cut where the
    ink runs solid. ``n <= 1`` (or no seam) yields the whole run as a single
    tightened cell."""
    x0, y0, x1, y1 = bbox
    w, _h = size
    tr, tg, tb = fg

    def whole() -> list[tuple[int, int, int, int]]:
        c = segment_run(rgb, size, bbox, fg, tol, gap=1)
        return c if c else [bbox]

    if n <= 1:
        return whole()
    prof = []
    for x in range(x0, x1 + 1):
        c = 0
        for y in range(y0, y1 + 1):
            j = (y * w + x) * 3
            if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                    and abs(rgb[j + 2] - tb) <= tol):
                c += 1
        prof.append(c)
    peak = max(prof) if prof else 0
    if peak == 0:
        return []
    mins: list[tuple[int, int]] = []
    for i in range(2, len(prof) - 2):
        if (prof[i] <= prof[i - 1] and prof[i] <= prof[i + 1]
                and prof[i] < prof[i - 2] and prof[i] < prof[i + 2]
                and prof[i] <= frac * peak):
            mins.append((prof[i], x0 + i))
    seams = sorted(x for _v, x in sorted(mins)[: n - 1])
    bounds = [x0] + seams + [x1]
    out: list[tuple[int, int, int, int]] = []
    for a, c in zip(bounds, bounds[1:]):
        cells = segment_run(rgb, size, (a, y0, c, y1), fg, tol, gap=1)
        out += cells if cells else [(a, y0, c, y1)]
    return out


def read_text(rgb: bytes, size: tuple[int, int],
              bbox: tuple[int, int, int, int],
              atlas: dict[str, list[int]],
              fg: tuple[int, int, int], tol: int = 60, gap: int = 2,
              n: int | None = None,
              nw: int = 48, nh: int = 48, thr: int = 24) -> str:
    """Read a multi-glyph text run from pixels (F103, kerned via F104).

    The rung above :func:`read_glyph`: where that reads one character we already
    isolated, this reads a *word the page drew straight onto a canvas* — no DOM,
    no per-letter node, only the rendered run. It :func:`segment_run`-s the run
    inside ``bbox`` by the foreground colour ``fg`` into per-glyph cells, then
    classifies each cell in the scale-free frame (:func:`read_glyph` against the
    reference ``atlas``), concatenating the labels in reading order into the
    string. ``atlas`` is ``{label: edge_signature(...)}`` built once from
    reference glyphs (rendered by the page on a scratch canvas, or captured from
    known controls) — exactly as :func:`read_glyph` consumes.

    Pass ``n`` (the expected glyph count) to read a run whose letters *touch*:
    when blank-column :func:`segment_run` yields fewer than ``n`` cells the
    letters share a column (tight kerning, overhang), and this falls back to
    :func:`split_run`, parting them at the ``n - 1`` shallowest column-ink valleys
    (F104). Without ``n`` it segments by blanks alone and reads only runs whose
    letters are parted by a gap.

    Still not full OCR: it reads only glyphs the ``atlas`` carries, and (without
    ``n``) only a run whose letters :func:`segment_run` can part; with ``n`` it
    parts touching glyphs but not ones that truly *fuse* (see :func:`split_run`).
    It returns ``""`` when nothing inked is found. This is reading a *string*
    reduced to its smallest honest form — segment by colour, read each by
    structure, in order."""
    cells = segment_run(rgb, size, bbox, fg, tol, gap)
    if n is not None and len(cells) < n:
        cells = split_run(rgb, size, bbox, fg, n, tol)
    return "".join(read_glyph(rgb, size, c, atlas, nw, nh, thr) for c in cells)


def read_text_conf(rgb: bytes, size: tuple[int, int],
                   bbox: tuple[int, int, int, int],
                   atlas: dict[str, list[int]],
                   fg: tuple[int, int, int], tol: int = 60, gap: int = 2,
                   n: int | None = None,
                   nw: int = 48, nh: int = 48, thr: int = 24,
                   max_dist: float = 0.6, conf_k: float = 2.0,
                   unknown: str = "?") -> str:
    """Read a run, *marking* each glyph the atlas cannot honestly name (F108).

    :func:`read_text` classifies every cell with :func:`read_glyph`, which returns
    the *nearest* atlas label no matter how badly it fits. Give it a line holding a
    glyph the atlas never carried (a ``"Z"`` inside ``"CZB"``) and it reads
    ``"CCB"``: the unknown letter is silently rewritten as the closest known one,
    and the string lies about a character it never recognised. The friction
    :func:`read_glyph_conf` cured for *one* glyph re-appears the moment a *line* is
    read, because :func:`read_text` never propagated the confidence up.

    This segments exactly as :func:`read_text` does (blank columns, or
    :func:`split_run` when ``n`` is given and the letters touch) but classifies each
    cell with :func:`read_glyph_conf`: a cell is named only when one atlas entry is
    both a good absolute fit and a clear winner, and is written as ``unknown``
    (``"?"`` by default) otherwise. The string therefore *shows* its gaps — every
    position the reader could not honestly resolve is a visible mark, not a
    fabricated letter — so a caller can tell ``"C?B"`` (one glyph unreadable) from
    ``"CAB"`` (read whole).

    Honest exactly where :func:`read_glyph_conf` is: the per-cell gates
    (``max_dist`` / ``conf_k``) decide each mark, and an atlas of indistinguishable
    near-twins will mark cells it cannot decide between rather than guess. Empty ink
    → ``""``; choose ``unknown=""`` to drop unreadable cells instead of marking them.
    """
    cells = segment_run(rgb, size, bbox, fg, tol, gap)
    if n is not None and len(cells) < n:
        cells = split_run(rgb, size, bbox, fg, n, tol)
    return "".join(read_glyph_conf(rgb, size, c, atlas, nw, nh, thr,
                                   max_dist, conf_k, unknown) for c in cells)


def read_words(rgb: bytes, size: tuple[int, int],
               bbox: tuple[int, int, int, int],
               atlas: dict[str, list[int]],
               fg: tuple[int, int, int], tol: int = 60, gap: int = 2,
               space_k: float = 1.8,
               nw: int = 48, nh: int = 48, thr: int = 24) -> str:
    """Read a line *with its word spaces* from pixels (F106).

    :func:`read_text` :func:`segment_run`-s a line into per-glyph cells and joins
    the labels with *nothing* between them — it records only *where* the inked
    cells are, never the *width* of the blank between them. Draw a line with a
    real word gap (``"OK  CAB"``) and it reads ``"OKCAB"``: the space the page
    left between words is dropped, because a blank column is a blank column to it
    whether it parts two letters or two words. ``read_text`` cannot tell an
    inter-letter gap from an inter-word gap — that is its named boundary.

    The gaps between cells carry the missing signal: they are *bimodal*. The gaps
    *inside* a word (between its letters) cluster small and roughly equal; the gap
    *between* words is markedly wider. This reads each cell as in :func:`read_text`,
    measures the horizontal blank between every adjacent pair, takes the median
    gap as the typical inter-letter spacing, and inserts a single ``' '`` wherever
    a gap is ``>= space_k`` times that median — a clear word seam, not a letter's
    own spacing. The labels join in reading order with spaces only at those seams.

    Honest only where the spacing is *bimodal*: it needs the letter gaps to
    cluster below the word gap (true for words of more than one letter). When the
    gaps are uniform — a single word, evenly-tracked display type where the word
    gap barely exceeds the letter gap — no gap clears the threshold and it reads
    the run as a single space-less word rather than inventing a break. It never
    splits a run it cannot read (empty ink → ``""``) and never guesses a space the
    spacing does not justify; raise ``space_k`` to demand a wider seam, lower it to
    split more eagerly."""
    cells = segment_run(rgb, size, bbox, fg, tol, gap)
    if not cells:
        return ""
    labels = [read_glyph(rgb, size, c, atlas, nw, nh, thr) for c in cells]
    if len(cells) == 1:
        return labels[0]
    gaps = [cells[i + 1][0] - cells[i][2] for i in range(len(cells) - 1)]
    srt = sorted(gaps)
    med = srt[len(srt) // 2]
    out = [labels[0]]
    for i, g in enumerate(gaps):
        if med > 0 and g >= space_k * med:
            out.append(" ")
        out.append(labels[i + 1])
    return "".join(out)


def segment_lines(rgb: bytes, size: tuple[int, int],
                  bbox: tuple[int, int, int, int],
                  fg: tuple[int, int, int], tol: int = 60,
                  gap: int = 4) -> list[tuple[int, int, int, int]]:
    """Split a text *block* into per-line bboxes by row-ink bands (F105).

    :func:`segment_run` and :func:`read_text` project ink down *columns* across
    the whole ``bbox`` — they assume a single horizontal line. Point them at two
    stacked lines and every column is inked by *both* lines at once: the column
    profile never falls blank between letters, the rows fuse vertically, and the
    run reads as garbage (live: an ``"OK"`` over ``"CAB"`` block reads ``'AXB'``,
    three merged columns, not the two words). A column cut cannot part rows the
    page stacked; that is :func:`read_text`'s named boundary.

    The orthogonal projection parts them. This counts ink per *row* of ``bbox``
    and groups the inked rows into bands separated by ``>= gap`` fully-blank rows
    — the inter-line leading. Each band is the tight vertical extent of one text
    line (x kept at the block's full width); reading order is top-to-bottom. It
    returns ``[]`` on blank ink: it parts only the blank leading the page left
    between lines and never invents a split inside a single line's x-height."""
    x0, y0, x1, y1 = bbox
    w, _h = size
    tr, tg, tb = fg

    def inked(y: int) -> bool:
        row = y * w * 3
        for x in range(x0, x1 + 1):
            j = row + x * 3
            if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                    and abs(rgb[j + 2] - tb) <= tol):
                return True
        return False

    bands: list[tuple[int, int, int, int]] = []
    start: int | None = None
    blanks = 0
    for y in range(y0, y1 + 1):
        if inked(y):
            if start is None:
                start = y
            blanks = 0
        elif start is not None:
            blanks += 1
            if blanks >= gap:
                bands.append((x0, start, x1, y - blanks))
                start = None
                blanks = 0
    if start is not None:
        bands.append((x0, start, x1, y1 - blanks))
    return bands


def read_block(rgb: bytes, size: tuple[int, int],
               bbox: tuple[int, int, int, int],
               atlas: dict[str, list[int]],
               fg: tuple[int, int, int], tol: int = 60, gap: int = 2,
               row_gap: int = 4,
               nw: int = 48, nh: int = 48, thr: int = 24) -> list[str]:
    """Read a multi-*line* text block from pixels (F105).

    The rung above :func:`read_text`: where that reads one horizontal run, this
    reads a *paragraph the page drew onto a canvas*. It :func:`segment_lines`-s
    the block into per-line bands by the blank leading between them (``row_gap``),
    then reads each band as an independent run with :func:`read_text`, returning
    one string per line in top-to-bottom order. A single-line block yields a
    one-element list (``read_text`` of the whole bbox); a blank region yields
    ``[]``. It still reads only glyphs the ``atlas`` carries and only lines a
    blank gap separates — it parts rows by absence of ink between them, never by
    guessing where a wrapped line *should* break."""
    bands = segment_lines(rgb, size, bbox, fg, tol, row_gap)
    if not bands:
        return []
    return [read_text(rgb, size, band, atlas, fg, tol, gap,
                      None, nw, nh, thr) for band in bands]


def detect_fg(rgb: bytes, size: tuple[int, int],
              bbox: tuple[int, int, int, int],
              q: int = 16, min_dist: int = 120
              ) -> tuple[tuple[int, int, int], tuple[int, int, int] | None]:
    """Recover the foreground (ink) colour of a region from its pixels (F109).

    Every reader below — :func:`segment_run`, :func:`read_text`, :func:`read_block`
    — demands the caller pass ``fg``, the text colour, and segments by proximity to
    it. But a control found by *layout* (a button's bounds, a label's box) arrives
    with no colour attached: you know *where* the text is, not what colour the page
    drew it. Without ``fg`` not one of those readers can run — the whole stack is
    blind to text whose colour it was not told in advance. That is the friction:
    location is not enough; reading needs the ink colour, and nothing here supplies
    it from the pixels themselves.

    The region carries the answer. A label is a large flat field of *background*
    pixels with a sparse scatter of *ink* on top: quantise the region to ``q``-step
    buckets and the background is simply the most frequent bucket, while the ink is
    the most frequent bucket that lies *far* from it (L1 distance ``> min_dist``).
    Anti-alias fringe colours sit *between* ink and background and are rarer than
    either, so they never win. This returns ``(bg, fg)`` — ``fg`` ready to hand to
    any reader (within its ``tol``, the quantised value still matches the true ink).

    Honest about absence: a *uniform* region (a blank panel, a solid fill) has no
    bucket far from its background, so ``fg`` is ``None`` — there is no ink to read,
    and it says so rather than promoting a fringe or noise pixel to "the colour".
    Feed a region that is mostly *not* its background (it fills more than half the
    box) and the roles invert as you would expect; this assumes the common case of
    sparse ink on a flat field, the shape a found control actually has."""
    w, _ = size
    x0, y0, x1, y1 = bbox
    hist: dict[tuple[int, int, int], int] = {}
    for y in range(y0, y1 + 1):
        row = y * w
        for x in range(x0, x1 + 1):
            j = (row + x) * 3
            key = (rgb[j] // q * q, rgb[j + 1] // q * q, rgb[j + 2] // q * q)
            hist[key] = hist.get(key, 0) + 1
    if not hist:
        return (0, 0, 0), None
    ranked = sorted(hist.items(), key=lambda kv: kv[1], reverse=True)
    bg = ranked[0][0]
    for col, _cnt in ranked[1:]:
        if sum(abs(a - b) for a, b in zip(col, bg)) > min_dist:
            return bg, col
    return bg, None


def palette(rgb: bytes, size: tuple[int, int],
            bbox: tuple[int, int, int, int],
            q: int = 16, min_pop: float = 0.002, min_dist: int = 96
            ) -> list[tuple[int, int, int]]:
    """Recover *every* distinct colour in a region, frequency order (F110).

    :func:`detect_fg` answers "what is the one ink colour here?" — it returns the
    single most frequent bucket far from the background. But a region rarely holds
    just one ink: a status line draws a red word beside a green one, syntax
    highlighting paints three or four colours into one box, a label sits next to a
    coloured badge. Hand such a region to :func:`detect_fg` and it keeps only the
    most frequent ink and *silently drops the rest* — and since every reader
    (:func:`read_text`, :func:`read_block`) segments by a *single* ``fg``, the
    other-coloured words become unreadable. You cannot read what you were never
    told the colour of, and one ``fg`` can only name one colour.

    The region still carries the whole answer. Quantise to ``q``-step buckets and
    walk them in descending frequency, admitting a bucket only when it is at least
    ``min_dist`` (L1) from every colour already kept *and* holds at least
    ``min_pop`` of the region's pixels. The ``min_dist`` guard fuses each true
    colour's anti-alias fringe into the colour it edges (the fringe sits *between*
    two colours and is rarer than either, so it is never admitted as its own),
    and ``min_pop`` drops stray noise. The result is the region's palette: the
    background first (most pixels), then each ink, each ready to hand to a reader.

    Honest about the floor: a colour rarer than ``min_pop`` is not reported — a
    one-pixel speck is noise, not a colour the page meant to draw. Lower
    ``min_pop`` to surface fainter inks at the cost of admitting fringe; the
    default keeps only colours a reader could actually segment a glyph from."""
    w, _ = size
    x0, y0, x1, y1 = bbox
    hist: dict[tuple[int, int, int], int] = {}
    tot = 0
    for y in range(y0, y1 + 1):
        row = y * w
        for x in range(x0, x1 + 1):
            j = (row + x) * 3
            key = (rgb[j] // q * q, rgb[j + 1] // q * q, rgb[j + 2] // q * q)
            hist[key] = hist.get(key, 0) + 1
            tot += 1
    if not hist:
        return []
    floor = max(1, int(min_pop * tot))
    kept: list[tuple[int, int, int]] = []
    for col, cnt in sorted(hist.items(), key=lambda kv: kv[1], reverse=True):
        if cnt < floor:
            break
        if all(sum(abs(a - b) for a, b in zip(col, c)) > min_dist for c in kept):
            kept.append(col)
    return kept


def read_region(rgb: bytes, size: tuple[int, int],
                bbox: tuple[int, int, int, int],
                atlas: dict[str, list[int]],
                tol: int = 60, gap: int = 2,
                nw: int = 48, nh: int = 48, thr: int = 24,
                q: int = 16, min_pop: float = 0.002, min_dist: int = 96) -> str:
    """Read *all* text in a region, across every colour, in reading order (F111).

    :func:`read_text` segments by a *single* ``fg`` — :func:`segment_run` marks a
    column inked only where a pixel sits within ``tol`` of that one colour. Hand it
    a region holding two differently-coloured words (a red ``"OK"`` beside a green
    ``"GO"``, a black label next to a coloured value) and it reads only the run of
    its given colour: every other-coloured glyph is *background* to it, and the
    line comes back half-read. :func:`palette` (F110) can now *name* every ink in
    the region, but naming is not reading — there was still no primitive that turns
    the whole multi-coloured region into the string a human sees.

    This is that primitive. It asks :func:`palette` for the region's colours, drops
    the first (the background — the most pixels are the field the text sits on), and
    for *each* remaining ink :func:`segment_run`-s the region by that colour into
    per-glyph cells. Every cell from every ink is then gathered and **sorted by its
    left edge**, so the glyphs fall back into the single left-to-right order the eye
    reads regardless of which colour drew them, and each is classified in the
    scale-free frame (:func:`read_glyph` against ``atlas``). The labels join into the
    region's full text: ``"OKGO"`` where one ``fg`` read only ``"OK"``.

    Honest about its frame. It reads each ink as a *run of glyphs*: an ink that is a
    solid fill (a coloured badge, a progress bar) has no inter-glyph blanks and
    segments as one wide cell that :func:`read_glyph` will mislabel — ``read_region``
    reads the *text* colours of a region, not its decorations, and the caller scopes
    ``bbox`` to a text area. Ordering is by left edge, so words separated in x merge
    correctly; truly interleaved colours (a single word painted letter-by-letter in
    alternating inks) order by each glyph's own column, which is still reading order.
    Empty region (no ink above :func:`palette`'s floor) → ``""``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    cells: list[tuple[int, tuple[int, int, int, int]]] = []
    for ink in inks:
        for c in segment_run(rgb, size, bbox, ink, tol, gap):
            cells.append((c[0], c))
    cells.sort(key=lambda t: t[0])
    return "".join(read_glyph(rgb, size, c, atlas, nw, nh, thr) for _, c in cells)


def read_region_words(rgb: bytes, size: tuple[int, int],
                      bbox: tuple[int, int, int, int],
                      atlas: dict[str, list[int]],
                      tol: int = 60, gap: int = 2, space_k: float = 1.8,
                      nw: int = 48, nh: int = 48, thr: int = 24,
                      q: int = 16, min_pop: float = 0.002,
                      min_dist: int = 96) -> str:
    """Read all text in a region across every colour, *with its word spaces* (F113).

    :func:`read_region` (F111) gathers every ink's glyph cells, sorts them by left
    edge and joins the labels with *nothing* between them — so a two-colour line
    ``"OK GO"`` (red ``OK`` beside green ``GO``) reads ``"OKGO"``: the word gap the
    page left is dropped, exactly as :func:`read_text` dropped it before F106.
    :func:`read_words` (F106) recovers the space, but it :func:`segment_run`-s by a
    *single* ``fg``, so on that two-colour line it reads only one colour's word
    (``"OK"`` given red, ``"GO"`` given green) — never the whole line with its seam.

    This composes the two. As :func:`read_region`, it asks :func:`palette` for the
    region's inks (dropping the background) and :func:`segment_run`-s each ink into
    per-glyph cells, gathering every cell from every colour and sorting by left
    edge — the single left-to-right order the eye reads. Then, as :func:`read_words`,
    it measures the horizontal blank between adjacent cells, takes the median as the
    typical inter-letter gap, and inserts a single ``' '`` wherever a gap is
    ``>= space_k`` times that median — a word seam, regardless of which colours sit
    on either side. ``"OK GO"`` where :func:`read_region` read ``"OKGO"`` and
    :func:`read_words` read only ``"OK"``.

    Honest where :func:`read_region` and :func:`read_words` are: it reads a single
    *line* (use :func:`read_block_region` first to part stacked lines), each ink as
    a run of glyphs, and only splits where the spacing is *bimodal* — a region whose
    cells are evenly tracked yields no seam rather than an invented space. Empty
    region (no ink above :func:`palette`'s floor) → ``""``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    cells: list[tuple[int, int, int, int]] = []
    for ink in inks:
        cells.extend(segment_run(rgb, size, bbox, ink, tol, gap))
    if not cells:
        return ""
    cells.sort(key=lambda c: c[0])
    labels = [read_glyph(rgb, size, c, atlas, nw, nh, thr) for c in cells]
    if len(cells) == 1:
        return labels[0]
    gaps = [cells[i + 1][0] - cells[i][2] for i in range(len(cells) - 1)]
    srt = sorted(gaps)
    med = srt[len(srt) // 2]
    out = [labels[0]]
    for i, g in enumerate(gaps):
        if med > 0 and g >= space_k * med:
            out.append(" ")
        out.append(labels[i + 1])
    return "".join(out)


def read_block_region(rgb: bytes, size: tuple[int, int],
                      bbox: tuple[int, int, int, int],
                      atlas: dict[str, list[int]],
                      tol: int = 60, gap: int = 2, row_gap: int = 4,
                      nw: int = 48, nh: int = 48, thr: int = 24,
                      q: int = 16, min_pop: float = 0.002,
                      min_dist: int = 96) -> list[str]:
    """Read a multi-*line*, multi-*colour* block, line by line, in order (F112).

    The two readers above each see only half of a coloured paragraph.
    :func:`read_block` (F105) parts the lines — but by a *single* ``fg``, so
    :func:`segment_lines` bands rows only where *that one colour* inks them: give
    it a block whose first line is red and second green and it finds one band and
    reads ``["RED"]``, the green line invisible (live). :func:`read_region` (F111)
    reads *every* colour — but it flattens the whole ``bbox`` into one x-sorted run,
    so two stacked lines interleave by column: ``"OK GO"`` over ``"NO BY"`` reads
    ``"ONOKGBYO"``, every word shattered across the line break. One reader keeps the
    colours and loses the rows; the other keeps the rows and loses the colours.

    This keeps both. It asks :func:`palette` for the block's inks, then bands the
    rows the way :func:`segment_lines` does but counting a row inked when *any* ink
    touches it (not one named ``fg``) — so a line of any colour, or of several,
    raises its own band, parted from its neighbours by ``>= row_gap`` blank rows of
    leading. Each band, top-to-bottom, is then handed to :func:`read_region`, which
    reads that line across all its colours in left-to-right order. The result is one
    string per line: ``["OKGO", "NOBY"]`` where ``read_region`` alone read
    ``"ONOKGBYO"`` and ``read_block`` alone read only the lines of its one colour.

    Honest in the same frame as its parts: it parts rows only by the blank leading
    the page left between lines (never guessing a wrap inside an x-height), reads
    only glyphs the ``atlas`` carries, and reads *text* colours, not solid-fill
    decorations. A block with no ink above :func:`palette`'s floor → ``[]``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    if not inks:
        return []
    bands = _band_rows(rgb, size, bbox, inks, tol, row_gap)
    return [read_region(rgb, size, band, atlas, tol, gap, nw, nh, thr,
                        q, min_pop, min_dist) for band in bands]


def _band_rows(rgb: bytes, size: tuple[int, int],
               bbox: tuple[int, int, int, int],
               inks: list[tuple[int, int, int]],
               tol: int, row_gap: int) -> list[tuple[int, int, int, int]]:
    """Band a region's rows into per-line bboxes by *any* ink (F112/F114).

    A row counts as inked when *any* colour in ``inks`` touches it (not one named
    ``fg``), so a line of any colour — or of several — raises its own band, parted
    from its neighbours by ``>= row_gap`` blank rows of leading. Shared by
    :func:`read_block_region` and :func:`read_block_region_words` so the two read a
    block by the *same* rows, differing only in how each band is then read."""
    x0, y0, x1, y1 = bbox
    w, _h = size

    def inked(y: int) -> bool:
        row = y * w * 3
        for x in range(x0, x1 + 1):
            j = row + x * 3
            pr, pg, pb = rgb[j], rgb[j + 1], rgb[j + 2]
            for ir, ig, ib in inks:
                if (abs(pr - ir) <= tol and abs(pg - ig) <= tol
                        and abs(pb - ib) <= tol):
                    return True
        return False

    bands: list[tuple[int, int, int, int]] = []
    start: int | None = None
    blanks = 0
    for y in range(y0, y1 + 1):
        if inked(y):
            if start is None:
                start = y
            blanks = 0
        elif start is not None:
            blanks += 1
            if blanks >= row_gap:
                bands.append((x0, start, x1, y - blanks))
                start = None
                blanks = 0
    if start is not None:
        bands.append((x0, start, x1, y1 - blanks))
    return bands


def read_block_region_words(rgb: bytes, size: tuple[int, int],
                            bbox: tuple[int, int, int, int],
                            atlas: dict[str, list[int]],
                            tol: int = 60, gap: int = 2, row_gap: int = 4,
                            space_k: float = 1.8,
                            nw: int = 48, nh: int = 48, thr: int = 24,
                            q: int = 16, min_pop: float = 0.002,
                            min_dist: int = 96) -> list[str]:
    """Read a multi-*line*, multi-*colour* block *with its word spaces* (F114).

    :func:`read_block_region` (F112) parts a coloured paragraph into lines and reads
    each across every colour — but through :func:`read_region`, which joins a line's
    glyph cells with *nothing* between them. So a block whose lines each carry a word
    seam, ``"OK GO"`` over ``"NO BY"``, reads ``["OKGO", "NOBY"]``: the rows are kept,
    the colours are kept, but every word gap inside a line is dropped — the F113
    friction, now one level up at block scope. :func:`read_region_words` (F113)
    recovers a line's seams, but it flattens the *whole* ``bbox`` into one x-sorted
    run, so handed a two-line block its lines interleave by column and every word
    shatters across the line break. One reader keeps the rows and loses the seams;
    the other keeps the seams and loses the rows.

    This keeps both. It bands the block's rows exactly as :func:`read_block_region`
    does (:func:`_band_rows`, a row inked by *any* palette ink, lines parted by
    ``>= row_gap`` blank leading), then reads each band, top-to-bottom, with
    :func:`read_region_words` instead of :func:`read_region` — so every line comes
    back across all its colours *and* with the ``' '`` at each word seam its spacing
    is bimodal about. The result is one spaced string per line:
    ``["OK GO", "NO BY"]`` where :func:`read_block_region` read ``["OKGO", "NOBY"]``
    and :func:`read_region_words` alone scrambled the rows together.

    Honest in the union of its parts' frames: it parts rows only by the blank leading
    the page left between lines (never a wrap inside an x-height), reads each line's
    inks as runs of glyphs, splits a line only where its spacing is *bimodal* (an
    evenly-tracked line yields no invented space), reads only glyphs the ``atlas``
    carries, and reads *text* colours, not solid-fill decorations. A single-line
    block is ``[read_region_words(...)]``; a block with no ink above
    :func:`palette`'s floor → ``[]``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    if not inks:
        return []
    bands = _band_rows(rgb, size, bbox, inks, tol, row_gap)
    return [read_region_words(rgb, size, band, atlas, tol, gap, space_k,
                              nw, nh, thr, q, min_pop, min_dist)
            for band in bands]


def _line_words(rgb: bytes, size: tuple[int, int],
                bbox: tuple[int, int, int, int],
                atlas: dict[str, list[int]],
                tol: int, gap: int, space_k: float, nw: int, nh: int, thr: int,
                q: int, min_pop: float, min_dist: int
                ) -> list[tuple[str, tuple[int, int, int, int]]]:
    """Read one line's words as ``(label, bbox)`` pairs in reading order (F115/F117).

    The shared spine under :func:`locate_word` and :func:`locate_phrase`: it
    gathers every ink's glyph cells across ``bbox`` (:func:`palette` +
    :func:`segment_run`), sorts them left-to-right, groups them into words at the
    *bimodal* seam (a gap ``>= space_k`` times the median cell gap — the F113
    boundary), reads each group (:func:`read_glyph` against ``atlas``), and returns
    each word's label paired with the union bbox of its cells (tight to the word's
    ink, in :func:`capture_rgb`/:func:`click` screen coordinates). One *line*: band
    a block first. Empty region → ``[]``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    cells: list[tuple[int, int, int, int]] = []
    for ink in inks:
        cells.extend(segment_run(rgb, size, bbox, ink, tol, gap))
    if not cells:
        return []
    cells.sort(key=lambda c: c[0])
    gaps = [cells[i + 1][0] - cells[i][2] for i in range(len(cells) - 1)]
    med = sorted(gaps)[len(gaps) // 2] if gaps else 0
    groups: list[list[tuple[int, int, int, int]]] = []
    cur = [cells[0]]
    for i, g in enumerate(gaps):
        if med > 0 and g >= space_k * med:
            groups.append(cur)
            cur = []
        cur.append(cells[i + 1])
    groups.append(cur)
    out: list[tuple[str, tuple[int, int, int, int]]] = []
    for grp in groups:
        label = "".join(read_glyph(rgb, size, c, atlas, nw, nh, thr) for c in grp)
        out.append((label, (min(c[0] for c in grp), min(c[1] for c in grp),
                            max(c[2] for c in grp), max(c[3] for c in grp))))
    return out


def locate_word(rgb: bytes, size: tuple[int, int],
                bbox: tuple[int, int, int, int],
                atlas: dict[str, list[int]], target: str,
                tol: int = 60, gap: int = 2, space_k: float = 1.8,
                nw: int = 48, nh: int = 48, thr: int = 24,
                q: int = 16, min_pop: float = 0.002,
                min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Find a word by its *text* and return *where* it sits — its bbox (F115).

    Every reader from F103 on answers *what* the pixels say and throws the rest
    away: :func:`segment_run` knows each glyph's bbox, but :func:`read_region` and
    :func:`read_region_words` fold those cells into a single joined string and the
    positions are gone. So an agent that has just *read* ``"GO"`` off a ``<canvas>``
    button still cannot *press* it — there is no DOM node for :func:`Browser.click`
    to find, and the pixel finders (:func:`find_color`, :func:`template_match`)
    locate by *colour* or *bitmap*, never by the *word* the eye actually read.
    Reading and acting were split: you could name the text or you could find a
    shape, but not click the text you named.

    This closes that loop. It gathers every ink's glyph cells across the region
    (:func:`palette` + :func:`segment_run`, as :func:`read_region_words`), sorts
    them left-to-right and groups them into words at the same *bimodal* gap a seam
    lives in (a run of cells, then a gap ``>= space_k`` times the median cell gap,
    then the next word). Each group is read in the scale-free frame
    (:func:`read_glyph` against ``atlas``) and compared to ``target``; the first
    group whose label matches returns the **union bbox of its cells** — tight to the
    word's ink, in the same screen coordinates :func:`capture_rgb` and
    :func:`click` share. Hand that bbox's centre to :func:`click` and the agent
    presses the very word it read.

    Honest in the frame of its readers: ``target`` is a *single* word (it matches a
    run between seams, never a string with its own space), it reads only glyphs the
    ``atlas`` carries and *text* colours, not solid-fill decorations, and it parts
    words only where the spacing is bimodal. A word the region does not hold — or
    that the atlas cannot spell — returns ``None`` rather than a guessed location;
    repeated words return the *leftmost* match (reading order)."""
    for label, box in _line_words(rgb, size, bbox, atlas, tol, gap, space_k,
                                  nw, nh, thr, q, min_pop, min_dist):
        if label == target:
            return box
    return None


def locate_block_word(rgb: bytes, size: tuple[int, int],
                      bbox: tuple[int, int, int, int],
                      atlas: dict[str, list[int]], target: str,
                      tol: int = 60, gap: int = 2, row_gap: int = 4,
                      space_k: float = 1.8,
                      nw: int = 48, nh: int = 48, thr: int = 24,
                      q: int = 16, min_pop: float = 0.002,
                      min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Find a word anywhere in a multi-*line* block and return its bbox (F116).

    :func:`locate_word` (F115) finds a word *in a single line*: it sorts every
    cell in the ``bbox`` by left edge and groups them by the gaps between. Hand it
    a two-line block and its lines interleave by column exactly as
    :func:`read_region_words` scrambled before F114 — a word on the second line
    has its cells shuffled in among the first line's, so its run never forms and
    the word is unfindable (or a bogus group spanning two lines reads as noise).
    The reach :func:`locate_word` opened was line-deep; a paragraph closed it
    again.

    This bands the block's rows first, exactly as :func:`read_block_region` and
    :func:`read_block_region_words` do (:func:`_band_rows`, a row inked by *any*
    palette ink, lines parted by ``>= row_gap`` blank leading), then runs
    :func:`locate_word` within each band, top band to bottom, returning the bbox of
    the first band that holds ``target``. So a word is found *where it sits in the
    paragraph* — its cells grouped only against its own line's neighbours, never a
    line above or below — and its bbox, in the screen frame :func:`capture_rgb` and
    :func:`click` share, is the place to press it.

    Honest in the union of its parts' frames: it parts rows only by the blank
    leading the page left between lines, reads each line's words at the bimodal
    seam, reads only glyphs the ``atlas`` carries and *text* colours, and returns
    the first match top-to-bottom then left-to-right (reading order). A word no
    line holds — or the atlas cannot spell — returns ``None``, not a guess."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    if not inks:
        return None
    for band in _band_rows(rgb, size, bbox, inks, tol, row_gap):
        hit = locate_word(rgb, size, band, atlas, target, tol, gap, space_k,
                          nw, nh, thr, q, min_pop, min_dist)
        if hit is not None:
            return hit
    return None


def locate_phrase(rgb: bytes, size: tuple[int, int],
                  bbox: tuple[int, int, int, int],
                  atlas: dict[str, list[int]], target: str,
                  tol: int = 60, gap: int = 2, row_gap: int = 4,
                  space_k: float = 1.8,
                  nw: int = 48, nh: int = 48, thr: int = 24,
                  q: int = 16, min_pop: float = 0.002,
                  min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Find a multi-*word* phrase and return the bbox spanning it (F117).

    :func:`locate_word`/:func:`locate_block_word` (F115/F116) reach a *single*
    word: each matches one run between seams, so a button labelled across a word
    space — ``Sign In``, ``Add To Cart``, here ``OK GO`` — is unfindable. Ask
    :func:`locate_word` for ``"OK GO"`` and it never matches (no single run carries
    the space); ask it for ``"OK"`` and you get only that word's box, its centre
    landing on *half* the button, not its middle. The locators could name where one
    word sits but not where a labelled control — a *run of words* — spans.

    This matches a phrase. It bands the block's rows (:func:`_band_rows`, as
    :func:`locate_block_word`) and within each line reads the words in order
    (:func:`_line_words`, the F115 spine), then slides a window over that line's
    word labels for the consecutive run equal to ``target`` split on spaces. The
    first match returns the **union bbox of exactly those words** — the whole
    label's extent, whose centre is the control's true middle, in
    :func:`capture_rgb`/:func:`click` screen coordinates. A one-word ``target`` is
    :func:`locate_block_word`; a phrase no line carries in order → ``None``.

    Honest in its parts' frames: the words must be *consecutive on one line* (it
    never stitches a phrase across a line break or out of reading order), it parts
    words only at the bimodal seam, reads only ``atlas`` glyphs and *text* colours,
    and returns the first match top-to-bottom, left-to-right. A phrase the page
    never wrote — or the atlas cannot spell — returns ``None``, not a guess."""
    want = target.split(" ")
    if not want:
        return None
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    if not inks:
        return None
    n = len(want)
    for band in _band_rows(rgb, size, bbox, inks, tol, row_gap):
        words = _line_words(rgb, size, band, atlas, tol, gap, space_k,
                            nw, nh, thr, q, min_pop, min_dist)
        labels = [w[0] for w in words]
        for i in range(len(words) - n + 1):
            if labels[i:i + n] == want:
                boxes = [w[1] for w in words[i:i + n]]
                return (min(b[0] for b in boxes), min(b[1] for b in boxes),
                        max(b[2] for b in boxes), max(b[3] for b in boxes))
    return None


def wait_for_phrase(bbox: tuple[int, int, int, int],
                    atlas: dict[str, list[int]], target: str,
                    timeout: float = 5.0, interval: float = 0.15,
                    tol: int = 60, gap: int = 2, row_gap: int = 4,
                    space_k: float = 1.8,
                    nw: int = 48, nh: int = 48, thr: int = 24,
                    q: int = 16, min_pop: float = 0.002,
                    min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Wait until a word or phrase *appears* on screen, then return its bbox (F118).

    Every locator from F115 on reads a *single frame*: it asks :func:`capture_rgb`
    once and finds the target in that snapshot. But a GUI is a process in time — a
    result paints after a click, a page settles after a load — so the one capture
    an agent takes the instant it acts catches the screen *before* the word it
    waits for, and :func:`locate_phrase` honestly returns ``None`` for text that is
    a heartbeat from existing. Acting and observing were one tick apart: you could
    find what is already drawn, but not *wait* for what is coming. An agent that
    clicks and reads in the same breath reads the old screen.

    This closes the act → observe → act loop. It re-captures the screen on a fixed
    cadence (``interval`` seconds) and runs :func:`locate_phrase` over ``bbox`` each
    time, returning the moment the target first appears — its bbox in the same
    screen frame :func:`capture_rgb` and :func:`click` share, ready to press. If the
    text never shows within ``timeout`` seconds it returns ``None`` rather than
    blocking forever or guessing a place. So ``click(button); box =
    wait_for_phrase(field, atlas, "DONE"); click(box…)`` reads the screen as it
    *becomes*, not as it *was*.

    Honest in :func:`locate_phrase`'s frame at every poll (banded rows, bimodal
    seams, ``atlas`` glyphs, text colours, reading order) and honest about time: it
    promises only to look until the deadline, and a target that never arrives —
    or the atlas cannot spell — returns ``None``."""
    deadline = time.monotonic() + timeout
    while True:
        w, h, rgb = capture_rgb()
        hit = locate_phrase(rgb, (w, h), bbox, atlas, target, tol, gap, row_gap,
                            space_k, nw, nh, thr, q, min_pop, min_dist)
        if hit is not None:
            return hit
        if time.monotonic() >= deadline:
            return None
        time.sleep(interval)


def scroll_to_phrase(bbox: tuple[int, int, int, int],
                     atlas: dict[str, list[int]], target: str,
                     step: int = 5, max_steps: int = 40,
                     x: int | None = None, y: int | None = None,
                     settle: float = 0.25,
                     tol: int = 60, gap: int = 2, row_gap: int = 4,
                     space_k: float = 1.8,
                     nw: int = 48, nh: int = 48, thr: int = 24,
                     q: int = 16, min_pop: float = 0.002,
                     min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Scroll until a word or phrase comes into view, then return its bbox (F120).

    :func:`scroll` (F119) can reach past the fold, but only by a *guessed* amount:
    the caller must know how many notches the target lies below, and a fixed roll
    over- or under-shoots — too few and the word never enters the frame, too many
    and it flies past the top and out again (the F119 probe lost ``GO`` at the
    first overshoot). And :func:`locate_phrase` still only reads the one screenful
    it is handed. To *find* text on a surface taller than the window you must
    search and scroll together, and know when to stop.

    This marries the two. It looks for ``target`` in the current frame
    (:func:`locate_phrase` over ``bbox``); finding it, returns its bbox at once.
    Else it rolls the wheel down ``step`` notches over ``(x, y)`` (the region's
    centre by default) and looks again, walking the surface one screenful at a
    time, up to ``max_steps`` rolls — so ``box = scroll_to_phrase(field, atlas,
    "SUBMIT")`` brings a button anywhere down a long page into view and hands back
    where to press it, the window walking itself to the text instead of the caller
    counting notches.

    It bounds the search by ``max_steps`` rather than by pixels-stopped-changing,
    and that is deliberate honesty: a long blank stretch scrolls past while the
    captured screen does not change a single byte (the scrollbar thumb does not
    register in a GDI grab), so "the frame held still" cannot tell *bottomed out*
    from *still travelling through emptiness* — a pixel-only reader simply has no
    truthful bottom signal, and pretending one (stopping on a still frame) would
    abandon a target that lies just past the blank. So it promises only to look
    across ``max_steps`` successive screenfuls; set ``max_steps`` to cover the
    surface (``page_height / screenful`` rolls of ``step``).

    Honest in its parts' frames at every step (banded rows, bimodal seams,
    ``atlas`` glyphs, text colours) and honest about its reach: it reads only what
    each roll reveals and declares failure only after exhausting ``max_steps``.
    Leaves the surface scrolled at wherever it found the target (or as far as it
    walked); a word no screenful within reach holds — or the atlas cannot spell —
    returns ``None``."""
    if x is None:
        x = (bbox[0] + bbox[2]) // 2
    if y is None:
        y = (bbox[1] + bbox[3]) // 2
    for i in range(max_steps):
        w, h, rgb = capture_rgb()
        hit = locate_phrase(rgb, (w, h), bbox, atlas, target, tol, gap, row_gap,
                            space_k, nw, nh, thr, q, min_pop, min_dist)
        if hit is not None:
            return hit
        if i < max_steps - 1:
            scroll(dy=-step, x=x, y=y)
            time.sleep(settle)
    return None


if __name__ == "__main__":
    print("screen:", screen_size())
    rt = "agentctl osctl clipboard round-trip \u2713"
    set_clipboard(rt)
    print("clipboard ok:", get_clipboard() == rt)
    out = screenshot("osctl_desktop.png")
    import os as _os
    print("screenshot:", out, _os.path.getsize(out), "bytes")
