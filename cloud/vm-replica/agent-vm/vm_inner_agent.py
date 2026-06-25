"""vm_inner_agent.py (v2) - Inner agent for Windows RDP "VM" sessions.

Runs INSIDE each account's interactive session. Exposes an HTTP API that lets a
remote agent operate this session exactly like Devin operates its own VM:
  exec, file_read, file_write, file_append, screenshot(PNG/BMP),
  click, double_click, right_click, mouse_move, drag, scroll,
  type, key, hold_key, ui_info, desktop_info, health

Design goals vs v1:
  - PNG screenshots (pure stdlib zlib) for parity with Devin's computer tool.
  - Full input parity: scroll / double_click / right_click / drag / hold_key.
  - Bind 127.0.0.1 only (loopback) + Bearer token  -> isolation + safety.
  - Zero external deps beyond Python stdlib + ctypes Win32.
"""
import http.server, json, subprocess, os, sys, base64, ctypes, ctypes.wintypes
import struct, threading, time, traceback, zlib, socketserver
import socket, urllib.request, urllib.parse, re

PORT  = int(os.environ.get('VM_AGENT_PORT', '9001'))
TOKEN = os.environ.get('VM_AGENT_TOKEN', '')          # '' => no auth (loopback only)
BIND  = os.environ.get('VM_AGENT_BIND', '127.0.0.1')

# Optional UI Automation backend (modern UI frameworks the raw HWND tree can't see:
# Ribbon / WPF / UWP-XAML / Chromium / Qt). Guarded import (this embedded Python does
# not auto-add the script dir to sys.path) -- if it fails, find() simply falls back to
# the HWND walk / visual escalation, never a hard dependency.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import uia as _uia
except Exception:
    _uia = None

try:
    import vmodel as _vmodel
except Exception:
    _vmodel = None

# Pixel-only world model: persisted affordance memory grown from practice. Lazily loaded so the
# daemon and the practice scripts share one growing store on disk.
_WM_PATH = os.path.join(os.path.expanduser('~'), '.dao_world_model.json')
_WM = None
def _wm():
    global _WM
    if _WM is None and _vmodel is not None:
        _WM = _vmodel.WorldModel(_WM_PATH)
    return _WM

user32 = ctypes.windll.user32
gdi32  = ctypes.windll.gdi32
try:
    user32.SetProcessDPIAware()
except Exception:
    pass

# Declare 64-bit-safe signatures: without argtypes ctypes truncates HWND/HDC
# handles to 32-bit, which silently breaks capture on Win64.
from ctypes import wintypes as _wt
_VP = ctypes.c_void_p
user32.GetDC.restype = _VP;                 user32.GetDC.argtypes = [_wt.HWND]
user32.ReleaseDC.argtypes = [_wt.HWND, _VP]
user32.IsWindowVisible.argtypes = [_wt.HWND]
user32.GetWindowRect.argtypes = [_wt.HWND, ctypes.POINTER(_wt.RECT)]
user32.PrintWindow.argtypes = [_wt.HWND, _VP, _wt.UINT]
user32.EnumWindows.argtypes = [_VP, _wt.LPARAM]
gdi32.CreateCompatibleDC.restype = _VP;     gdi32.CreateCompatibleDC.argtypes = [_VP]
gdi32.CreateCompatibleBitmap.restype = _VP; gdi32.CreateCompatibleBitmap.argtypes = [_VP, ctypes.c_int, ctypes.c_int]
gdi32.SelectObject.restype = _VP;           gdi32.SelectObject.argtypes = [_VP, _VP]
gdi32.BitBlt.argtypes = [_VP, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, _VP, ctypes.c_int, ctypes.c_int, _wt.DWORD]
gdi32.GetDIBits.argtypes = [_VP, _VP, _wt.UINT, _wt.UINT, _VP, _VP, _wt.UINT]
gdi32.DeleteObject.argtypes = [_VP]
gdi32.DeleteDC.argtypes = [_VP]
kernel32 = ctypes.windll.kernel32
user32.GetForegroundWindow.restype = _VP
user32.SetForegroundWindow.argtypes = [_VP]
user32.SetActiveWindow.restype = _VP; user32.SetActiveWindow.argtypes = [_VP]
user32.BringWindowToTop.argtypes = [_VP]
user32.ShowWindow.argtypes = [_VP, ctypes.c_int]
user32.IsIconic.argtypes = [_VP]
user32.GetWindowThreadProcessId.restype = _wt.DWORD
user32.GetWindowThreadProcessId.argtypes = [_VP, ctypes.POINTER(_wt.DWORD)]
user32.AttachThreadInput.argtypes = [_wt.DWORD, _wt.DWORD, ctypes.c_int]
user32.GetWindowTextW.argtypes = [_VP, _wt.LPWSTR, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [_VP]
SW_SHOW = 5; SW_RESTORE = 9

# GetGUIThreadInfo => focused control of the foreground thread (cheap focus probe)
class GUITHREADINFO(ctypes.Structure):
    _fields_ = [('cbSize', _wt.DWORD), ('flags', _wt.DWORD),
                ('hwndActive', _VP), ('hwndFocus', _VP), ('hwndCapture', _VP),
                ('hwndMenuOwner', _VP), ('hwndMoveSize', _VP), ('hwndCaret', _VP),
                ('rcCaret', _wt.RECT)]
user32.GetGUIThreadInfo.argtypes = [_wt.DWORD, ctypes.POINTER(GUITHREADINFO)]

# ====== Win32 screen capture ======
class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [('biSize', ctypes.c_uint32), ('biWidth', ctypes.c_int32),
                ('biHeight', ctypes.c_int32), ('biPlanes', ctypes.c_uint16),
                ('biBitCount', ctypes.c_uint16), ('biCompression', ctypes.c_uint32),
                ('biSizeImage', ctypes.c_uint32), ('biXPelsPerMeter', ctypes.c_int32),
                ('biYPelsPerMeter', ctypes.c_int32), ('biClrUsed', ctypes.c_uint32),
                ('biClrImportant', ctypes.c_uint32)]

def _dib_from_hbmp(hdc_screen, hbmp, w, h):
    """Read a 24-bit top-down BGR DIB out of an HBITMAP."""
    bih = BITMAPINFOHEADER()
    bih.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bih.biWidth = w; bih.biHeight = -h; bih.biPlanes = 1
    bih.biBitCount = 24; bih.biCompression = 0
    row_size = ((w * 3 + 3) & ~3)
    bih.biSizeImage = row_size * h
    buf = ctypes.create_string_buffer(row_size * h)
    gdi32.GetDIBits(hdc_screen, hbmp, 0, h, buf, ctypes.byref(bih), 0)
    return row_size, buf.raw

def _is_black(raw, sample=4096):
    """Cheap detector: True if a sample of the buffer is all-zero (black frame)."""
    n = len(raw)
    if n == 0:
        return True
    step = max(1, n // sample)
    s = 0
    for i in range(0, n, step):
        s |= raw[i]
        if s:
            return False
    return True

# --- PrintWindow composite (works when an RDP session is minimized/output-suppressed,
#     where screen BitBlt returns black). Each window paints itself via WM_PRINT. ---
PW_RENDERFULLCONTENT = 0x00000002
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)

def _enum_top_windows():
    out = []
    def cb(hwnd, lparam):
        if not user32.IsWindowVisible(hwnd):
            return 1
        r = ctypes.wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return 1
        if (r.right - r.left) <= 0 or (r.bottom - r.top) <= 0:
            return 1
        out.append((hwnd, r.left, r.top, r.right - r.left, r.bottom - r.top))
        return 1
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out  # EnumWindows yields front-to-back

# Transient popups (context menus, combo dropdowns, autosuggest, tooltips) are SEPARATE
# top-level windows, NOT children of the active window -> tree-based find() can't see them.
# Detecting them cheaply by window class is the "a menu popped up" signal.
POPUP_CLASSES = ('#32768', 'ComboLBox', 'Auto-Suggest Dropdown', 'DropDown', 'tooltips_class32')

def _popup_windows():
    out = []
    for hwnd, l, t, w, h in _enum_top_windows():
        c = _cls(hwnd)
        if c in POPUP_CLASSES:
            out.append({'hwnd': int(hwnd), 'class': c, 'rect': [l, t, l + w, t + h]})
    return out

def _menu_open():
    for p in _popup_windows():
        if p['class'] == '#32768':
            return p
    return None

def _capture_printwindow(w, h):
    hdc_screen = user32.GetDC(0)
    comp_dc = gdi32.CreateCompatibleDC(hdc_screen)
    comp_bmp = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(comp_dc, comp_bmp)
    # paint back-to-front so top windows land on top (incl. Progman => wallpaper/icons)
    for hwnd, x, y, ww, hh in reversed(_enum_top_windows()):
        wdc = gdi32.CreateCompatibleDC(hdc_screen)
        wbmp = gdi32.CreateCompatibleBitmap(hdc_screen, ww, hh)
        gdi32.SelectObject(wdc, wbmp)
        ok = user32.PrintWindow(hwnd, wdc, PW_RENDERFULLCONTENT)
        if not ok:
            user32.PrintWindow(hwnd, wdc, 0)
        gdi32.BitBlt(comp_dc, x, y, ww, hh, wdc, 0, 0, 0x00CC0020)
        gdi32.DeleteObject(wbmp); gdi32.DeleteDC(wdc)
    row_size, raw = _dib_from_hbmp(hdc_screen, comp_bmp, w, h)
    gdi32.DeleteObject(comp_bmp); gdi32.DeleteDC(comp_dc)
    user32.ReleaseDC(0, hdc_screen)
    return row_size, raw

def _capture_bgr():
    """Return (width, height, row_size, raw_top_down_bgr_bytes).
    Tries a screen BitBlt first; if the session output is suppressed (minimized RDP
    client => black frame), falls back to a PrintWindow composite of all windows."""
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(hdc_mem, hbmp)
    gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, 0, 0, 0x00CC0020)  # SRCCOPY
    row_size, raw = _dib_from_hbmp(hdc_screen, hbmp, w, h)
    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(0, hdc_screen)
    if _is_black(raw):
        try:
            row_size, raw = _capture_printwindow(w, h)
        except Exception:
            pass
    return w, h, row_size, raw

def screenshot_bmp():
    w, h, row_size, raw = _capture_bgr()
    bih = BITMAPINFOHEADER()
    bih.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bih.biWidth = w; bih.biHeight = -h; bih.biPlanes = 1
    bih.biBitCount = 24; bih.biCompression = 0; bih.biSizeImage = row_size * h
    bmp = bytearray(b'BM')
    bmp += struct.pack('<I', 54 + row_size * h)
    bmp += b'\x00\x00\x00\x00' + struct.pack('<I', 54)
    bmp += bytes(bih) + raw
    return w, h, bytes(bmp)

def _png_chunk(tag, data):
    out = struct.pack('>I', len(data)) + tag + data
    out += struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return out

def screenshot_png():
    """Encode the screen as PNG using only stdlib (zlib)."""
    w, h, row_size, raw = _capture_bgr()
    # Build raw scanlines: filter byte 0x00 + RGB row (convert BGR->RGB, drop padding)
    scan = bytearray()
    line = w * 3
    for y in range(h):
        off = y * row_size
        row = bytearray(raw[off:off + line])
        row[0::3], row[2::3] = row[2::3], row[0::3]   # BGR -> RGB
        scan.append(0)
        scan += row
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)  # RGB
    png = b'\x89PNG\r\n\x1a\n'
    png += _png_chunk(b'IHDR', ihdr)
    png += _png_chunk(b'IDAT', zlib.compress(bytes(scan), 6))
    png += _png_chunk(b'IEND', b'')
    return w, h, png

# ====== Win32 input injection ======
INPUT_MOUSE = 0; INPUT_KEYBOARD = 1
MOUSEEVENTF_MOVE = 0x0001; MOUSEEVENTF_LEFTDOWN = 0x0002; MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008; MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_ABSOLUTE = 0x8000; MOUSEEVENTF_WHEEL = 0x0800
KEYEVENTF_UNICODE = 0x0004; KEYEVENTF_KEYUP = 0x0002; KEYEVENTF_EXTENDEDKEY = 0x0001
WHEEL_DELTA = 120

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]
class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]
class INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]
class INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("union", INPUT_UNION)]

def _send(inp):
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

def _send_n(inputs):
    # Atomic batch injection: down+up in a single SendInput avoids the event
    # loss/coalescing seen on an offscreen/minimized RDP session when down and up
    # are sent as two separate calls back-to-back.
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    user32.SendInput(n, arr, ctypes.sizeof(INPUT))

def move_mouse(x, y):
    sw = user32.GetSystemMetrics(0); sh = user32.GetSystemMetrics(1)
    inp = INPUT(); inp.type = INPUT_MOUSE
    inp.union.mi.dx = int(x * 65535 / max(sw - 1, 1))
    inp.union.mi.dy = int(y * 65535 / max(sh - 1, 1))
    inp.union.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
    _send(inp)

def _mouse_btn(down_flag, up_flag, hold=0.05):
    d = INPUT(); d.type = INPUT_MOUSE; d.union.mi.dwFlags = down_flag
    u = INPUT(); u.type = INPUT_MOUSE; u.union.mi.dwFlags = up_flag
    _send(d); time.sleep(hold); _send(u)

def click_at(x, y):
    move_mouse(x, y); time.sleep(0.05)
    _mouse_btn(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)

def double_click_at(x, y):
    move_mouse(x, y); time.sleep(0.05)
    _mouse_btn(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0.02)
    time.sleep(0.05)
    _mouse_btn(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0.02)

def right_click_at(x, y):
    move_mouse(x, y); time.sleep(0.05)
    _mouse_btn(MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)

def drag(x1, y1, x2, y2):
    move_mouse(x1, y1); time.sleep(0.05)
    d = INPUT(); d.type = INPUT_MOUSE; d.union.mi.dwFlags = MOUSEEVENTF_LEFTDOWN
    _send(d); time.sleep(0.08)
    steps = 20
    for i in range(1, steps + 1):
        move_mouse(int(x1 + (x2 - x1) * i / steps), int(y1 + (y2 - y1) * i / steps))
        time.sleep(0.01)
    u = INPUT(); u.type = INPUT_MOUSE; u.union.mi.dwFlags = MOUSEEVENTF_LEFTUP
    _send(u)

def drag_sampled(x1, y1, x2, y2, region, cols=24, rows=24, samples=6):
    """A drag that captures gray frames of `region` WHILE the button is held -- the continuous
    motion a temporal/optical-flow cue needs. Returns the list of sub-frames (flat gray grids)."""
    move_mouse(x1, y1); time.sleep(0.05)
    d = INPUT(); d.type = INPUT_MOUSE; d.union.mi.dwFlags = MOUSEEVENTF_LEFTDOWN
    _send(d); time.sleep(0.06)
    frames = [_region_gray(region, cols, rows)]
    for i in range(1, samples + 1):
        move_mouse(int(x1 + (x2 - x1) * i / samples), int(y1 + (y2 - y1) * i / samples))
        time.sleep(0.03)
        frames.append(_region_gray(region, cols, rows))
    u = INPUT(); u.type = INPUT_MOUSE; u.union.mi.dwFlags = MOUSEEVENTF_LEFTUP
    _send(u)
    return frames

def flow_probe(body):
    """Drag while sampling sub-frames, then report the temporal motion axis (rotate vs tilt) and
    the overall before/after change descriptor. Pure pixels; the daemon-level direction cue."""
    region = body['region']; cols = int(body.get('cols', 24)); rows = int(body.get('rows', cols))
    frames = drag_sampled(int(body['x']), int(body['y']), int(body['x2']), int(body['y2']),
                          region, cols, rows, int(body.get('samples', 6)))
    out = {'ok': True, 'frames': len(frames)}
    if _vmodel is not None:
        l, t, rr, b = region
        px_w = (rr - l) / max(1, cols); px_h = (b - t) / max(1, rows)
        out['flow'] = _vmodel.flow_axis(frames, cols, rows, px_w, px_h)
        out['change'] = {k: _vmodel.change_descriptor(frames[0], frames[-1], cols, rows)[k]
                         for k in ('mag', 'cx', 'cy')}
    return out

def scroll(x, y, clicks):
    move_mouse(x, y); time.sleep(0.03)
    inp = INPUT(); inp.type = INPUT_MOUSE
    inp.union.mi.mouseData = ctypes.c_ulong(int(clicks * WHEEL_DELTA) & 0xFFFFFFFF).value
    inp.union.mi.dwFlags = MOUSEEVENTF_WHEEL
    _send(inp)

def type_text(text):
    # Whitespace control chars must be sent as real virtual-key taps; a UNICODE
    # scan of 0x0A/0x0D/0x09 does NOT produce a newline/tab in editors (VSCode,
    # Notepad++ etc.). \r\n is collapsed to a single Enter.
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    if not text:
        return
    # Prime the input channel: the very first keystroke of a fresh SendInput burst
    # can be swallowed by the editor (seen with a control key issued right after a
    # hold_key auto-repeat burst into Win11 Notepad). A bare Shift tap produces no
    # character, so it harmlessly absorbs any first-event loss before real keys.
    _key_down(0xA0); _key_up(0xA0); time.sleep(0.02)
    CTRL_VK = {'\n': 0x0D, '\t': 0x09}
    for ch in text:
        vk = CTRL_VK.get(ch)
        if vk is not None:
            d = INPUT(); d.type = INPUT_KEYBOARD; d.union.ki.wVk = vk
            u = INPUT(); u.type = INPUT_KEYBOARD; u.union.ki.wVk = vk
            u.union.ki.dwFlags = KEYEVENTF_KEYUP
            _send_n([d, u]); time.sleep(0.02); continue
        code = ord(ch)
        d = INPUT(); d.type = INPUT_KEYBOARD
        d.union.ki.wScan = code; d.union.ki.dwFlags = KEYEVENTF_UNICODE
        u = INPUT(); u.type = INPUT_KEYBOARD
        u.union.ki.wScan = code; u.union.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        # down+up atomically, then a gap large enough for the RDP input queue
        _send_n([d, u]); time.sleep(0.015)

VK_MAP = {
    'enter': 0x0D, 'return': 0x0D, 'tab': 0x09, 'escape': 0x1B, 'esc': 0x1B,
    'backspace': 0x08, 'delete': 0x2E, 'del': 0x2E, 'space': 0x20, 'insert': 0x2D,
    'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27,
    'home': 0x24, 'end': 0x23, 'pageup': 0x21, 'pagedown': 0x22,
    'ctrl': 0xA2, 'control': 0xA2, 'shift': 0xA0, 'alt': 0xA4,
    'win': 0x5B, 'super': 0x5B, 'meta': 0x5B, 'capslock': 0x14,
    'f1': 0x70, 'f2': 0x71, 'f3': 0x72, 'f4': 0x73, 'f5': 0x74, 'f6': 0x75,
    'f7': 0x76, 'f8': 0x77, 'f9': 0x78, 'f10': 0x79, 'f11': 0x7A, 'f12': 0x7B,
}
EXT_KEYS = {0x26, 0x28, 0x25, 0x27, 0x24, 0x23, 0x21, 0x22, 0x2D, 0x2E, 0x5B}

def _vk_for(p):
    if p in VK_MAP: return VK_MAP[p]
    if len(p) == 1: return ord(p.upper())
    return 0

def _key_down(vk):
    inp = INPUT(); inp.type = INPUT_KEYBOARD; inp.union.ki.wVk = vk
    if vk in EXT_KEYS: inp.union.ki.dwFlags = KEYEVENTF_EXTENDEDKEY
    _send(inp)

def _key_up(vk):
    inp = INPUT(); inp.type = INPUT_KEYBOARD; inp.union.ki.wVk = vk
    inp.union.ki.dwFlags = KEYEVENTF_KEYUP | (KEYEVENTF_EXTENDEDKEY if vk in EXT_KEYS else 0)
    _send(inp)

def press_key(key_str):
    vks = [_vk_for(p.strip().lower()) for p in key_str.split('+')]
    for vk in vks:
        _key_down(vk); time.sleep(0.02)
    for vk in reversed(vks):
        _key_up(vk); time.sleep(0.02)

def hold_key(key_str, duration):
    vks = [_vk_for(p.strip().lower()) for p in key_str.split('+')]
    duration = max(0.0, float(duration))
    if len(vks) == 1:
        # A single held key: SendInput does NOT auto-repeat on its own (OS repeat
        # is hardware-driven). Emulate auto-repeat with DISCRETE down+up taps. A single keydown held
        # with only one trailing keyup leaves the key state "dirty" on the RDP
        # session and the editor swallows the next keystroke (e.g. a following
        # Enter). Discrete taps keep state clean; a final settle guarantees the
        # next keystroke lands.
        vk = vks[0]; end = time.time() + duration
        while True:
            _key_down(vk); _key_up(vk)
            if time.time() >= end:
                break
            time.sleep(0.04)
        time.sleep(0.06)
    else:
        # Chord (e.g. ctrl+shift+x): hold all down for the duration, release in reverse.
        for vk in vks: _key_down(vk)
        time.sleep(duration)
        for vk in reversed(vks): _key_up(vk)

# ====== Window focus (robust even on a minimized/output-suppressed RDP session) ======
def _win_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ''
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value

def foreground_info():
    hwnd = user32.GetForegroundWindow()
    return {'hwnd': int(hwnd or 0), 'title': _win_title(hwnd) if hwnd else ''}

def find_window(title=None, hwnd=None):
    if hwnd:
        return int(hwnd)
    if not title:
        return 0
    title_l = title.lower()
    match = [0]
    def cb(h, _):
        if user32.IsWindowVisible(h):
            t = _win_title(h)
            if t and title_l in t.lower():
                match[0] = int(h); return 0
        return 1
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return match[0]

def activate_window(hwnd):
    """Bring hwnd to the foreground reliably by attaching to the current foreground
    and target input queues (bypasses the foreground-lock), restoring if minimized."""
    if not hwnd:
        return False
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    cur = kernel32.GetCurrentThreadId()
    fg = user32.GetForegroundWindow()
    fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    tgt_tid = user32.GetWindowThreadProcessId(hwnd, None)
    attached = []
    for tid in {fg_tid, tgt_tid}:
        if tid and tid != cur and user32.AttachThreadInput(cur, tid, 1):
            attached.append(tid)
    user32.BringWindowToTop(hwnd)
    user32.ShowWindow(hwnd, SW_SHOW)
    user32.SetForegroundWindow(hwnd)
    user32.SetActiveWindow(hwnd)
    for tid in attached:
        user32.AttachThreadInput(cur, tid, 0)
    time.sleep(0.12)
    return int(user32.GetForegroundWindow() or 0) == int(hwnd)

def _maybe_focus(body):
    """If a target window is named in the request, focus it before input."""
    if body.get('hwnd') or body.get('title'):
        h = find_window(body.get('title'), body.get('hwnd'))
        if h:
            activate_window(h)
            return h
    return 0

# ====== HTTP handler ======
class AgentHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _auth_ok(self):
        if not TOKEN:
            return True
        hdr = self.headers.get('Authorization', '')
        return hdr == f'Bearer {TOKEN}'

    def _respond(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False, default=str).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._respond({'status': 'ok', 'role': 'inner_agent',
                           'user': os.environ.get('USERNAME', '?'),
                           'session': os.environ.get('SESSIONNAME', '?'), 'port': PORT})
        else:
            self._respond({'error': 'not found'}, 404)

    def do_POST(self):
        try:
            if not self._auth_ok():
                return self._respond({'error': 'unauthorized'}, 401)
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
            self._respond(self._dispatch(body.get('action', self.path.strip('/')), body))
        except Exception as e:
            self._respond({'error': str(e), 'trace': traceback.format_exc()}, 500)

    def _dispatch(self, action, body):
        if action in ('exec', 'launch'):
            cmd = body.get('command', body.get('cmd', ''))
            timeout = body.get('timeout', 60)
            # detach=True (or action 'launch') fire-and-forgets GUI apps without
            # waiting on / inheriting the stdio pipes (which makes a captured run
            # hang on long-lived GUI children like notepad/chrome).
            if action == 'launch' or body.get('detach'):
                DETACHED_PROCESS = 0x00000008
                CREATE_NEW_PROCESS_GROUP = 0x00000200
                p = subprocess.Popen(cmd, shell=True, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
                return {'ok': True, 'detached': True, 'pid': p.pid}
            try:
                r = subprocess.run(cmd, shell=True, capture_output=True, timeout=timeout,
                                   encoding='utf-8', errors='replace')
                return {'stdout': r.stdout, 'stderr': r.stderr, 'exit_code': r.returncode}
            except subprocess.TimeoutExpired:
                return {'error': 'timeout', 'timeout': timeout}
        elif action == 'file_read':
            with open(body['path'], 'rb') as f: data = f.read()
            return {'path': body['path'], 'size': len(data),
                    'content_base64': base64.b64encode(data).decode()}
        elif action in ('file_write', 'file_append'):
            data = base64.b64decode(body['content_base64'])
            os.makedirs(os.path.dirname(body['path']) or '.', exist_ok=True)
            with open(body['path'], 'ab' if action == 'file_append' else 'wb') as f:
                f.write(data)
            return {'path': body['path'], 'size': len(data), 'ok': True}
        elif action == 'screenshot':
            fmt = body.get('format', 'png').lower()
            if fmt == 'bmp':
                w, h, img = screenshot_bmp()
            else:
                fmt = 'png'; w, h, img = screenshot_png()
            return {'format': fmt, 'width': w, 'height': h, 'size': len(img),
                    'image_base64': base64.b64encode(img).decode()}
        elif action == 'desktop_info':
            return {'width': user32.GetSystemMetrics(0), 'height': user32.GetSystemMetrics(1),
                    'user': os.environ.get('USERNAME', '?'),
                    'session': os.environ.get('SESSIONNAME', '?')}
        elif action == 'click':
            click_at(body.get('x', 0), body.get('y', 0)); return {'ok': True}
        elif action == 'double_click':
            double_click_at(body.get('x', 0), body.get('y', 0)); return {'ok': True}
        elif action == 'right_click':
            right_click_at(body.get('x', 0), body.get('y', 0)); return {'ok': True}
        elif action == 'mouse_move':
            move_mouse(body.get('x', 0), body.get('y', 0)); return {'ok': True}
        elif action == 'drag':
            drag(body.get('x1', 0), body.get('y1', 0), body.get('x2', 0), body.get('y2', 0))
            return {'ok': True}
        elif action == 'scroll':
            scroll(body.get('x', 0), body.get('y', 0), body.get('clicks', body.get('amount', -3)))
            return {'ok': True}
        elif action == 'type':
            focused = _maybe_focus(body)
            t = body.get('text', ''); type_text(t)
            return {'ok': True, 'length': len(t), 'focused_hwnd': focused,
                    'foreground': foreground_info()}
        elif action == 'key':
            focused = _maybe_focus(body)
            k = body.get('key', ''); press_key(k)
            return {'ok': True, 'key': k, 'focused_hwnd': focused,
                    'foreground': foreground_info()}
        elif action == 'hold_key':
            _maybe_focus(body)
            hold_key(body.get('key', ''), body.get('duration', 0.5)); return {'ok': True}
        elif action == 'activate':
            h = find_window(body.get('title'), body.get('hwnd'))
            if not h:
                return {'ok': False, 'error': 'window not found',
                        'title': body.get('title'), 'hwnd': body.get('hwnd')}
            ok = activate_window(h)
            return {'ok': ok, 'hwnd': h, 'title': _win_title(h),
                    'foreground': foreground_info()}
        elif action == 'foreground':
            return {'ok': True, 'foreground': foreground_info()}
        elif action == 'ui_info':
            return {'windows': list_windows()}
        elif action == 'ui_tree':
            h = (find_window(body.get('title'), body.get('hwnd'))
                 if (body.get('title') or body.get('hwnd')) else user32.GetForegroundWindow())
            if not h:
                return {'ok': False, 'error': 'no root window'}
            return {'ok': True, 'root': ui_tree(h, int(body.get('max_depth', 6)))}
        elif action == 'observe':
            return observe(body)
        elif action == 'find':
            return find_elements(body)
        elif action == 'read':
            return read_value(body)
        elif action == 'region_hash':
            return {'ok': True, 'hash': region_hash_rect(body['rect'])}
        elif action == 'where_changed':
            return where_changed(body)
        elif action == 'wait_change':
            return wait_change(body)
        elif action == 'act':
            return act(body)
        elif action == 'act_seq':
            return act_seq(body)
        elif action == 'flow_probe':
            return flow_probe(body)
        elif action == 'browser_launch':
            return browser_launch(body.get('url'))
        elif action == 'browser_navigate':
            return browser_navigate(body.get('url', ''))
        elif action == 'browser_eval':
            return browser_eval(body.get('expression', body.get('js', '')))
        elif action == 'browser_screenshot':
            return browser_screenshot()
        elif action == 'browser_targets':
            return browser_targets()
        elif action == 'health':
            return {'status': 'ok', 'role': 'inner_agent',
                    'user': os.environ.get('USERNAME', '?'), 'port': PORT}
        return {'error': f'unknown action: {action}'}

def list_windows():
    windows = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n > 0:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                rect = ctypes.wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                windows.append({'hwnd': int(hwnd), 'title': buf.value,
                                'rect': [rect.left, rect.top, rect.right, rect.bottom]})
        return True
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return windows

# ====== UIA-ish control tree (pure ctypes; direct-child walk, no deps) ======
user32.GetClassNameW.argtypes = [_VP, _wt.LPWSTR, ctypes.c_int]
user32.GetDlgCtrlID.argtypes = [_VP]
user32.GetWindow.restype = _VP; user32.GetWindow.argtypes = [_VP, _wt.UINT]
user32.SendMessageW.restype = ctypes.c_long
user32.SendMessageW.argtypes = [_VP, _wt.UINT, _wt.WPARAM, _VP]
GW_CHILD = 5; GW_HWNDNEXT = 2
WM_GETTEXT = 0x000D; WM_GETTEXTLENGTH = 0x000E

def _cls(h):
    b = ctypes.create_unicode_buffer(256); user32.GetClassNameW(h, b, 256); return b.value

def _ctrl_text(h):
    n = user32.GetWindowTextLengthW(h)
    if n <= 0:  # controls (buttons/edits) often need WM_GETTEXT instead
        n = user32.SendMessageW(h, WM_GETTEXTLENGTH, 0, None)
        if n <= 0:
            return ''
        b = ctypes.create_unicode_buffer(n + 1)
        user32.SendMessageW(h, WM_GETTEXT, n + 1, ctypes.cast(b, _VP)); return b.value
    b = ctypes.create_unicode_buffer(n + 1); user32.GetWindowTextW(h, b, n + 1); return b.value

def _hrect(h):
    r = ctypes.wintypes.RECT(); user32.GetWindowRect(h, ctypes.byref(r))
    return [r.left, r.top, r.right, r.bottom]

def _direct_children(h):
    out = []; c = user32.GetWindow(h, GW_CHILD)
    while c:
        out.append(c); c = user32.GetWindow(c, GW_HWNDNEXT)
    return out

def ui_tree(root, max_depth=6):
    def node(h, depth):
        d = {'hwnd': int(h), 'class': _cls(h), 'text': _ctrl_text(h),
             'id': int(user32.GetDlgCtrlID(h)), 'rect': _hrect(h),
             'visible': bool(user32.IsWindowVisible(h))}
        if depth > 0:
            kids = [node(c, depth - 1) for c in _direct_children(h)]
            if kids:
                d['children'] = kids
        return d
    return node(root, max_depth)

# ====== Chrome/Edge CDP (browser parity with Devin's browser_console) ======
# Minimal stdlib WebSocket + DevTools client => keeps the zero-dep / freezable
# invariant (no websocket-client / playwright needed).
# Prefer Devin's OWN Chrome build first (本源对齐): the agent's browser tool drives
# exactly this binary via CDP. Falling back to system Chrome/Edge keeps parity on
# machines without the Devin build.
_BROWSER_CANDIDATES = [
    r'C:\devin\chrome\chrome-win64\chrome.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
]
# Devin's own Chrome launch flag profile (captured verbatim from the running
# browser tool process). Replicated so the VM browser behaves identically to
# Devin operating its own VM. Per-instance flags (remote-debugging-port,
# user-data-dir, load-extension, the target URL) are appended at launch time.
_DEVIN_CHROME_FLAGS = [
    '--disable-field-trial-config', '--disable-background-networking',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-back-forward-cache', '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages', '--disable-component-update',
    '--no-default-browser-check', '--disable-default-apps',
    '--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,'
    'DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,'
    'AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,'
    'AvoidUnnecessaryBeforeUnloadCheckSync,Translate,HttpsUpgrades,PaintHolding',
    '--allow-pre-commit-input', '--disable-hang-monitor', '--disable-ipc-flooding-protection',
    '--disable-popup-blocking', '--disable-prompt-on-repost', '--disable-renderer-backgrounding',
    '--force-color-profile=srgb', '--metrics-recording-only', '--no-first-run',
    '--enable-automation', '--disable-infobars', '--password-store=basic',
    '--use-mock-keychain', '--no-service-autorun', '--export-tagged-pdf',
    '--disable-search-engine-choice-screen', '--mute-audio',
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,'
    'primaryPointerType=4,availablePointerTypes=4',
    '--no-sandbox', '--disable-blink-features=AutomationControlled', '--noerrdialogs',
    '--auto-accept-browser-signin-for-tests', '--window-size=1600,1122',
    '--window-position=0,0', '--start-maximized', '--disable-gpu',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36; Devin/1.0; +devin.ai',
    '--remote-allow-origins=*',
]
_ADBLOCK_EXT = r'C:\ProgramData\devin\package\chrome_extensions\adblock'
DEBUG_PORT = PORT + 200          # unique per VM (loopback ports are machine-wide)
def _user_data_dir(exe):
    # Per-browser profile dir: chrome and edge profiles are NOT interchangeable,
    # so keying on the exe basename avoids a stale-profile launch failure when a
    # previous run used a different browser on the same VM/port.
    tag = os.path.splitext(os.path.basename(exe))[0].lower()
    return os.path.join(os.environ.get('TEMP', r'C:\Windows\Temp'),
                        f'dao_vm_browser_{PORT}_{tag}')

def _find_browsers():
    return [p for p in _BROWSER_CANDIDATES if os.path.exists(p)]

def _find_browser():
    found = _find_browsers()
    return found[0] if found else None

def _cdp_http(path, method='GET'):
    req = urllib.request.Request(f'http://127.0.0.1:{DEBUG_PORT}/json{path}', method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        data = r.read().decode('utf-8')
    try:
        return json.loads(data)
    except Exception:
        return data

class _CDP:
    """Tiny CDP client over a raw stdlib WebSocket (client frames masked)."""
    def __init__(self, ws_url, timeout=30):
        u = urllib.parse.urlparse(ws_url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        hs = (f'GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n'
              f'Upgrade: websocket\r\nConnection: Upgrade\r\n'
              f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n')
        self.sock.sendall(hs.encode())
        self._buf = b''
        while b'\r\n\r\n' not in self._buf:
            self._buf += self.sock.recv(4096)
        self._buf = self._buf.split(b'\r\n\r\n', 1)[1]
        self._id = 0

    def _rd(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise IOError('ws closed')
            self._buf += chunk
        d, self._buf = self._buf[:n], self._buf[n:]
        return d

    def _send(self, text):
        data = text.encode('utf-8'); n = len(data); mask = os.urandom(4)
        hdr = bytearray([0x81])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack('>H', n)
        else:
            hdr.append(0x80 | 127); hdr += struct.pack('>Q', n)
        hdr += mask
        self.sock.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _recv_msg(self):
        chunks = []
        while True:
            b0, b1 = self._rd(2)
            fin = b0 & 0x80; opcode = b0 & 0x0f; ln = b1 & 0x7f
            if ln == 126:
                ln = struct.unpack('>H', self._rd(2))[0]
            elif ln == 127:
                ln = struct.unpack('>Q', self._rd(8))[0]
            payload = self._rd(ln) if ln else b''
            if opcode == 0x8:
                raise IOError('ws closed by peer')
            if opcode in (0x9, 0xA):   # ping/pong control frames
                continue
            chunks.append(payload)
            if fin:
                return b''.join(chunks)

    def call(self, method, params=None):
        self._id += 1; mid = self._id
        self._send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        while True:
            msg = json.loads(self._recv_msg().decode('utf-8'))
            if msg.get('id') == mid:
                return {'error': msg['error']} if 'error' in msg else msg.get('result', {})

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass

def browser_launch(url=None):
    candidates = _find_browsers()
    if not candidates:
        return {'ok': False, 'error': 'no chrome/edge installed'}
    # Already up? reuse it (matches Devin's single-CDP-endpoint model).
    try:
        _cdp_http('/version')
        if url:
            browser_navigate(url)
        ver = _cdp_http('/version')
        return {'ok': True, 'port': DEBUG_PORT, 'reused': True,
                'version': ver.get('Browser') if isinstance(ver, dict) else None}
    except Exception:
        pass
    last_err = None
    for exe in candidates:
        udd = _user_data_dir(exe)
        args = [exe, f'--remote-debugging-port={DEBUG_PORT}', f'--user-data-dir={udd}']
        args += _DEVIN_CHROME_FLAGS
        if 'chrome' in os.path.basename(exe).lower() and os.path.isdir(_ADBLOCK_EXT):
            args.append(f'--load-extension={_ADBLOCK_EXT}')
        if url:
            args.append(url)
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, creationflags=0x00000008 | 0x00000200)
        ver = None
        for _ in range(30):
            time.sleep(0.5)
            try:
                ver = _cdp_http('/version'); break
            except Exception:
                ver = None
        if ver:
            return {'ok': True, 'port': DEBUG_PORT, 'browser': os.path.basename(exe),
                    'version': ver.get('Browser') if isinstance(ver, dict) else None}
        # This candidate failed to expose CDP -> kill it and try the next one.
        last_err = f'{os.path.basename(exe)} started but CDP never came up'
        try:
            proc.kill()
        except Exception:
            pass
    return {'ok': False, 'error': last_err or 'no browser could expose CDP'}

def _page_target(create_url=None):
    targets = _cdp_http('/list')
    pages = [t for t in targets if t.get('type') == 'page'] if isinstance(targets, list) else []
    if not pages:
        pages = [_cdp_http(f'/new?url={urllib.parse.quote(create_url or "about:blank")}', method='PUT')]
    return pages[0]

def browser_navigate(url):
    pg = _page_target(url); ws = _CDP(pg['webSocketDebuggerUrl'])
    try:
        ws.call('Page.enable'); r = ws.call('Page.navigate', {'url': url})
        return {'ok': 'error' not in r, 'targetId': pg.get('id'), 'url': url,
                'frameId': r.get('frameId'), 'error': r.get('error')}
    finally:
        ws.close()

def browser_eval(expression):
    pg = _page_target(); ws = _CDP(pg['webSocketDebuggerUrl'])
    try:
        r = ws.call('Runtime.evaluate', {'expression': expression,
                                         'returnByValue': True, 'awaitPromise': True})
        if 'error' in r:
            return {'ok': False, 'error': r['error']}
        res = r.get('result', {}); exc = r.get('exceptionDetails')
        return {'ok': exc is None, 'type': res.get('type'), 'value': res.get('value'),
                'description': res.get('description'),
                'exception': exc.get('text') if exc else None}
    finally:
        ws.close()

def browser_screenshot():
    pg = _page_target(); ws = _CDP(pg['webSocketDebuggerUrl'])
    try:
        ws.call('Page.enable'); r = ws.call('Page.captureScreenshot', {'format': 'png'})
        return {'ok': 'data' in r, 'format': 'png', 'image_base64': r.get('data'),
                'error': r.get('error')}
    finally:
        ws.close()

def browser_targets():
    return {'ok': True, 'targets': _cdp_http('/list')}

# ====== Predictive Operation Layer (active inference: predict -> act -> verify -> reflex) ======
# Replaces the "screenshot -> LLM reads pixels -> coords -> screenshot to verify" poll loop
# with cheap, structured, LOCAL verification. The LLM is only pulled in on genuine surprise
# (prediction error that the reflex ladder cannot resolve). See 09_*.md for the rationale.

def _focus_info():
    """The focused control of the foreground thread (class/text/rect), cheap."""
    gti = GUITHREADINFO(); gti.cbSize = ctypes.sizeof(GUITHREADINFO)
    if not user32.GetGUIThreadInfo(0, ctypes.byref(gti)) or not gti.hwndFocus:
        return {'hwnd': 0, 'class': '', 'text': '', 'rect': [0, 0, 0, 0]}
    h = gti.hwndFocus
    return {'hwnd': int(h), 'class': _cls(h), 'text': _ctrl_text(h)[:200], 'rect': _hrect(h)}

def _flatten_tree(node, out, cap=2000):
    out.append(node)
    if len(out) >= cap:
        return
    for c in node.get('children', []):
        _flatten_tree(c, out, cap)
        if len(out) >= cap:
            return

def _tree_sig(hwnd, max_depth=4, cap=600):
    """A stable, compact hash of a window's control tree (class|text|rect|id per node).
    Tiny (8 hex chars) yet sensitive to the state changes that matter for verification."""
    if not hwnd:
        return '0', 0
    nodes = []
    _flatten_tree(ui_tree(hwnd, max_depth), nodes, cap)
    parts = []
    for n in nodes:
        r = n.get('rect', [0, 0, 0, 0])
        parts.append('%s|%s|%d,%d,%d,%d|%d' % (n.get('class', ''), (n.get('text') or '')[:80],
                                               r[0], r[1], r[2], r[3], n.get('id', 0)))
    blob = '\n'.join(parts).encode('utf-8', 'replace')
    return '%08x' % (zlib.crc32(blob) & 0xffffffff), len(nodes)

def state_sig():
    """Compact signature of the desktop's interactive state. Hundreds of bytes, no PNG."""
    fg = user32.GetForegroundWindow()
    fg = int(fg or 0)
    title = _win_title(fg) if fg else ''
    th, nodes = _tree_sig(fg)
    foc = _focus_info()
    composite = '%d|%s|%s|%s|%d,%d' % (fg, title, th, foc['class'], foc['rect'][0], foc['rect'][1])
    return {'fg_hwnd': fg, 'fg_title': title, 'tree_hash': th, 'tree_nodes': nodes,
            'focus_class': foc['class'], 'focus_text': foc['text'],
            'h': '%08x' % (zlib.crc32(composite.encode('utf-8', 'replace')) & 0xffffffff)}

def _grid_gray(l, t, r, b, cols, rows, frame=None, sub=4):
    """Sample a cols x rows grayscale grid from a screen rectangle, averaging each cell over a
    sub x sub block. Block-averaging (not a single center pixel) is what lets thin/sparse pixel
    changes -- a 1px pencil stroke, a caret, a small icon -- still move a cell value, so the
    visual change-detection works on canvas/custom-drawn apps with no control tree.
    Reuses a pre-captured frame when given (avoids a redundant BitBlt)."""
    w, h, row_size, raw = frame if frame else _capture_bgr()
    l = max(0, min(int(l), w - 1)); r = max(l + 1, min(int(r), w))
    t = max(0, min(int(t), h - 1)); b = max(t + 1, min(int(b), h))
    rw = r - l; rh = b - t
    g = [[0] * cols for _ in range(rows)]
    for j in range(rows):
        for i in range(cols):
            acc = 0
            for sj in range(sub):
                yy = min(t + int((j + (sj + 0.5) / sub) * rh / rows), h - 1)
                base = yy * row_size
                for si in range(sub):
                    xx = min(l + int((i + (si + 0.5) / sub) * rw / cols), w - 1)
                    o = base + xx * 3
                    acc += (raw[o + 2] * 30 + raw[o + 1] * 59 + raw[o] * 11) // 100  # BGR->gray
            g[j][i] = acc // (sub * sub)
    return g

def _grid_dhash(l, t, r, b, cols=9, rows=8, frame=None):
    """Difference-hash of a screen rectangle: cheap, robust change detection (no PNG).
    Returns a hex string sized to (cols-1)*rows bits."""
    g = _grid_gray(l, t, r, b, cols, rows, frame)
    bits = 0
    for j in range(rows):
        for i in range(cols - 1):
            bits = (bits << 1) | (1 if g[j][i] < g[j][i + 1] else 0)
    width = ((cols - 1) * rows + 3) // 4
    return ('%0*x') % (width, bits)

def _coarse_visual(region=None, cols=16, rows=16, frame=None):
    """A coarse whole-screen (or region) visual hash for the change-detection FALLBACK that
    keeps 'changed' working on no-control-tree apps (canvas / custom-drawn / games)."""
    if region:
        l, t, r, b = region
    else:
        l, t, r, b = 0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    return _grid_dhash(l, t, r, b, cols, rows, frame)

def _region_gray(region=None, cols=12, rows=10, frame=None):
    """Flat list of block-averaged cell grays for a region (or whole screen). Used as the
    change-detection baseline: comparing absolute cell means with a threshold catches changes
    that dHash misses -- scrolling text preserves left/right brightness ORDER (dHash bits don't
    flip) yet every cell's mean shifts, so a mean-diff sees the scroll. This is what
    where_changed uses, unified into act()'s verification."""
    if region:
        l, t, r, b = region
    else:
        l, t, r, b = 0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    g = _grid_gray(l, t, r, b, cols, rows, frame)
    return [v for row in g for v in row]

def _grays_differ(pre, region, thr=12):
    """True iff any cell mean moved >= thr between the pre baseline and now (block-averaged)."""
    if pre is None:
        return None
    cur = _region_gray(region)
    if len(cur) != len(pre):
        return True
    return any(abs(c - p) >= thr for c, p in zip(cur, pre))

def _crop_png(l, t, r, b):
    """PNG of just one screen rectangle (the surprising region) -- escalation payload only."""
    w, h, row_size, raw = _capture_bgr()
    l = max(0, min(int(l), w)); r = max(l, min(int(r), w))
    t = max(0, min(int(t), h)); b = max(t, min(int(b), h))
    cw = r - l; ch = b - t
    if cw <= 0 or ch <= 0:
        return None
    scan = bytearray()
    for y in range(t, b):
        off = y * row_size + l * 3
        row = bytearray(raw[off:off + cw * 3])
        row[0::3], row[2::3] = row[2::3], row[0::3]  # BGR -> RGB
        scan.append(0); scan += row
    ihdr = struct.pack('>IIBBBBB', cw, ch, 8, 2, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + _png_chunk(b'IHDR', ihdr)
    png += _png_chunk(b'IDAT', zlib.compress(bytes(scan), 6)) + _png_chunk(b'IEND', b'')
    return base64.b64encode(png).decode()

def _root_hwnd(body):
    if body.get('hwnd') or body.get('root_hwnd'):
        return int(body.get('hwnd') or body.get('root_hwnd'))
    if body.get('title') or body.get('root_title'):
        return find_window(body.get('title') or body.get('root_title'))
    return int(user32.GetForegroundWindow() or 0)

def _match_node(n, q):
    if not n.get('visible', True) and not q.get('include_hidden'):
        return False
    txt = (n.get('text') or ''); cls = (n.get('class') or '')
    if q.get('id') is not None and n.get('id') != int(q['id']):
        return False
    if q.get('class') and q['class'].lower() not in cls.lower():
        return False
    if q.get('regex'):
        if not re.search(q['regex'], txt, re.I):
            return False
    elif q.get('text'):
        if q['text'].lower() not in txt.lower():
            return False
    return True

def find_in_root(root, q, max_depth=8):
    if not root:
        return []
    nodes = []
    _flatten_tree(ui_tree(root, max_depth), nodes)
    out = []
    for n in nodes:
        if _match_node(n, q):
            r = n.get('rect', [0, 0, 0, 0])
            out.append({'hwnd': n['hwnd'], 'class': n.get('class', ''), 'text': n.get('text', ''),
                        'id': n.get('id', 0), 'rect': r,
                        'center': [(r[0] + r[2]) // 2, (r[1] + r[3]) // 2]})
    return out

def _uia_find(root, q):
    """UIA fallback mapped into the HWND-find result shape (text/class/rect/center).
    Modern frameworks (Ribbon/WPF/UWP/Chromium/Qt) expose controls only via UIA, not HWNDs."""
    if not _uia:
        return []
    try:
        els = _uia.uia_find(int(root or 0), q)
    except Exception:
        return []
    return [{'hwnd': 0, 'class': e.get('class', ''), 'text': e.get('name', ''), 'id': 0,
             'rect': e.get('rect', [0, 0, 0, 0]), 'center': e.get('center', [0, 0]),
             'control_type': e.get('control_type', ''), 'backend': 'uia'} for e in els]

def find_any(root, q, max_depth=8):
    """Semantic locate: raw HWND tree first (cheapest), then UIA fallback for modern
    frameworks. Mirrors the human instinct -- look for the obvious control; if the
    'obvious' layer has nothing, the richer accessibility layer still sees it."""
    els = find_in_root(root, q, max_depth)
    if els:
        return els
    return _uia_find(root, q)

def _uia_read(root, q):
    """Semantic value/STATE of the first matching control (checkbox toggle, edit value, slider
    range, selection) via UIA -- verify the *meaning* instead of inferring it from pixels."""
    if not _uia:
        return {}
    try:
        return _uia.uia_read(int(root or 0), q) or {}
    except Exception:
        return {}

def read_value(body):
    root = _root_hwnd(body)
    q = body.get('query') or {k: body[k] for k in ('text', 'class', 'id', 'regex', 'control_type') if k in body}
    st = _uia_read(root, q)
    return {'ok': True, 'root': root, 'found': bool(st), 'state': st}

def _find_anywhere(fg, q):
    """Locate a control the way a human's eyes do: the active window first, then any transient
    popup/dialog (which are SEPARATE top-level windows, not in the active window's tree)."""
    els = find_any(int(fg or 0), q)
    if els:
        return els
    for p in _popup_windows():
        els = find_any(p['hwnd'], q)
        if els:
            return els
    return []

def _read_anywhere(fg, q):
    """Semantic value/STATE, searching the active window then transient popups -- so checked/
    state/value verify controls that live in a dialog or popup, not just the foreground tree."""
    st = _uia_read(int(fg or 0), q)
    if st:
        return st
    for p in _popup_windows():
        st = _uia_read(p['hwnd'], q)
        if st:
            return st
    return {}

def find_elements(body):
    root = _root_hwnd(body)
    q = body.get('query') or {k: body[k] for k in ('text', 'class', 'id', 'regex', 'control_type') if k in body}
    els = find_any(root, q, int(body.get('max_depth', 8)))
    backend = 'uia' if (els and els[0].get('backend') == 'uia') else 'tree'
    return {'ok': True, 'root': root, 'count': len(els), 'elements': els, 'backend': backend}

def observe(body):
    """Cheap perception: state signature (+ optional region dHash / screen dHash / tile grid)."""
    sig = state_sig()
    out = {'ok': True, 'sig': sig}
    reg = body.get('region')
    if reg:
        out['region_hash'] = _grid_dhash(*reg)
    if body.get('screen_hash'):
        out['screen_hash'] = _coarse_visual()
    if body.get('tiles'):
        out['tiles'] = _tile_grid(reg, int(body.get('cols', 16)), int(body.get('rows', 16)))
    if body.get('popups'):
        out['popups'] = _popup_windows()
    return out

def region_hash_rect(rect):
    return _grid_dhash(*rect)

def _tile_grid(region, cols, rows):
    if region:
        l, t, r, b = region
    else:
        l, t, r, b = 0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    g = _grid_gray(l, t, r, b, cols, rows)
    return {'region': [l, t, r, b], 'cols': cols, 'rows': rows,
            'gray': [v for row in g for v in row]}

def where_changed(body):
    """Localize WHERE the screen changed, for no-control-tree apps. First call (no baseline)
    returns a tile baseline; pass it back next call to get changed cells + a union bbox in
    screen coords -- the human 'something moved over there' signal, at ~hundreds of bytes."""
    region = body.get('region'); cols = int(body.get('cols', 16)); rows = int(body.get('rows', 16))
    cur = _tile_grid(region, cols, rows)
    base = body.get('baseline')
    if not base:
        return {'ok': True, 'changed': None, 'baseline': cur}
    thr = int(body.get('threshold', 12))
    bg = base['gray']; cg = cur['gray']; l, t, r, b = cur['region']
    cw = (r - l) / cols; ch = (b - t) / rows
    cells = []; minx = miny = 1 << 30; maxx = maxy = -1
    for j in range(rows):
        for i in range(cols):
            if abs(cg[j * cols + i] - bg[j * cols + i]) >= thr:
                cells.append([i, j])
                x0 = int(l + i * cw); y0 = int(t + j * ch)
                x1 = int(l + (i + 1) * cw); y1 = int(t + (j + 1) * ch)
                minx = min(minx, x0); miny = min(miny, y0); maxx = max(maxx, x1); maxy = max(maxy, y1)
    bbox = [minx, miny, maxx, maxy] if cells else None
    return {'ok': True, 'changed': bool(cells), 'cells': cells, 'bbox': bbox, 'baseline': cur}

def wait_change(body):
    """Block until the state signature changes from baseline (or timeout). Event-style
    verification: replaces re-screenshot polling with a tiny signature poll."""
    base = body.get('baseline')
    if base is None:
        base = state_sig()['h']
    reg = body.get('region'); base_rh = body.get('baseline_region_hash')
    if reg and base_rh is None:
        base_rh = _grid_dhash(*reg)
    timeout = float(body.get('timeout', 5.0)); poll = float(body.get('poll', 0.1))
    end = time.time() + timeout
    while time.time() < end:
        cur = state_sig()
        changed = cur['h'] != base
        if reg and not changed:
            changed = _grid_dhash(*reg) != base_rh
        if changed:
            return {'ok': True, 'changed': True, 'sig': cur, 'waited': round(timeout - (end - time.time()), 3)}
        time.sleep(poll)
    return {'ok': True, 'changed': False, 'sig': state_sig(), 'waited': timeout}

# --- expectation evaluation (all LOCAL, no LLM, no full screenshot) ---
def _eval_expect(expect, pre, pre_rh, rect, pre_visual=None, visual_region=None,
                 pre_gray=None, pre_gray_vis=None):
    """Return (matched, reasons). expect is a dict of predicates, all AND-combined.

    'changed' is tree-first but auto-falls back to a coarse visual hash (pre_visual): canvas /
    custom-drawn / game-like apps mutate pixels without any control-tree delta, so a purely
    structural 'changed' would be blind to them. This keeps one predicate honest in both worlds."""
    if not expect:
        return True, ['no-expectation']
    post = state_sig(); reasons = []
    ok = True
    fg = user32.GetForegroundWindow()
    for key, val in expect.items():
        if key == 'changed':
            tree_changed = post['h'] != pre['h']
            vis_changed = None
            if pre_visual is not None:
                vis_changed = _coarse_visual(region=visual_region) != pre_visual
            if not vis_changed and pre_gray_vis is not None:
                vis_changed = _grays_differ(pre_gray_vis, visual_region)
            any_changed = tree_changed or bool(vis_changed)
            r = any_changed == bool(val)
            via = 'tree' if tree_changed else ('visual' if vis_changed else 'none')
            reasons.append('changed=%s(%s)' % ('ok' if r else 'FAIL', via))
            ok = ok and r
            continue
        elif key == 'foreground':
            r = val.lower() in (post['fg_title'] or '').lower()
        elif key == 'foreground_regex':
            r = bool(re.search(val, post['fg_title'] or '', re.I))
        elif key == 'focus_class':
            r = val.lower() in (post['focus_class'] or '').lower()
        elif key == 'focus_text':
            r = val.lower() in (post['focus_text'] or '').lower()
        elif key == 'menu_open':
            r = bool(_menu_open()) == bool(val)
        elif key in ('appears', 'disappears'):
            q = val if isinstance(val, dict) else {'text': val}
            found = bool(_find_anywhere(fg, q))  # active window + transient popups; HWND tree + UIA
            r = found if key == 'appears' else (not found)
        elif key == 'value':
            sel = dict(val); equals = sel.pop('equals', None); contains = sel.pop('contains', None)
            els = _find_anywhere(fg, sel)
            txt = els[0]['text'] if els else None
            r = (txt == equals) if equals is not None else \
                (contains.lower() in (txt or '').lower() if contains is not None else bool(els))
        elif key in ('checked', 'unchecked'):
            # semantic toggle STATE via UIA (read the meaning, not the pixels)
            sel = val if isinstance(val, dict) else {'text': val}
            st = _read_anywhere(fg, sel)
            r = (st.get('toggle') == 1) if key == 'checked' else (st.get('toggle') == 0)
        elif key == 'state':
            # general semantic assertion: {'text':..,'toggle':1} / {'value':..,'equals':..} / 'selected'/'range'
            sel = dict(val)
            want = {k: sel.pop(k) for k in ('toggle', 'selected', 'value', 'range') if k in sel}
            st = _read_anywhere(fg, sel)
            r = bool(st) and all(st.get(k) == v for k, v in want.items())
        elif key in ('region_changed', 'region_stable'):
            rr = val if isinstance(val, (list, tuple)) else rect
            ch_d = (_grid_dhash(*rr) != pre_rh) if (rr and pre_rh is not None) else None
            ch_t = _grays_differ(pre_gray, rr) if (rr and pre_gray is not None) else None
            changed = None if (ch_d is None and ch_t is None) else (bool(ch_d) or bool(ch_t))
            r = (changed is True) if key == 'region_changed' else (changed is False)
        else:
            r = True  # unknown predicate => non-blocking
        reasons.append('%s=%s' % (key, 'ok' if r else 'FAIL'))
        ok = ok and r
    return ok, reasons

# --- the act() core: predict -> act -> verify -> reflex retry -> escalate-on-surprise ---
_COORD_OPS = {'click', 'double_click', 'right_click', 'mouse_move', 'drag', 'scroll'}

def _resolve_target(body):
    """-> (x, y, rect | None). Semantic target resolved LOCALLY via the control tree."""
    t = body.get('target')
    if isinstance(t, dict):
        if 'x' in t and 'y' in t:
            return int(t['x']), int(t['y']), None
        els = find_any(_root_hwnd(body), t, int(body.get('max_depth', 8)))
        nth = int(t.get('nth', 0))
        if els and nth < len(els):
            e = els[nth]; return e['center'][0], e['center'][1], e['rect']
        return None, None, None
    if 'x' in body and 'y' in body:
        return int(body['x']), int(body['y']), None
    return None, None, None

def _do_op(op, x, y, body):
    if op == 'click': click_at(x, y)
    elif op == 'double_click': double_click_at(x, y)
    elif op == 'right_click': right_click_at(x, y)
    elif op == 'mouse_move': move_mouse(x, y)
    elif op == 'scroll': scroll(x, y, int(body.get('clicks', body.get('amount', -3))))
    elif op == 'drag': drag(x, y, int(body['x2']), int(body['y2']))
    elif op == 'type':
        if x is not None: click_at(x, y); time.sleep(0.05)
        type_text(body.get('text', ''))
    elif op == 'key':
        if x is not None: click_at(x, y); time.sleep(0.05)
        press_key(body.get('key', ''))
    elif op == 'hold_key':
        hold_key(body.get('key', ''), body.get('duration', 0.5))
    else:
        raise ValueError('unknown op: %s' % op)

def act(body):
    """Predict-act-verify with a local reflex ladder. Cheap on the happy path; only escalates
    (returns a cropped region PNG + signature diff) when prediction error persists."""
    op = body.get('op', 'click')
    expect = body.get('expect') or {}
    max_retry = int(body.get('retry', 3))
    x, y, rect = _resolve_target(body)
    if op in _COORD_OPS and x is None:
        return {'ok': False, 'matched': False, 'error': 'target not found',
                'target': body.get('target')}
    # region to watch: explicit, else the resolved target rect
    watch = expect.get('region') if isinstance(expect.get('region'), (list, tuple)) else rect
    if isinstance(expect.get('region_changed'), (list, tuple)):
        watch = expect['region_changed']
    # world-model 'effect' predicate: verify the action's LOCAL VISUAL change against what practice
    # has learned this action does here -- the pixel-only path for canvas/no-semantics apps.
    eff = expect.get('effect') if isinstance(expect.get('effect'), dict) else None
    expect_pred = {k: v for k, v in expect.items() if k != 'effect'}
    eff_region = (eff.get('region') if eff else None) or watch or rect
    pre_eff = _region_gray(eff_region, 16, 16) if (eff and _vmodel is not None and eff_region) else None
    pre = state_sig()
    pre_rh = _grid_dhash(*watch) if watch else None
    pre_gray = _region_gray(watch) if watch else None
    # visual fallback baseline for 'changed' (target region if known, else whole screen)
    vis_region = (watch or rect) if (watch or rect) else None
    pre_visual = _coarse_visual(region=vis_region) if 'changed' in expect_pred else None
    pre_gray_vis = _region_gray(vis_region) if 'changed' in expect_pred else None
    _do_op(op, x, y, body)
    matched, reasons = _eval_expect(expect_pred, pre, pre_rh, watch or rect, pre_visual, vis_region,
                                    pre_gray, pre_gray_vis)
    eff_res = None
    if pre_eff is not None:
        cur_eff = _region_gray(eff_region, 16, 16)
        obs = _vmodel.change_descriptor(pre_eff, cur_eff, 16, 16)
        ctx = _vmodel.context_fp(pre_eff, 16, 16)
        akey = eff.get('action') or op
        wm = _wm()
        v = wm.verify(akey, ctx, obs)
        if eff.get('learn', True):
            wm.record(akey, ctx, obs); wm.save()
        eff_res = {'action': akey, 'region': list(eff_region),
                   'obs': {'mag': obs['mag'], 'cx': obs['cx'], 'cy': obs['cy']}, **v}
        if v.get('known'):
            matched = matched and bool(v.get('match'))  # known mismatch is a real prediction error
        reasons.append('effect=%s(%s)' % ('ok' if v.get('match') else ('novel' if not v.get('known')
                       else 'FAIL'), akey))
    attempts = 1; ladder = []
    # reflex ladder: the human "no reaction -> click/double-click/retry again" instinct.
    # Skipped when an 'effect' is asserted: canvas drags/scrolls are NON-idempotent, re-issuing them
    # compounds the motion instead of re-checking; the world model just reports prediction error.
    while not matched and attempts <= max_retry and eff is None:
        strat = None
        if op in ('click', 'double_click', 'right_click'):
            seq = ['wait', 'refocus', 'double', 'jitter']
            strat = seq[(attempts - 1) % len(seq)]
            if strat == 'wait':
                time.sleep(0.18)
            elif strat == 'refocus':
                rh = _root_hwnd(body)
                if rh: activate_window(rh)
                time.sleep(0.05); _do_op(op, x, y, body)
            elif strat == 'double':
                double_click_at(x, y)
            elif strat == 'jitter':
                _do_op(op, x + 3, y + 2, body)
        elif op in ('type', 'key'):
            # Keystrokes are NON-idempotent: re-emitting double-types text or toggles a toggle
            # (Ctrl+B) right back off. The human reflex on "did that land?" is to wait & re-check,
            # not to blindly retype. Only re-emit when the caller marks the op idempotent.
            if body.get('idempotent'):
                strat = 'retry'; time.sleep(0.08); _do_op(op, x, y, body)
            else:
                strat = 'wait'; time.sleep(0.18)
        else:
            strat = 'wait'; time.sleep(0.15)
        ladder.append(strat)
        matched, reasons = _eval_expect(expect_pred, pre, pre_rh, watch or rect, pre_visual, vis_region,
                                        pre_gray, pre_gray_vis)
        attempts += 1
    res = {'ok': True, 'matched': matched, 'op': op, 'attempts': attempts,
           'reflex': ladder, 'reasons': reasons, 'target_xy': [x, y] if x is not None else None}
    if eff_res is not None:
        res['effect'] = eff_res
    if not matched:
        # genuine surprise -> escalate with the MINIMAL extra perception the brain needs
        post = state_sig()
        res['prediction_error'] = {
            'pre': {k: pre[k] for k in ('fg_title', 'tree_hash', 'focus_class', 'h')},
            'post': {k: post[k] for k in ('fg_title', 'tree_hash', 'focus_class', 'h')}}
        crop = watch or rect
        if not crop and x is not None:  # coordinate action -> crop a box around the point
            crop = [x - 160, y - 110, x + 160, y + 110]
        if crop:
            png = _crop_png(*crop)
            if png:
                res['region_png_base64'] = png; res['region_rect'] = list(crop)
    return res

def act_seq(body):
    """Speculative multi-action: run a predicted chain of act() steps with per-step
    self-verification. One plan, zero per-step LLM/screenshot on the happy path; abort and
    escalate at the first unrecoverable prediction error (stop_on_error default True)."""
    steps = body.get('steps') or []
    stop = body.get('stop_on_error', True)
    results = []; ok_all = True
    for i, st in enumerate(steps):
        r = act(st)
        results.append({'i': i, **{k: r[k] for k in ('matched', 'op', 'attempts', 'reflex')}})
        if not r.get('matched'):
            ok_all = False
            results[-1]['prediction_error'] = r.get('prediction_error')
            if 'region_png_base64' in r:
                results[-1]['region_png_base64'] = r['region_png_base64']
                results[-1]['region_rect'] = r.get('region_rect')
            if stop:
                break
    return {'ok': True, 'all_matched': ok_all, 'completed': len(results), 'total': len(steps),
            'steps': results}

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True

def main():
    srv = ThreadedHTTPServer((BIND, PORT), AgentHandler)
    print(f'[vm_inner_agent v2] {os.environ.get("USERNAME","?")} listening on {BIND}:{PORT}')
    sys.stdout.flush()
    srv.serve_forever()

if __name__ == '__main__':
    main()
