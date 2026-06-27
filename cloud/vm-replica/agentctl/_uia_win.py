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
# IUIAutomationTogglePattern vtable indices
_TOGGLE = 3           # IUIAutomationTogglePattern::Toggle
_TOGGLE_STATE = 4     # IUIAutomationTogglePattern::get_CurrentToggleState
_UIA_TogglePatternId = 10015
_TOGGLE_NAMES = {0: "off", 1: "on", 2: "indeterminate"}
# IUIAutomationSelectionItemPattern vtable indices
_SELITEM_SELECT = 3       # IUIAutomationSelectionItemPattern::Select
_SELITEM_ISSELECTED = 6   # IUIAutomationSelectionItemPattern::get_CurrentIsSelected
_UIA_SelectionItemPatternId = 10010
# IUIAutomationExpandCollapsePattern vtable indices
_EC_EXPAND = 3        # IUIAutomationExpandCollapsePattern::Expand
_EC_COLLAPSE = 4      # IUIAutomationExpandCollapsePattern::Collapse
_EC_STATE = 5         # IUIAutomationExpandCollapsePattern::get_CurrentExpandCollapseState
_UIA_ExpandCollapsePatternId = 10005
_EC_NAMES = {0: "collapsed", 1: "expanded", 2: "partial", 3: "leaf"}
# IUIAutomationScrollItemPattern vtable indices
_SCROLLINTOVIEW = 3   # IUIAutomationScrollItemPattern::ScrollIntoView
_UIA_ScrollItemPatternId = 10017
# IUIAutomationRangeValuePattern vtable indices
_RV_SET = 3       # IUIAutomationRangeValuePattern::SetValue (double)
_RV_GET = 4       # IUIAutomationRangeValuePattern::get_CurrentValue
_RV_MAX = 6       # IUIAutomationRangeValuePattern::get_CurrentMaximum
_RV_MIN = 7       # IUIAutomationRangeValuePattern::get_CurrentMinimum
_UIA_RangeValuePatternId = 10003
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


def uia_toggle_state(win: int, name=None, ctype=None) -> str:
    """Read the toggle state of an element found by meaning (a checkbox, a toggle
    switch) via the UIA TogglePattern: "on" / "off" / "indeterminate", or "" if the
    element has no TogglePattern. The read dual of :func:`uia_toggle`."""
    uia = _get_uia()
    if not uia:
        return ""
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return ""
    try:
        tp = _pattern(el, _UIA_TogglePatternId)
        if not tp:
            return ""
        try:
            st = ctypes.c_int()
            if _vcall(tp, _TOGGLE_STATE, ctypes.c_long,
                      [ctypes.POINTER(ctypes.c_int)], ctypes.byref(st)) != 0:
                return ""
            return _TOGGLE_NAMES.get(st.value, "")
        finally:
            _release(tp)
    finally:
        _release(el)


def uia_toggle(win: int, name=None, ctype=None) -> bool:
    """Toggle an element found by meaning (a checkbox / toggle switch) via the UIA
    TogglePattern — the semantic state-flip inside native and modern apps alike, no
    mouse, no pixels. Returns True if the flip was issued. It deliberately does NOT
    return the new state: across the accessibility bridge a modern app (Chrome)
    updates its ToggleState *asynchronously*, so a state read in the same breath is
    stale — read the settled truth with :func:`uia_toggle_state` a moment later (the
    action reports that it acted; the read reports what is)."""
    uia = _get_uia()
    if not uia:
        return False
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return False
    try:
        tp = _pattern(el, _UIA_TogglePatternId)
        if not tp:
            return False
        try:
            return _vcall(tp, _TOGGLE, ctypes.c_long, []) == 0
        finally:
            _release(tp)
    finally:
        _release(el)


def uia_select(win: int, name=None, ctype=None) -> bool:
    """Select an item found by meaning (a radio button, a list option, a tab) via the
    UIA SelectionItemPattern — the semantic *choose-one* verb, no mouse, no pixels.
    Returns True if Select was issued. Like :func:`uia_toggle`, it reports only that
    it acted; read the settled truth with :func:`uia_is_selected` (selection settles
    asynchronously across the a11y bridge in modern apps)."""
    uia = _get_uia()
    if not uia:
        return False
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return False
    try:
        sp = _pattern(el, _UIA_SelectionItemPatternId)
        if not sp:
            return False
        try:
            return _vcall(sp, _SELITEM_SELECT, ctypes.c_long, []) == 0
        finally:
            _release(sp)
    finally:
        _release(el)


def uia_is_selected(win: int, name=None, ctype=None):
    """Read whether an item found by meaning is selected, via the UIA
    SelectionItemPattern — the read dual of :func:`uia_select`. Returns True/False, or
    None if the element has no SelectionItemPattern."""
    uia = _get_uia()
    if not uia:
        return None
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return None
    try:
        sp = _pattern(el, _UIA_SelectionItemPatternId)
        if not sp:
            return None
        try:
            v = ctypes.c_int()
            if _vcall(sp, _SELITEM_ISSELECTED, ctypes.c_long,
                      [ctypes.POINTER(ctypes.c_int)], ctypes.byref(v)) != 0:
                return None
            return bool(v.value)
        finally:
            _release(sp)
    finally:
        _release(el)


def _ec_act(win, name, ctype, vidx):
    uia = _get_uia()
    if not uia:
        return False
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return False
    try:
        ec = _pattern(el, _UIA_ExpandCollapsePatternId)
        if not ec:
            return False
        try:
            return _vcall(ec, vidx, ctypes.c_long, []) == 0
        finally:
            _release(ec)
    finally:
        _release(el)


def uia_expand(win: int, name=None, ctype=None) -> bool:
    """Expand an element found by meaning (a dropdown, a tree node, a <details>
    disclosure) via the UIA ExpandCollapsePattern. Returns True if Expand was issued;
    read the settled truth with :func:`uia_expand_state` (it settles asynchronously)."""
    return _ec_act(win, name, ctype, _EC_EXPAND)


def uia_collapse(win: int, name=None, ctype=None) -> bool:
    """Collapse an element found by meaning via the UIA ExpandCollapsePattern — the
    dual of :func:`uia_expand`. Returns True if Collapse was issued."""
    return _ec_act(win, name, ctype, _EC_COLLAPSE)


def uia_expand_state(win: int, name=None, ctype=None) -> str:
    """Read the expand/collapse state of an element found by meaning:
    "collapsed"/"expanded"/"partial"/"leaf", or "" if no ExpandCollapsePattern. The
    read dual of :func:`uia_expand`/:func:`uia_collapse`."""
    uia = _get_uia()
    if not uia:
        return ""
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return ""
    try:
        ec = _pattern(el, _UIA_ExpandCollapsePatternId)
        if not ec:
            return ""
        try:
            st = ctypes.c_int()
            if _vcall(ec, _EC_STATE, ctypes.c_long,
                      [ctypes.POINTER(ctypes.c_int)], ctypes.byref(st)) != 0:
                return ""
            return _EC_NAMES.get(st.value, "")
        finally:
            _release(ec)
    finally:
        _release(el)


def uia_scroll_into_view(win: int, name=None, ctype=None) -> bool:
    """Scroll an element found by meaning into the visible viewport via the UIA
    ScrollItemPattern — the modern-content "bring into reach", the element-level dual
    of moving an off-screen window back on screen (F149). An element below the fold has
    no on-screen pixels to click; this asks its own scroll container to bring it into
    view, after which uia_find returns its now-visible rect and the pixel executor can
    reach it. Returns True if ScrollIntoView was issued."""
    uia = _get_uia()
    if not uia:
        return False
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return False
    try:
        sp = _pattern(el, _UIA_ScrollItemPatternId)
        if not sp:
            return False
        try:
            return _vcall(sp, _SCROLLINTOVIEW, ctypes.c_long, []) == 0
        finally:
            _release(sp)
    finally:
        _release(el)


def uia_range_value(win: int, name=None, ctype=None):
    """Read a ranged control (a slider, a progress bar, a scrollbar) found by meaning
    via the UIA RangeValuePattern. Returns a dict {"value", "min", "max"} (floats), or
    None if the element has no RangeValuePattern. The read dual of
    :func:`uia_set_range_value`."""
    uia = _get_uia()
    if not uia:
        return None
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return None
    try:
        rv = _pattern(el, _UIA_RangeValuePatternId)
        if not rv:
            return None
        try:
            out = {}
            for key, idx in (("value", _RV_GET), ("max", _RV_MAX), ("min", _RV_MIN)):
                d = ctypes.c_double()
                if _vcall(rv, idx, ctypes.c_long,
                          [ctypes.POINTER(ctypes.c_double)], ctypes.byref(d)) != 0:
                    return None
                out[key] = d.value
            return out
        finally:
            _release(rv)
    finally:
        _release(el)


def uia_set_range_value(win: int, value: float, name=None, ctype=None) -> bool:
    """Set a ranged control (a slider, a scrollbar) found by meaning to ``value`` via
    the UIA RangeValuePattern SetValue — set a slider to a number by meaning, no mouse
    drag. Returns True if SetValue succeeded (the value is clamped to the control's
    own min/max by the provider). Read the result with :func:`uia_range_value`."""
    uia = _get_uia()
    if not uia:
        return False
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return False
    try:
        rv = _pattern(el, _UIA_RangeValuePatternId)
        if not rv:
            return False
        try:
            return _vcall(rv, _RV_SET, ctypes.c_long, [ctypes.c_double],
                          ctypes.c_double(float(value))) == 0
        finally:
            _release(rv)
    finally:
        _release(el)
