# -*- coding: utf-8 -*-
"""Runs in administrator's console session (1). Finds the mstsc (Remote Desktop)
client window(s) and restores them if minimized, so the loopback RDP session to
zhou becomes ACTIVE again (active input desktop -> SendInput works). Writes a
report to C:\\dao_vm\\mstsc_state.txt. Moves the window to a back corner to stay
out of the way rather than maximized in the user's face."""
import ctypes, ctypes.wintypes as wt, io, sys
out = io.open(r'C:\dao_vm\mstsc_state.txt', 'w', encoding='utf-8')
u = ctypes.windll.user32; k = ctypes.windll.kernel32
u.GetForegroundWindow.restype = ctypes.c_void_p
EnumProc = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
def title(h):
    n = u.GetWindowTextLengthW(h)
    if n <= 0: return ''
    b = ctypes.create_unicode_buffer(n+1); u.GetWindowTextW(h, b, n+1); return b.value
def clsname(h):
    b = ctypes.create_unicode_buffer(256); u.GetClassNameW(h, b, 256); return b.value
found = []
def cb(h, _):
    if u.IsWindowVisible(h) or u.IsIconic(h):
        c = clsname(h); t = title(h)
        if 'TscShellContainerClass' in c or 'mstsc' in t.lower() or '远程桌面' in t or 'Remote Desktop' in t:
            r = wt.RECT(); u.GetWindowRect(h, ctypes.byref(r))
            found.append((int(h), c, t, bool(u.IsIconic(h)), (r.left, r.top, r.right, r.bottom)))
    return 1
u.EnumWindows(EnumProc(cb), 0)
out.write("foreground(before)=%r\n" % (int(u.GetForegroundWindow() or 0),))
out.write("mstsc-like windows found: %d\n" % len(found))
for h, c, t, ic, rect in found:
    out.write("  hwnd=%d class=%s title=%r iconic=%s rect=%s\n" % (h, c, t, ic, rect))
    # restore if minimized, show, move to a back corner (small) to stay unobtrusive
    if ic:
        u.ShowWindow(h, 9)  # SW_RESTORE
    u.ShowWindow(h, 5)      # SW_SHOW
    # keep it active but small in bottom-right-ish; do NOT steal foreground aggressively
    u.SetWindowPos(h, ctypes.c_void_p(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)  # HWND_BOTTOM, NOSIZE|NOMOVE|NOACTIVATE
out.write("done\n")
out.close()
print("mstsc-restore-done found=%d" % len(found))
