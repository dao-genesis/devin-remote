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


def screenshot(path: str) -> str:
    """Capture the whole virtual desktop to a PNG via GDI BitBlt."""
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

    with open(path, "wb") as f:
        f.write(_png(w, h, bytes(rgb)))
    return path


if __name__ == "__main__":
    print("screen:", screen_size())
    rt = "agentctl osctl clipboard round-trip \u2713"
    set_clipboard(rt)
    print("clipboard ok:", get_clipboard() == rt)
    out = screenshot("osctl_desktop.png")
    import os as _os
    print("screenshot:", out, _os.path.getsize(out), "bytes")
