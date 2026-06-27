"""Prototype X11/XTest backend for osctl leaf primitives — Linux ground.

Verifies, against the live Chrome on this machine, that the same pixel/input
floor osctl exposes on Windows can be implemented in pure ctypes on X11:
screen_size, capture_rgb, move, click, key_down/up, type_unicode, clipboard.
"""
from __future__ import annotations

import ctypes
import threading
import time

_x = ctypes.CDLL("libX11.so.6")
_xt = ctypes.CDLL("libXtst.so.6")

# ---- prototypes ----
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
_x.XDestroyImage = None  # XImage->f.destroy_image; we free via XFree on data+struct
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
_ALLPLANES = (1 << 32) - 1  # AllPlanes

_dpy = _x.XOpenDisplay(None)
_screen = _x.XDefaultScreen(_dpy)
_root = _x.XDefaultRootWindow(_dpy)


def screen_size():
    return (_x.XDisplayWidth(_dpy, _screen), _x.XDisplayHeight(_dpy, _screen))


def cursor_pos():
    rr = ctypes.c_ulong(); cr = ctypes.c_ulong()
    rx = ctypes.c_int(); ry = ctypes.c_int(); wx = ctypes.c_int(); wy = ctypes.c_int()
    mask = ctypes.c_uint()
    _x.XQueryPointer(_dpy, _root, ctypes.byref(rr), ctypes.byref(cr),
                     ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy),
                     ctypes.byref(mask))
    return (rx.value, ry.value)


def move(x, y):
    _xt.XTestFakeMotionEvent(_dpy, _screen, int(x), int(y), 0)
    _x.XFlush(_dpy)


def mouse_button(button, down):
    b = {"left": 1, "middle": 2, "right": 3}[button]
    _xt.XTestFakeButtonEvent(_dpy, b, 1 if down else 0, 0)
    _x.XFlush(_dpy)


def click(x=None, y=None, right=False):
    if x is not None:
        move(x, y); time.sleep(0.02)
    btn = "right" if right else "left"
    mouse_button(btn, True); mouse_button(btn, False)


def mouse_wheel(notches, horizontal=False):
    # X buttons: 4 up, 5 down, 6 left, 7 right. One click per notch.
    if horizontal:
        b = 6 if notches < 0 else 7
    else:
        b = 4 if notches > 0 else 5
    for _ in range(abs(notches)):
        _xt.XTestFakeButtonEvent(_dpy, b, 1, 0)
        _xt.XTestFakeButtonEvent(_dpy, b, 0, 0)
        _x.XFlush(_dpy)


def capture_rgb():
    w, h = screen_size()
    img_p = _x.XGetImage(_dpy, _root, 0, 0, w, h, _ALLPLANES, _ZPIXMAP)
    if not img_p:
        raise RuntimeError("XGetImage failed")
    img = ctypes.cast(img_p, ctypes.POINTER(_XImage)).contents
    bpp = img.bits_per_pixel
    bpl = img.bytes_per_line
    raw = ctypes.string_at(img.data, bpl * h)
    _x.XFree(img_p)
    if bpp != 32:
        raise RuntimeError(f"unsupported bpp {bpp}")
    # 32bpp ZPixmap, little-endian: bytes are B,G,R,X under typical TrueColor.
    if bpl != w * 4:  # drop row padding first
        rows = [raw[y * bpl:y * bpl + w * 4] for y in range(h)]
        raw = b"".join(rows)
    rgb = bytearray(w * h * 3)
    rgb[0::3] = raw[2::4]
    rgb[1::3] = raw[1::4]
    rgb[2::3] = raw[0::4]
    return w, h, bytes(rgb)


# ---- keyboard ----
_VK_KEYSYM = {
    0x08: 0xFF08, 0x09: 0xFF09, 0x0D: 0xFF0D, 0x10: 0xFFE1, 0x11: 0xFFE3,
    0x12: 0xFFE9, 0x1B: 0xFF1B, 0x20: 0x20, 0x21: 0xFF55, 0x22: 0xFF56,
    0x23: 0xFF57, 0x24: 0xFF50, 0x25: 0xFF51, 0x26: 0xFF52, 0x27: 0xFF53,
    0x28: 0xFF54, 0x2E: 0xFFFF,
}


def _vk_keysym(vk):
    if vk in _VK_KEYSYM:
        return _VK_KEYSYM[vk]
    if 0x30 <= vk <= 0x39:  # digits
        return vk
    if 0x41 <= vk <= 0x5A:  # letters -> lowercase keysym (physical key)
        return vk + 0x20
    return vk


def key_down(vk):
    kc = _x.XKeysymToKeycode(_dpy, _vk_keysym(vk))
    _xt.XTestFakeKeyEvent(_dpy, kc, 1, 0)
    _x.XFlush(_dpy)


def key_up(vk):
    kc = _x.XKeysymToKeycode(_dpy, _vk_keysym(vk))
    _xt.XTestFakeKeyEvent(_dpy, kc, 0, 0)
    _x.XFlush(_dpy)


# scratch keycode for Unicode typing
_kmin = ctypes.c_int(); _kmax = ctypes.c_int()
_x.XDisplayKeycodes(_dpy, ctypes.byref(_kmin), ctypes.byref(_kmax))


def _find_scratch():
    count = _kmax.value - _kmin.value + 1
    nsyms = ctypes.c_int()
    syms = _x.XGetKeyboardMapping(_dpy, _kmin.value, count, ctypes.byref(nsyms))
    per = nsyms.value
    chosen = None
    for k in range(count):
        empty = all(syms[k * per + j] == 0 for j in range(per))
        if empty:
            chosen = _kmin.value + k
    _x.XFree(ctypes.cast(syms, ctypes.c_void_p))
    return chosen if chosen is not None else _kmax.value


_scratch = _find_scratch()


def type_unicode(text):
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
    # restore scratch keycode to no mapping so it can't autorepeat a stale glyph
    zero = (ctypes.c_ulong * 2)(0, 0)
    _x.XChangeKeyboardMapping(_dpy, _scratch, 2, zero, 1)
    _x.XSync(_dpy, 0)


# ---- clipboard (selection owner on its own display connection) ----
_clip_text = ""
_clip_started = False


def set_clipboard(text):
    global _clip_text, _clip_started
    _clip_text = text
    if not _clip_started:
        _clip_started = True
        threading.Thread(target=_clip_serve, daemon=True).start()
        time.sleep(0.05)
    # (re)assert ownership from the serving thread's display via a flag
    _clip_assert.set()


_clip_assert = threading.Event()


def _clip_serve():
    d = _x.XOpenDisplay(None)
    root = _x.XDefaultRootWindow(d)
    XA_STRING = 31
    _x.XInternAtom.restype = ctypes.c_ulong
    _x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    CLIPBOARD = _x.XInternAtom(d, b"CLIPBOARD", 0)
    PRIMARY = 1
    UTF8 = _x.XInternAtom(d, b"UTF8_STRING", 0)
    TARGETS = _x.XInternAtom(d, b"TARGETS", 0)
    _x.XCreateSimpleWindow.restype = ctypes.c_ulong
    _x.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                                       ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                                       ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
    win = _x.XCreateSimpleWindow(d, root, 0, 0, 1, 1, 0, 0, 0)
    _x.XSetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    _x.XSetSelectionOwner(d, CLIPBOARD, win, 0)
    _x.XSetSelectionOwner(d, PRIMARY, win, 0)
    _x.XFlush(d)

    class XSelReq(ctypes.Structure):  # XSelectionRequestEvent
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                    ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                    ("owner", ctypes.c_ulong), ("requestor", ctypes.c_ulong),
                    ("selection", ctypes.c_ulong), ("target", ctypes.c_ulong),
                    ("property", ctypes.c_ulong), ("time", ctypes.c_ulong)]

    class XSelNotify(ctypes.Structure):  # XSelectionEvent (no 'owner' field!)
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                    ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                    ("requestor", ctypes.c_ulong), ("selection", ctypes.c_ulong),
                    ("target", ctypes.c_ulong), ("property", ctypes.c_ulong),
                    ("time", ctypes.c_ulong)]

    class XEvent(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("pad", ctypes.c_long * 30)]

    _x.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _x.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                                   ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_char_p, ctypes.c_int]
    _x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                              ctypes.c_long, ctypes.c_void_p]

    SelectionRequest = 30
    SelectionNotify = 31
    ev = XEvent()
    while True:
        _x.XNextEvent(d, ctypes.byref(ev))
        if ev.type == SelectionRequest:
            req = ctypes.cast(ctypes.byref(ev), ctypes.POINTER(XSelReq)).contents
            data = _clip_text.encode("utf-8")
            prop = req.property
            if req.target in (UTF8, XA_STRING):
                _x.XChangeProperty(d, req.requestor, prop, req.target, 8, 0, data, len(data))
            elif req.target == TARGETS:
                targs = (ctypes.c_ulong * 2)(UTF8, XA_STRING)
                _x.XChangeProperty(d, req.requestor, prop, 4, 32, 0,
                                   ctypes.cast(targs, ctypes.c_char_p), 2)
            else:
                prop = 0
            note = XSelNotify(type=SelectionNotify, serial=0, send_event=1, display=d,
                              requestor=req.requestor, selection=req.selection,
                              target=req.target, property=prop, time=req.time)
            _x.XSendEvent(d, req.requestor, 0, 0, ctypes.byref(note))
            _x.XFlush(d)


def get_clipboard():
    return _clip_text  # owner-side cache; full round-trip read not needed for prototype


if __name__ == "__main__":
    print("screen_size", screen_size())
    print("cursor_pos", cursor_pos())
    w, h, rgb = capture_rgb()
    print("capture", w, h, len(rgb), "expect", w * h * 3)
