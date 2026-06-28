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
import functools
import threading
from ctypes import wintypes

_ole32 = ctypes.windll.ole32
_user32 = ctypes.windll.user32
_user32.FindWindowW.restype = ctypes.c_void_p
_user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
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


def _variant_bstr(s):
    """A VT_BSTR VARIANT carrying ``s`` — the by-value argument FindItemByProperty
    matches against. Caller must VariantClear it to free the BSTR."""
    v = _VARIANT()
    v.vt = 8  # VT_BSTR
    v.val = _oleaut.SysAllocString(s)
    return v


def _guid(s):
    g = _GUID()
    _ole32.CLSIDFromString(ctypes.c_wchar_p(s), ctypes.byref(g))
    return g


_CLSID_CUIAutomation = _guid("{ff48dba4-60ef-4201-aa87-54103eef594e}")
_IID_IUIAutomation = _guid("{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}")

# IUIAutomation vtable indices (after IUnknown 0..2)
_EFH = 6        # ElementFromHandle
_GETFOCUSED = 8  # GetFocusedElement
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
# IUIAutomationItemContainerPattern vtable indices
_IC_FINDITEM = 3      # IUIAutomationItemContainerPattern::FindItemByProperty
_UIA_ItemContainerPatternId = 10019
# IUIAutomationRangeValuePattern vtable indices
_RV_SET = 3       # IUIAutomationRangeValuePattern::SetValue (double)
_RV_GET = 4       # IUIAutomationRangeValuePattern::get_CurrentValue
_RV_MAX = 6       # IUIAutomationRangeValuePattern::get_CurrentMaximum
_RV_MIN = 7       # IUIAutomationRangeValuePattern::get_CurrentMinimum
_UIA_RangeValuePatternId = 10003
# IUIAutomationLegacyIAccessiblePattern vtable indices
_LEG_VALUE = 8    # IUIAutomationLegacyIAccessiblePattern::get_CurrentValue (BSTR)
_UIA_LegacyIAccessiblePatternId = 10018
# IUIAutomationElementArray vtable indices
_ARR_LEN = 3    # get_Length
_ARR_GET = 4    # GetElement

_UIA_NameProperty = 30005
_UIA_ControlTypeProperty = 30003
_UIA_BoundingRectangleProperty = 30001
_UIA_AutomationIdProperty = 30011   # stable developer-assigned id (semantic handle)
_UIA_HelpTextProperty = 30013       # tooltip / accessible help string
_UIA_ProcessIdProperty = 30002      # owning process id (which app the focus is in)
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
_VALUE_READONLY = 5  # IUIAutomationValuePattern::get_CurrentIsReadOnly

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

_tls = threading.local()  # per-thread UIA instance + COM apartment (see _get_uia)


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
    """The IUIAutomation instance for the *calling thread*. Each thread gets its own
    STA apartment + UIA instance (UIA objects cannot cross apartments), so a verb can
    be run on an abandonable worker thread (:func:`_hangproof`) without poisoning the
    main thread's instance. Cached per thread; None on init failure so callers fall
    back to the Win32 / pixel floor."""
    if getattr(_tls, "uia", None) is not None or getattr(_tls, "failed", False):
        return getattr(_tls, "uia", None)
    try:
        _ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED (idempotent)
        pp = ctypes.c_void_p()
        hr = _ole32.CoCreateInstance(ctypes.byref(_CLSID_CUIAutomation), None, 1,
                                     ctypes.byref(_IID_IUIAutomation),
                                     ctypes.byref(pp))
        if hr != 0 or not pp.value:
            _tls.failed = True
            return None
        _tls.uia = pp.value
    except Exception:
        _tls.failed = True
    return getattr(_tls, "uia", None)


def _teardown_uia():
    """Release the calling thread's UIA instance and leave its COM apartment. Run
    when a :func:`_hangproof` worker finishes so the fresh-per-call worker leaks
    nothing; a worker abandoned mid-hang (rare) leaks only its one instance."""
    u = getattr(_tls, "uia", None)
    if u:
        _release(u)
    _tls.uia = None
    _tls.failed = False
    try:
        _ole32.CoUninitialize()
    except Exception:
        pass


_FIND_TIMEOUT = 8.0  # seconds a single locate/read/act verb may run before abandon


def _hangproof(default):
    """Run an element-resolving verb on a daemon worker with its own COM apartment +
    UIA, joined with a timeout. Generalises F193 from *invoke* to *every* locate /
    read / act verb: a provider that blocks a single COM call deep in a descendant
    search (a native file dialog's virtualised shell list view wedges both FindAll
    and a hand-rolled TreeWalker step, F194) can no longer freeze the agent. The
    worker is abandoned and the verb returns ``default``; a completed worker tears
    down its own UIA so nothing leaks. The timeout fires only on a true block — a
    missing element returns ``default`` fast — so it never truncates a normal call."""
    def deco(fn):
        @functools.wraps(fn)
        def wrap(*a, **kw):
            box = [default]
            done = threading.Event()

            def run():
                try:
                    box[0] = fn(*a, **kw)
                except Exception:
                    box[0] = default
                finally:
                    _teardown_uia()
                    done.set()

            threading.Thread(target=run, daemon=True).start()
            return box[0] if done.wait(_FIND_TIMEOUT) else default
        return wrap
    return deco


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
                            "type": _CONTROL_TYPES.get(t, str(t)),
                            "aid": _prop_bstr(ce.value, _UIA_AutomationIdProperty),
                            "help": _prop_bstr(ce.value, _UIA_HelpTextProperty)})
            finally:
                _release(ce.value)
        return out
    finally:
        _release(cond.value)
        _release(arr.value)
        _release(el)


@_hangproof(None)
def uia_find(win: int, name=None, ctype=None, max_scan: int = 6000):
    """Find a descendant element of ``win`` by its *meaning* — accessible name
    (case-insensitive substring) and/or control type (e.g. ``"Button"``,
    ``"Tab"``, ``"Edit"``) — and report *where it is*:
    ``{"name","type","aid","help","rect":(x,y,w,h)}`` in screen coordinates, or None.
    ``name`` is matched not only against the accessible Name but also the
    **AutomationId** and **HelpText** (tooltip): icon-only toolbars (paint.net's
    tools, many WinUI apps) leave Name empty yet carry a stable, *semantic* handle
    in AutomationId (e.g. ``"foreColorRectangle"``) the floor can still address by.
    The UIA analogue of :func:`find_control`, but it works *inside modern apps* (the
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
                "aid": _prop_bstr(el, _UIA_AutomationIdProperty),
                "help": _prop_bstr(el, _UIA_HelpTextProperty),
                "rect": _prop_rect(el)}
    finally:
        _release(el)


@_hangproof(None)
def uia_focused():
    """The element that currently holds the **keyboard focus**, anywhere on the
    desktop, as ``{"name","type","aid","help","rect":(x,y,w,h),"pid"}`` — or ``None``
    when nothing focusable does (e.g. the desktop itself). Where :func:`uia_find`
    asks "where is the control named X in window W", this asks the dual question the
    floor needs before it *types*: "**where will my keystrokes land right now?**" —
    the one element that will receive `type_text`/`tap`, across every app at once.

    It is the keyboard's twin of the mouse cursor: a click is aimed at a point, but a
    keypress is aimed at whatever holds focus, and that target is otherwise invisible.
    Reading it lets the floor *verify a focus move landed* (did clicking that field,
    or Tabbing, actually put focus where intended) before committing input — closing
    the loop the way `_prop_rect` closes the locate→click loop. ``pid`` says which
    application owns the focus, so the floor can tell "focus is in my target app"
    from "a dialog/another app stole it". Returns ``None`` on a backend without UIA."""
    uia = _get_uia()
    if not uia:
        return None
    el = ctypes.c_void_p()
    if _vcall(uia, _GETFOCUSED, ctypes.c_long,
              [ctypes.POINTER(ctypes.c_void_p)], ctypes.byref(el)) != 0 or not el.value:
        return None
    try:
        return {"name": _prop_bstr(el.value, _UIA_NameProperty),
                "type": _CONTROL_TYPES.get(_prop_int(el.value, _UIA_ControlTypeProperty)),
                "aid": _prop_bstr(el.value, _UIA_AutomationIdProperty),
                "help": _prop_bstr(el.value, _UIA_HelpTextProperty),
                "rect": _prop_rect(el.value),
                "pid": _prop_int(el.value, _UIA_ProcessIdProperty)}
    finally:
        _release(el.value)


def _find_ptr(uia, win, name=None, ctype=None, max_scan: int = 6000):
    """Return the raw element pointer of the descendant of ``win`` best matching
    name/type, or None. Caller must _release() it. Shared by uia_find and the
    action helpers. Matching prefers an **exact** (case-insensitive) name equality
    over a mere substring: driving the calculator showed substring matching picks
    ``'Memory add'`` when you asked for ``'Add'`` (it appears earlier in the tree),
    so an exact name, if one exists anywhere in scope, always wins; the first
    substring match is kept only as a fallback. ``name`` is tested against the
    accessible Name *and* the AutomationId (exact on either wins) and, as a last
    resort, a substring of Name/AutomationId/HelpText — so icon controls that leave
    Name empty but carry a semantic AutomationId/tooltip stay reachable.

    One further preference, learned from a real Replace dialog (Notepad++): a field's
    **caption** is a static ``Text`` carrying the *same* accessible name as the input
    it labels (label, ComboBox and Edit were all ``"Replace with:"``). The label sits
    first in tree order, so a naive exact match returns the *uneditable caption* and a
    later write silently no-ops. When the caller did not pin a ``ctype``, an exact
    match on a ``Text`` control is therefore held as a fallback only: an actionable
    (non-``Text``) control with the same exact name, if one exists, wins."""
    el = _element(uia, win)
    if not el:
        return None
    cond = ctypes.c_void_p()
    arr = ctypes.c_void_p()
    nl = name.lower() if name else None
    fuzzy = None  # first substring match, kept if no exact match is found
    label = None  # exact match on a static Text caption, kept only as a fallback
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
            nm = (_prop_bstr(ce.value, _UIA_NameProperty) or "").lower()
            aid = (_prop_bstr(ce.value, _UIA_AutomationIdProperty) or "").lower()
            if nm == nl or aid == nl:
                if ctype is None and t == "Text":
                    if label is None:
                        label = ce.value  # caption fallback, keep scanning
                    else:
                        _release(ce.value)
                    continue
                if fuzzy:
                    _release(fuzzy)
                if label:
                    _release(label)
                return ce.value  # exact, actionable Name/AutomationId match wins
            ht = (_prop_bstr(ce.value, _UIA_HelpTextProperty) or "").lower()
            if fuzzy is None and (nl in nm or nl in aid or nl in ht):
                fuzzy = ce.value  # keep as fallback, do not release
            else:
                _release(ce.value)
        if label:
            if fuzzy:
                _release(fuzzy)
            return label
        return fuzzy
    finally:
        _release(cond.value)
        _release(arr.value)
        _release(el)


@_hangproof([])
def uia_find_all(win: int, name=None, ctype=None, max_scan: int = 6000) -> list:
    """The *plural* of :func:`uia_find` — every descendant of ``win`` matching the
    given meaning, as ``[{"name","type","aid","help","rect"}, …]``. Where
    :func:`uia_children` sees only the *direct* children of a window, this reaches
    the whole subtree, which is how you read a *collection* by meaning: the rows of
    a file list (7-Zip), the layers of an image (paint.net), a page of search hits —
    things that live many levels below the top window and that a single
    :func:`uia_find` can only surface one of. ``ctype``/``name`` filter exactly as
    in :func:`uia_find` (name tested against Name/AutomationId/HelpText); omit both
    to enumerate everything. ``max_scan`` bounds the walk."""
    uia = _get_uia()
    if not uia:
        return []
    el = _element(uia, win)
    if not el:
        return []
    cond = ctypes.c_void_p()
    arr = ctypes.c_void_p()
    nl = name.lower() if name else None
    cl = ctype.lower() if ctype else None
    out = []
    try:
        if _vcall(uia, _CTRUE, ctypes.c_long, [ctypes.POINTER(ctypes.c_void_p)],
                  ctypes.byref(cond)) != 0:
            return []
        if _vcall(el, _FINDALL, ctypes.c_long,
                  [ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
                  _TreeScope_Descendants, cond, ctypes.byref(arr)) != 0 or not arr.value:
            return []
        n = ctypes.c_int()
        _vcall(arr.value, _ARR_LEN, ctypes.c_long,
               [ctypes.POINTER(ctypes.c_int)], ctypes.byref(n))
        for i in range(min(n.value, max_scan)):
            ce = ctypes.c_void_p()
            if _vcall(arr.value, _ARR_GET, ctypes.c_long,
                      [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)],
                      i, ctypes.byref(ce)) != 0 or not ce.value:
                continue
            try:
                t = _CONTROL_TYPES.get(_prop_int(ce.value, _UIA_ControlTypeProperty))
                if cl is not None and (t or "").lower() != cl:
                    continue
                nm = _prop_bstr(ce.value, _UIA_NameProperty)
                aid = _prop_bstr(ce.value, _UIA_AutomationIdProperty)
                ht = _prop_bstr(ce.value, _UIA_HelpTextProperty)
                if nl is not None and nl not in (nm or "").lower() \
                   and nl not in (aid or "").lower() and nl not in (ht or "").lower():
                    continue
                out.append({"name": nm, "type": t, "aid": aid, "help": ht,
                            "rect": _prop_rect(ce.value)})
            finally:
                _release(ce.value)
        return out
    finally:
        _release(cond.value)
        _release(arr.value)
        _release(el)


def _scope_findall(el, uia, max_scan: int = 4000) -> list:
    """Every descendant element pointer of element ``el`` (TreeScope_Descendants),
    as a list of raw pointers the caller must ``_release()``. The element-rooted
    twin of the window-rooted walk inside :func:`uia_find_all` — used to descend a
    sub-tree (a toolbar, an overflow flyout) that is not itself a window with an
    HWND. [] on any failure."""
    cond = ctypes.c_void_p()
    arr = ctypes.c_void_p()
    ptrs = []
    try:
        if _vcall(uia, _CTRUE, ctypes.c_long, [ctypes.POINTER(ctypes.c_void_p)],
                  ctypes.byref(cond)) != 0:
            return []
        if _vcall(el, _FINDALL, ctypes.c_long,
                  [ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
                  _TreeScope_Descendants, cond, ctypes.byref(arr)) != 0 or not arr.value:
            return []
        n = ctypes.c_int()
        _vcall(arr.value, _ARR_LEN, ctypes.c_long,
               [ctypes.POINTER(ctypes.c_int)], ctypes.byref(n))
        for i in range(min(n.value, max_scan)):
            ce = ctypes.c_void_p()
            if _vcall(arr.value, _ARR_GET, ctypes.c_long,
                      [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)],
                      i, ctypes.byref(ce)) == 0 and ce.value:
                ptrs.append(ce.value)
        return ptrs
    finally:
        _release(cond.value)
        _release(arr.value)


@_hangproof([])
def tray_icons() -> list:
    """Enumerate the **system-tray (notification-area) icons by meaning**, as
    ``[{"name","help","aid","rect":(x,y,w,h)}, …]`` in screen coordinates.

    The friction this dissolves (F200): an app resident *only* in the tray owns no
    normal top-level window, so :func:`list_windows` never returns it — and the host
    that *does* contain the icons, ``Shell_TrayWnd``, is itself an untitled
    explorer window the floor does not enumerate. So a window minimised to the tray
    is the deepest zero-pixel case yet: nothing in the meaning-floor's window list
    even hints the app is alive. UIA *can* reach the icon (it is a ``Button`` whose
    Name is the icon's tooltip), but only if you already know the magic class name —
    knowledge an agent operating by meaning does not have. This verb is that
    knowledge: it walks the two ``"…Notification Area"`` toolbars of ``Shell_TrayWnd``
    (promoted icons) plus the overflow flyout (hidden icons), returning every icon
    as a meaning+rect the floor can then right-click / invoke. The taskbar's own
    buttons (Start, Search, Task View, running apps) are *not* notification icons and
    are correctly excluded by scoping to the notification-area toolbars. [] where
    there is no Windows tray (other backends) or UIA is unavailable."""
    uia = _get_uia()
    if not uia:
        return []
    out = []
    seen = set()

    def _collect(root_el):
        for ce in _scope_findall(root_el, uia):
            try:
                if _CONTROL_TYPES.get(_prop_int(ce, _UIA_ControlTypeProperty)) != "Button":
                    continue
                rect = _prop_rect(ce)
                if not rect:
                    continue
                nm = _prop_bstr(ce, _UIA_NameProperty) or ""
                key = (nm, rect)
                if key in seen:
                    continue
                seen.add(key)
                out.append({"name": nm, "rect": rect,
                            "help": _prop_bstr(ce, _UIA_HelpTextProperty) or "",
                            "aid": _prop_bstr(ce, _UIA_AutomationIdProperty) or ""})
            finally:
                _release(ce)

    tray = _user32.FindWindowW("Shell_TrayWnd", None)
    if tray:
        el = _element(uia, int(tray))
        if el:
            try:
                for sub in _scope_findall(el, uia):
                    try:
                        t = _CONTROL_TYPES.get(_prop_int(sub, _UIA_ControlTypeProperty))
                        nm = _prop_bstr(sub, _UIA_NameProperty) or ""
                        if t == "ToolBar" and "notification area" in nm.lower():
                            _collect(sub)
                    finally:
                        _release(sub)
            finally:
                _release(el)
    # the overflow flyout (hidden icons) is a separate top-level: class name varies
    # by Windows build, and every button inside it is a tray icon.
    for cls in ("NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland"):
        ov = _user32.FindWindowW(cls, None)
        if not ov:
            continue
        el = _element(uia, int(ov))
        if el:
            try:
                _collect(el)
            finally:
                _release(el)
    return out


def uia_rows(win: int, container_name=None, container_ctype="list",
             cell_ctypes=("edit", "text", "dataitem", "listitem"),
             y_tol: int = 8) -> list:
    """Rebuild a details/report view's **rows** from a *flattened* tree (F196).

    A multi-column list — a file manager (7-Zip), a task list, a mail view — often
    exposes each column cell as a *separate sibling* element with no per-row parent:
    :func:`uia_find_all` hands back the names in one place and the sizes/dates in
    another, so you can read each cell by meaning yet cannot read *the row for X* as a
    unit (the row that pairs ``desktop.ini`` with its ``402`` bytes and its date).
    This regroups the scattered cells by geometry — exactly what the eye does: keep
    only cells inside the container's rect, cluster them into rows by vertical band
    (rect top within ``y_tol`` px of the band), and order each row left-to-right by x.
    Returns ``[[cell, …], …]`` in visual row/column order. It relies only on rects
    (which UIA reports reliably even when it scatters the elements) and Names, so it is
    provider-agnostic; and it composes the already hang-proof :func:`uia_find` /
    :func:`uia_find_all` then does pure-Python geometry, so it cannot itself hang."""
    cont = uia_find(win, name=container_name, ctype=container_ctype)
    if not cont or not cont.get("rect"):
        return []
    cx, cy, cw, ch = cont["rect"]
    x2, y2 = cx + cw, cy + ch
    cells = []
    seen = set()
    for ct in cell_ctypes:
        for e in uia_find_all(win, ctype=ct):
            nm = (e.get("name") or "").strip()
            r = e.get("rect")
            if not nm or not r:
                continue
            if not (cx - 2 <= r[0] < x2 and cy - 2 <= r[1] < y2):
                continue  # outside the list body (toolbar/header/status bar)
            key = (r[0], r[1], nm)
            if key in seen:
                continue
            seen.add(key)
            cells.append((r[1], r[0], r[0] + r[2], nm))  # (top, left, right, text)
    cells.sort()
    rows = []
    cur = []
    band = None
    for top, left, right, nm in cells:
        if band is not None and abs(top - band) > y_tol:
            rows.append(_row_columns(cur))
            cur = []
            band = None
        cur.append((left, right, nm))
        if band is None:
            band = top
    if cur:
        rows.append(_row_columns(cur))
    return [r for r in rows if r]


def _row_columns(cells):
    """Order one geometric row's cells into columns, dropping any row-*wrapper*. A
    details view often carries both the per-column cells (a name ``edit``, a size/date
    ``text``) and a single ``listitem`` spanning the whole row — the wrapper duplicates
    the name. A wrapper is exactly the cell that spatially *contains* two or more of the
    others, so drop those and keep the leaves, ordered left-to-right. Containment (not
    text equality) is the test, so two columns that legitimately share a value — the
    equal Modified/Created dates of a folder — are both preserved."""
    kept = []
    for i, (l, r, t) in enumerate(cells):
        encloses = sum(1 for j, (l2, r2, _) in enumerate(cells)
                       if j != i and l - 2 <= l2 and r2 <= r + 2)
        if encloses >= 2:
            continue
        kept.append((l, t))
    return [t for _, t in sorted(kept)]


def _pattern(el, pattern_id):
    p = ctypes.c_void_p()
    if _vcall(el, _GETPATTERN, ctypes.c_long,
              [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)],
              pattern_id, ctypes.byref(p)) != 0:
        return None
    return p.value


@_hangproof(False)
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
            ro = ctypes.c_int(0)
            if _vcall(vp, _VALUE_READONLY, ctypes.c_long,
                      [ctypes.POINTER(ctypes.c_int)], ctypes.byref(ro)) == 0 and ro.value:
                return False  # read-only target (e.g. a static caption): SetValue
                              # would return S_OK yet write nothing — refuse honestly
            before = _value_pattern_text(el)
            bstr = _oleaut.SysAllocString(value)
            hr = _vcall(vp, _VALUE_SET, ctypes.c_long, [ctypes.c_void_p], bstr)
            after = _value_pattern_text(el)
            if hr != 0:
                return False
            # SetValue can return S_OK yet write nothing (a read-only field whose
            # IsReadOnly the provider under-reports). Treat the write as successful
            # only if the value actually became what we asked, or at least changed
            # from before (a field that normalises its input still counts).
            after = _value_pattern_text(el)
            return after == value or after != before
        finally:
            _release(vp)
    finally:
        if bstr:
            _oleaut.SysFreeString(bstr)
        _release(el)


def _value_pattern_text(el) -> str:
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


def _legacy_value_text(el) -> str:
    lp = _pattern(el, _UIA_LegacyIAccessiblePatternId)
    if not lp:
        return ""
    try:
        out = ctypes.c_void_p()
        if _vcall(lp, _LEG_VALUE, ctypes.c_long,
                  [ctypes.POINTER(ctypes.c_void_p)], ctypes.byref(out)) != 0 or not out.value:
            return ""
        s = ctypes.wstring_at(out.value)
        _oleaut.SysFreeString(out.value)
        return s
    finally:
        _release(lp)


@_hangproof("")
def uia_get_value(win: int, name=None, ctype=None) -> str:
    """Read the value of an element found by meaning — the read dual of
    :func:`uia_set_value`, reaching inside modern apps. Tries the ValuePattern first;
    if that comes back empty it falls back to the LegacyIAccessible value. The fallback
    is not cosmetic: Chrome (and other modern apps) accept a ValuePattern *write* to a
    text input but return "" from the ValuePattern *read* — driving a form proved the
    write landed (DOM confirmed) while the read dual was silently blank. LegacyIAccessible
    (the MSAA bridge) carries the live text in that case. "" if neither yields text."""
    uia = _get_uia()
    if not uia:
        return ""
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return ""
    try:
        return _value_pattern_text(el) or _legacy_value_text(el)
    finally:
        _release(el)


def _invoke_worker(win, name, ctype, res, done):
    """Run a single InvokePattern call on its *own* per-thread STA + UIA (F194's
    thread-local :func:`_get_uia`) with a freshly-resolved element. Self-contained so
    it can be abandoned (daemon) if it blocks in a modal handler without poisoning the
    main thread's UIA; the same per-thread lifecycle every :func:`_hangproof` worker
    uses, so a completed worker tears its UIA down (no leak) and an abandoned one
    leaks only its single instance."""
    try:
        uia = _get_uia()  # this thread's own apartment + UIA instance
        if not uia:
            res[0] = False
            return
        el = _find_ptr(uia, win, name, ctype)
        if not el:
            res[0] = False
            return
        try:
            ip = _pattern(el, _UIA_InvokePatternId)
            if not ip:
                res[0] = False
                return
            try:
                res[0] = _vcall(ip, _INVOKE, ctypes.c_long, []) == 0
            finally:
                _release(ip)
        finally:
            _release(el)
    except Exception:
        res[0] = False
    finally:
        _teardown_uia()
        done.set()


def uia_invoke(win: int, name=None, ctype=None, timeout: float = 6.0) -> bool:
    """Invoke an element found by meaning (name/type) via the UIA InvokePattern —
    the semantic *action* inside modern apps (the UIA analogue of invoke_menu).
    Presses a button/link by what it means, no mouse, no pixels, even in
    Chrome/Electron/UWP. Returns True if invoked.

    Never hangs the agent. ``InvokePattern::Invoke`` is *synchronous* in an STA: a
    control whose handler spins a **modal** dialog (a Save/Open file dialog behind a
    toolbar button) does not return from Invoke until that dialog is dismissed, so a
    naive call freezes the caller forever (F193). The call runs on a daemon thread
    with its own apartment + UIA instance; if it has not returned within ``timeout``
    the agent regains control with ``True`` — the action *was* dispatched and the
    modal is now up, ready to be driven by meaning — and the orphaned worker ends
    harmlessly when the dialog closes. A genuinely missing element/pattern returns
    ``False`` fast (the find is cheap), so the timeout only ever fires on a real
    block."""
    if not _get_uia():
        return False
    res = [None]
    done = threading.Event()
    th = threading.Thread(target=_invoke_worker,
                          args=(win, name, ctype, res, done), daemon=True)
    th.start()
    if done.wait(timeout):
        return bool(res[0])
    return True  # dispatched but still blocked in a modal handler — do not hang


@_hangproof(False)
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


@_hangproof("")
def uia_text(win: int, name=None, ctype=None, max_len: int = 20000) -> str:
    """Read an element's full text via the UIA TextPattern (DocumentRange.GetText)
    — the proper way to read text *out of* modern documents (a Chrome/Electron page,
    a rich editor) where the ValuePattern returns empty or is absent. The deep read
    dual that reaches where :func:`uia_get_value` (single-line value fields) and the
    native :func:`window_text` (native HWNDs only) cannot.

    Falls back to the element's accessible **Name** when no TextPattern is present
    (or it yields empty): a custom-drawn editor that models no TextPattern still
    publishes its content as its Name — Notepad++/Scintilla exposes the whole buffer
    on a ``Pane``'s Name, where ``window_text`` (native HWNDs only) is blind and the
    pattern read is empty (F191). The Name *is* what the accessibility tree reports
    as that element's text, so the fallback reads truth, not a guess. "" if no element
    or no text by either channel. ``max_len`` bounds a huge document.

    With **no target** (neither ``name`` nor ``ctype``), this reads the window's
    *primary* text rather than whatever descendant happens to come first: a console's
    whole scrollback sits on its ``Document`` (TextPattern), but the first child a
    type-less scan reaches is a scrollbar — so "read this window's text" would silently
    return a scrollbar's name. It therefore resolves to the main text container in
    priority order (``Document`` → ``Edit``), and only falls back to the first-element
    read when none carries text."""
    uia = _get_uia()
    if not uia:
        return ""
    if name is None and ctype is None:
        for cand in ("Document", "Edit"):
            el = _find_ptr(uia, win, None, cand)
            if el:
                try:
                    s = _element_text(el, max_len)
                finally:
                    _release(el)
                if s:
                    return s
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return ""
    try:
        return _element_text(el, max_len)
    finally:
        _release(el)


def _element_text(el, max_len: int) -> str:
    """Read one element's full text: the UIA TextPattern (DocumentRange.GetText) if it
    models one, else the accessible Name (where a custom-drawn editor publishes its
    buffer). Shared by :func:`uia_text` so the no-target path and the targeted path read
    by the same rules."""
    s = ""
    tp = _pattern(el, _UIA_TextPatternId)
    if tp:
        try:
            rng = ctypes.c_void_p()
            if _vcall(tp, _TEXT_DOCRANGE, ctypes.c_long,
                      [ctypes.POINTER(ctypes.c_void_p)],
                      ctypes.byref(rng)) == 0 and rng.value:
                try:
                    out = ctypes.c_void_p()
                    if _vcall(rng.value, _RANGE_GETTEXT, ctypes.c_long,
                              [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)],
                              max_len, ctypes.byref(out)) == 0 and out.value:
                        s = ctypes.wstring_at(out.value)
                        _oleaut.SysFreeString(out.value)
                finally:
                    _release(rng.value)
        finally:
            _release(tp)
    if not s:
        s = _prop_bstr(el, _UIA_NameProperty)
        if len(s) > max_len:
            s = s[:max_len]
    return s


@_hangproof("")
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


@_hangproof(False)
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


@_hangproof(False)
def uia_select(win: int, name=None, ctype=None) -> bool:
    """Select an item found by meaning (a radio button, a list option, a tab) via the
    UIA SelectionItemPattern — the semantic *choose-one* verb, no mouse, no pixels.

    Many real controls mean "choose me" but do not implement SelectionItemPattern: a
    Qt ``QTabBar`` tab, for instance, exposes only **InvokePattern** (it switches the
    page when *invoked*, not *selected*). So when the selection pattern is absent —
    or its ``Select`` fails — this falls back to invoking the element, which is the
    same human gesture (click the tab) by a different UIA name. Returns True if either
    path acted. Like :func:`uia_toggle`, it reports only that it acted; read the
    settled truth with :func:`uia_is_selected`."""
    uia = _get_uia()
    if not uia:
        return False
    el = _find_ptr(uia, win, name, ctype)
    if not el:
        return False
    try:
        sp = _pattern(el, _UIA_SelectionItemPatternId)
        if sp:
            try:
                if _vcall(sp, _SELITEM_SELECT, ctypes.c_long, []) == 0:
                    return True
            finally:
                _release(sp)
        # Fallback: a control that means "choose one" but only models InvokePattern
        # (Qt tabs, some custom lists) — invoking it is the same gesture.
        ip = _pattern(el, _UIA_InvokePatternId)
        if not ip:
            return False
        try:
            return _vcall(ip, _INVOKE, ctypes.c_long, []) == 0
        finally:
            _release(ip)
    finally:
        _release(el)


@_hangproof(None)
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


@_hangproof(False)
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


@_hangproof("")
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


@_hangproof(False)
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


@_hangproof(None)
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


@_hangproof(None)
def uia_find_item(win: int, item: str, container_name=None,
                  container_ctype: str = "list", max_scan: int = 6000):
    """Find a *virtualized* item by meaning and realize it — the bridge that
    ``uia_find`` cannot cross. A long modern list (WPF/UWP/WinUI) only materializes
    the rows near the viewport into the UIA tree; an item below the fold has no
    element at all, so ``uia_find`` (a Descendants walk) returns None for it and
    ``uia_scroll_into_view`` has nothing to scroll. This asks the *container* (found
    by ``container_name``/``container_ctype``, default a List) for the item by name
    via the UIA ItemContainerPattern, which forces the provider to realize it, then
    scrolls it into view and reports its now-visible screen ``rect`` —
    ``{"name","type","rect"}`` — so the pixel actuator can click it and the realized
    element is now reachable by the other ``uia_*`` verbs. None if no container, no
    ItemContainerPattern, or no such item (JOURNAL F183)."""
    uia = _get_uia()
    if not uia:
        return None
    cont = _find_ptr(uia, win, container_name, container_ctype, max_scan)
    if not cont:
        return None
    try:
        ic = _pattern(cont, _UIA_ItemContainerPatternId)
        if not ic:
            return None
        try:
            var = _variant_bstr(item)
            found = ctypes.c_void_p()
            try:
                hr = _vcall(ic, _IC_FINDITEM, ctypes.c_long,
                            [ctypes.c_void_p, ctypes.c_int, _VARIANT,
                             ctypes.POINTER(ctypes.c_void_p)],
                            None, _UIA_NameProperty, var, ctypes.byref(found))
            finally:
                _oleaut.VariantClear(ctypes.byref(var))
            if hr != 0 or not found.value:
                return None
            try:
                sp = _pattern(found.value, _UIA_ScrollItemPatternId)
                if sp:
                    try:
                        _vcall(sp, _SCROLLINTOVIEW, ctypes.c_long, [])
                    finally:
                        _release(sp)
                return {"name": _prop_bstr(found.value, _UIA_NameProperty),
                        "type": _CONTROL_TYPES.get(
                            _prop_int(found.value, _UIA_ControlTypeProperty)),
                        "rect": _prop_rect(found.value)}
            finally:
                _release(found.value)
        finally:
            _release(ic)
    finally:
        _release(cont)


@_hangproof(False)
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
