# -*- coding: utf-8 -*-
"""Runs in administrator session 1. Window policy for non-interference + active zhou:
 - zhou RDP (127.0.0.3): ensure NOT minimized (keeps session active), move OFF-SCREEN
   so it doesn't clutter the admin desktop, do NOT steal foreground.
 - other RDP (e.g. 192.168.31.179): re-minimize (restore the user's prior state, since
   we only touched it incidentally).
Writes report to C:\\dao_vm\\winmgr.txt."""
import ctypes, ctypes.wintypes as wt, io
u = ctypes.windll.user32
u.GetForegroundWindow.restype = ctypes.c_void_p
EnumProc = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
SWP_NOSIZE=0x1; SWP_NOZORDER=0x4; SWP_NOACTIVATE=0x10
def title(h):
    n=u.GetWindowTextLengthW(h)
    if n<=0: return ''
    b=ctypes.create_unicode_buffer(n+1); u.GetWindowTextW(h,b,n+1); return b.value
def clsname(h):
    b=ctypes.create_unicode_buffer(256); u.GetClassNameW(h,b,256); return b.value
rep=io.open(r'C:\dao_vm\winmgr.txt','w',encoding='utf-8')
targets=[]
def cb(h,_):
    if 'TscShellContainerClass' in clsname(h):
        targets.append((int(h),title(h),bool(u.IsIconic(h))))
    return 1
u.EnumWindows(EnumProc(cb),0)
for h,t,ic in targets:
    if '127.0.0.3' in t:
        if ic: u.ShowWindow(h,9)   # SW_RESTORE -> un-suppress session
        u.ShowWindow(h,5)          # SW_SHOWNORMAL
        # move fully off the visible desktop (left of x=0), no activate, keep active
        u.SetWindowPos(h, None, -4000, 0, 0, 0, SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE)
        rep.write("zhou(127.0.0.3) hwnd=%d was_iconic=%s -> restored+offscreen\n"%(h,ic))
    else:
        u.ShowWindow(h,6)          # SW_MINIMIZE (restore prior minimized state)
        rep.write("other hwnd=%d title=%r -> minimized\n"%(h,t))
rep.write("foreground(after)=%r\n"%(int(u.GetForegroundWindow() or 0),))
rep.close()
print("winmgr-done targets=%d"%len(targets))
