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
import os
import signal
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
# F177: without these, ctypes defaults the Display* arg to a 32-bit c_int and
# truncates the 64-bit pointer -> libX11 dereferences garbage -> SIGSEGV. The
# read side of the keyboard (key_state) is the only place these two are used.
_x.XQueryKeymap.restype = ctypes.c_int
_x.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_char * 32]
_x.XkbGetState.restype = ctypes.c_int
_x.XkbGetState.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p]
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

# Window enumeration / activation (EWMH). format-32 properties come back as an
# array of C `long` (8 bytes on 64-bit) — the classic libX11 gotcha — so we read
# them as c_ulong, not c_uint32.
_x.XInternAtom.restype = ctypes.c_ulong
_x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
_x.XChangeProperty.restype = ctypes.c_int
_x.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                               ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                               ctypes.c_char_p, ctypes.c_int]
_x.XGetWindowProperty.restype = ctypes.c_int
_x.XGetWindowProperty.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
    ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
_x.XSendEvent.restype = ctypes.c_int
_x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                          ctypes.c_long, ctypes.c_void_p]
_x.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
_x.XMapRaised.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
_x.XIconifyWindow.restype = ctypes.c_int
_x.XIconifyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int]
# Geometry read + move/resize. XGetGeometry gives size in the window's own
# coords; XTranslateCoordinates maps its (0,0) to the root to get absolute x,y.
_x.XGetGeometry.restype = ctypes.c_int
_x.XGetGeometry.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint),
    ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
_x.XTranslateCoordinates.restype = ctypes.c_int
_x.XTranslateCoordinates.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_ulong)]
_x.XMoveResizeWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                                 ctypes.c_int, ctypes.c_uint, ctypes.c_uint]
_x.XMoveWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int]
# Walk the window tree to map a screen pixel to the client window that owns it.
_x.XQueryTree.restype = ctypes.c_int
_x.XQueryTree.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
    ctypes.POINTER(ctypes.c_uint)]


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


_BTN_MASK = {"left": 0x0100, "middle": 0x0200, "right": 0x0400}  # Button1/2/3Mask


def mouse_state() -> dict:
    """Read which mouse buttons are pressed *right now* plus the cursor position:
    ``{"left","right","middle": bool, "pos": (x,y)}``. ``mouse_button`` could
    press/release but nothing could *read* the buttons, so a drag whose button-up
    was lost left the floor silently stuck pressed, dragging every later move.
    ``XQueryPointer``'s modifier/button mask carries the live button bits; the
    button-read dual of ``mouse_button`` (mirrors the Win32 backend)."""
    rr = ctypes.c_ulong(); cr = ctypes.c_ulong()
    rx = ctypes.c_int(); ry = ctypes.c_int(); wx = ctypes.c_int(); wy = ctypes.c_int()
    mask = ctypes.c_uint()
    with _lock:
        _x.XQueryPointer(_dpy, _root, ctypes.byref(rr), ctypes.byref(cr),
                         ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx),
                         ctypes.byref(wy), ctypes.byref(mask))
    s = {name: bool(mask.value & bit) for name, bit in _BTN_MASK.items()}
    s["pos"] = (rx.value, ry.value)
    return s


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
    0x14: 0xFFE5, 0x90: 0xFF7F,  # F177: CapsLock / NumLock — key_state could
    # READ these latches but key_down/up had no keysym to actuate them.
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
    if not kc:  # F177: keysym unmapped here. XTEST with keycode 0 is a fatal
        return  # BadValue (kills the process); a no-op press is the honest floor.
    with _lock:
        _xt.XTestFakeKeyEvent(_dpy, kc, 1, 0)
        _x.XFlush(_dpy)


def key_up(vk: int) -> None:
    kc = _x.XKeysymToKeycode(_dpy, _vk_keysym(vk))
    if not kc:  # F177: see key_down — never hand keycode 0 to XTEST.
        return
    with _lock:
        _xt.XTestFakeKeyEvent(_dpy, kc, 0, 0)
        _x.XFlush(_dpy)


class _XkbStateRec(ctypes.Structure):
    _fields_ = [("group", ctypes.c_ubyte), ("locked_group", ctypes.c_ubyte),
                ("base_group", ctypes.c_ushort), ("latched_group", ctypes.c_ushort),
                ("mods", ctypes.c_ubyte), ("base_mods", ctypes.c_ubyte),
                ("latched_mods", ctypes.c_ubyte), ("locked_mods", ctypes.c_ubyte),
                ("compat_state", ctypes.c_ubyte), ("grab_mods", ctypes.c_ubyte),
                ("compat_grab_mods", ctypes.c_ubyte), ("lookup_mods", ctypes.c_ubyte),
                ("compat_lookup_mods", ctypes.c_ubyte), ("ptr_buttons", ctypes.c_ushort)]


_XKB_USE_CORE_KBD = 0x0100
_LOCK_MASK = 0x02   # CapsLock
_MOD2_MASK = 0x10   # NumLock (conventional)
_VK_LOCKMASK = {0x14: _LOCK_MASK, 0x90: _MOD2_MASK}  # VK_CAPITAL, VK_NUMLOCK


def key_state(vk: int) -> dict:
    """Read a key's live state: ``{"down": bool, "toggled": bool}``. The floor
    could *press*/*release* keys but never *read* them, so it held modifiers and
    typed blind — a stuck Shift or a silently-on CapsLock would corrupt all
    later typing undetectably. ``down`` comes from ``XQueryKeymap`` (the physical
    keymap bitmap); ``toggled`` from the Xkb locked-mods (CapsLock/NumLock). The
    read dual of the keyboard writes (mirrors the Win32 backend)."""
    with _lock:
        keys = (ctypes.c_char * 32)()
        _x.XQueryKeymap(_dpy, keys)
        kc = _x.XKeysymToKeycode(_dpy, _vk_keysym(vk))
        down = bool(keys[kc >> 3][0] & (1 << (kc & 7))) if 0 <= kc < 256 else False
        toggled = False
        mask = _VK_LOCKMASK.get(vk)
        if mask is not None:
            st = _XkbStateRec()
            if _x.XkbGetState(_dpy, _XKB_USE_CORE_KBD, ctypes.byref(st)) == 0:
                toggled = bool(st.locked_mods & mask)
        return {"down": down, "toggled": toggled}


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


# ---- windows (EWMH enumerate + activate) ---------------------------------- #
def _atom(name: str) -> int:
    return _x.XInternAtom(_dpy, name.encode(), 0)


def _prop(win: int, prop_atom: int, req_type: int) -> bytes | None:
    """Read a window property as raw bytes (or None). Handles the 64-bit format-32
    quirk by always fetching as bytes via the returned format/nitems."""
    actual_type = ctypes.c_ulong()
    actual_fmt = ctypes.c_int()
    nitems = ctypes.c_ulong()
    bytes_after = ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    r = _x.XGetWindowProperty(_dpy, win, prop_atom, 0, 1 << 20, 0, req_type,
                              ctypes.byref(actual_type), ctypes.byref(actual_fmt),
                              ctypes.byref(nitems), ctypes.byref(bytes_after),
                              ctypes.byref(data))
    if r != 0 or not data:
        return None
    fmt = actual_fmt.value
    n = nitems.value
    width = {8: 1, 16: 2, 32: ctypes.sizeof(ctypes.c_long)}.get(fmt, 0)
    nbytes = n * width
    out = bytes(bytearray(ctypes.cast(
        data, ctypes.POINTER(ctypes.c_ubyte * nbytes)).contents)) if nbytes else b""
    _x.XFree(data)
    return out


def _win_title(win: int) -> str:
    for prop_atom, typ in ((_atom("_NET_WM_NAME"), _atom("UTF8_STRING")),
                           (_atom("WM_NAME"), 31)):  # 31 = XA_STRING
        raw = _prop(win, prop_atom, typ)
        if raw:
            return raw.split(b"\x00", 1)[0].decode("utf-8", "replace")
    return ""


def _wm_class(win: int) -> str:
    raw = _prop(win, _atom("WM_CLASS"), 31)  # 31 = XA_STRING
    if not raw:
        return ""
    parts = raw.split(b"\x00")
    return (parts[1] if len(parts) > 1 and parts[1] else parts[0]).decode(
        "utf-8", "replace")


def window_text(win: int) -> str:
    """Read the *text a window carries* — its name/title via ``_NET_WM_NAME`` /
    ``WM_NAME``. On Windows this also reaches *inside* to a child control's content
    (an edit box's text); on X11 toolkits paint their own widgets, so the OS sees
    only window-level names — this returns that, the closest honest analogue. The
    semantic string the OS holds, OCR-free."""
    with _lock:
        return _win_title(win)


_PROP_REPLACE = 0  # PropModeReplace


def set_window_text(win: int, text: str) -> bool:
    """*Write* the text a window carries — the write dual of :func:`window_text`.
    On Windows ``WM_SETTEXT`` sets a child control's content directly; on X11
    toolkits own their widget text, so the OS-level write reaches the window
    *name* (``_NET_WM_NAME`` UTF-8 + ``WM_NAME``) — the honest analogue of the
    read side. Returns True."""
    data = text.encode("utf-8")
    with _lock:
        for atom, typ in ((_atom("_NET_WM_NAME"), _atom("UTF8_STRING")),
                          (_atom("WM_NAME"), 31)):  # 31 = XA_STRING
            _x.XChangeProperty(_dpy, win, atom, typ, 8, _PROP_REPLACE,
                               data, len(data))
        _x.XFlush(_dpy)
    return True


def child_windows(win: int) -> list:
    """Descend into a window's child windows as ``[{"id","class","text"}, …]``
    (``XQueryTree`` children; class from ``WM_CLASS``, text from
    :func:`window_text`). The floor could enumerate top-level windows but never
    look *inside* one. Mirrors the Win32 ``EnumChildWindows`` (where children are
    the actual edit/label/button controls; under X11 they are the sub-windows the
    toolkit chose to create)."""
    with _lock:
        root_r = ctypes.c_ulong(); parent_r = ctypes.c_ulong()
        kids = ctypes.POINTER(ctypes.c_ulong)(); nkids = ctypes.c_uint()
        if not _x.XQueryTree(_dpy, win, ctypes.byref(root_r), ctypes.byref(parent_r),
                             ctypes.byref(kids), ctypes.byref(nkids)):
            return []
        out = []
        try:
            for i in range(nkids.value):
                c = int(kids[i])
                out.append({"id": c & 0xFFFFFFFF, "class": _wm_class(c),
                            "text": _win_title(c)})
        finally:
            if kids:
                _x.XFree(ctypes.cast(kids, ctypes.c_void_p))
        return out


def _abs_rect(win: int) -> tuple:
    root = ctypes.c_ulong(); gx = ctypes.c_int(); gy = ctypes.c_int()
    gw = ctypes.c_uint(); gh = ctypes.c_uint(); bw = ctypes.c_uint(); d = ctypes.c_uint()
    if not _x.XGetGeometry(_dpy, win, ctypes.byref(root), ctypes.byref(gx),
                           ctypes.byref(gy), ctypes.byref(gw), ctypes.byref(gh),
                           ctypes.byref(bw), ctypes.byref(d)):
        return (0, 0, 0, 0)
    ax = ctypes.c_int(); ay = ctypes.c_int(); ch = ctypes.c_ulong()
    _x.XTranslateCoordinates(_dpy, win, _root, 0, 0, ctypes.byref(ax),
                             ctypes.byref(ay), ctypes.byref(ch))
    return (int(ax.value), int(ay.value), int(gw.value), int(gh.value))


def _walk_tree(win: int, cl, tl, depth: int = 0):
    if depth > 64:
        return None
    root_r = ctypes.c_ulong(); parent_r = ctypes.c_ulong()
    kids = ctypes.POINTER(ctypes.c_ulong)(); nkids = ctypes.c_uint()
    if not _x.XQueryTree(_dpy, win, ctypes.byref(root_r), ctypes.byref(parent_r),
                         ctypes.byref(kids), ctypes.byref(nkids)):
        return None
    try:
        for i in range(nkids.value):
            c = int(kids[i])
            ccls = _wm_class(c); ctext = _win_title(c)
            if (cl is None or cl in ccls.lower()) and \
               (tl is None or tl in (ctext or "").lower()):
                return {"id": c & 0xFFFFFFFF, "class": ccls, "text": ctext,
                        "rect": _abs_rect(c)}
            hit = _walk_tree(c, cl, tl, depth + 1)
            if hit:
                return hit
    finally:
        if kids:
            _x.XFree(ctypes.cast(kids, ctypes.c_void_p))
    return None


def find_control(top: int, cls=None, text=None):
    """Find a child window inside ``top`` by its *meaning* (class and/or name,
    case-insensitive substring) and report *where it is*:
    ``{"id","class","text","rect":(x,y,w,h)}`` in screen coords, or None. The dual
    of :func:`control_at` — that maps a pixel to a control, this maps a control's
    meaning to a pixel rect the mouse can click. (Win32 children are real controls;
    under X11 toolkits often paint one window, so the matchable tree is shallower —
    the honest analogue.)"""
    with _lock:
        return _walk_tree(int(top), cls.lower() if cls else None,
                          text.lower() if text else None)


def list_windows() -> list:
    """Enumerate top-level windows the window manager manages (EWMH
    ``_NET_CLIENT_LIST``), newest last. Each item is ``{"id", "title"}``.

    This is the eye that *finds the right window* — the floor previously acted
    only on whatever happened to hold focus, so on a busy desktop input could
    land in the wrong place. Each item also carries ``"desktop"`` (the workspace
    it lives on; -1 = sticky) so the floor can *see* a window is off the current
    workspace — invisible and unclickable until switched to or pulled over.
    Falls back to an empty list if the WM is not EWMH."""
    with _lock:
        raw = _prop(_root, _atom("_NET_CLIENT_LIST"), 33)  # 33 = XA_WINDOW
        if not raw:
            return []
        wl = ctypes.c_long
        n = len(raw) // ctypes.sizeof(wl)
        ids = ctypes.cast(raw, ctypes.POINTER(wl * n)).contents
        cur = _read_card(_root, "_NET_CURRENT_DESKTOP")  # read inline; _lock held
        cur = cur if cur is not None else 0
        out = []
        for w in ids:
            if not int(w):
                continue
            d = _read_card(int(w), "_NET_WM_DESKTOP")
            out.append({"id": int(w) & 0xFFFFFFFF, "title": _win_title(int(w)),
                        "desktop": (-1 if d == _ALL_DESKTOPS else d)
                        if d is not None else cur})
        return out


def activate_window(win: int) -> bool:
    """Raise and focus a window by id via an EWMH ``_NET_ACTIVE_WINDOW`` client
    message to the root (the request a pager/taskbar makes), then map+raise it.
    Returns True if the request was dispatched."""
    with _lock:
        class _CM(ctypes.Structure):  # XClientMessageEvent (data as 5 longs)
            _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                        ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                        ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                        ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]
        ev = _CM(type=33, send_event=1, display=_dpy, window=win,  # 33 = ClientMessage
                 message_type=_atom("_NET_ACTIVE_WINDOW"), format=32)
        ev.data[0] = 2          # source indication: pager
        ev.data[1] = 0          # timestamp (CurrentTime)
        SUBSTRUCTURE = (1 << 19) | (1 << 20)  # Redirect | Notify
        ok = _x.XSendEvent(_dpy, _root, 0, SUBSTRUCTURE, ctypes.byref(ev))
        _x.XMapRaised(_dpy, win)
        _x.XRaiseWindow(_dpy, win)
        _x.XFlush(_dpy)
        _x.XSync(_dpy, 0)
        return bool(ok)


def close_window(win: int) -> bool:
    """Ask the WM to close a window *by identity* via an EWMH
    ``_NET_CLOSE_WINDOW`` client message (what a pager's close button sends) —
    the graceful path that runs the app's own close handlers, unlike killing the
    process. Screenshot+click would have to hunt the ✕ pixel."""
    with _lock:
        class _CM(ctypes.Structure):
            _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                        ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                        ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                        ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]
        ev = _CM(type=33, send_event=1, display=_dpy, window=win,  # 33 = ClientMessage
                 message_type=_atom("_NET_CLOSE_WINDOW"), format=32)
        ev.data[0] = 0          # timestamp (CurrentTime)
        ev.data[1] = 2          # source indication: pager
        SUBSTRUCTURE = (1 << 19) | (1 << 20)  # Redirect | Notify
        ok = _x.XSendEvent(_dpy, _root, 0, SUBSTRUCTURE, ctypes.byref(ev))
        _x.XFlush(_dpy)
        _x.XSync(_dpy, 0)
        return bool(ok)


def window_exists(win: int) -> bool:
    """Whether the WM still manages this window (present in ``_NET_CLIENT_LIST``)
    — the read that lets the floor wait for a window to appear or confirm it has
    closed."""
    with _lock:
        raw = _prop(_root, _atom("_NET_CLIENT_LIST"), 33)  # 33 = XA_WINDOW
        if not raw:
            return False
        wl = ctypes.c_long
        n = len(raw) // ctypes.sizeof(wl)
        ids = {int(w) & 0xFFFFFFFF
               for w in ctypes.cast(raw, ctypes.POINTER(wl * n)).contents}
        return (int(win) & 0xFFFFFFFF) in ids


def active_window() -> "int | None":
    """Which top-level window currently holds keyboard focus — the id a ``type``
    or key press would reach right now — or None. The keyboard follows *focus*
    while the mouse follows the *stack*: ``activate_window`` could *write* focus
    yet nothing could *read* it, so the floor typed blind. Read EWMH
    ``_NET_ACTIVE_WINDOW`` off the root — the focus-read dual of
    ``activate_window``, as ``window_under`` is the stack-read dual."""
    with _lock:
        raw = _prop(_root, _atom("_NET_ACTIVE_WINDOW"), 33)  # 33 = XA_WINDOW
        if not raw or len(raw) < ctypes.sizeof(ctypes.c_long):
            return None
        win = int(ctypes.cast(raw, ctypes.POINTER(ctypes.c_long))[0]) & 0xFFFFFFFF
        return win or None


def _net_wm_state(win: int, action: int, p1: int, p2: int = 0) -> bool:
    """Send an EWMH ``_NET_WM_STATE`` client message (action 0=remove, 1=add,
    2=toggle) to add/remove up to two state atoms at once — the request a pager
    makes to (un)maximize a window."""
    class _CM(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                    ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                    ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                    ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]
    ev = _CM(type=33, send_event=1, display=_dpy, window=win,
             message_type=_atom("_NET_WM_STATE"), format=32)
    ev.data[0] = action
    ev.data[1] = p1
    ev.data[2] = p2
    ev.data[3] = 2  # source indication: pager
    SUBSTRUCTURE = (1 << 19) | (1 << 20)
    ok = _x.XSendEvent(_dpy, _root, 0, SUBSTRUCTURE, ctypes.byref(ev))
    _x.XFlush(_dpy)
    return bool(ok)


def window_state(win: int) -> "str | None":
    """Read a window's show-state — ``"minimized"``, ``"maximized"`` or
    ``"normal"`` — or None if unmanaged. Geometry tells *where* a window is, not
    *how it is shown*: minimized via ICCCM ``WM_STATE`` (IconicState); maximized
    when ``_NET_WM_STATE`` carries both MAXIMIZED_VERT and _HORZ. A screenshot
    cannot tell a maximized window from one merely sized to the screen, nor a
    minimized window from a closed one."""
    with _lock:
        if not window_exists(win):
            return None
        wsa = _atom("WM_STATE")
        raw = _prop(win, wsa, wsa)
        if raw and len(raw) >= ctypes.sizeof(ctypes.c_long):
            st = ctypes.cast(raw, ctypes.POINTER(ctypes.c_long))[0]
            if st == 3:  # IconicState
                return "minimized"
        raw = _prop(win, _atom("_NET_WM_STATE"), 4)  # 4 = XA_ATOM
        if raw:
            al = ctypes.c_long
            n = len(raw) // ctypes.sizeof(al)
            atoms = {int(a) for a in ctypes.cast(raw, ctypes.POINTER(al * n)).contents}
            if {_atom("_NET_WM_STATE_MAXIMIZED_VERT"),
                _atom("_NET_WM_STATE_MAXIMIZED_HORZ")} <= atoms:
                return "maximized"
        return "normal"


def set_window_state(win: int, state: str) -> bool:
    """Minimize / maximize / restore a window *by identity* — the everyday
    title-bar gestures. Minimize via ``XIconifyWindow`` (ICCCM); maximize/restore
    by adding/removing the two ``_NET_WM_STATE_MAXIMIZED_*`` atoms via EWMH.
    Screenshot+click would have to hunt the min/max-button pixels. Unknown state
    returns False."""
    if state not in ("minimized", "maximized", "normal"):
        return False
    with _lock:
        if not window_exists(win):
            return False
        mv = _atom("_NET_WM_STATE_MAXIMIZED_VERT")
        mh = _atom("_NET_WM_STATE_MAXIMIZED_HORZ")
        if state == "minimized":
            ok = bool(_x.XIconifyWindow(_dpy, win, _screen))
        elif state == "maximized":
            ok = _net_wm_state(win, 1, mv, mh)  # 1 = add
        else:  # normal
            _net_wm_state(win, 0, mv, mh)       # 0 = remove maximize
            _x.XMapRaised(_dpy, win)            # de-iconify if minimized
            ok = True
        _x.XSync(_dpy, 0)
        return ok


def window_pid(win: int) -> "int | None":
    """Which OS process owns a window — its identity *beyond the title*. Two
    windows can share an identical title, which a title cannot tell apart; the
    owning pid can, and it is what lets the floor escalate a graceful close to a
    forceful kill. Read EWMH ``_NET_WM_PID`` (a CARDINAL); None if absent."""
    with _lock:
        raw = _prop(win, _atom("_NET_WM_PID"), 6)  # 6 = XA_CARDINAL
        if not raw or len(raw) < ctypes.sizeof(ctypes.c_long):
            return None
        pid = int(ctypes.cast(raw, ctypes.POINTER(ctypes.c_long))[0])
        return pid or None


def terminate_window(win: int) -> bool:
    """Force the owning process of a window to end — the *forceful* death dual to
    the graceful ``close_window`` (_NET_CLOSE_WINDOW). When an app ignores the
    polite close (a hung window, a modal that won't dismiss), this kills the pid
    behind it (``SIGKILL``). Works for a local client carrying ``_NET_WM_PID``;
    returns False if no pid is known or the kill fails."""
    pid = window_pid(win)
    if not pid:
        return False
    try:
        os.kill(pid, signal.SIGKILL)
        return True
    except OSError:
        return False


def is_window_topmost(win: int) -> bool:
    """Whether a window is pinned *always-on-top* — it stays above ordinary
    windows even without focus, decoupling the stack from focus. Read as
    ``_NET_WM_STATE_ABOVE`` in ``_NET_WM_STATE``; the read dual of
    ``set_window_topmost``."""
    with _lock:
        raw = _prop(win, _atom("_NET_WM_STATE"), 4)  # 4 = XA_ATOM
        if not raw:
            return False
        al = ctypes.c_long
        n = len(raw) // ctypes.sizeof(al)
        atoms = {int(a) for a in ctypes.cast(raw, ctypes.POINTER(al * n)).contents}
        return _atom("_NET_WM_STATE_ABOVE") in atoms


def set_window_topmost(win: int, on: bool = True) -> bool:
    """Pin / unpin a window *always-on-top* by identity — it then stays above
    non-topmost windows regardless of focus, the one case where stack and focus
    must deliberately diverge. EWMH ``_NET_WM_STATE`` add/remove of
    ``_NET_WM_STATE_ABOVE``."""
    with _lock:
        if not window_exists(win):
            return False
        return _net_wm_state(win, 1 if on else 0, _atom("_NET_WM_STATE_ABOVE"))


def _has_wm_state(win: int) -> bool:
    ws = _atom("WM_STATE")
    return _prop(win, ws, ws) is not None


def _client_of(win: int, depth: int = 0) -> "int | None":
    """Descend a window subtree to the managed client window (the one bearing
    ``WM_STATE``), the ICCCM way — a reparenting WM wraps the client in frame/
    decoration windows, so the window directly under a pixel is usually a frame,
    not the id ``list_windows`` reports."""
    if win == 0 or depth > 8:
        return None
    if _has_wm_state(win):
        return win
    root_r = ctypes.c_ulong()
    parent_r = ctypes.c_ulong()
    kids = ctypes.POINTER(ctypes.c_ulong)()
    nkids = ctypes.c_uint()
    if not _x.XQueryTree(_dpy, win, ctypes.byref(root_r), ctypes.byref(parent_r),
                         ctypes.byref(kids), ctypes.byref(nkids)):
        return None
    found = None
    try:
        # Topmost child is last in XQueryTree order; search front-to-back.
        for i in range(nkids.value - 1, -1, -1):
            found = _client_of(int(kids[i]), depth + 1)
            if found is not None:
                break
    finally:
        if kids:
            _x.XFree(kids)
    return found


def window_under(x: int, y: int) -> "int | None":
    """Which top-level window owns the screen pixel ``(x, y)`` — the id a real
    mouse click there would land on, or None if the point is bare root.

    A click lands on whoever owns that pixel in the Z-order; the keyboard follows
    focus, but the mouse follows the stack. ``activate_window`` could *write* the
    stack, yet nothing could *read* it, so the floor clicked blind. We translate
    the point through the root to the toplevel beneath it, then descend to the
    ``WM_STATE``-bearing client so the result keys against ``list_windows``. Only
    a window the WM actually manages (in ``_NET_CLIENT_LIST``) is returned."""
    with _lock:
        cx = ctypes.c_int()
        cy = ctypes.c_int()
        child = ctypes.c_ulong()
        _x.XTranslateCoordinates(_dpy, _root, _root, int(x), int(y),
                                 ctypes.byref(cx), ctypes.byref(cy),
                                 ctypes.byref(child))
        top = child.value
        if not top:
            return None
        client = _client_of(top) or top
        # Confirm it is a managed client before reporting it.
        raw = _prop(_root, _atom("_NET_CLIENT_LIST"), 33)  # 33 = XA_WINDOW
        if raw:
            wl = ctypes.c_long
            n = len(raw) // ctypes.sizeof(wl)
            managed = {int(w) & 0xFFFFFFFF
                       for w in ctypes.cast(raw, ctypes.POINTER(wl * n)).contents}
            for cand in (client, top):
                if (int(cand) & 0xFFFFFFFF) in managed:
                    return int(cand) & 0xFFFFFFFF
            return None
        return int(client) & 0xFFFFFFFF


def control_at(x: int, y: int) -> "dict | None":
    """Which *control* (leaf window) owns the screen pixel ``(x, y)`` and what it
    says: ``{"id","class","text","top"}``. Where :func:`window_under` returns the
    managed top-level a click lands in, this descends the window tree to the
    deepest child under the point and reads its name/class — joining the pixel the
    eye sees to the semantic window behind it. (Win32 controls are real child
    windows with text; under X11 toolkits often paint one window, so the leaf may
    be the client itself — the honest OS-visible analogue.) None on bare root."""
    with _lock:
        cur = _root
        cx, cy = int(x), int(y)
        top = None
        for _ in range(64):  # bounded descent through the window tree
            nx = ctypes.c_int(); ny = ctypes.c_int(); child = ctypes.c_ulong()
            _x.XTranslateCoordinates(_dpy, _root, cur, cx, cy,
                                     ctypes.byref(nx), ctypes.byref(ny),
                                     ctypes.byref(child))
            if not child.value:
                break
            if top is None:
                top = child.value
            cur = child.value
        if cur == _root or not cur:
            return None
        client = _client_of(top) if top else None
        return {"id": int(cur) & 0xFFFFFFFF, "class": _wm_class(cur),
                "text": _win_title(cur),
                "top": (int(client) & 0xFFFFFFFF) if client else
                       (int(top) & 0xFFFFFFFF if top else None)}


_ALL_DESKTOPS = 0xFFFFFFFF  # _NET_WM_DESKTOP sentinel: window shown on every desktop


def _read_card(win: int, name: str) -> int | None:
    raw = _prop(win, _atom(name), 6)  # 6 = XA_CARDINAL
    if not raw:
        return None
    wl = ctypes.c_long
    if len(raw) < ctypes.sizeof(wl):
        return None
    return int(ctypes.cast(raw, ctypes.POINTER(wl)).contents.value) & 0xFFFFFFFF


def num_desktops() -> int:
    """How many virtual desktops (workspaces) the WM advertises
    (``_NET_NUMBER_OF_DESKTOPS``); 1 if the WM has none."""
    with _lock:
        n = _read_card(_root, "_NET_NUMBER_OF_DESKTOPS")
        return n if n else 1


def current_desktop() -> int:
    """Index of the workspace currently shown (``_NET_CURRENT_DESKTOP``)."""
    with _lock:
        n = _read_card(_root, "_NET_CURRENT_DESKTOP")
        return n if n is not None else 0


def window_desktop(win: int) -> int:
    """Which workspace a window lives on (``_NET_WM_DESKTOP``); -1 means it is
    sticky (shown on all desktops). A window whose desktop differs from
    :func:`current_desktop` has *no on-screen pixels* — no click can reach it
    until the workspace is switched or the window is pulled over."""
    with _lock:
        n = _read_card(win, "_NET_WM_DESKTOP")
        if n is None:
            cur = _read_card(_root, "_NET_CURRENT_DESKTOP")  # inline; _lock held
            return cur if cur is not None else 0
        return -1 if n == _ALL_DESKTOPS else n


def _root_card_msg(name: str, win: int, d0: int, d1: int = 0) -> bool:
    class _CM(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                    ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                    ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                    ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]
    ev = _CM(type=33, send_event=1, display=_dpy, window=win,
             message_type=_atom(name), format=32)
    ev.data[0] = d0
    ev.data[1] = d1
    SUBSTRUCTURE = (1 << 19) | (1 << 20)
    ok = _x.XSendEvent(_dpy, _root, 0, SUBSTRUCTURE, ctypes.byref(ev))
    _x.XFlush(_dpy)
    _x.XSync(_dpy, 0)
    return bool(ok)


def set_desktop(n: int) -> bool:
    """Switch the shown workspace to ``n`` (``_NET_CURRENT_DESKTOP``) — *go there*,
    the way clicking a pager cell does."""
    with _lock:
        return _root_card_msg("_NET_CURRENT_DESKTOP", _root, int(n), 0)


def move_window_to_desktop(win: int, n: int) -> bool:
    """Send a window to workspace ``n`` (``_NET_WM_DESKTOP``). With ``n`` equal to
    :func:`current_desktop` this *brings the window here* — onto the visible
    workspace without leaving it, which ``activate_window`` (which instead
    *follows* the window to its desktop) cannot express. ``n`` of -1 makes it
    sticky (all desktops)."""
    with _lock:
        d0 = _ALL_DESKTOPS if int(n) < 0 else int(n)
        return _root_card_msg("_NET_WM_DESKTOP", win, d0, 2)  # 2 = source: pager


def window_geometry(win: int) -> dict | None:
    """Absolute on-screen geometry of a window as ``{"x","y","w","h"}`` (the
    outer position the WM placed it at), or None if the window is gone. Lets the
    floor *know where a window actually is* — the prerequisite for deciding it is
    off-screen and must be moved into view."""
    with _lock:
        root = ctypes.c_ulong()
        gx, gy = ctypes.c_int(), ctypes.c_int()
        gw, gh = ctypes.c_uint(), ctypes.c_uint()
        bw, depth = ctypes.c_uint(), ctypes.c_uint()
        if not _x.XGetGeometry(_dpy, win, ctypes.byref(root), ctypes.byref(gx),
                               ctypes.byref(gy), ctypes.byref(gw), ctypes.byref(gh),
                               ctypes.byref(bw), ctypes.byref(depth)):
            return None
        ax, ay = ctypes.c_int(), ctypes.c_int()
        child = ctypes.c_ulong()
        _x.XTranslateCoordinates(_dpy, win, _root, 0, 0, ctypes.byref(ax),
                                 ctypes.byref(ay), ctypes.byref(child))
        return {"x": int(ax.value), "y": int(ay.value),
                "w": int(gw.value), "h": int(gh.value)}


def move_window(win: int, x: int, y: int, w: int = 0, h: int = 0) -> bool:
    """Move (and optionally resize) a window by id via an EWMH
    ``_NET_MOVERESIZE_WINDOW`` client message to the root, so the WM honours it
    the same way a user drag would. ``w``/``h`` of 0 leave that dimension alone.

    This is what *raising* (activate_window) cannot do: a window placed off the
    visible screen stays unreachable no matter how it is stacked — only moving it
    back into view lets a click land on it. Official screenshot+click has no way
    to reposition a window at all."""
    with _lock:
        flags = (1 << 8) | (1 << 9)          # x, y supplied
        if w:
            flags |= (1 << 10)
        if h:
            flags |= (1 << 11)
        flags |= (2 << 12)                   # source indication: pager
        flags |= 1                           # gravity: NorthWest (default)

        class _CM(ctypes.Structure):
            _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                        ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                        ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                        ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]
        ev = _CM(type=33, send_event=1, display=_dpy, window=win,  # 33 = ClientMessage
                 message_type=_atom("_NET_MOVERESIZE_WINDOW"), format=32)
        ev.data[0] = flags
        ev.data[1] = int(x)
        ev.data[2] = int(y)
        ev.data[3] = int(w)
        ev.data[4] = int(h)
        SUBSTRUCTURE = (1 << 19) | (1 << 20)  # Redirect | Notify
        ok = _x.XSendEvent(_dpy, _root, 0, SUBSTRUCTURE, ctypes.byref(ev))
        # Fallback for non-EWMH WMs: also issue the core request directly.
        if w and h:
            _x.XMoveResizeWindow(_dpy, win, int(x), int(y), int(w), int(h))
        else:
            _x.XMoveWindow(_dpy, win, int(x), int(y))
        _x.XFlush(_dpy)
        _x.XSync(_dpy, 0)
        return bool(ok)


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


# ---- semantic floor: AT-SPI (the Linux dual of Windows UIA) --------------- #
# F178. window_text/child_windows are honest about their ceiling: on X11 a
# toolkit paints its OWN widgets, so the X server only ever sees window-level
# names and opaque sub-windows — the buttons, menu items and edit fields inside
# a modern app are invisible to it. UIA gives Windows that reach; its Linux dual
# is AT-SPI (the at-spi2 accessibility bus). We bind libatspi directly by ctypes
# — same discipline as libX11/libXTst, no pyatspi/gi — and light up the very
# same uia_* verbs osctl already speaks, so the floor is one and only the ground
# differs. If the a11y bus is absent (atspi_init fails), every verb degrades to
# its empty default and never crashes — an unseen floor, never a broken one.

import threading as _threading

_atspi_lock = _threading.RLock()
_atspi_state = {"tried": False, "ok": False, "at": None, "g": None, "go": None}


class _AtspiRect(ctypes.Structure):
    _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int),
                ("width", ctypes.c_int), ("height", ctypes.c_int)]


_ATSPI_COORD_SCREEN = 0

# A control-type word the floor speaks -> the AT-SPI role name it means.
_ROLE_ALIAS = {
    "button": "push button", "edit": "text", "textbox": "text", "entry": "text",
    "checkbox": "check box", "menuitem": "menu item", "combobox": "combo box",
    "listitem": "list item", "radio": "radio button", "tab": "page tab",
    "cell": "table cell", "link": "link",
}


def _atspi():
    """Lazily load + init libatspi once. Returns the lib handle or None. Loading
    is deferred (not at import) so the backend stays importable where no a11y
    stack exists; a failure here simply leaves the semantic floor dark."""
    st = _atspi_state
    if st["tried"]:
        return st["at"] if st["ok"] else None
    st["tried"] = True
    try:
        at = ctypes.CDLL("libatspi.so.0")
        g = ctypes.CDLL("libglib-2.0.so.0")
        go = ctypes.CDLL("libgobject-2.0.so.0")
        at.atspi_init.restype = ctypes.c_int
        at.atspi_get_desktop.restype = ctypes.c_void_p
        at.atspi_get_desktop.argtypes = [ctypes.c_int]
        at.atspi_accessible_get_child_count.restype = ctypes.c_int
        at.atspi_accessible_get_child_count.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        at.atspi_accessible_get_child_at_index.restype = ctypes.c_void_p
        at.atspi_accessible_get_child_at_index.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        at.atspi_accessible_get_name.restype = ctypes.c_void_p
        at.atspi_accessible_get_name.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        at.atspi_accessible_get_role_name.restype = ctypes.c_void_p
        at.atspi_accessible_get_role_name.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        at.atspi_accessible_get_process_id.restype = ctypes.c_uint
        at.atspi_accessible_get_process_id.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        at.atspi_accessible_get_component_iface.restype = ctypes.c_void_p
        at.atspi_accessible_get_component_iface.argtypes = [ctypes.c_void_p]
        at.atspi_component_get_extents.restype = ctypes.c_void_p   # AtspiRect*
        at.atspi_component_get_extents.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p]
        at.atspi_component_grab_focus.restype = ctypes.c_int
        at.atspi_component_grab_focus.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        at.atspi_accessible_get_action_iface.restype = ctypes.c_void_p
        at.atspi_accessible_get_action_iface.argtypes = [ctypes.c_void_p]
        at.atspi_action_do_action.restype = ctypes.c_int
        at.atspi_action_do_action.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        at.atspi_accessible_get_text_iface.restype = ctypes.c_void_p
        at.atspi_accessible_get_text_iface.argtypes = [ctypes.c_void_p]
        at.atspi_text_get_character_count.restype = ctypes.c_int
        at.atspi_text_get_character_count.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        at.atspi_text_get_text.restype = ctypes.c_void_p
        at.atspi_text_get_text.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        at.atspi_accessible_get_editable_text_iface.restype = ctypes.c_void_p
        at.atspi_accessible_get_editable_text_iface.argtypes = [ctypes.c_void_p]
        at.atspi_editable_text_set_text_contents.restype = ctypes.c_int
        at.atspi_editable_text_set_text_contents.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p]
        at.atspi_accessible_get_value_iface.restype = ctypes.c_void_p
        at.atspi_accessible_get_value_iface.argtypes = [ctypes.c_void_p]
        at.atspi_value_get_current_value.restype = ctypes.c_double
        at.atspi_value_get_current_value.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        at.atspi_rect_free.restype = None
        at.atspi_rect_free.argtypes = [ctypes.c_void_p]
        g.g_free.argtypes = [ctypes.c_void_p]
        go.g_object_unref.argtypes = [ctypes.c_void_p]
        if at.atspi_init() not in (0, 1):  # 0 = newly inited, 1 = already
            return None
        st["at"], st["g"], st["go"], st["ok"] = at, g, go, True
        return at
    except OSError:
        return None


def _gstr(ptr):
    if not ptr:
        return ""
    s = ctypes.string_at(ptr).decode("utf-8", "replace")
    _atspi_state["g"].g_free(ptr)
    return s


def _unref(acc):
    if acc:
        _atspi_state["go"].g_object_unref(acc)


def _acc_name(at, acc):
    return _gstr(at.atspi_accessible_get_name(acc, None))


def _acc_role(at, acc):
    return _gstr(at.atspi_accessible_get_role_name(acc, None))


def _acc_children(at, acc):
    n = at.atspi_accessible_get_child_count(acc, None)
    out = []
    for i in range(n):
        c = at.atspi_accessible_get_child_at_index(acc, i, None)
        if c:
            out.append(c)
    return out


def _acc_rect(at, acc):
    comp = at.atspi_accessible_get_component_iface(acc)
    if not comp:
        return None
    rp = at.atspi_component_get_extents(comp, _ATSPI_COORD_SCREEN, None)
    _unref(comp)
    if not rp:
        return None
    r = ctypes.cast(rp, ctypes.POINTER(_AtspiRect)).contents
    rect = (r.x, r.y, r.width, r.height)
    at.atspi_rect_free(rp)
    if rect[2] <= 0 or rect[3] <= 0:
        return None
    return rect


def _atspi_frame_for(at, win):
    """Map an X window id to its AT-SPI frame accessible. Identity crosses the
    two worlds by process id (EWMH _NET_WM_PID == atspi app pid); the window
    title disambiguates when one app owns several frames. Caller owns the
    returned ref (must _unref)."""
    pid = window_pid(win)
    title = (window_text(win) or "").strip()
    desk = at.atspi_get_desktop(0)
    if not desk:
        return None
    best = None
    try:
        for app in _acc_children(at, desk):
            app_pid = at.atspi_accessible_get_process_id(app, None)
            pid_match = pid is not None and app_pid == pid
            for fr in _acc_children(at, app):
                role = _acc_role(at, fr).lower()
                if role not in ("frame", "window", "dialog", "alert"):
                    _unref(fr)
                    continue
                nm = _acc_name(at, fr).strip()
                if title and nm == title:
                    _unref(best) if best else None
                    _unref(app)
                    _unref(desk)
                    return fr
                if pid_match and best is None:
                    best = fr            # keep as fallback, don't unref
                else:
                    _unref(fr)
            _unref(app)
    finally:
        _unref(desk)
    return best


def _match(at, acc, name, ctype):
    if name is not None:
        nm = _acc_name(at, acc).lower()
        if name.lower() != nm and name.lower() not in nm:
            return False
    if ctype is not None:
        want = ctype.lower()
        want = _ROLE_ALIAS.get(want, want)
        rl = _acc_role(at, acc).lower()
        if want != rl and want not in rl:
            return False
    return True


def _walk(at, acc, fn, depth=0, _budget=None):
    """Depth-first visit. fn(acc) may return a truthy value to stop early (that
    value is returned). Bounded by depth and a node budget so a pathological
    tree can never hang the floor."""
    if _budget is None:
        _budget = [4000]
    if depth > 40 or _budget[0] <= 0:
        return None
    _budget[0] -= 1
    hit = fn(acc, depth)
    if hit:
        return hit
    for c in _acc_children(at, acc):
        r = _walk(at, c, fn, depth + 1, _budget)
        if r is not None:
            # Each accessible holds its own ref (get_child_at_index is transfer
            # full), so unref'ing an ancestor never frees the match. Only skip
            # the unref when the match IS this child — then its ref passes to
            # the caller (used by _find_acc, which returns a live accessible).
            if r is not c:
                _unref(c)
            return r
        _unref(c)
    return None


def uia_name(win: int) -> str:
    """The accessible name a window carries at the a11y layer — its frame name
    as the toolkit reports it (often richer/cleaner than the raw WM title). The
    semantic dual of window_text that reads from the app's own accessibility,
    not the X server's WM hints. '' if no a11y."""
    at = _atspi()
    if not at:
        return ""
    with _atspi_lock:
        fr = _atspi_frame_for(at, win)
        if not fr:
            return ""
        try:
            return _acc_name(at, fr)
        finally:
            _unref(fr)


def uia_children(win: int) -> list:
    """Enumerate the *real controls inside* a window as
    ``[{"name","ctype","rect"}, …]`` — the buttons, menu items, fields and
    labels the toolkit painted, which child_windows (opaque sub-windows) could
    never name. This is the floor finally seeing *inside* a modern Linux app,
    the dual of UIA control enumeration. Named/actionable nodes only, bounded."""
    at = _atspi()
    if not at:
        return []
    with _atspi_lock:
        fr = _atspi_frame_for(at, win)
        if not fr:
            return []
        out = []

        def visit(acc, depth):
            nm = _acc_name(at, acc)
            rl = _acc_role(at, acc)
            if depth > 0 and (nm or rl in ("push button", "menu item", "check box",
                                           "radio button", "text", "page tab",
                                           "combo box", "link", "slider")):
                out.append({"name": nm, "ctype": rl, "rect": _acc_rect(at, acc)})
            return None

        try:
            _walk(at, fr, visit)
        finally:
            _unref(fr)
        return out


def uia_find(win: int, name=None, ctype=None):
    """Locate one control inside a window by meaning — by accessible name and/or
    role — and return ``{"name","ctype","rect":(x,y,w,h)}`` (screen rect) or
    None. The crucial bridge: semantics in, geometry out, so the pixel/input
    floor can then click the centre of a control it found by *what it is*."""
    at = _atspi()
    if not at:
        return None
    with _atspi_lock:
        fr = _atspi_frame_for(at, win)
        if not fr:
            return None

        def visit(acc, depth):
            if depth > 0 and _match(at, acc, name, ctype):
                return {"name": _acc_name(at, acc), "ctype": _acc_role(at, acc),
                        "rect": _acc_rect(at, acc)}
            return None

        try:
            return _walk(at, fr, visit)
        finally:
            _unref(fr)


def _find_acc(at, fr, name, ctype):
    """DFS for the matching accessible itself (caller must _unref the result)."""
    def visit(acc, depth):
        if depth > 0 and _match(at, acc, name, ctype):
            return acc
        return None
    return _walk(at, fr, visit)


def uia_invoke(win: int, name=None, ctype=None) -> bool:
    """Press a control by meaning — fire its default action (Action.do_action 0)
    on the element matched by name/role. The semantic dual of a mouse click that
    needs no pixels: a button, menu item or link actuated by *what it is*."""
    at = _atspi()
    if not at:
        return False
    with _atspi_lock:
        fr = _atspi_frame_for(at, win)
        if not fr:
            return False
        try:
            acc = _find_acc(at, fr, name, ctype)
            if not acc:
                return False
            try:
                action = at.atspi_accessible_get_action_iface(acc)
                if not action:
                    return False
                ok = bool(at.atspi_action_do_action(action, 0, None))
                _unref(action)
                return ok
            finally:
                _unref(acc)
        finally:
            _unref(fr)


def uia_get_value(win: int, name=None, ctype=None) -> str:
    """Read a control's text content by meaning — the full text of the matched
    element (Text interface), or its numeric Value as a string when it carries
    no text. The read dual of uia_set_value; reaches inside the widget the X
    server only saw as an opaque sub-window."""
    at = _atspi()
    if not at:
        return ""
    with _atspi_lock:
        fr = _atspi_frame_for(at, win)
        if not fr:
            return ""
        try:
            acc = _find_acc(at, fr, name, ctype)
            if not acc:
                return ""
            try:
                text = at.atspi_accessible_get_text_iface(acc)
                if text:
                    n = at.atspi_text_get_character_count(text, None)
                    s = _gstr(at.atspi_text_get_text(text, 0, n, None))
                    _unref(text)
                    return s
                val = at.atspi_accessible_get_value_iface(acc)
                if val:
                    v = at.atspi_value_get_current_value(val, None)
                    _unref(val)
                    return repr(v)
                return ""
            finally:
                _unref(acc)
        finally:
            _unref(fr)


def uia_set_value(win: int, value: str, name=None, ctype=None) -> bool:
    """Write a control's text by meaning — replace the matched editable field's
    contents (EditableText.set_text_contents) with no keystroke stream at all.
    The write dual of uia_get_value; the toolkit's own text, set directly."""
    at = _atspi()
    if not at:
        return False
    with _atspi_lock:
        fr = _atspi_frame_for(at, win)
        if not fr:
            return False
        try:
            acc = _find_acc(at, fr, name, ctype)
            if not acc:
                return False
            try:
                et = at.atspi_accessible_get_editable_text_iface(acc)
                if not et:
                    return False
                ok = bool(at.atspi_editable_text_set_text_contents(
                    et, value.encode("utf-8"), None))
                _unref(et)
                return ok
            finally:
                _unref(acc)
        finally:
            _unref(fr)


def uia_focus(win: int, name=None, ctype=None) -> bool:
    """Give keyboard focus to a control by meaning (Component.grab_focus) — so a
    field found semantically can then receive the keyboard floor's typing."""
    at = _atspi()
    if not at:
        return False
    with _atspi_lock:
        fr = _atspi_frame_for(at, win)
        if not fr:
            return False
        try:
            acc = _find_acc(at, fr, name, ctype)
            if not acc:
                return False
            try:
                comp = at.atspi_accessible_get_component_iface(acc)
                if not comp:
                    return False
                ok = bool(at.atspi_component_grab_focus(comp, None))
                _unref(comp)
                return ok
            finally:
                _unref(acc)
        finally:
            _unref(fr)
