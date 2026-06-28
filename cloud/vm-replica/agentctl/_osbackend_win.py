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


_VK_BUTTON = {"left": 0x01, "right": 0x02, "middle": 0x04}  # VK_L/R/MBUTTON


def mouse_state() -> dict:
    """Read which mouse buttons are pressed *right now* plus the cursor position:
    ``{"left","right","middle": bool, "pos": (x,y)}``. ``mouse_button`` could
    *press* and *release* but nothing could *read* the buttons, so a drag whose
    button-up was lost (a half-finished drag) left the floor silently stuck in a
    pressed state, dragging every later move. The button-read dual of
    ``mouse_button``, completing the input floor alongside ``key_state``."""
    s = {name: bool(user32.GetAsyncKeyState(vk) & 0x8000)
         for name, vk in _VK_BUTTON.items()}
    s["pos"] = cursor_pos()
    return s


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


user32.GetAsyncKeyState.restype = wintypes.SHORT
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetKeyState.restype = wintypes.SHORT
user32.GetKeyState.argtypes = [ctypes.c_int]


def key_state(vk: int) -> dict:
    """Read a key's live state: ``{"down": bool, "toggled": bool}``. The floor
    could *press* and *release* keys (`key_down`/`key_up`) but never *read* them,
    so it held modifiers and typed blind — a stuck Shift or a silently-on CapsLock
    would corrupt everything typed after, undetectably. ``down`` is the physical
    press (``GetAsyncKeyState`` high bit); ``toggled`` is the lock/latch
    (``GetKeyState`` low bit) that matters for CapsLock/NumLock/ScrollLock. The
    read dual of the keyboard writes."""
    down = bool(user32.GetAsyncKeyState(int(vk)) & 0x8000)
    toggled = bool(user32.GetKeyState(int(vk)) & 0x0001)
    return {"down": down, "toggled": toggled}


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
user32.SystemParametersInfoW.restype = wintypes.BOOL
user32.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT,
                                         ctypes.c_void_p, wintypes.UINT]

_SW_RESTORE = 9

# Lift Windows' foreground lock once. Without this, SetForegroundWindow grants
# only the *first* foreground change a process requests after user input and
# silently denies later ones (ForegroundLockTimeout) — so activate_window worked
# the first time and failed on every switch after, leaving the keyboard pointed
# at the wrong window. Zeroing SPI_SETFOREGROUNDLOCKTIMEOUT makes every
# subsequent activate_window take reliably. (Surfaced live by R115/F154.)
_SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
_SPIF_SENDCHANGE = 0x0002
try:
    user32.SystemParametersInfoW(_SPI_SETFOREGROUNDLOCKTIMEOUT, 0,
                                 ctypes.c_void_p(0), _SPIF_SENDCHANGE)
except Exception:
    pass


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
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                out.append({"id": int(hwnd) if hwnd else 0, "title": buf.value,
                            "pid": int(pid.value) or None})
        return True

    user32.EnumWindows(_WNDENUMPROC(cb), 0)
    return out


_GWL_STYLE = -16
_WS_POPUP = 0x80000000
_WS_CAPTION = 0x00C00000  # WS_BORDER | WS_DLGFRAME — a titled frame
_GW_OWNER = 4
user32.GetWindow.restype = wintypes.HWND
user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]


def menu_windows() -> list:
    """Enumerate open **popup menus** as ``[{"id","title","class"}, …]``.

    A right-click context menu (and a classic Win32 menubar dropdown) opens in a
    top-level window that carries **no title**, so :func:`list_windows` — which keeps
    only *titled* top-levels — never returns it, and a ``uia_find`` has no window id to
    search. The first cut (F186) recognised only the native ``#32768`` class; but each
    GUI toolkit pops its own menu in its own window class — LibreOffice/VCL uses
    ``SALTMPSUBFRAME``, Qt/wx use theirs — so a class allow-list is endless and
    toolkit-specific. What every popup menu shares is not a class but a *shape*: it is
    a **titleless ``WS_POPUP`` window** (a popup with no caption bar). This recognises a
    menu by that shape, so one eye sees the popup of any toolkit. A bare ``WS_POPUP``
    also describes persistent shell furniture (the taskbar, the IME bar), so this keeps
    only popups that are **owned** by another window — a context/dropdown menu is spawned
    *by* an app window and owned by it, whereas shell windows stand alone (no owner). The
    native ``#32768`` class is admitted unconditionally, since it is unambiguously a menu.
    The menu *walk* (osctl ``_find_menuitem``) then keeps only windows that actually hold
    a ``menuitem``, so any remaining stray popup contributes nothing."""
    out = []

    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        # has a title? then list_windows already covers it — not a bare popup menu.
        if user32.GetWindowTextLengthW(hwnd) > 0:
            return True
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        if cls.value != "#32768":
            style = user32.GetWindowLongW(hwnd, _GWL_STYLE) & 0xFFFFFFFF
            if not (style & _WS_POPUP) or (style & _WS_CAPTION) == _WS_CAPTION:
                return True
            # owned popup => spawned by an app (a menu); unowned => shell furniture.
            if not user32.GetWindow(hwnd, _GW_OWNER):
                return True
            rect = wintypes.RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                return True
            if rect.right - rect.left <= 0 or rect.bottom - rect.top <= 0:
                return True  # zero-area shadow/sentinel, not a menu
        out.append({"id": int(hwnd), "title": window_text(int(hwnd)),
                    "class": cls.value})
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


user32.PostMessageW.restype = wintypes.BOOL
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM,
                                wintypes.LPARAM]
user32.IsWindow.restype = wintypes.BOOL
user32.IsWindow.argtypes = [wintypes.HWND]

_WM_CLOSE = 0x0010


def close_window(win: int) -> bool:
    """Ask a window to close *by identity*, the graceful way a human clicking its
    ✕ would — ``WM_CLOSE`` runs the app's own close path (its "save changes?"
    prompt, cleanup), unlike killing the process. Screenshot+click would have to
    hunt the close-button pixel; this addresses the window itself. Returns False
    if the handle is already gone."""
    hwnd = wintypes.HWND(win)
    if not user32.IsWindow(hwnd):
        return False
    return bool(user32.PostMessageW(hwnd, _WM_CLOSE, 0, 0))


def window_exists(win: int) -> bool:
    """Whether a window handle still refers to a live window (``IsWindow``) — the
    read that lets the floor wait for a window to appear or confirm it has gone."""
    return bool(user32.IsWindow(wintypes.HWND(win)))


user32.GetWindowLongW.restype = wintypes.LONG
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND,
                                            ctypes.POINTER(wintypes.DWORD)]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.TerminateProcess.restype = wintypes.BOOL
kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

_PROCESS_TERMINATE = 0x0001


def window_pid(win: int) -> "int | None":
    """Which OS process owns a window — its identity *beyond the title*. Two
    windows can share an identical title (two consoles, two Notepads), so a title
    cannot tell them apart; the owning pid can, and it is what lets the floor
    escalate from a graceful close to a forceful kill. ``GetWindowThreadProcessId``
    fills the pid; None if the handle is gone."""
    if not user32.IsWindow(wintypes.HWND(win)):
        return None
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(wintypes.HWND(win), ctypes.byref(pid))
    return int(pid.value) or None


def terminate_window(win: int) -> bool:
    """Force the owning process of a window to end — the *forceful* death dual to
    the graceful ``close_window`` (WM_CLOSE). When an app ignores the polite close
    (a hung window, a modal that won't dismiss), this is the escalation a human
    reaches for via Task Manager: ``OpenProcess(PROCESS_TERMINATE)`` +
    ``TerminateProcess``. Returns False if the window/pid is already gone."""
    pid = window_pid(win)
    if not pid:
        return False
    h = kernel32.OpenProcess(_PROCESS_TERMINATE, False, pid)
    if not h:
        return False
    try:
        return bool(kernel32.TerminateProcess(h, 1))
    finally:
        kernel32.CloseHandle(h)


_WM_SETTEXT = 0x000C
_WM_GETTEXT = 0x000D
_WM_GETTEXTLENGTH = 0x000E
user32.SendMessageW.restype = ctypes.c_long
user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT,
                                wintypes.WPARAM, wintypes.LPARAM]
user32.GetClassNameW.restype = ctypes.c_int
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
_ENUMCHILDPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumChildWindows.argtypes = [wintypes.HWND, _ENUMCHILDPROC, wintypes.LPARAM]


def window_text(win: int) -> str:
    """Read the *text a window carries* — not its pixels, its actual content.
    ``WM_GETTEXT`` returns a top-level window's title, but for a child *control*
    (an edit box, a label, a button) it returns the control's live text: what the
    field holds, what the label says. The floor could see only painted pixels
    (OCR, fragile) or a window's outer title; this reads the semantic string the
    OS already knows — exact, no recognition error. Cross-process safe (unlike
    ``GetWindowText``, which only fetches titles across processes)."""
    hwnd = wintypes.HWND(win)
    if not user32.IsWindow(hwnd):
        return ""
    n = user32.SendMessageW(hwnd, _WM_GETTEXTLENGTH, 0, 0)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.SendMessageW(hwnd, _WM_GETTEXT, n + 1, ctypes.addressof(buf))
    return buf.value


def set_window_text(win: int, text: str) -> bool:
    """*Write* a control's text directly by identity — the write dual of
    :func:`window_text`. To put text in a field the floor otherwise had to focus
    the window, focus the right control, then type it character by character:
    slow, focus-fragile (a popup steals focus mid-type), and corruptible (a stuck
    modifier upper-cases everything). ``WM_SETTEXT`` hands the exact string to the
    control in one message — focus-independent, instant, verbatim, even if the
    window is occluded. Returns True on success."""
    hwnd = wintypes.HWND(win)
    if not user32.IsWindow(hwnd):
        return False
    buf = ctypes.create_unicode_buffer(text)
    return bool(user32.SendMessageW(hwnd, _WM_SETTEXT, 0, ctypes.addressof(buf)))


_WM_COMMAND = 0x0111
_MF_BYPOSITION = 0x0400
user32.GetMenu.restype = wintypes.HMENU
user32.GetMenu.argtypes = [wintypes.HWND]
user32.GetMenuItemCount.restype = ctypes.c_int
user32.GetMenuItemCount.argtypes = [wintypes.HMENU]
user32.GetSubMenu.restype = wintypes.HMENU
user32.GetSubMenu.argtypes = [wintypes.HMENU, ctypes.c_int]
user32.GetMenuItemID.restype = ctypes.c_uint
user32.GetMenuItemID.argtypes = [wintypes.HMENU, ctypes.c_int]
user32.GetMenuStringW.restype = ctypes.c_int
user32.GetMenuStringW.argtypes = [wintypes.HMENU, ctypes.c_uint,
                                  wintypes.LPWSTR, ctypes.c_int, ctypes.c_uint]


def _read_menu(hmenu, depth: int = 0) -> list:
    if not hmenu or depth > 16:
        return []
    out = []
    n = user32.GetMenuItemCount(hmenu)
    for i in range(n):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetMenuStringW(hmenu, i, buf, 256, _MF_BYPOSITION)
        label = buf.value
        sub = user32.GetSubMenu(hmenu, i)
        item = {"label": label,
                "id": int(user32.GetMenuItemID(hmenu, i)) if not sub else None,
                "sep": (not label and not sub),
                "items": _read_menu(sub, depth + 1) if sub else []}
        out.append(item)
    return out


def window_menu(win: int) -> list:
    """Read a window's *menu bar* as a tree — the application's own command
    vocabulary (File/Edit/…), each leaf carrying its command ``id``. The floor
    could read controls, but a window's *actions* live in its menus, invisible to
    every screenshot until the user clicks to open them. ``GetMenu`` + the
    ``GetMenuString``/``GetSubMenu``/``GetMenuItemID`` family expose the whole
    structure without opening a thing — the verbs an app offers, named and
    addressable. Empty if the window has no OS menu (many modern apps draw their
    own)."""
    hwnd = wintypes.HWND(win)
    if not user32.IsWindow(hwnd):
        return []
    return _read_menu(user32.GetMenu(hwnd))


def invoke_menu(win: int, command_id: int) -> bool:
    """Invoke a menu command *by its id* — the action dual of :func:`window_menu`.
    A human must open the menu, move to the item, and click; this posts the
    ``WM_COMMAND`` the menu would have sent, straight to the window — no opening,
    no mouse, no focus, working even if the window is occluded. The verb is
    executed by name, not by hunting its pixels. Returns True if delivered."""
    hwnd = wintypes.HWND(win)
    if not user32.IsWindow(hwnd):
        return False
    user32.SendMessageW(hwnd, _WM_COMMAND, int(command_id), 0)
    return True


def find_control(top: int, cls: "str | None" = None,
                 text: "str | None" = None) -> "dict | None":
    """Find a control inside ``top`` by its *meaning* — its class and/or its text
    — and report *where it is*: ``{"id","class","text","rect":(x,y,w,h)}`` in
    screen coordinates, or None. The dual of :func:`control_at`: that answers
    *what is at this pixel?* (location → identity); this answers *where is the
    control that means X?* (identity → location). Matching is case-insensitive
    substring for both ``cls`` and ``text`` (either may be omitted). Returning the
    screen rect closes the loop back to the actuator floor — a semantic find hands
    a pixel target the mouse can click, no visual scanning."""
    hwnd = wintypes.HWND(top)
    if not user32.IsWindow(hwnd):
        return None
    cl = cls.lower() if cls else None
    tl = text.lower() if text else None
    found: dict = {}

    def _cb(child, _lp):
        cbuf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(child, cbuf, 256)
        ccls = cbuf.value
        ctext = window_text(int(child))
        if cl is not None and cl not in ccls.lower():
            return True
        if tl is not None and tl not in (ctext or "").lower():
            return True
        rect = wintypes.RECT()
        user32.GetWindowRect(child, ctypes.byref(rect))
        found.update({"id": int(child), "class": ccls, "text": ctext,
                      "rect": (rect.left, rect.top,
                               rect.right - rect.left, rect.bottom - rect.top)})
        return False  # stop at the first match

    user32.EnumChildWindows(hwnd, _ENUMCHILDPROC(_cb), 0)
    return found or None


def child_windows(win: int) -> list:
    """Descend into a window's *controls* — the edit boxes, labels, buttons it is
    built from — as ``[{"id","class","text"}, …]``. The floor could enumerate
    top-level windows but never look *inside* one; yet a window's meaning lives in
    its controls. ``EnumChildWindows`` walks them; each carries its class
    (``Edit``, ``Button``, ``Static``) and, via :func:`window_text`, its content —
    semantic structure no screenshot exposes."""
    hwnd = wintypes.HWND(win)
    if not user32.IsWindow(hwnd):
        return []
    out: list = []

    def _cb(child, _lp):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(child, cls, 256)
        out.append({"id": int(child), "class": cls.value,
                    "text": window_text(int(child))})
        return True

    user32.EnumChildWindows(hwnd, _ENUMCHILDPROC(_cb), 0)
    return out


_GWL_EXSTYLE = -20
_WS_EX_TOPMOST = 0x00000008
_HWND_TOPMOST = wintypes.HWND(-1)
_HWND_NOTOPMOST = wintypes.HWND(-2)


def is_window_topmost(win: int) -> bool:
    """Whether a window is pinned *always-on-top* — it stays above ordinary
    windows even when it does not hold focus, decoupling the stack from focus.
    Read via the ``WS_EX_TOPMOST`` extended style; the read dual of
    ``set_window_topmost``."""
    ex = user32.GetWindowLongW(wintypes.HWND(win), _GWL_EXSTYLE)
    return bool(ex & _WS_EX_TOPMOST)


def set_window_topmost(win: int, on: bool = True) -> bool:
    """Pin / unpin a window *always-on-top* by identity. A topmost window stays
    above non-topmost ones regardless of focus — so the floor can keep a reference
    window visible while typing into another, the one case where the stack and
    focus must deliberately diverge. ``SetWindowPos`` with ``HWND_TOPMOST`` /
    ``HWND_NOTOPMOST`` (keeping position & size)."""
    hwnd = wintypes.HWND(win)
    if not user32.IsWindow(hwnd):
        return False
    after = _HWND_TOPMOST if on else _HWND_NOTOPMOST
    # 0x0001 SWP_NOSIZE | 0x0002 SWP_NOMOVE | 0x0010 SWP_NOACTIVATE
    return bool(user32.SetWindowPos(hwnd, after, 0, 0, 0, 0,
                                    0x0001 | 0x0002 | 0x0010))


def active_window() -> "int | None":
    """Which top-level window currently holds keyboard focus — the id a ``type``
    or key press would reach right now — or None if none does. The keyboard
    follows *focus* while the mouse follows the *stack*: ``activate_window``/
    ``focus_window`` could *write* focus, yet nothing could *read* it, so the
    floor typed blind, unable to confirm its input would land where intended.
    ``GetForegroundWindow`` is the focus-read dual of ``activate_window``, as
    ``window_under`` is the stack-read dual."""
    hwnd = user32.GetForegroundWindow()
    return int(hwnd) if hwnd else None


user32.IsZoomed.restype = wintypes.BOOL
user32.IsZoomed.argtypes = [wintypes.HWND]

_SW_SHOWNORMAL = 1
_SW_MAXIMIZE = 3
_SW_MINIMIZE = 6
# "normal" uses SW_SHOWNORMAL, not SW_RESTORE: restoring a *minimized* window with
# SW_RESTORE returns it to its prior (maybe maximized) state, whereas
# SW_SHOWNORMAL forces the normal size/position regardless of prior state.
_WIN_STATES = {"minimized": _SW_MINIMIZE, "maximized": _SW_MAXIMIZE,
               "normal": _SW_SHOWNORMAL}


def window_state(win: int) -> "str | None":
    """Read a window's show-state — ``"minimized"``, ``"maximized"`` or
    ``"normal"`` — or None if the handle is gone. Geometry (``window_geometry``)
    tells *where* a window is, but not *how it is shown*: a maximized window fills
    the work area, a minimized one has no on-screen pixels at all. The floor could
    move/raise/close a window yet was blind to this axis of its state, and a
    screenshot cannot tell a maximized window from one merely sized to the screen,
    nor a minimized window from a closed one."""
    hwnd = wintypes.HWND(win)
    if not user32.IsWindow(hwnd):
        return None
    if user32.IsIconic(hwnd):
        return "minimized"
    if user32.IsZoomed(hwnd):
        return "maximized"
    return "normal"


def set_window_state(win: int, state: str) -> bool:
    """Minimize / maximize / restore a window *by identity* via ``ShowWindow`` —
    the everyday gestures a human does with the title-bar buttons. ``"minimized"``
    gets a window out of the way without closing it; ``"maximized"`` fills the
    work area; ``"normal"`` restores. Screenshot+click would have to hunt the
    min/max-button pixels. Unknown state returns False."""
    sw = _WIN_STATES.get(state)
    if sw is None or not user32.IsWindow(wintypes.HWND(win)):
        return False
    user32.ShowWindow(wintypes.HWND(win), sw)
    return True


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


def control_at(x: int, y: int) -> "dict | None":
    """Which *control* — not just which top-level window — owns the screen pixel
    ``(x, y)``, and what it says: ``{"id","class","text","top"}`` (``top`` = the
    owning top-level root). Where :func:`window_under` answers *which window* a
    click lands in, this descends to the leaf control under the point and reads its
    text — joining the two perception worlds: a pixel the eye sees is resolved to
    the semantic control behind it (an Edit, a Button, a label) and its content.
    This is what an accessibility inspector does. None on bare desktop."""
    pt = wintypes.POINT(int(x), int(y))
    hwnd = user32.WindowFromPoint(pt)
    if not hwnd:
        return None
    cls = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(wintypes.HWND(hwnd), cls, 256)
    root = user32.GetAncestor(wintypes.HWND(hwnd), _GA_ROOT)
    return {"id": int(hwnd), "class": cls.value, "text": window_text(int(hwnd)),
            "top": int(root) if root else None}


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


# --- F165: UI Automation read access (sees inside modern apps) ----------------
# Best-effort raw-COM UIA in pure ctypes; any failure degrades to empty results
# so the backend still imports and callers fall back to the Win32 / pixel floor.
try:
    from _uia_win import (uia_name, uia_children, uia_find, uia_find_all,
                          uia_set_value, uia_get_value, uia_invoke, uia_focus,
                          uia_text, uia_toggle, uia_toggle_state,
                          uia_select, uia_is_selected,
                          uia_expand, uia_collapse, uia_expand_state,
                          uia_scroll_into_view, uia_find_item,
                          uia_range_value, uia_set_range_value)
except Exception:  # pragma: no cover - UIA unavailable
    def uia_name(win: int) -> str:
        return ""

    def uia_children(win: int) -> list:
        return []

    def uia_find(win: int, name=None, ctype=None):
        return None

    def uia_find_all(win: int, name=None, ctype=None, max_scan: int = 6000) -> list:
        return []

    def uia_set_value(win: int, value, name=None, ctype=None) -> bool:
        return False

    def uia_get_value(win: int, name=None, ctype=None) -> str:
        return ""

    def uia_invoke(win: int, name=None, ctype=None) -> bool:
        return False

    def uia_focus(win: int, name=None, ctype=None) -> bool:
        return False

    def uia_text(win: int, name=None, ctype=None, max_len: int = 20000) -> str:
        return ""

    def uia_toggle(win: int, name=None, ctype=None) -> bool:
        return False

    def uia_toggle_state(win: int, name=None, ctype=None) -> str:
        return ""

    def uia_select(win: int, name=None, ctype=None) -> bool:
        return False

    def uia_is_selected(win: int, name=None, ctype=None):
        return None

    def uia_expand(win: int, name=None, ctype=None) -> bool:
        return False

    def uia_collapse(win: int, name=None, ctype=None) -> bool:
        return False

    def uia_expand_state(win: int, name=None, ctype=None) -> str:
        return ""

    def uia_scroll_into_view(win: int, name=None, ctype=None) -> bool:
        return False

    def uia_range_value(win: int, name=None, ctype=None):
        return None

    def uia_set_range_value(win: int, value, name=None, ctype=None) -> bool:
        return False

    def uia_find_item(win: int, item, container_name=None,
                      container_ctype: str = "list", max_scan: int = 6000):
        return None
