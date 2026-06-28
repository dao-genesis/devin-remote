"""F199 — drive a window parked on **another Windows virtual desktop** (zero
on-screen pixels) by meaning, and prove the floor can now *see* the workspace axis
it was blind to.

The screenshot+click loop is defined by pixels; a window on a non-current virtual
desktop has none — the same nothing-to-click as F192's minimized window, but by
*workspace*, not show-state. This proves:
  1. baseline: floor reports the fixture on the current desktop (has pixels)
  2. after Win+Ctrl+D the fixture is parked on the prior desktop — the floor now
     SEES it: window_on_current_desktop -> False, and its workspace identity
     (window_desktop GUID) is stable and differs from current_desktop()
  3. the semantic floor still DRIVES it with zero pixels: uia_set_value / uia_invoke
     / uia_text all reach across the workspace boundary
  4. honest boundary: the documented MoveWindowToDesktop refuses a foreign-process
     window (E_ACCESSDENIED), so the floor does not fake "bring it here" on Windows.

Run: ``python _probe_vdesk.py``.
"""
import os, sys, time, subprocess, ctypes
from ctypes import wintypes, POINTER, byref, c_void_p
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

HERE = os.path.dirname(os.path.abspath(__file__))
TITLE = "DaoVDesk_%d" % (os.getpid() % 100000)
VK_LWIN, VK_CONTROL, VK_D, VK_LEFT, VK_F4 = 0x5B, 0x11, 0x44, 0x25, 0x73

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")


def find_win(sub):
    for w in osctl.list_windows():
        if sub.lower() in (w.get("title") or "").lower():
            return w["id"]
    return None


# ---- the documented MoveWindowToDesktop, to prove the honest boundary ------- #
class _GUID(ctypes.Structure):
    _fields_ = [("a", wintypes.DWORD), ("b", wintypes.WORD), ("c", wintypes.WORD),
                ("d", ctypes.c_ubyte * 8)]
_ole = ctypes.windll.ole32
_ole.CoInitialize(None)
def _g(s):
    x = _GUID(); _ole.CLSIDFromString(s, byref(x)); return x
_p = c_void_p()
_ole.CoCreateInstance(byref(_g("{aa509086-5ca9-4c25-8f95-589d3c07b48a}")), None, 23,
                      byref(_g("{a5cd92ff-29be-454c-8d04-d82879fb3f1b}")), byref(_p))
_vt = ctypes.cast(_p, POINTER(POINTER(c_void_p))).contents
_GETID = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p, wintypes.HWND, POINTER(_GUID))(_vt[4])
_MOVE = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p, wintypes.HWND, POINTER(_GUID))(_vt[5])


proc = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                         "-File", os.path.join(HERE, "_fixture_wpf.ps1"), "-Title", TITLE])
win = None
for _ in range(50):
    time.sleep(0.3)
    win = find_win(TITLE)
    if win:
        break
print("fixture hwnd:", win)
time.sleep(1.0)

try:
    on0 = osctl.window_on_current_desktop(win)
    d0 = osctl.window_desktop(win)
    cur0 = osctl.current_desktop()
    check("baseline: floor sees fixture on current desktop (has pixels)",
          on0 is True and d0 and d0 == cur0, f"on={on0} desk={d0} cur={cur0}")

    # create + switch to a fresh virtual desktop; the fixture stays on the prior one
    osctl.chord(VK_LWIN, VK_CONTROL, VK_D)
    time.sleep(1.6)

    on1 = osctl.window_on_current_desktop(win)
    d1 = osctl.window_desktop(win)
    cur1 = osctl.current_desktop()
    check("floor now SEES fixture off-workspace (zero pixels)",
          on1 is False, f"on_current={on1}")
    check("fixture workspace identity stable & differs from the now-current one",
          d1 and d1 == d0 and d1 != cur1, f"fixture_desk={d1} prev_cur={cur0} now_cur={cur1}")

    # the semantic floor drives the pixel-less window by meaning
    set_ok = osctl.uia_set_value(win, "ACROSS-DESKTOP-道法自然", name="field")
    rb = osctl.uia_get_value(win, name="field")
    check("uia_set_value reaches the off-workspace window", rb == "ACROSS-DESKTOP-道法自然",
          f"readback={rb!r}")

    osctl.uia_invoke(win, name="ping")
    time.sleep(0.3)
    pong = osctl.uia_get_value(win, name="field")
    check("uia_invoke reaches the off-workspace window", pong == "PONG", f"field={pong!r}")

    txt = osctl.uia_text(win, name="doc")
    check("uia_text reads the off-workspace window", "line beta" in (txt or ""), f"text={txt!r}")

    # honest boundary: documented MoveWindowToDesktop refuses a foreign window
    g = _GUID()
    _GETID(_p, wintypes.HWND(int(win)), byref(g))   # the fixture's own desktop id (valid GUID)
    hr = _MOVE(_p, wintypes.HWND(int(win)), byref(g)) & 0xFFFFFFFF
    check("documented MoveWindowToDesktop denies a foreign-process window (E_ACCESSDENIED)",
          hr == 0x80070005, f"hr=0x%08X" % hr)
    check("floor does not fake the act on Windows (move_window_to_desktop is a no-op)",
          osctl.move_window_to_desktop(win, 0) is False)
finally:
    osctl.chord(VK_LWIN, VK_CONTROL, VK_LEFT)   # back to the original desktop
    time.sleep(1.2)
    osctl.chord(VK_LWIN, VK_CONTROL, VK_F4)      # close the temporary empty desktop
    time.sleep(0.8)
    try:
        proc.terminate()
    except Exception:
        pass

print(f"\n==== {len(PASS)} PASS / {len(FAIL)} FAIL ====")
sys.exit(1 if FAIL else 0)
