"""agentctl.osctl — OS-level input, clipboard and screen capture (Windows).

CDP can only reach what lives *inside* a page.  Real GUIs leak outside the DOM:
the omnibox, Chrome's own "Leave site?" / basic-auth / file-chooser dialogs,
other windows entirely (F005).  ``osctl`` is the escape hatch — it drives the
machine through Win32 ``SendInput`` (trusted input), the clipboard, and a GDI
screen grab — so the agent keeps operating where the browser channel goes blind.

The standout primitive is **atomic paste into the omnibox**: per-character typing
into Chrome's address bar loses keystrokes to history autocomplete (F003).  The
robust path is clipboard + Ctrl+V — one trusted event, nothing to race.

No third-party deps (no PIL/mss on this VM): the PNG encoder is hand-rolled with
``zlib`` so a desktop screenshot is always available for the perception side.
"""

from __future__ import annotations

import ctypes
import struct
import time
import zlib
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

# 64-bit safety: handles/pointers must NOT default to 32-bit int return, or they
# get truncated and the next call dereferences a null/garbage pointer.
_wp = wintypes
kernel32.GlobalAlloc.restype = _wp.HGLOBAL
kernel32.GlobalAlloc.argtypes = [_wp.UINT, ctypes.c_size_t]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [_wp.HGLOBAL]
kernel32.GlobalUnlock.argtypes = [_wp.HGLOBAL]
user32.SetClipboardData.restype = _wp.HANDLE
user32.SetClipboardData.argtypes = [_wp.UINT, _wp.HANDLE]
user32.GetClipboardData.restype = _wp.HANDLE
user32.GetClipboardData.argtypes = [_wp.UINT]
user32.GetDC.restype = _wp.HDC
user32.GetDC.argtypes = [_wp.HWND]
user32.ReleaseDC.argtypes = [_wp.HWND, _wp.HDC]
gdi32.CreateCompatibleDC.restype = _wp.HDC
gdi32.CreateCompatibleDC.argtypes = [_wp.HDC]
gdi32.CreateCompatibleBitmap.restype = _wp.HBITMAP
gdi32.CreateCompatibleBitmap.argtypes = [_wp.HDC, ctypes.c_int, ctypes.c_int]
gdi32.SelectObject.restype = _wp.HGDIOBJ
gdi32.SelectObject.argtypes = [_wp.HDC, _wp.HGDIOBJ]
gdi32.BitBlt.argtypes = [_wp.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                         ctypes.c_int, _wp.HDC, ctypes.c_int, ctypes.c_int,
                         _wp.DWORD]
gdi32.GetDIBits.argtypes = [_wp.HDC, _wp.HBITMAP, _wp.UINT, _wp.UINT,
                            ctypes.c_void_p, ctypes.c_void_p, _wp.UINT]
gdi32.DeleteObject.argtypes = [_wp.HGDIOBJ]
gdi32.DeleteDC.argtypes = [_wp.HDC]

# ---- SendInput plumbing --------------------------------------------------- #
INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT)]


class _INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


def _send(*inputs: _INPUT) -> None:
    n = len(inputs)
    arr = (_INPUT * n)(*inputs)
    sent = user32.SendInput(n, arr, ctypes.sizeof(_INPUT))
    if sent != n:
        raise ctypes.WinError(ctypes.get_last_error())


def screen_size() -> tuple[int, int]:
    return (user32.GetSystemMetrics(0), user32.GetSystemMetrics(1))


# ---- mouse ---------------------------------------------------------------- #
def _abs(x: int, y: int) -> tuple[int, int]:
    w, h = screen_size()
    return int(x * 65535 / max(w - 1, 1)), int(y * 65535 / max(h - 1, 1))


def move(x: int, y: int) -> None:
    ax, ay = _abs(x, y)
    mi = _MOUSEINPUT(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, 0)
    _send(_INPUT(INPUT_MOUSE, _INPUTUNION(mi=mi)))


def click(x: int | None = None, y: int | None = None, right: bool = False) -> None:
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    down = MOUSEEVENTF_RIGHTDOWN if right else MOUSEEVENTF_LEFTDOWN
    up = MOUSEEVENTF_RIGHTUP if right else MOUSEEVENTF_LEFTUP
    for flag in (down, up):
        mi = _MOUSEINPUT(0, 0, 0, flag, 0, 0)
        _send(_INPUT(INPUT_MOUSE, _INPUTUNION(mi=mi)))


# ---- keyboard ------------------------------------------------------------- #
def key_down(vk: int) -> None:
    ki = _KEYBDINPUT(vk, 0, 0, 0, 0)
    _send(_INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=ki)))


def key_up(vk: int) -> None:
    ki = _KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP, 0, 0)
    _send(_INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=ki)))


def tap(vk: int) -> None:
    key_down(vk)
    key_up(vk)


def chord(*vks: int) -> None:
    """Press keys in order, release in reverse (e.g. Ctrl+L, Ctrl+V)."""
    for vk in vks:
        key_down(vk)
    for vk in reversed(vks):
        key_up(vk)


def type_unicode(text: str) -> None:
    """Inject text as trusted Unicode key events (bypasses layout)."""
    inputs = []
    for ch in text:
        for flags in (KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
            ki = _KEYBDINPUT(0, ord(ch), flags, 0, 0)
            inputs.append(_INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=ki)))
    _send(*inputs)


# Common virtual-key codes.
VK_RETURN, VK_TAB, VK_ESCAPE, VK_CONTROL, VK_MENU, VK_SHIFT = 0x0D, 0x09, 0x1B, 0x11, 0x12, 0x10
VK_L, VK_V, VK_A, VK_C = 0x4C, 0x56, 0x41, 0x43


# ---- clipboard ------------------------------------------------------------ #
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002


def set_clipboard(text: str) -> None:
    if not user32.OpenClipboard(0):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        ptr = kernel32.GlobalLock(h)
        ctypes.memmove(ptr, data, len(data))
        kernel32.GlobalUnlock(h)
        if not user32.SetClipboardData(CF_UNICODETEXT, h):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        user32.CloseClipboard()


def get_clipboard() -> str:
    if not user32.OpenClipboard(0):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        h = user32.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return ""
        ptr = kernel32.GlobalLock(h)
        text = ctypes.wstring_at(ptr)
        kernel32.GlobalUnlock(h)
        return text
    finally:
        user32.CloseClipboard()


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


# ---- GDI screen capture + hand-rolled PNG --------------------------------- #
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


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


def capture_rgb() -> tuple[int, int, bytes]:
    """Grab the whole desktop into memory as ``(w, h, rgb)`` (3 bytes/pixel,
    row-major, top-down) via GDI BitBlt — the raw pixel channel the agent sees.

    The dimensions match ``screen_size()`` (the same space ``_abs``/``click``
    normalise against), so a pixel located here is directly clickable."""
    w, h = screen_size()
    sdc = user32.GetDC(0)
    mdc = gdi32.CreateCompatibleDC(sdc)
    bmp = gdi32.CreateCompatibleBitmap(sdc, w, h)
    gdi32.SelectObject(mdc, bmp)
    gdi32.BitBlt(mdc, 0, 0, w, h, sdc, 0, 0, SRCCOPY)

    bih = _BITMAPINFOHEADER()
    bih.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
    bih.biWidth = w
    bih.biHeight = -h  # top-down
    bih.biPlanes = 1
    bih.biBitCount = 32
    bih.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bih), DIB_RGB_COLORS)

    # BGRA -> RGB
    bgra = bytes(buf.raw)
    rgb = bytearray(w * h * 3)
    rgb[0::3] = bgra[2::4]
    rgb[1::3] = bgra[1::4]
    rgb[2::3] = bgra[0::4]

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mdc)
    user32.ReleaseDC(0, sdc)
    return w, h, bytes(rgb)


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
    return [read_region(rgb, size, band, atlas, tol, gap, nw, nh, thr,
                        q, min_pop, min_dist) for band in bands]


if __name__ == "__main__":
    print("screen:", screen_size())
    rt = "agentctl osctl clipboard round-trip \u2713"
    set_clipboard(rt)
    print("clipboard ok:", get_clipboard() == rt)
    out = screenshot("osctl_desktop.png")
    import os as _os
    print("screenshot:", out, _os.path.getsize(out), "bytes")
