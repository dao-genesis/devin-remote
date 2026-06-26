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


if __name__ == "__main__":
    print("screen:", screen_size())
    rt = "agentctl osctl clipboard round-trip \u2713"
    set_clipboard(rt)
    print("clipboard ok:", get_clipboard() == rt)
    out = screenshot("osctl_desktop.png")
    import os as _os
    print("screenshot:", out, _os.path.getsize(out), "bytes")
