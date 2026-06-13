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
import socket, urllib.request, urllib.parse

PORT  = int(os.environ.get('VM_AGENT_PORT', '9001'))
TOKEN = os.environ.get('VM_AGENT_TOKEN', '')          # '' => no auth (loopback only)
BIND  = os.environ.get('VM_AGENT_BIND', '127.0.0.1')

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
_BROWSER_CANDIDATES = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
]
DEBUG_PORT = PORT + 200          # unique per VM (loopback ports are machine-wide)
_USER_DATA = os.path.join(os.environ.get('TEMP', r'C:\Windows\Temp'), f'dao_vm_browser_{PORT}')

def _find_browser():
    for p in _BROWSER_CANDIDATES:
        if os.path.exists(p):
            return p
    return None

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
    exe = _find_browser()
    if not exe:
        return {'ok': False, 'error': 'no chrome/edge installed'}
    try:
        _cdp_http('/version'); up = True
    except Exception:
        up = False
    if not up:
        args = [exe, f'--remote-debugging-port={DEBUG_PORT}', f'--user-data-dir={_USER_DATA}',
                '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*']
        if url:
            args.append(url)
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=0x00000008 | 0x00000200)
        ver = None
        for _ in range(40):
            time.sleep(0.5)
            try:
                ver = _cdp_http('/version'); break
            except Exception:
                ver = None
        if not ver:
            return {'ok': False, 'error': 'browser started but CDP endpoint never came up'}
    elif url:
        browser_navigate(url)
    ver = _cdp_http('/version')
    return {'ok': True, 'port': DEBUG_PORT, 'browser': os.path.basename(exe),
            'version': ver.get('Browser') if isinstance(ver, dict) else None}

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
