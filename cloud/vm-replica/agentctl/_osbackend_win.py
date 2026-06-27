"""osctl Windows backend — the OS leaf primitives on the Win32 ground.

Input via ``SendInput`` (trusted events), the clipboard via the Win32 clipboard
API, and a GDI ``BitBlt`` screen grab. These are the platform-specific floor;
everything above them (gestures, perception) is platform-agnostic and lives in
``osctl.py``. The companion ``_osbackend_x11`` exposes the *same* names on Linux.
"""

from __future__ import annotations

import ctypes
import time
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
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
WHEEL_DELTA = 120

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


class _POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


def cursor_pos() -> tuple[int, int]:
    pt = _POINT()
    if not user32.GetCursorPos(ctypes.byref(pt)):
        raise ctypes.WinError(ctypes.get_last_error())
    return (pt.x, pt.y)


_BUTTON_DOWN = {"left": MOUSEEVENTF_LEFTDOWN, "right": MOUSEEVENTF_RIGHTDOWN,
                "middle": MOUSEEVENTF_MIDDLEDOWN}
_BUTTON_UP = {"left": MOUSEEVENTF_LEFTUP, "right": MOUSEEVENTF_RIGHTUP,
              "middle": MOUSEEVENTF_MIDDLEUP}


def mouse_button(button: str, down: bool) -> None:
    """Emit one trusted mouse button transition (down or up) at the cursor."""
    flag = (_BUTTON_DOWN if down else _BUTTON_UP)[button]
    mi = _MOUSEINPUT(0, 0, 0, flag, 0, 0)
    _send(_INPUT(INPUT_MOUSE, _INPUTUNION(mi=mi)))


def mouse_wheel(notches: int, horizontal: bool = False) -> None:
    """Emit ``abs(notches)`` wheel events; sign follows the Windows convention."""
    flag = MOUSEEVENTF_HWHEEL if horizontal else MOUSEEVENTF_WHEEL
    d = WHEEL_DELTA if notches > 0 else -WHEEL_DELTA
    for _ in range(abs(notches)):
        mi = _MOUSEINPUT(0, 0, d & 0xFFFFFFFF, flag, 0, 0)
        _send(_INPUT(INPUT_MOUSE, _INPUTUNION(mi=mi)))


# ---- keyboard ------------------------------------------------------------- #
def key_down(vk: int) -> None:
    ki = _KEYBDINPUT(vk, 0, 0, 0, 0)
    _send(_INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=ki)))


def key_up(vk: int) -> None:
    ki = _KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP, 0, 0)
    _send(_INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=ki)))


def type_unicode(text: str) -> None:
    inputs = []
    for ch in text:
        for flags in (KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
            ki = _KEYBDINPUT(0, ord(ch), flags, 0, 0)
            inputs.append(_INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=ki)))
    _send(*inputs)


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


# ---- windows (enumerate + activate) --------------------------------------- #
_WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [_WNDENUMPROC, wintypes.LPARAM]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowRect.restype = wintypes.BOOL
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.SetWindowPos.restype = wintypes.BOOL
kernel32.GetCurrentThreadId.restype = wintypes.DWORD

_SW_RESTORE = 9


def list_windows() -> list:
    """Enumerate visible, titled top-level windows as ``{"id", "title"}``.

    The floor's keyboard/clipboard always act on whatever window holds focus, so
    on a busy desktop input can land in the wrong window — and screenshot+click
    cannot address a window by identity either. This is the eye that finds the
    right window; ``EnumWindows`` walks top-levels in Z-order (topmost first)."""
    out = []

    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n > 0:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                out.append({"id": int(hwnd) if hwnd else 0, "title": buf.value})
        return True

    user32.EnumWindows(_WNDENUMPROC(cb), 0)
    return out


def activate_window(win: int) -> bool:
    """Raise and focus a window by id. Defeats Windows' foreground lock by briefly
    attaching to the current foreground thread's input queue (the documented
    SetForegroundWindow workaround), then restores if minimised."""
    hwnd = wintypes.HWND(win)
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, _SW_RESTORE)
    fg = user32.GetForegroundWindow()
    cur = kernel32.GetCurrentThreadId()
    tgt_tid = user32.GetWindowThreadProcessId(hwnd, None)
    fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    attached = []
    for tid in (fg_tid, tgt_tid):
        if tid and tid != cur and user32.AttachThreadInput(cur, tid, True):
            attached.append(tid)
    user32.BringWindowToTop(hwnd)
    ok = bool(user32.SetForegroundWindow(hwnd))
    for tid in attached:
        user32.AttachThreadInput(cur, tid, False)
    return ok


def window_geometry(win: int) -> "dict | None":
    """Absolute on-screen geometry ``{"x","y","w","h"}`` of a window via
    ``GetWindowRect`` (the outer frame), or None if the handle is gone — the
    prerequisite for deciding a window is off-screen and must be moved back."""
    rect = wintypes.RECT()
    if not user32.GetWindowRect(wintypes.HWND(win), ctypes.byref(rect)):
        return None
    return {"x": int(rect.left), "y": int(rect.top),
            "w": int(rect.right - rect.left), "h": int(rect.bottom - rect.top)}


def move_window(win: int, x: int, y: int, w: int = 0, h: int = 0) -> bool:
    """Move (and optionally resize) a window via ``SetWindowPos``. ``w``/``h`` of
    0 keep the current size (SWP_NOSIZE). Raising stacks a window; only moving it
    can rescue one placed off the visible screen."""
    hwnd = wintypes.HWND(win)
    if not w or not h:
        cur = window_geometry(win) or {"w": 0, "h": 0}
        w = w or cur["w"]
        h = h or cur["h"]
    # 0x0004 SWP_NOZORDER | 0x0010 SWP_NOACTIVATE
    return bool(user32.SetWindowPos(hwnd, None, int(x), int(y), int(w), int(h),
                                    0x0004 | 0x0010))


user32.WindowFromPoint.restype = wintypes.HWND
user32.WindowFromPoint.argtypes = [wintypes.POINT]
user32.GetAncestor.restype = wintypes.HWND
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]

_GA_ROOT = 2


def window_under(x: int, y: int) -> "int | None":
    """Which top-level window owns the screen pixel ``(x, y)`` — the id that a
    real mouse click there would land on, or None if the point is bare desktop.

    A click lands on whatever window owns that pixel in the Z-order; the keyboard
    follows focus, but the mouse follows the stack. ``activate_window`` can *write*
    the stack, yet nothing could *read* it — so the floor clicked blind, unable to
    tell whether the intended window or an occluder sits under the cursor.
    ``WindowFromPoint`` resolves the deepest window at the point; ``GetAncestor``
    lifts that to its top-level root so the result keys against ``list_windows``.
    Screenshot+click is blind to this: pixels carry no window identity."""
    pt = wintypes.POINT(int(x), int(y))
    hwnd = user32.WindowFromPoint(pt)
    if not hwnd:
        return None
    root = user32.GetAncestor(wintypes.HWND(hwnd), _GA_ROOT)
    return int(root) if root else None


# ---- GDI screen capture --------------------------------------------------- #
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


def capture_rgb(x: int = 0, y: int = 0,
                w: "int | None" = None, h: "int | None" = None
                ) -> tuple[int, int, bytes]:
    """Grab the whole screen, or a sub-rectangle (foveal window), as (w, h, rgb).

    With no args this is the full-screen grab. Given x/y/w/h, ``BitBlt`` copies only
    that source rectangle of the screen DC — a smaller, faster read for foveated,
    high-rate sampling. The rectangle is clamped to the screen."""
    sw, sh = screen_size()
    if w is None:
        w = sw
    if h is None:
        h = sh
    x = max(0, min(int(x), sw - 1))
    y = max(0, min(int(y), sh - 1))
    w = max(1, min(int(w), sw - x))
    h = max(1, min(int(h), sh - y))
    sdc = user32.GetDC(0)
    mdc = gdi32.CreateCompatibleDC(sdc)
    bmp = gdi32.CreateCompatibleBitmap(sdc, w, h)
    gdi32.SelectObject(mdc, bmp)
    gdi32.BitBlt(mdc, 0, 0, w, h, sdc, x, y, SRCCOPY)

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
