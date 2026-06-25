"""uia.py - minimal UI Automation client over raw ctypes COM (zero pip deps).

The raw Win32 HWND tree (GetWindow/EnumChildWindows) only exposes classic per-window controls.
Modern UI frameworks -- the Windows Ribbon (mspaint/wordpad/explorer), WPF, UWP/XAML, Chromium/
Electron, Qt -- draw their controls WITHOUT per-control HWNDs, so an HWND walk is blind to them.
Those frameworks expose semantics only through UI Automation (UIAutomationCore.dll). This module
is a tiny, defensive IUIAutomation client: given a window handle it returns named elements
(name / control-type / class / rect / center) so find()/act() can semantically target them.

Pure stdlib + ctypes; no comtypes/pywin32. Every entry point swallows failures and returns []
so callers fall back to the HWND path or to visual escalation -- never a hard dependency.
"""
import ctypes
from ctypes import wintypes

ole32 = ctypes.WinDLL('ole32')
oleaut32 = ctypes.WinDLL('oleaut32')

COINIT_APARTMENTTHREADED = 0x2
CLSCTX_INPROC_SERVER = 0x1
TreeScope_Descendants = 0x4
TreeScope_Subtree = 0x7


class GUID(ctypes.Structure):
    _fields_ = [('Data1', ctypes.c_uint32), ('Data2', ctypes.c_uint16),
                ('Data3', ctypes.c_uint16), ('Data4', ctypes.c_ubyte * 8)]

    def __init__(self, s):
        super().__init__()
        ole32.CLSIDFromString(ctypes.c_wchar_p(s), ctypes.byref(self))


CLSID_CUIAutomation = '{FF48DBA4-60EF-4201-AA87-54103EEF594E}'
IID_IUIAutomation = '{30CBE57D-D9D0-452A-AB13-7AC5AC4825EE}'

# Semantic property ids (read STATE/VALUE via GetCurrentPropertyValue -> VARIANT, the path that
# actually works for built-in providers; the pattern-object QI route does not in raw ctypes).
PID_Value = 30045        # ValuePattern.Value (BSTR)   -- Edit/ComboBox text
PID_ToggleState = 30086  # TogglePattern.ToggleState (I4: 0 off / 1 on / 2 indeterminate)
PID_RangeValue = 30047   # RangeValuePattern.Value (R8) -- Slider/ProgressBar
PID_IsSelected = 30079   # SelectionItemPattern.IsSelected (BOOL)
# only report each property where it is meaningful for the control type (else providers return noise)
_VALUE_TYPES = {'Edit', 'ComboBox', 'Spinner', 'Document', 'Hyperlink'}
_TOGGLE_TYPES = {'CheckBox', 'RadioButton', 'Button', 'MenuItem', 'SplitButton'}
_SELECT_TYPES = {'ListItem', 'TabItem', 'TreeItem', 'DataItem', 'MenuItem', 'RadioButton'}
_RANGE_TYPES = {'Slider', 'ProgressBar', 'Spinner', 'ScrollBar'}


class VARIANT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [('llVal', ctypes.c_longlong), ('lVal', ctypes.c_long),
                    ('boolVal', ctypes.c_short), ('bstrVal', ctypes.c_void_p), ('dblVal', ctypes.c_double)]
    _anonymous_ = ('u',)
    _fields_ = [('vt', ctypes.c_ushort), ('r1', ctypes.c_ushort), ('r2', ctypes.c_ushort),
                ('r3', ctypes.c_ushort), ('u', _U)]

# vtable indices (IUnknown occupies 0..2 on every interface)
UIA_GetRootElement = 5
UIA_ElementFromHandle = 6
UIA_CreateTrueCondition = 21
EL_FindAll = 6
EL_GetCurrentPropertyValue = 10
EL_get_CurrentControlType = 21
EL_get_CurrentName = 23
EL_get_CurrentClassName = 30
EL_get_CurrentBoundingRectangle = 43  # verified empirically (vtable index)
ARR_get_Length = 3
ARR_GetElement = 4
IUnknown_Release = 2

# a few human-readable control types (UIA_*ControlTypeId)
CONTROL_TYPES = {
    50000: 'Button', 50001: 'Calendar', 50002: 'CheckBox', 50003: 'ComboBox', 50004: 'Edit',
    50005: 'Hyperlink', 50006: 'Image', 50007: 'ListItem', 50008: 'List', 50009: 'Menu',
    50010: 'MenuBar', 50011: 'MenuItem', 50012: 'ProgressBar', 50013: 'RadioButton',
    50014: 'ScrollBar', 50015: 'Slider', 50016: 'Spinner', 50017: 'StatusBar', 50018: 'Tab',
    50019: 'TabItem', 50020: 'Text', 50021: 'ToolBar', 50022: 'ToolTip', 50023: 'Tree',
    50024: 'TreeItem', 50025: 'Custom', 50026: 'Group', 50027: 'Thumb', 50028: 'DataGrid',
    50029: 'DataItem', 50030: 'Document', 50031: 'SplitButton', 50032: 'Window', 50033: 'Pane',
    50034: 'Header', 50035: 'HeaderItem', 50036: 'Table', 50037: 'TitleBar', 50038: 'Separator',
}


def _method(p, idx, restype, *argtypes):
    # restype is c_long (raw HRESULT) rather than ctypes.HRESULT so we can inspect the value
    # ourselves (ctypes.HRESULT auto-raises on any FAILED hr, defeating graceful fallback).
    vtbl = ctypes.cast(p, ctypes.POINTER(ctypes.c_void_p))[0]
    fn = ctypes.cast(vtbl, ctypes.POINTER(ctypes.c_void_p))[idx]
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    return proto(fn)


HR = ctypes.c_long


def _release(p):
    if p:
        try:
            _method(p, IUnknown_Release, ctypes.c_ulong)(p)
        except Exception:
            pass


def _bstr(ptr):
    if not ptr:
        return ''
    try:
        s = ctypes.cast(ptr, ctypes.c_wchar_p).value or ''
    finally:
        oleaut32.SysFreeString(ptr)
    return s


def _el_name(el):
    out = ctypes.c_void_p()
    if _method(el, EL_get_CurrentName, HR, ctypes.POINTER(ctypes.c_void_p))(el, ctypes.byref(out)) == 0:
        return _bstr(out)
    return ''


def _el_class(el):
    out = ctypes.c_void_p()
    if _method(el, EL_get_CurrentClassName, HR, ctypes.POINTER(ctypes.c_void_p))(el, ctypes.byref(out)) == 0:
        return _bstr(out)
    return ''


def _el_ctype(el):
    v = ctypes.c_int(0)
    if _method(el, EL_get_CurrentControlType, HR, ctypes.POINTER(ctypes.c_int))(el, ctypes.byref(v)) == 0:
        return v.value
    return 0


def _el_rect(el):
    r = wintypes.RECT()
    if _method(el, EL_get_CurrentBoundingRectangle, HR, ctypes.POINTER(wintypes.RECT))(el, ctypes.byref(r)) == 0:
        return [r.left, r.top, r.right, r.bottom]
    return [0, 0, 0, 0]


def _variant_py(v):
    vt = v.vt
    if vt == 8:  # VT_BSTR
        s = ctypes.cast(v.bstrVal, ctypes.c_wchar_p).value if v.bstrVal else ''
        return s or ''
    if vt == 3:   # VT_I4
        return v.lVal
    if vt == 11:  # VT_BOOL (-1 true / 0 false)
        return bool(v.boolVal)
    if vt == 5:   # VT_R8
        return v.dblVal
    return None


def _el_prop(el, pid):
    """Read a UIA property via GetCurrentPropertyValue into a VARIANT, return a python value."""
    var = VARIANT()
    if _method(el, EL_GetCurrentPropertyValue, HR, ctypes.c_int, ctypes.POINTER(VARIANT))(el, pid, ctypes.byref(var)) != 0:
        return None
    try:
        return _variant_py(var)
    finally:
        oleaut32.VariantClear(ctypes.byref(var))


def _el_read_state(el, ctname):
    """Semantic value/state for an element, only the properties meaningful for its control type."""
    st = {}
    if ctname in _VALUE_TYPES:
        val = _el_prop(el, PID_Value)
        if isinstance(val, str):
            st['value'] = val
    if ctname in _TOGGLE_TYPES:
        ts = _el_prop(el, PID_ToggleState)
        if isinstance(ts, int):
            st['toggle'] = ts  # 0 off / 1 on / 2 indeterminate
    if ctname in _SELECT_TYPES:
        sel = _el_prop(el, PID_IsSelected)
        if isinstance(sel, bool):
            st['selected'] = sel
    if ctname in _RANGE_TYPES:
        rv = _el_prop(el, PID_RangeValue)
        if isinstance(rv, float):
            st['range'] = rv
    return st


def uia_find(hwnd=0, query=None, max_results=400, read_state=False):
    """Return named UIA elements under a window (or the desktop root if hwnd==0).
    query: dict with optional 'text'/'name', 'class', 'control_type' (name or id), 'regex'.
    Each result: {name, control_type, class, rect, center}. With read_state=True, matched
    elements also carry semantic value/toggle/selected/range (where meaningful). [] on failure."""
    import re as _re
    query = query or {}
    want_text = (query.get('text') or query.get('name') or '').lower()
    want_class = (query.get('class') or '').lower()
    want_ct = query.get('control_type')
    want_re = query.get('regex')
    if isinstance(want_ct, str):
        want_ct = want_ct.lower()
    rx = _re.compile(want_re, _re.I) if want_re else None

    hr = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
    did_init = hr in (0, 1)  # S_OK or S_FALSE (already init on this thread)
    uia = ctypes.c_void_p()
    root = ctypes.c_void_p()
    cond = ctypes.c_void_p()
    arr = ctypes.c_void_p()
    out = []
    try:
        if ole32.CoCreateInstance(ctypes.byref(GUID(CLSID_CUIAutomation)), None,
                                  CLSCTX_INPROC_SERVER, ctypes.byref(GUID(IID_IUIAutomation)),
                                  ctypes.byref(uia)) != 0 or not uia:
            return []
        if hwnd:
            if _method(uia, UIA_ElementFromHandle, HR, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(uia, ctypes.c_void_p(int(hwnd)), ctypes.byref(root)) != 0:
                return []
        else:
            if _method(uia, UIA_GetRootElement, HR, ctypes.POINTER(ctypes.c_void_p))(uia, ctypes.byref(root)) != 0:
                return []
        if not root:
            return []
        if _method(uia, UIA_CreateTrueCondition, HR, ctypes.POINTER(ctypes.c_void_p))(uia, ctypes.byref(cond)) != 0:
            return []
        if _method(root, EL_FindAll, HR, ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(root, TreeScope_Subtree, cond, ctypes.byref(arr)) != 0 or not arr:
            return []
        n = ctypes.c_int(0)
        _method(arr, ARR_get_Length, HR, ctypes.POINTER(ctypes.c_int))(arr, ctypes.byref(n))
        for i in range(min(n.value, max_results)):
            el = ctypes.c_void_p()
            if _method(arr, ARR_GetElement, HR, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))(arr, i, ctypes.byref(el)) != 0 or not el:
                continue
            try:
                name = _el_name(el)
                ct = _el_ctype(el)
                ctname = CONTROL_TYPES.get(ct, str(ct))
                cls = _el_class(el)
                if want_text and want_text not in name.lower():
                    continue
                if rx and not rx.search(name):
                    continue
                if want_class and want_class not in cls.lower():
                    continue
                if want_ct is not None and want_ct not in (ctname.lower(), ct):
                    continue
                if not name and not (want_class or want_ct):
                    continue  # skip anonymous noise unless explicitly querying by class/type
                rect = _el_rect(el)
                cx = (rect[0] + rect[2]) // 2; cy = (rect[1] + rect[3]) // 2
                item = {'name': name, 'control_type': ctname, 'class': cls,
                        'rect': rect, 'center': [cx, cy]}
                if read_state:
                    item.update(_el_read_state(el, ctname))
                out.append(item)
            finally:
                _release(el)
        return out
    except Exception:
        return []
    finally:
        _release(arr); _release(cond); _release(root); _release(uia)
        if did_init:
            ole32.CoUninitialize()


def uia_read(hwnd=0, query=None):
    """Semantic value/state of the first element matching query: {name, control_type, value,
    toggle, selected, range} (only the meaningful keys). {} on no match / any failure."""
    els = uia_find(int(hwnd or 0), query, max_results=400, read_state=True)
    return els[0] if els else {}
