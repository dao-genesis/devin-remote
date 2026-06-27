"""F165 — UI Automation (UIA) read access via raw COM in pure ctypes (no
comtypes, no extra deps).

The Win32 semantic layer (F160–F164: child_windows, window_text, window_menu)
reads *native* controls — real child HWNDs and OS menus. It is **blind to modern
apps**: Chrome, Electron, UWP and most current software paint their entire UI
inside a single window with no child controls and no OS menu, so child_windows
returns almost nothing and the meaning is invisible. UIA is the OS accessibility
tree that *does* see inside them — the same tree a screen reader uses. This module
adds a read window onto it: the accessible *name* of a window, and its child
elements (name + control type), uniformly across native and modern apps.

Everything is best-effort: any failure yields empty results so the backend never
breaks, and callers fall back to the Win32 / pixel floor.
"""
import ctypes
from ctypes import wintypes

_ole32 = ctypes.windll.ole32
_oleaut = ctypes.windll.oleaut32
_oleaut.SysFreeString.argtypes = [ctypes.c_void_p]


class _GUID(ctypes.Structure):
    _fields_ = [("d1", ctypes.c_ulong), ("d2", ctypes.c_ushort),
                ("d3", ctypes.c_ushort), ("d4", ctypes.c_ubyte * 8)]


class _VARIANT(ctypes.Structure):
    _fields_ = [("vt", ctypes.c_ushort), ("r1", ctypes.c_ushort),
                ("r2", ctypes.c_ushort), ("r3", ctypes.c_ushort),
                ("val", ctypes.c_void_p), ("pad", ctypes.c_void_p)]


def _guid(s):
    g = _GUID()
    _ole32.CLSIDFromString(ctypes.c_wchar_p(s), ctypes.byref(g))
    return g


_CLSID_CUIAutomation = _guid("{ff48dba4-60ef-4201-aa87-54103eef594e}")
_IID_IUIAutomation = _guid("{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}")

# IUIAutomation vtable indices (after IUnknown 0..2)
_EFH = 6        # ElementFromHandle
_CTRUE = 21     # CreateTrueCondition
# IUIAutomationElement vtable indices
_FINDALL = 6    # FindAll
_GETPROP = 10   # GetCurrentPropertyValue
# IUIAutomationElementArray vtable indices
_ARR_LEN = 3    # get_Length
_ARR_GET = 4    # GetElement

_UIA_NameProperty = 30005
_UIA_ControlTypeProperty = 30003
_TreeScope_Children = 2

# Control-type ids → readable names (the common ones).
_CONTROL_TYPES = {
    50000: "Button", 50001: "Calendar", 50002: "CheckBox", 50003: "ComboBox",
    50004: "Edit", 50005: "Hyperlink", 50006: "Image", 50007: "ListItem",
    50008: "List", 50009: "Menu", 50010: "MenuBar", 50011: "MenuItem",
    50012: "ProgressBar", 50013: "RadioButton", 50014: "ScrollBar",
    50015: "Slider", 50016: "Spinner", 50017: "StatusBar", 50018: "Tab",
    50019: "TabItem", 50020: "Text", 50021: "ToolBar", 50022: "ToolTip",
    50023: "Tree", 50024: "TreeItem", 50025: "Custom", 50026: "Group",
    50027: "Thumb", 50028: "DataGrid", 50029: "DataItem", 50030: "Document",
    50031: "SplitButton", 50032: "Window", 50033: "Pane", 50034: "Header",
    50035: "HeaderItem", 50036: "Table", 50037: "TitleBar", 50038: "Separator",
}

_uia = None  # cached IUIAutomation pointer (per process)
_init_failed = False


def _vcall(ptr, idx, restype, argtypes, *args):
    table = ctypes.cast(ctypes.cast(ptr, ctypes.POINTER(ctypes.c_void_p))[0],
                        ctypes.POINTER(ctypes.c_void_p))
    fn = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(table[idx])
    return fn(ptr, *args)


def _release(ptr):
    if ptr:
        try:
            _vcall(ptr, 2, ctypes.c_ulong, [])  # IUnknown::Release
        except Exception:
            pass


def _get_uia():
    global _uia, _init_failed
    if _uia is not None or _init_failed:
        return _uia
    try:
        _ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED (idempotent)
        pp = ctypes.c_void_p()
        hr = _ole32.CoCreateInstance(ctypes.byref(_CLSID_CUIAutomation), None, 1,
                                     ctypes.byref(_IID_IUIAutomation),
                                     ctypes.byref(pp))
        if hr != 0 or not pp.value:
            _init_failed = True
            return None
        _uia = pp.value
    except Exception:
        _init_failed = True
    return _uia


def _prop_bstr(el, prop):
    v = _VARIANT()
    if _vcall(el, _GETPROP, ctypes.c_long,
              [ctypes.c_int, ctypes.POINTER(_VARIANT)], prop, ctypes.byref(v)) != 0:
        return ""
    if v.vt == 8 and v.val:  # VT_BSTR
        s = ctypes.wstring_at(v.val)
        _oleaut.SysFreeString(v.val)
        return s
    return ""


def _prop_int(el, prop):
    v = _VARIANT()
    if _vcall(el, _GETPROP, ctypes.c_long,
              [ctypes.c_int, ctypes.POINTER(_VARIANT)], prop, ctypes.byref(v)) != 0:
        return 0
    if v.vt == 3:  # VT_I4 — the 4-byte value sits in the low bits of the union
        return int(v.val) & 0xFFFFFFFF if v.val else 0
    return 0


def _element(uia, win):
    el = ctypes.c_void_p()
    hr = _vcall(uia, _EFH, ctypes.c_long,
                [wintypes.HWND, ctypes.POINTER(ctypes.c_void_p)],
                wintypes.HWND(int(win)), ctypes.byref(el))
    return el.value if hr == 0 else None


def uia_name(win: int) -> str:
    """The accessible *name* of a window's UIA element — the title/label the OS
    accessibility tree reports, available even for modern apps that expose no
    Win32 title to a cross-process reader. "" if UIA is unavailable."""
    uia = _get_uia()
    if not uia:
        return ""
    el = _element(uia, win)
    if not el:
        return ""
    try:
        return _prop_bstr(el, _UIA_NameProperty)
    finally:
        _release(el)


def uia_children(win: int) -> list:
    """The direct child elements of a window in the UIA tree as
    ``[{"name","type"}, …]`` — seeing *inside* modern apps (Chrome, Electron, UWP)
    where :func:`child_windows` is blind because they have no child HWNDs. ``type``
    is the UIA control-type name (Button, Edit, Tab, Document, …). [] if UIA is
    unavailable."""
    uia = _get_uia()
    if not uia:
        return []
    el = _element(uia, win)
    if not el:
        return []
    cond = ctypes.c_void_p()
    arr = ctypes.c_void_p()
    out = []
    try:
        if _vcall(uia, _CTRUE, ctypes.c_long, [ctypes.POINTER(ctypes.c_void_p)],
                  ctypes.byref(cond)) != 0:
            return []
        if _vcall(el, _FINDALL, ctypes.c_long,
                  [ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
                  _TreeScope_Children, cond, ctypes.byref(arr)) != 0 or not arr.value:
            return []
        n = ctypes.c_int()
        _vcall(arr.value, _ARR_LEN, ctypes.c_long,
               [ctypes.POINTER(ctypes.c_int)], ctypes.byref(n))
        for i in range(n.value):
            ce = ctypes.c_void_p()
            if _vcall(arr.value, _ARR_GET, ctypes.c_long,
                      [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)],
                      i, ctypes.byref(ce)) != 0 or not ce.value:
                continue
            try:
                t = _prop_int(ce.value, _UIA_ControlTypeProperty)
                out.append({"name": _prop_bstr(ce.value, _UIA_NameProperty),
                            "type": _CONTROL_TYPES.get(t, str(t))})
            finally:
                _release(ce.value)
        return out
    finally:
        _release(cond.value)
        _release(arr.value)
        _release(el)
