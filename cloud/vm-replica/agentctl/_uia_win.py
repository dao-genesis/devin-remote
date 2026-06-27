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
_oleaut.SysAllocString.restype = ctypes.c_void_p
_oleaut.SysAllocString.argtypes = [ctypes.c_wchar_p]


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
_SETFOCUS = 3   # SetFocus
_FINDALL = 6    # FindAll
_GETPROP = 10   # GetCurrentPropertyValue
# IUIAutomationTextPattern / IUIAutomationTextRange vtable indices
_TEXT_DOCRANGE = 7    # IUIAutomationTextPattern::get_DocumentRange
_RANGE_GETTEXT = 12   # IUIAutomationTextRange::GetText
_UIA_TextPatternId = 10014
# IUIAutomationElementArray vtable indices
_ARR_LEN = 3    # get_Length
_ARR_GET = 4    # GetElement

_UIA_NameProperty = 30005
_UIA_ControlTypeProperty = 30003
_UIA_BoundingRectangleProperty = 30001
_TreeScope_Children = 2
_TreeScope_Descendants = 4

# IUIAutomationElement::GetCurrentPattern is vtable index 16; pattern objects then
# expose their own methods at index 3+.
_GETPATTERN = 16
_UIA_InvokePatternId = 10000
_UIA_ValuePatternId = 10002
_INVOKE = 3        # IUIAutomationInvokePattern::Invoke
_VALUE_SET = 3     # IUIAutomationValuePattern::SetValue
_VALUE_GET = 4     # IUIAutomationValuePattern::get_CurrentValue

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


def _prop_rect(el):
    """The element's on-screen BoundingRectangle as (x, y, w, h), or None. UIA
    returns it as a VARIANT holding a SAFEARRAY of 4 R8 (left, top, width,
    height)."""
    v = _VARIANT()
    if _vcall(el, _GETPROP, ctypes.c_long,
              [ctypes.c_int, ctypes.POINTER(_VARIANT)],
              _UIA_BoundingRectangleProperty, ctypes.byref(v)) != 0:
        return None
    if v.vt != 0x2005 or not v.val:  # VT_ARRAY | VT_R8
        return None
    try:
        pv = ctypes.c_void_p.from_address(v.val + 16).value  # SAFEARRAY.pvData @ x64
        if not pv:
            return None
        a = (ctypes.c_double * 4).from_address(pv)
        return (int(a[0]), int(a[1]), int(a[2]), int(a[3]))
    finally:
        _oleaut.VariantClear(ctypes.byref(v))


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


def uia_find(win: int, name=None, ctype=None, max_scan: int = 6000):
    """Find a descendant element of ``win`` by its *meaning* — accessible name
    (case-insensitive substring) and/or control type (e.g. ``"Button"``,
    ``"Tab"``, ``"Edit"``) — and report *where it is*:
    ``{"name","type","rect":(x,y,w,h)}`` in screen coordinates, or None. The UIA
    analogue of :func:`find_control`, but it works *inside modern apps* (the
    accessibility tree, not native child HWNDs), and returning the rect closes the
    loop back to the pixel actuator: a semantic search in Chrome/Electron/UWP hands
    the mouse a target to click — no visual scanning. ``max_scan`` bounds the walk
    so a huge tree cannot hang."""
    uia = _get_uia()
    if not uia:
        return None
    el = _find_ptr(uia, win, name, ctype, max_scan)
    if not el:
        return None
    try:
        return {"name": _prop_bstr(el, _UIA_NameProperty),
                "type": _CONTROL_TYPES.get(_prop_int(el, _UIA_ControlTypeProperty)),
                "rect": _prop_rect(el)}
    finally:
        _release(el)


def _find_ptr(uia, win, name=None, ctype=None, max_scan: int = 6000):
    """Return the raw element pointer of the descendant of ``win`` best matching
    name/type, or None. Caller must _release() it. Shared by uia_find and the
    action helpers. Matching prefers an **exact** (case-insensitive) name equality
    over a mere substring: driving the calculator showed substring matching picks
    ``'Memory add'`` when you asked for ``'Add'`` (it appears earlier in the tree),
    so an exact name, if one exists anywhere in scope, always wins; the first
    substring match is kept only as a fallback."""
    el = _element(uia, win)
    if not el:
        return None
    cond = ctypes.c_void_p()
    arr = ctypes.c_void_p()
    nl = name.lower() if name else None
    fuzzy = None  # first substring match, kept if no exact match is found
    try:
        if _vcall(uia, _CTRUE, ctypes.c_long, [ctypes.POINTER(ctypes.c_void_p)],
                  ctypes.byref(cond)) != 0:
            return None
        if _vcall(el, _FINDALL, ctypes.c_long,
                  [ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
                  _TreeScope_Descendants, cond, ctypes.byref(arr)) != 0 or not arr.value:
            return None
        n = ctypes.c_int()
        _vcall(arr.value, _ARR_LEN, ctypes.c_long,
               [ctypes.POINTER(ctypes.c_int)], ctypes.byref(n))
        for i in range(min(n.value, max_scan)):
            ce = ctypes.c_void_p()
            if _vcall(arr.value, _ARR_GET, ctypes.c_long,
                      [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)],
                      i, ctypes.byref(ce)) != 0 or not ce.value:
                continue
            t = _CONTROL_TYPES.get(_prop_int(ce.value, _UIA_ControlTypeProperty))
            if ctype is not None and (t or "").lower() != ctype.lower():
                _release(ce.value); continue
            if nl is None:
                fuzzy = ce.value  # type-only search: first match wins
                break
            cand = (_prop_bstr(ce.value, _UIA_NameProperty) or "").lower()
            if cand == nl:
                if fuzzy:
                    _release(fuzzy)
                return ce.value  # exact match always wins
            if nl in cand and fuzzy is None:
                fuzzy = ce.value  # keep as fallback, do not release
            else:
                _release(ce.value)
        return fuzzy
    finally:
        _release(cond.value)
        _release(arr.value)
        _release(el)


def _pattern(el, pattern_id):
    p = ctypes.c_void_p()
    if _vcall(el, _GETPATTERN, ctypes.c_long,
              [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)],
              pattern_id, ctypes.byref(p)) != 0:
        return None
    return p.value


def uia_set_value(win: int, value: str, name=None, ctype=None) -> bool:
    """Write ``value`` into an element found by meaning (name/type), via the UIA
    ValuePattern — the modern-app-capable write, the UIA dual of the native
    :func:`set_window_text`. Because it goes through the accessibility tree it can
    set the text of fields *inside* Chrome/Electron/UWP (an address bar, a search
    box) that have no native HWND to write to. Returns True on success."""
    uia = _get_uia()
    if not uia:
        return False
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return False
    bstr = None
    try:
        vp = _pattern(el, _UIA_ValuePatternId)
        if not vp:
            return False
        try:
            bstr = _oleaut.SysAllocString(value)
            hr = _vcall(vp, _VALUE_SET, ctypes.c_long, [ctypes.c_void_p], bstr)
            return hr == 0
        finally:
            _release(vp)
    finally:
        if bstr:
            _oleaut.SysFreeString(bstr)
        _release(el)


def uia_get_value(win: int, name=None, ctype=None) -> str:
    """Read the ValuePattern value of an element found by meaning — the read dual
    of :func:`uia_set_value`, reaching inside modern apps. "" if unavailable."""
    uia = _get_uia()
    if not uia:
        return ""
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return ""
    try:
        vp = _pattern(el, _UIA_ValuePatternId)
        if not vp:
            return ""
        try:
            v = _VARIANT()
            if _vcall(vp, _VALUE_GET, ctypes.c_long,
                      [ctypes.POINTER(_VARIANT)], ctypes.byref(v)) != 0:
                return ""
            if v.vt == 8 and v.val:
                s = ctypes.wstring_at(v.val)
                _oleaut.SysFreeString(v.val)
                return s
            return ""
        finally:
            _release(vp)
    finally:
        _release(el)


def uia_invoke(win: int, name=None, ctype=None) -> bool:
    """Invoke an element found by meaning (name/type) via the UIA InvokePattern —
    the semantic *action* inside modern apps (the UIA analogue of invoke_menu).
    Presses a button/link by what it means, no mouse, no pixels, even in
    Chrome/Electron/UWP. Returns True if invoked."""
    uia = _get_uia()
    if not uia:
        return False
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return False
    try:
        ip = _pattern(el, _UIA_InvokePatternId)
        if not ip:
            return False
        try:
            return _vcall(ip, _INVOKE, ctypes.c_long, []) == 0
        finally:
            _release(ip)
    finally:
        _release(el)


def uia_focus(win: int, name=None, ctype=None) -> bool:
    """Move keyboard focus to an element found by meaning (name/type) via the UIA
    ``SetFocus`` — the bridge from semantic *locate* to the keystroke floor. Some
    modern inputs (rich text, contenteditable, custom canvases) expose no
    ValuePattern to write through, but they *can* be focused through the
    accessibility tree; once focused, the universal keyboard floor types into them.
    Returns True if focus was set."""
    uia = _get_uia()
    if not uia:
        return False
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return False
    try:
        return _vcall(el, _SETFOCUS, ctypes.c_long, []) == 0
    finally:
        _release(el)


def uia_text(win: int, name=None, ctype=None, max_len: int = 20000) -> str:
    """Read an element's full text via the UIA TextPattern (DocumentRange.GetText)
    — the proper way to read text *out of* modern documents (a Chrome/Electron page,
    a rich editor) where the ValuePattern returns empty or is absent. The deep read
    dual that reaches where :func:`uia_get_value` (single-line value fields) and the
    native :func:`window_text` (native HWNDs only) cannot. "" if no element or no
    TextPattern. ``max_len`` bounds a huge document."""
    uia = _get_uia()
    if not uia:
        return ""
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return ""
    try:
        tp = _pattern(el, _UIA_TextPatternId)
        if not tp:
            return ""
        try:
            rng = ctypes.c_void_p()
            if _vcall(tp, _TEXT_DOCRANGE, ctypes.c_long,
                      [ctypes.POINTER(ctypes.c_void_p)],
                      ctypes.byref(rng)) != 0 or not rng.value:
                return ""
            try:
                out = ctypes.c_void_p()
                if _vcall(rng.value, _RANGE_GETTEXT, ctypes.c_long,
                          [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)],
                          max_len, ctypes.byref(out)) != 0 or not out.value:
                    return ""
                s = ctypes.wstring_at(out.value)
                _oleaut.SysFreeString(out.value)
                return s
            finally:
                _release(rng.value)
        finally:
            _release(tp)
    finally:
        _release(el)
