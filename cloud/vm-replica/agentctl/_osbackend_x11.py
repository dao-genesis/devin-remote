"""osctl Linux backend — the OS leaf primitives on the X11 ground.

The Win32 floor (``_osbackend_win``) has no meaning on Linux, yet the agent must
still operate the GUI *outside* the DOM here too. This is the same floor rebuilt
on X11, pure ``ctypes`` against ``libX11`` + the XTEST extension (``libXtst``) —
no third-party deps, mirroring the project's stdlib-only ethos:

* input — ``XTestFakeMotionEvent`` / ``XTestFakeButtonEvent`` / ``XTestFakeKeyEvent``
  deliver *trusted* synthetic events, the X analogue of ``SendInput``;
* keys — Windows virtual-key codes are mapped to X keysyms; arbitrary Unicode is
  typed by binding a spare keycode to the target keysym (the xdotool technique),
  so CJK and emoji go in without a layout;
* clipboard — a tiny invisible window owns the ``CLIPBOARD``/``PRIMARY`` selection
  and serves it from a daemon thread on its own display connection, so Ctrl+V in
  Chrome pastes what :func:`set_clipboard` stored;
* capture — ``XGetImage`` of the root window, the same ``(w, h, rgb)`` byte layout
  that the Windows GDI grab returns, so the perception side is identical.

Exposes the exact names ``osctl`` expects from a backend: ``screen_size``,
``move``, ``cursor_pos``, ``mouse_button``, ``mouse_wheel``, ``key_down``,
``key_up``, ``type_unicode``, ``set_clipboard``, ``get_clipboard``, ``capture_rgb``.
"""

from __future__ import annotations

import ctypes
import threading
import time

_x = ctypes.CDLL("libX11.so.6")
_xt = ctypes.CDLL("libXtst.so.6")

_x.XOpenDisplay.restype = ctypes.c_void_p
_x.XOpenDisplay.argtypes = [ctypes.c_char_p]
_x.XDefaultScreen.restype = ctypes.c_int
_x.XDefaultScreen.argtypes = [ctypes.c_void_p]
_x.XDefaultRootWindow.restype = ctypes.c_ulong
_x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
_x.XDisplayWidth.restype = ctypes.c_int
_x.XDisplayHeight.restype = ctypes.c_int
_x.XDisplayWidth.argtypes = _x.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
_x.XFlush.argtypes = [ctypes.c_void_p]
_x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
_x.XKeysymToKeycode.restype = ctypes.c_ubyte
_x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
_x.XQueryPointer.restype = ctypes.c_int
_x.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                             ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                             ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                             ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                             ctypes.POINTER(ctypes.c_uint)]
_x.XGetImage.restype = ctypes.c_void_p
_x.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                         ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
_x.XFree.argtypes = [ctypes.c_void_p]
_x.XChangeKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                      ctypes.POINTER(ctypes.c_ulong), ctypes.c_int]
_x.XDisplayKeycodes.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int),
                                ctypes.POINTER(ctypes.c_int)]
_x.XGetKeyboardMapping.restype = ctypes.POINTER(ctypes.c_ulong)
_x.XGetKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int,
                                   ctypes.POINTER(ctypes.c_int)]

_xt.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                     ctypes.c_int, ctypes.c_ulong]
_xt.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
_xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]


class _XImage(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int),
        ("format", ctypes.c_int), ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int),
        ("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int),
        ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int),
        ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int),
        ("red_mask", ctypes.c_ulong), ("green_mask", ctypes.c_ulong),
        ("blue_mask", ctypes.c_ulong),
    ]


_ZPIXMAP = 2
_ALLPLANES = (1 << 32) - 1

_dpy = _x.XOpenDisplay(None)
if not _dpy:
    raise RuntimeError("osctl/x11: cannot open X display (is DISPLAY set?)")
_screen = _x.XDefaultScreen(_dpy)
_root = _x.XDefaultRootWindow(_dpy)
_lock = threading.RLock()  # one display connection, many caller threads


def screen_size() -> tuple[int, int]:
    return (_x.XDisplayWidth(_dpy, _screen), _x.XDisplayHeight(_dpy, _screen))


def cursor_pos() -> tuple[int, int]:
    rr = ctypes.c_ulong(); cr = ctypes.c_ulong()
    rx = ctypes.c_int(); ry = ctypes.c_int(); wx = ctypes.c_int(); wy = ctypes.c_int()
    mask = ctypes.c_uint()
    with _lock:
        _x.XQueryPointer(_dpy, _root, ctypes.byref(rr), ctypes.byref(cr),
                         ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx),
                         ctypes.byref(wy), ctypes.byref(mask))
    return (rx.value, ry.value)


def move(x: int, y: int) -> None:
    with _lock:
        _xt.XTestFakeMotionEvent(_dpy, _screen, int(x), int(y), 0)
        _x.XFlush(_dpy)


_BUTTON = {"left": 1, "middle": 2, "right": 3}


def mouse_button(button: str, down: bool) -> None:
    with _lock:
        _xt.XTestFakeButtonEvent(_dpy, _BUTTON[button], 1 if down else 0, 0)
        _x.XFlush(_dpy)


def mouse_wheel(notches: int, horizontal: bool = False) -> None:
    # X core buttons: 4 up, 5 down, 6 left, 7 right — one press/release per notch.
    if horizontal:
        b = 7 if notches > 0 else 6
    else:
        b = 4 if notches > 0 else 5
    with _lock:
        for _ in range(abs(notches)):
            _xt.XTestFakeButtonEvent(_dpy, b, 1, 0)
            _xt.XTestFakeButtonEvent(_dpy, b, 0, 0)
            _x.XFlush(_dpy)


def capture_rgb(x: int = 0, y: int = 0,
                w: "int | None" = None, h: "int | None" = None
                ) -> tuple[int, int, bytes]:
    """Grab the root, or a sub-rectangle (foveal window) of it, as (w, h, rgb).

    With no args this is the full-screen grab. Given x/y/w/h it asks XGetImage for
    only that rectangle — a smaller, faster read used for foveated, high-rate
    sampling. The rectangle is clamped to the screen so a window partly off-screen
    still returns a valid image."""
    sw, sh = screen_size()
    if w is None:
        w = sw
    if h is None:
        h = sh
    x = max(0, min(int(x), sw - 1))
    y = max(0, min(int(y), sh - 1))
    w = max(1, min(int(w), sw - x))
    h = max(1, min(int(h), sh - y))
    with _lock:
        img_p = _x.XGetImage(_dpy, _root, x, y, w, h, _ALLPLANES, _ZPIXMAP)
        if not img_p:
            raise RuntimeError("XGetImage failed")
        img = ctypes.cast(img_p, ctypes.POINTER(_XImage)).contents
        bpp = img.bits_per_pixel
        bpl = img.bytes_per_line
        data_ptr = img.data
        raw = ctypes.string_at(data_ptr, bpl * h)
        # XGetImage images own their data; free both data and the struct (what the
        # XDestroyImage macro does for a default image) so repeated grabs don't leak.
        _x.XFree(data_ptr)
        _x.XFree(img_p)
    if bpp != 32:
        raise RuntimeError(f"osctl/x11: unsupported bits_per_pixel {bpp}")
    if bpl != w * 4:  # strip row padding to a tight w*4 stride first
        raw = b"".join(raw[y * bpl:y * bpl + w * 4] for y in range(h))
    rgb = bytearray(w * h * 3)
    rgb[0::3] = raw[2::4]  # R  (pixel bytes are B,G,R,X little-endian)
    rgb[1::3] = raw[1::4]  # G
    rgb[2::3] = raw[0::4]  # B
    return w, h, bytes(rgb)


# ---- keyboard ------------------------------------------------------------- #
# Windows virtual-key code -> X keysym (the codes osctl/tests speak are Win VKs).
_VK_KEYSYM = {
    0x08: 0xFF08, 0x09: 0xFF09, 0x0D: 0xFF0D, 0x10: 0xFFE1, 0x11: 0xFFE3,
    0x12: 0xFFE9, 0x1B: 0xFF1B, 0x20: 0x20, 0x21: 0xFF55, 0x22: 0xFF56,
    0x23: 0xFF57, 0x24: 0xFF50, 0x25: 0xFF51, 0x26: 0xFF52, 0x27: 0xFF53,
    0x28: 0xFF54, 0x2E: 0xFFFF,
}


def _vk_keysym(vk: int) -> int:
    if vk in _VK_KEYSYM:
        return _VK_KEYSYM[vk]
    if 0x30 <= vk <= 0x39:        # '0'-'9' — keysym equals the ASCII code
        return vk
    if 0x41 <= vk <= 0x5A:        # 'A'-'Z' VK -> lowercase keysym = the physical key
        return vk + 0x20
    return vk


def key_down(vk: int) -> None:
    kc = _x.XKeysymToKeycode(_dpy, _vk_keysym(vk))
    with _lock:
        _xt.XTestFakeKeyEvent(_dpy, kc, 1, 0)
        _x.XFlush(_dpy)


def key_up(vk: int) -> None:
    kc = _x.XKeysymToKeycode(_dpy, _vk_keysym(vk))
    with _lock:
        _xt.XTestFakeKeyEvent(_dpy, kc, 0, 0)
        _x.XFlush(_dpy)


def _find_scratch_keycode() -> int:
    kmin = ctypes.c_int(); kmax = ctypes.c_int()
    _x.XDisplayKeycodes(_dpy, ctypes.byref(kmin), ctypes.byref(kmax))
    count = kmax.value - kmin.value + 1
    nsyms = ctypes.c_int()
    syms = _x.XGetKeyboardMapping(_dpy, kmin.value, count, ctypes.byref(nsyms))
    per = nsyms.value
    chosen = None
    for k in range(count):
        if all(syms[k * per + j] == 0 for j in range(per)):
            chosen = kmin.value + k  # last fully-empty keycode = safe scratch
    _x.XFree(ctypes.cast(syms, ctypes.c_void_p))
    return chosen if chosen is not None else kmax.value


_scratch = _find_scratch_keycode()


def type_unicode(text: str) -> None:
    """Type ``text`` as trusted key events, any Unicode, without a layout.

    Each char's X keysym (``cp`` for Latin-1, else ``0x01000000 | cp``) is bound
    to a spare keycode via ``XChangeKeyboardMapping``, struck with XTEST, then the
    keycode is cleared — so the press always resolves to exactly that glyph and a
    stale binding can never autorepeat. The Win32 backend injects the same text
    via ``KEYEVENTF_UNICODE``; both bypass the active keyboard layout."""
    with _lock:
        for ch in text:
            cp = ord(ch)
            keysym = cp if cp < 0x100 else (0x01000000 | cp)
            arr = (ctypes.c_ulong * 2)(keysym, keysym)
            _x.XChangeKeyboardMapping(_dpy, _scratch, 2, arr, 1)
            _x.XSync(_dpy, 0)
            time.sleep(0.012)
            _xt.XTestFakeKeyEvent(_dpy, _scratch, 1, 0)
            _x.XSync(_dpy, 0)
            time.sleep(0.008)
            _xt.XTestFakeKeyEvent(_dpy, _scratch, 0, 0)
            _x.XSync(_dpy, 0)
            time.sleep(0.012)
        zero = (ctypes.c_ulong * 2)(0, 0)
        _x.XChangeKeyboardMapping(_dpy, _scratch, 2, zero, 1)
        _x.XSync(_dpy, 0)


# ---- clipboard (selection owner on its own display connection) ------------ #
_clip_text = ""
_clip_started = False


def set_clipboard(text: str) -> None:
    """Own the X CLIPBOARD/PRIMARY selection and serve ``text`` to requestors.

    X has no global clipboard buffer: the owner hands the text to each paster on
    demand. A daemon thread on its own display connection answers SelectionRequest
    events, so Chrome's Ctrl+V (a request to the owner) receives ``text``."""
    global _clip_text, _clip_started
    _clip_text = text
    if not _clip_started:
        _clip_started = True
        threading.Thread(target=_clip_serve, daemon=True).start()
        time.sleep(0.05)


def get_clipboard() -> str:
    return _clip_text


def _clip_serve() -> None:
    d = _x.XOpenDisplay(None)
    root = _x.XDefaultRootWindow(d)
    _x.XInternAtom.restype = ctypes.c_ulong
    _x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    _x.XCreateSimpleWindow.restype = ctypes.c_ulong
    _x.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                                       ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                                       ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
    _x.XSetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                                      ctypes.c_ulong]
    _x.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _x.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                                   ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_char_p, ctypes.c_int]
    _x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                              ctypes.c_long, ctypes.c_void_p]

    XA_STRING = 31
    XA_ATOM = 4
    PRIMARY = 1
    CLIPBOARD = _x.XInternAtom(d, b"CLIPBOARD", 0)
    UTF8 = _x.XInternAtom(d, b"UTF8_STRING", 0)
    TARGETS = _x.XInternAtom(d, b"TARGETS", 0)
    win = _x.XCreateSimpleWindow(d, root, 0, 0, 1, 1, 0, 0, 0)
    _x.XSetSelectionOwner(d, CLIPBOARD, win, 0)
    _x.XSetSelectionOwner(d, PRIMARY, win, 0)
    _x.XFlush(d)

    class XSelReq(ctypes.Structure):  # XSelectionRequestEvent
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                    ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                    ("owner", ctypes.c_ulong), ("requestor", ctypes.c_ulong),
                    ("selection", ctypes.c_ulong), ("target", ctypes.c_ulong),
                    ("property", ctypes.c_ulong), ("time", ctypes.c_ulong)]

    class XSelNotify(ctypes.Structure):  # XSelectionEvent — note: no 'owner' field
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                    ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                    ("requestor", ctypes.c_ulong), ("selection", ctypes.c_ulong),
                    ("target", ctypes.c_ulong), ("property", ctypes.c_ulong),
                    ("time", ctypes.c_ulong)]

    class XEvent(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("pad", ctypes.c_long * 30)]

    SELECTION_REQUEST = 30
    SELECTION_NOTIFY = 31
    ev = XEvent()
    while True:
        _x.XNextEvent(d, ctypes.byref(ev))
        if ev.type != SELECTION_REQUEST:
            continue
        req = ctypes.cast(ctypes.byref(ev), ctypes.POINTER(XSelReq)).contents
        prop = req.property
        if req.target in (UTF8, XA_STRING):
            data = _clip_text.encode("utf-8")
            _x.XChangeProperty(d, req.requestor, prop, req.target, 8, 0, data, len(data))
        elif req.target == TARGETS:
            targs = (ctypes.c_ulong * 2)(UTF8, XA_STRING)
            _x.XChangeProperty(d, req.requestor, prop, XA_ATOM, 32, 0,
                               ctypes.cast(targs, ctypes.c_char_p), 2)
        else:
            prop = 0  # refuse unknown targets
        note = XSelNotify(type=SELECTION_NOTIFY, serial=0, send_event=1, display=d,
                          requestor=req.requestor, selection=req.selection,
                          target=req.target, property=prop, time=req.time)
        _x.XSendEvent(d, req.requestor, 0, 0, ctypes.byref(note))
        _x.XFlush(d)
