"""agentctl.osctl — OS-level input, clipboard and screen capture.

CDP can only reach what lives *inside* a page.  Real GUIs leak outside the DOM:
the omnibox, Chrome's own "Leave site?" / basic-auth / file-chooser dialogs,
other windows entirely (F005).  ``osctl`` is the escape hatch — it drives the
machine through trusted synthetic input, the clipboard, and a screen grab — so
the agent keeps operating where the browser channel goes blind.

The standout primitive is **atomic paste into the omnibox**: per-character typing
into Chrome's address bar loses keystrokes to history autocomplete (F003).  The
robust path is clipboard + Ctrl+V — one trusted event, nothing to race.

The OS floor is the one platform-specific layer, so it is delegated to a backend
chosen at import (F141): Win32 ``SendInput``/GDI on Windows, X11 + XTEST on Linux
(``_osbackend_win`` / ``_osbackend_x11``). Everything below this header — the
gesture vocabulary and the whole perception side — is platform-agnostic and built
only on the backend's leaf primitives. No third-party deps on either ground: the
PNG encoder is hand-rolled with ``zlib`` so a screenshot is always available.
"""

from __future__ import annotations

import math
import re
import struct
import sys
import time
import zlib

# Optional acceleration (no new F-number — this speeds existing rungs F134/F135/
# F136/F137/F247, it is not a new verb): the whole-region pixel loops below — mean
# colour, change count, change localisation — are O(pixels) in pure Python and dominate a
# perception tick over a large ROI (~90ms for sample_color on ~0.9Mpx). When NumPy
# is importable, the hot paths vectorise to a C loop (10-100x) while returning the
# *byte-identical* result; when it is not, the pure-Python body runs unchanged, so
# the floor keeps its zero-hard-dependency guarantee (道法自然: faster where the
# ground allows, correct everywhere).
try:  # pragma: no cover - exercised at runtime, both branches
    import numpy as _np
except Exception:  # pragma: no cover
    _np = None

if sys.platform.startswith("win"):
    import _osbackend_win as _be
elif sys.platform.startswith("linux"):
    import _osbackend_x11 as _be
else:  # pragma: no cover - no OS backend for this ground yet
    raise ImportError(f"osctl: no OS backend for platform {sys.platform!r}")

# Leaf primitives supplied by the platform backend. Every gesture and reader
# below is written once, against these names only — never the raw OS calls.
screen_size = _be.screen_size
move = _be.move
key_down = _be.key_down
key_up = _be.key_up
set_clipboard = _be.set_clipboard
get_clipboard = _be.get_clipboard
# File clipboard (CF_HDROP): copy/paste *files* between Explorer and apps. The
# non-text twin of the clipboard above — a Ctrl+C in Explorer puts a file list,
# not text, so get_clipboard is blind to it. Fall back to [] / False on a backend
# that predates these (e.g. an X11 ground without a file-list selection bridge).
get_clipboard_files = getattr(_be, "get_clipboard_files", lambda: [])
set_clipboard_files = getattr(_be, "set_clipboard_files", lambda paths, move=False: False)
# Image clipboard (CF_DIB): the third clipboard tongue (text / files / image). Lets
# the floor *see* an image an app put on the clipboard ("Copy image", a chart, a
# screenshot tool) as pixels its own perception reads, and paste one into Paint/docs.
_get_clipboard_image_rgb = getattr(_be, "get_clipboard_image_rgb", lambda: None)
_set_clipboard_image_rgb = getattr(_be, "set_clipboard_image_rgb",
                                   lambda w, h, rgb: False)
_mouse_button = _be.mouse_button
_mouse_wheel = _be.mouse_wheel
# Window addressing (enumerate + activate). Backends expose these; if a backend
# predates them, fall back to no-ops so import never breaks on an older floor.
list_windows = getattr(_be, "list_windows", lambda: [])
# menu_windows: open NATIVE popup menus (class #32768) — context menus and classic
# Win32 dropdowns — which carry no title, so list_windows never returns them. The
# eye that sees a menu the moment it pops, so uia_find can search it by meaning.
menu_windows = getattr(_be, "menu_windows", lambda: [])
activate_window = getattr(_be, "activate_window", lambda win: False)
# Window geometry (read where a window is) + move/resize (put it back in view).
# Raising stacks a window; it cannot rescue one placed *off* the visible screen
# — only moving it can. Fall back gracefully on an older floor that lacks them.
window_geometry = getattr(_be, "window_geometry", lambda win: None)
move_window = getattr(_be, "move_window", lambda win, x, y, w=0, h=0: False)
# Read which window owns a screen pixel — the Z-order read-side dual of
# activate_window. The keyboard follows focus, but the mouse follows the stack:
# a click lands on whoever owns that pixel. This lets the floor *see* which
# window sits under a point before committing a click. None on bare desktop or
# an older floor that lacks the primitive.
window_under = getattr(_be, "window_under", lambda x, y: None)
# Window lifecycle: close a window *by identity* (graceful, runs the app's own
# close path — not a process kill) and read whether a window still exists. Both
# fall back gracefully on an older floor.
close_window = getattr(_be, "close_window", lambda win: False)
window_exists = getattr(_be, "window_exists", lambda win: False)
# Window show-state: read/set minimized vs maximized vs normal. Geometry says
# *where* a window is, never *how it is shown* — a maximized window fills the work
# area, a minimized one has no pixels at all. None / no-op on an older floor.
window_state = getattr(_be, "window_state", lambda win: None)
set_window_state = getattr(_be, "set_window_state", lambda win, state: False)
# Read which window holds keyboard focus right now — the focus-read dual of
# activate_window, as window_under is its stack-read dual. The keyboard follows
# focus; this lets the floor confirm its typing will land where intended. None if
# nothing is focused or on an older floor.
active_window = getattr(_be, "active_window", lambda: None)
# Always-on-top pinning: a topmost window stays above ordinary windows even when
# it does NOT hold focus — the one case where the stack and focus deliberately
# diverge (keep a reference window visible while typing into another). Read dual
# tells whether a window is pinned. No-op / False on an older floor.
set_window_topmost = getattr(_be, "set_window_topmost", lambda win, on=True: False)
is_window_topmost = getattr(_be, "is_window_topmost", lambda win: False)
# Window→process identity: a title can collide (two consoles, two Notepads), but
# the owning pid tells them apart and is what lets the floor escalate from a
# graceful close (close_window) to a forceful kill (terminate_window) when an app
# ignores the polite request. None / no-op on an older floor.
window_pid = getattr(_be, "window_pid", lambda win: None)
terminate_window = getattr(_be, "terminate_window", lambda win: False)
# Read a key's live state {"down","toggled"}: the floor could press/release keys
# but never read them, so a stuck modifier or a silently-on CapsLock/NumLock would
# corrupt all later typing undetectably. The read dual of key_down/key_up. Empty
# state on an older floor.
key_state = getattr(_be, "key_state", lambda vk: {"down": False, "toggled": False})
# Read which mouse buttons are pressed now + cursor pos: mouse_button could press
# /release but nothing could read the buttons, so a drag whose button-up was lost
# left the floor silently stuck pressed. The button-read dual of mouse_button,
# completing the input floor alongside key_state. Empty on an older floor.
mouse_state = getattr(_be, "mouse_state", lambda: {"left": False, "right": False,
                                                   "middle": False, "pos": (0, 0)})
# Semantic content reads: window_text reads the *text a window/control carries*
# (a window title, or — for a child control — an edit box's content, a label's
# words) via the OS text protocol, exact and OCR-free; child_windows descends into
# a window's controls ({id,class,text}). The floor could see only pixels or outer
# titles; this reads the meaning the OS already holds. Empty on an older floor.
window_text = getattr(_be, "window_text", lambda win: "")
child_windows = getattr(_be, "child_windows", lambda win: [])
# Write a control's text directly by identity (write dual of window_text): to fill
# a field the floor otherwise had to focus the window, focus the control, and type
# char-by-char (slow, focus-fragile, modifier-corruptible). WM_SETTEXT hands the
# exact string over in one message — focus-independent, instant, even occluded.
# On X11 it writes the window name (toolkits own widget text). No-op on older floor.
set_window_text = getattr(_be, "set_window_text", lambda win, text: False)
# Which CONTROL (not just top-level window) owns a screen pixel, and what it says:
# {"id","class","text","top"}. window_under answers which window a click lands in;
# this descends to the leaf control under the point and reads it — joining the
# pixel the eye sees to the semantic control behind it (what an a11y inspector
# does). None on bare desktop / older floor.
control_at = getattr(_be, "control_at", lambda x, y: None)
# Find a control inside a window by its MEANING (class and/or text, case-insensitive
# substring) and get WHERE it is: {"id","class","text","rect":(x,y,w,h)} in screen
# coords. The dual of control_at: that answers "what is at this pixel?" (location →
# identity); this answers "where is the control that means X?" (identity → location).
# Returning the rect closes the loop back to the mouse — a semantic find yields a
# pixel target to click, no visual scanning. None if not found / older floor.
find_control = getattr(_be, "find_control", lambda top, cls=None, text=None: None)
# Read a window's MENU BAR as a tree — the app's own command vocabulary
# (File/Edit/…), each leaf carrying its command id; and invoke a command BY ID.
# A window's *actions* live in its menus, invisible to every screenshot until a
# click opens them; this exposes the verbs an app offers (named, addressable) and
# executes one without opening the menu, moving the mouse, or holding focus — the
# action by name, not by pixel-hunt. Windows-native (OS menus); [] / False where
# the app draws its own menus (most X11 toolkits) or on an older floor.
window_menu = getattr(_be, "window_menu", lambda win: [])
invoke_menu = getattr(_be, "invoke_menu", lambda win, command_id: False)
# UI Automation read (F165): the OS accessibility tree, which sees INSIDE modern
# apps (Chrome/Electron/UWP) that paint everything in one HWND with no child
# controls and no OS menu — exactly where child_windows/window_menu are blind.
# uia_name -> a window's accessible name; uia_children -> its child elements as
# [{"name","type"}] (type = UIA control-type: Button/Edit/Tab/Document/…). The
# semantic floor made uniform across native AND modern software; "" / [] where
# UIA is unavailable (non-Windows / older floor), with the Win32+pixel fallback.
uia_name = getattr(_be, "uia_name", lambda win: "")
uia_children = getattr(_be, "uia_children", lambda win: [])
# UIA find (F166): locate a descendant element by MEANING (accessible name and/or
# control type) anywhere in a window's accessibility tree, and get WHERE it is:
# {"name","type","rect":(x,y,w,h)} in screen coords. The UIA analogue of
# find_control, but it reaches INSIDE modern apps (Chrome/Electron/UWP); returning
# the rect closes the loop to the mouse — a semantic search yields a pixel target
# to click, no visual scanning. None if not found / UIA unavailable.
uia_find = getattr(_be, "uia_find", lambda win, name=None, ctype=None: None)
# uia_find_all (F184): the plural of uia_find — every descendant matching the meaning,
# as a list. uia_children sees only direct children; this reaches the whole subtree to
# read a COLLECTION by meaning (a file list's rows, an image's layers, search hits) that
# live far below the top window. name matches Name/AutomationId/HelpText, ctype filters.
uia_find_all = getattr(_be, "uia_find_all", lambda win, name=None, ctype=None, max_scan=6000: [])
# uia_rows (F196): rebuild a details/report view's ROWS from a flattened tree. A
# multi-column list often scatters each cell into a separate sibling element with no
# per-row parent, so uia_find_all yields names and sizes/dates apart and you cannot read
# "the row for X" as a unit. This regroups the cells by geometry — cluster by vertical
# band, order by x — returning [[cell,…],…] in visual row/column order.
uia_rows = getattr(_be, "uia_rows", lambda win, container_name=None, container_ctype="list", cell_ctypes=("edit", "text", "dataitem", "listitem"), y_tol=8: [])
# UIA action (F167): operate elements found by MEANING through the accessibility
# tree, reaching INSIDE modern apps (Chrome/Electron/UWP) that have no native HWND
# to write to or click. uia_set_value writes a field's value (modern-app dual of
# set_window_text); uia_get_value reads it back; uia_invoke presses a button/link
# by what it means (UIA analogue of invoke_menu) — no mouse, no pixels. False / ""
# where UIA or the pattern is unavailable, with the pixel/keystroke floor as fallback.
_uia_set_value_pattern = getattr(_be, "uia_set_value", lambda win, value, name=None, ctype=None: False)


def _type_into_focused(value: str) -> None:
    """Replace the focused field's contents with ``value`` via the keyboard floor."""
    time.sleep(0.08)
    key_down(0x11); tap(0x41); key_up(0x11)   # Ctrl+A — select all
    tap(0x2E)                                  # Delete — clear the selection
    time.sleep(0.02)
    type_unicode(value)


def uia_set_value(win, value, name=None, ctype=None) -> bool:
    """Set a field's text by meaning. Tries the UIA **ValuePattern** first — the clean,
    focus-free write (modern-app dual of ``set_window_text``) — but trusts it **only when
    a read-back confirms** it, because the pattern lies two different ways:

    * it can **refuse** the write (wxWidgets number fields return ``SetValue`` failure),
    * or it can **fake** it — a Qt Scintilla code editor returns ``SetValue`` *success*
      yet writes nothing, so a verb that believed the return code would report a write
      that never happened.

    A read-back that equals ``value`` is the only proof the write landed. Absent that,
    this reaches for the **keyboard floor**, which cannot lie: give the field focus and
    type. Focus too is taken the human way — a **real click on the field's centre** —
    since UIA ``SetFocus`` likewise *reports* success on custom widgets without moving the
    real caret; a click on the rect puts the caret where the pixels are. So "set this
    field" holds whether the toolkit models a truthful ValuePattern, a lying one, or only
    lets a person type. Composed of existing leaves (``uia_find`` + the click/key floor).
    Returns True once the value is written or typed; falls back to the pattern's own claim
    only when the field can be neither clicked nor focused (e.g. off-screen).

    The keyboard floor can lie too: typing into a **read-only** field (a caption, a
    disabled box, a log view) changes nothing, yet a click+type would blindly report
    success — exactly the bug a real Notepad++ Replace dialog exposed, where the label,
    combo and edit all shared one name. So the typed path is held to the *same* proof as
    the pattern path: a read-back. The write is trusted only when the value actually
    became ``value`` or at least *changed* from before; it stays optimistic only when the
    field's value cannot be read back at all (a Scintilla editor exposes no value), so a
    truly-unobservable-but-working field is not wrongly failed."""
    value = str(value)
    before = uia_get_value(win, name=name, ctype=ctype)
    pattern_ok = _uia_set_value_pattern(win, value, name=name, ctype=ctype)
    if pattern_ok and uia_get_value(win, name=name, ctype=ctype) == value:
        return True  # pattern wrote it and a read-back proves it

    def _landed() -> bool:
        after = uia_get_value(win, name=name, ctype=ctype)
        if after == value:
            return True              # exact: the value took
        if after != before:
            return True              # changed (a field that normalises its input)
        return before == "" and after == ""  # unobservable value → stay optimistic;
        #                                       readable and unchanged → it did not land

    # Unconfirmed: pattern refused, or claimed success without a confirming read-back.
    el = uia_find(win, name=name, ctype=ctype)
    if el and el.get("rect"):
        x, y, w, h = el["rect"]
        if w > 0 and h > 0:
            click(x + w // 2, y + h // 2)  # a real click cannot lie about focus
            _type_into_focused(value)
            return _landed()
    if uia_focus(win, name=name, ctype=ctype):
        _type_into_focused(value)
        return _landed()
    return pattern_ok  # cannot reach the keyboard floor — trust the pattern's claim


uia_get_value = getattr(_be, "uia_get_value", lambda win, name=None, ctype=None: "")
uia_invoke = getattr(_be, "uia_invoke", lambda win, name=None, ctype=None: False)
# UIA click (F179): the explicit union of the semantic and gesture floors — locate a
# control by name/role, then land a real click on its screen rect. Answers for ANY
# visible control (text regions, canvases, custom widgets) regardless of whether the
# toolkit exposed an Action; uia_invoke falls through to this when a match is not
# actionable. False if no element / accessibility unavailable.
uia_click = getattr(_be, "uia_click", lambda win, name=None, ctype=None: False)


def uia_drag(win, name=None, ctype=None, to_name=None, to_ctype=None,
             steps: int = 40, hold: float = 0.2) -> bool:
    """Drag one control onto another **by meaning** — the gesture dual of
    :func:`uia_click` (locate-then-click) carried to the held stroke of :func:`drag`
    (F190b). Both ends are found in the accessibility tree by name/role; the press,
    glide and release land on real screen pixels, so a drag-aware target (a track to
    reorder, a list row to move, a header to shuffle) sees a genuine mouse path.

    The grip is **not** the element centre. A real reorder handle sits at the item's
    leading edge — a track's control-panel header, a row's drag-dots, a card's title
    bar — while the centre is usually the *body* (a waveform, a cell), where a press
    means "select", not "move". So this grips a point just inside the **top-left** of
    each element (a small inset), which lands on the handle for list/track/row items
    and still falls inside the frame for a plain item. It performs the stroke and
    returns True once both ends are located; like every floor verb it does not assert
    the app *honoured* the drag — the caller confirms by reading the new order back
    (the change is the oracle). Returns False only when either end cannot be found or
    has no on-screen rect.

    Two honest limits, by nature not by bug: a target that turns a drag into a click
    (a header that only sorts) does nothing visible, and an **OLE** drop target (file
    drag between Explorer and an app) ignores synthetic mouse motion entirely — those
    need the platform drag-drop protocol, not a pointer path."""
    src = uia_find(win, name=name, ctype=ctype)
    dst = uia_find(win, name=to_name, ctype=to_ctype)
    if not (src and dst):
        return False
    rs, rd = src.get("rect"), dst.get("rect")
    if not (rs and rd) or rs[2] <= 0 or rs[3] <= 0 or rd[2] <= 0 or rd[3] <= 0:
        return False

    def handle(r):  # a point just inside the leading (top-left) edge — where handles live
        x, y, w, h = r
        return x + min(40, w // 2), y + min(12, h // 2)

    (sx, sy), (dx, dy) = handle(rs), handle(rd)
    drag(sx, sy, dx, dy, steps=steps, hold=hold)
    return True


# UIA focus (F169): the bridge from semantic LOCATE to the keystroke floor. Some
# modern inputs (rich text, contenteditable, custom canvases) expose no ValuePattern
# to write through, but CAN be focused through the accessibility tree; once focused,
# the universal keyboard floor (osctl.type/key) types into them. False if no element
# / UIA unavailable.
uia_focus = getattr(_be, "uia_focus", lambda win, name=None, ctype=None: False)
# Read which element holds keyboard focus *right now*, desktop-wide (F204): the dual
# of uia_find — "where will my keystrokes land?" Returns {name,type,aid,help,rect,pid}
# or None. Lets the floor verify a focus move landed (clicked the right field, Tab
# went where intended, no dialog stole focus) before it commits input. None w/o UIA.
uia_focused = getattr(_be, "uia_focused", lambda: None)
# UIA TextPattern read (F170): read an element's full text via DocumentRange.GetText
# — the deep read that reaches INTO modern documents (a Chrome/Electron page, a rich
# editor) where uia_get_value (single-line value fields) returns empty and the native
# window_text (native HWNDs only) cannot reach at all. "" if no TextPattern.
uia_text = getattr(_be, "uia_text", lambda win, name=None, ctype=None, max_len=20000: "")
# UIA toggle (F171): flip a checkbox/switch by meaning via TogglePattern (returns
# True if the flip was issued) — the semantic state verb completing the modern-app
# action set (invoke=press, set_value=write, focus=aim, toggle=flip). It does NOT
# return the new state: a modern app updates ToggleState asynchronously across the
# a11y bridge, so read the settled truth with uia_toggle_state a moment later (the
# read dual; "on"/"off"/"indeterminate"). False/"" where no TogglePattern.
uia_toggle = getattr(_be, "uia_toggle", lambda win, name=None, ctype=None: False)
uia_toggle_state = getattr(_be, "uia_toggle_state", lambda win, name=None, ctype=None: "")
# UIA select (F172): choose an item (radio button, list option, tab) by meaning via
# SelectionItemPattern (returns True if Select was issued) — the semantic choose-one
# verb, with uia_is_selected (True/False/None) as its settled read dual. As with
# toggle, selection settles asynchronously, so the action only reports that it acted.
uia_select = getattr(_be, "uia_select", lambda win, name=None, ctype=None: False)
uia_is_selected = getattr(_be, "uia_is_selected", lambda win, name=None, ctype=None: None)
# UIA expand/collapse (F173): open or close a dropdown / tree node / disclosure
# (<details>, combobox) by meaning via ExpandCollapsePattern (actions return True if
# issued); uia_expand_state reads the settled "collapsed"/"expanded"/"partial"/"leaf"
# (read dual). The reveal verb — making hidden structure appear before reading it.
uia_expand = getattr(_be, "uia_expand", lambda win, name=None, ctype=None: False)
uia_collapse = getattr(_be, "uia_collapse", lambda win, name=None, ctype=None: False)
uia_expand_state = getattr(_be, "uia_expand_state", lambda win, name=None, ctype=None: "")
# UIA scroll-into-view (F174): bring an element below the fold / off-screen into the
# visible viewport by meaning via ScrollItemPattern (True if issued) — modern-content
# "bring into reach", the element-level dual of moving an off-screen window back on
# screen (F149). After it, uia_find returns the now-visible rect for the pixel floor.
uia_scroll_into_view = getattr(_be, "uia_scroll_into_view", lambda win, name=None, ctype=None: False)
# UIA range value (F175): read/set a ranged control (slider, progress bar, scrollbar)
# by meaning via RangeValuePattern. uia_range_value -> {"value","min","max"} (read
# dual); uia_set_range_value sets a slider to a number with no mouse drag (True if
# set; the provider clamps to its own min/max). None/False where no RangeValuePattern.
uia_range_value = getattr(_be, "uia_range_value", lambda win, name=None, ctype=None: None)
uia_set_range_value = getattr(_be, "uia_set_range_value", lambda win, value, name=None, ctype=None: False)
# UIA find-item (F183): locate a *virtualized* list item by meaning that uia_find
# cannot — a long modern list (WPF/UWP/WinUI) only materializes rows near the
# viewport into the a11y tree, so an item below the fold has no element to find or
# scroll. uia_find_item asks the container via ItemContainerPattern to realize it
# by name, scrolls it into view, and returns its now-visible {"name","type","rect"}
# so the pixel floor can reach it and the other uia_* verbs see the realized element.
uia_find_item = getattr(_be, "uia_find_item", lambda win, item, container_name=None, container_ctype="list", max_scan=6000: None)
# tray_icons (F200): the system tray (notification area) is the deepest zero-pixel
# surface — an app resident there owns no top-level window, so list_windows never
# names it, and the host that holds the icons (Shell_TrayWnd) is an untitled shell
# window the floor does not enumerate either. This returns every tray icon by
# MEANING — [{"name","help","aid","rect"}] in screen coords — closing the loop to
# the mouse (right-click the rect for the icon's context menu) so an app that has
# retreated entirely to the tray is still operable. [] on a backend with no tray.
tray_icons = getattr(_be, "tray_icons", lambda: [])


def _tray_find(name: str):
    """The one tray icon whose name/tooltip/aid best matches ``name`` — exact
    (case-insensitive) wins over a substring, mirroring uia_find's preference."""
    nl = name.lower()
    fuzzy = None
    for ic in tray_icons():
        fields = [(ic.get("name") or "").lower(), (ic.get("help") or "").lower(),
                  (ic.get("aid") or "").lower()]
        if nl in fields:
            return ic
        if fuzzy is None and any(nl in f for f in fields):
            fuzzy = ic
    return fuzzy


def tray_invoke(name: str, right: bool = False, pause: float = 0.4) -> bool:
    """Click a **system-tray icon by meaning** — ``tray_invoke("OneDrive")``. Finds
    the icon via :func:`tray_icons` and clicks its centre (``right=True`` for the
    context menu). The mouse is the honest actuator here: a tray icon exposes only a
    legacy IAccessible default action, not a real UIA Invoke pattern, so a real
    click is what a human (and a screen reader's "do default") does. Returns True iff
    an icon matched ``name``. Pair with :func:`tray_context` to also pick a menu item."""
    ic = _tray_find(name)
    if not ic or not ic.get("rect"):
        return False
    x, y, w, h = ic["rect"]
    click(x + w // 2, y + h // 2, right=right)
    time.sleep(pause)
    return True


def tray_context(name: str, *path: str, pause: float = 0.45) -> bool:
    """Right-click a **tray icon by meaning** then pick from its context menu by
    meaning — ``tray_context("DaoTray", "Quit")``. The tray's twin of
    :func:`uia_context`: a NotifyIcon's menu opens as the same untitled native
    ``#32768`` popup that ``list_windows`` cannot see, so the path is walked through
    :func:`menu_windows` exactly as for any other context menu. Returns True iff the
    icon matched and every name on the path was found and clicked. Composed of
    existing floor verbs, so one implementation serves every backend that has a tray."""
    if not path:
        return False
    if not tray_invoke(name, right=True, pause=pause):
        return False
    return _walk_menu_path(path, pause)


# A window's UIA tree always carries its *frame* even when the toolkit inside
# exposes nothing: the OS-drawn caption buttons and the system menu. These names
# (and the structural control types) are scaffolding, never an app's operable
# control, so window_opaque discounts them when asking "is there any meaning here?"
_OPAQUE_CHROME_NAMES = frozenset(
    {"minimize", "maximize", "restore", "close", "system",
     "application", "move", "size"})
_OPAQUE_ACTIONABLE = frozenset(
    {"Button", "MenuItem", "Edit", "Document", "CheckBox", "RadioButton",
     "ComboBox", "Tab", "TabItem", "Hyperlink", "ListItem", "TreeItem",
     "Slider", "Spinner", "SplitButton", "DataItem", "Text", "List", "Tree"})


def window_opaque(win: int, max_scan: int = 1500) -> bool:
    """True when a window has **pixels but no operable meaning** — its UIA/AT-SPI
    tree exposes no application control, only the OS window frame (the caption
    buttons + system menu). Such a window must be driven by the **pixel+keyboard**
    channel, not by meaning: a GTK app on Windows (Inkscape exposes its whole client
    area as a single opaque ``Pane`` — File/Edit/the toolbox/the palette are all
    invisible to UIA), a game, a video surface, a bare ``<canvas>``.

    The friction this dissolves (F201): ``uia_find(win, name=…) → None`` is
    *ambiguous* — it means **either** "that control isn't here, try another name"
    **or** "this whole window has no semantic surface, stop searching by meaning".
    An agent that cannot tell them apart wastes its turns guessing names at a wall.
    ``window_opaque`` answers the second question directly, so the floor can *switch
    channels deliberately*: meaning where it exists, pixels+keys where it does not —
    知止不殆, knowing where the meaning-floor stops is itself part of operating it.

    Honest boundary: this is a heuristic over the a11y tree, not an oracle. It
    discounts controls whose names match the OS frame (``Close``/``Minimize``/… and
    the ``System`` menu), so a *real* app whose **only** actionable control happens
    to be named exactly "Close" could read as opaque — vanishingly rare for a
    genuinely operable window, and recorded rather than papered over. Frame names
    are English here; a localized OS frame would need its own name set."""
    if not window_exists(win):
        return False
    for e in uia_find_all(win, max_scan=max_scan):
        if (e.get("type") in _OPAQUE_ACTIONABLE
                and (e.get("name") or "").strip().lower() not in _OPAQUE_CHROME_NAMES):
            return False
    return True


def _actionable(elems: list) -> list:
    """Keep only the elements an agent could act on — the F201 actionable control
    types, minus the OS window-frame chrome — so an observation is decision-ready
    rather than raw a11y noise."""
    out = []
    for e in elems:
        if (e.get("type") in _OPAQUE_ACTIONABLE
                and (e.get("name") or "").strip().lower() not in _OPAQUE_CHROME_NAMES):
            out.append({"name": e.get("name") or "", "type": e.get("type"),
                        "aid": e.get("aid") or "", "rect": e.get("rect")})
    return out


def screen_observe(deep: bool = False, max_actions: int = 400,
                   max_scan: int = 4000) -> dict:
    """One structured snapshot of the whole screen — the per-step *observation* a
    GUI agent reasons over — composed from the floor's own reads:

        {
          "active":  <hwnd or None>,             # the foreground window's id
          "focus":   {name,type,aid,rect,pid} | None,   # where keystrokes land now
          "windows": [ {"id","title","rect","active","opaque","actions":[…]}, … ],
        }

    Each window carries its frame ``rect`` and an ``opaque`` flag (F201: pixels but
    no operable meaning), and — for the **foreground** window by default — its list
    of *actionable* controls (`{name,type,aid,rect}`, the F201 control types minus
    frame chrome), so the snapshot is decision-ready, not raw tree dump. The active
    window is the one an agent almost always acts in; scanning every window's full
    a11y tree each step is costly and rarely needed, so background windows are listed
    (id/title/rect/opaque) without an action scan unless ``deep=True``.

    This is the perception primitive the public AI-GUI frameworks are built around —
    UFO's per-app *control inventory*, OmniParser / Agent-S's *set-of-marks* of
    labelled, clickable regions: one call that answers "what is on screen and what can
    I do right now?" Here it is assembled from `list_windows` + `active_window` +
    `window_geometry` + `window_opaque` + `uia_find_all` + `uia_focused`, so it speaks
    *meaning* where a window offers it and flags ``opaque`` where the agent must drop
    to the pixel+keyboard channel — the floor's own discipline, surfaced as one read.
    On a backend without UIA, ``actions`` is ``[]`` and ``opaque`` ``False`` (the
    pixel floor still applies); the window list and geometry remain truthful."""
    act = active_window()
    obs = {"active": act, "focus": uia_focused(), "windows": []}
    budget = max_actions
    for w in list_windows():
        wid = w.get("id")
        entry = {"id": wid, "title": w.get("title") or "",
                 "rect": None, "active": wid == act, "opaque": False, "actions": []}
        geo = window_geometry(wid)
        if geo:
            entry["rect"] = (geo["x"], geo["y"], geo["w"], geo["h"])
        if deep or wid == act:
            entry["opaque"] = window_opaque(wid, max_scan=max_scan)
            if not entry["opaque"] and budget > 0:
                acts = _actionable(uia_find_all(wid, max_scan=max_scan))
                entry["actions"] = acts[:budget]
                budget -= len(entry["actions"])
        obs["windows"].append(entry)
    return obs


def uia_menu(win: int, *path: str, pause: float = 0.45) -> bool:
    """Invoke a menu path by **meaning** — ``uia_menu(win, "Edit", "Preferences")``.

    A dropdown menu does not live inside the window that owns its menubar: Qt, wx
    and Win32 all open it as a *separate top-level popup window*, so ``uia_find``
    scoped to the app window sees the menubar item but never the items beneath it
    (they materialise in another window only once the menu is open). This walks the
    path the way a human does: open the menubar item, then for each further name find
    it as a ``menuitem`` in *whatever* popup it opened into — a titled Qt/wx window
    (``list_windows``) or a titleless native ``#32768`` popup (``menu_windows``) — and
    click it, opening the next submenu or, on the last name, firing the action.
    Returns True iff every name on the path was found and clicked. Composed purely of
    existing floor verbs, so it is one implementation for every backend."""
    if not path:
        return False
    tap(0x1B)  # ESC — clear any half-open menu so the walk starts clean
    time.sleep(0.15)
    # F219: menubar entries may be either "menuitem" (Qt/KDE) or "menu" (GTK/GIMP);
    # try both before giving up.
    top = uia_find(win, name=path[0], ctype="menuitem")
    if not top or not top.get("rect"):
        top = uia_find(win, name=path[0], ctype="menu")
    if not top or not top.get("rect"):
        return False
    _click_center(top["rect"])
    time.sleep(pause)
    # F220: wxWidgets (Audacity) menus don't open from a rect-click on the
    # menubar entry; the AT-SPI Action interface ("click" action) is needed.
    # If no submenu items appeared after the rect-click, retry with uia_invoke.
    if len(path) > 1:
        probe = _find_menuitem(path[1], prefer_wid=win)
        if not probe:
            uia_invoke(win, name=path[0], ctype="menu")
            time.sleep(pause)
    return _walk_menu_path(path[1:], pause, prefer_wid=win)


def _click_center(rect):
    x, y, w, h = rect
    click(x + w // 2, y + h // 2)


def _find_menuitem(name: str, prefer_wid: int = 0):
    """Find a ``menuitem`` by meaning across *every* place a menu can pop: titled
    top-level windows (Qt/wx) and titleless native ``#32768`` popups.

    F222: prefer *exact* name matches over substring hits so that "Copy" finds
    the context-menu "Copy" rather than a menubar "Save Copy As…".  Also returns
    items with ``rect=None`` (GTK context menus) paired with their window id so
    callers can fall back to ``uia_invoke``.

    F229: GIMP uses compound menu names ("Blur / Sharpen" for "Blur") and
    exposes them with ``rect=None``.  Without a substring-no-rect fallback
    the item is invisible to the walker.

    ``prefer_wid``: when set, search that window first — if it yields an exact
    match with a rect, return immediately without scanning other windows."""
    targets = menu_windows() + list_windows()
    # Put prefer_wid first so its exact matches win.
    if prefer_wid:
        targets = [w for w in targets if w["id"] == prefer_wid] + \
                  [w for w in targets if w["id"] != prefer_wid]
    nl = name.lower()
    best_sub = None         # first substring hit with rect
    best_exact_norect = None  # exact match but rect=None (GTK context menu)
    best_sub_norect = None  # F229: substring hit without rect (GIMP compound names)
    for w in targets:
        # F229: GIMP submenus (Filters > Blur) are type "menu", not "menuitem".
        # Search both types so submenu entries are found.  GIMP's AT-SPI tree
        # is deeply nested (469+ elements); submenu entries need max_scan≥800.
        scan = 1000
        all_items = uia_find_all(w["id"], name=name, ctype="menuitem", max_scan=scan)
        all_items += uia_find_all(w["id"], name=name, ctype="menu", max_scan=scan)
        for it in all_items:
            it["_wid"] = w["id"]  # carry window id for invoke fallback
            exact = it.get("name", "").lower() == nl
            has_rect = it.get("rect") is not None
            if exact and has_rect:
                return it
            if exact and best_exact_norect is None:
                best_exact_norect = it
            if has_rect and best_sub is None:
                best_sub = it
            if not exact and not has_rect and best_sub_norect is None:
                best_sub_norect = it
    return best_exact_norect or best_sub or best_sub_norect


def _walk_menu_path(names, pause: float, prefer_wid: int = 0) -> bool:
    for name in names:
        hit = _find_menuitem(name, prefer_wid=prefer_wid)
        if hit is None:
            tap(0x1B)
            return False
        # F222: GTK context menu items have rect=None; use uia_invoke instead.
        if hit.get("rect"):
            _click_center(hit["rect"])
        elif hit.get("_wid"):
            uia_invoke(hit["_wid"], name=hit.get("name"), ctype="menuitem")
        else:
            tap(0x1B)
            return False
        time.sleep(pause)
    return True


def uia_context(win: int, target: str, *path: str, ctype=None, pause: float = 0.45) -> bool:
    """Right-click an element by meaning, then pick from its **context menu** by
    meaning — ``uia_context(win, "report.pdf", "Open with", "Notepad")``.

    The context menu is the other half of the menu story (F185): a right-click opens
    a native ``#32768`` popup that carries *no title*, so ``list_windows`` never sees
    it and ``uia_find`` has no window to search — the menu is on screen yet
    unaddressable. This finds ``target`` in ``win`` (``ctype`` narrows it), right-clicks
    its centre, then walks ``path`` through ``menu_windows()`` exactly as
    :func:`uia_menu` walks a menubar. Returns True iff the target was found and every
    name on the path was clicked. One implementation, every backend."""
    if not path:
        return False
    el = uia_find(win, name=target, ctype=ctype)
    if not el or not el.get("rect"):
        return False
    tap(0x1B)
    time.sleep(0.1)
    x, y, w, h = el["rect"]
    click(x + w // 2, y + h // 2, right=True)
    time.sleep(pause)
    return _walk_menu_path(path, pause, prefer_wid=win)


def uia_file_dialog_set_path(dialog_wid: int, path: str, pause: float = 0.5) -> bool:
    """Set the file path in an open/save file dialog, handling KDE, GTK, and
    Xfce toolkits automatically.

    F223: GTK file choosers (GIMP, LibreOffice, gedit) don't expose a file-name
    entry by default — the entry only appears after pressing ``/`` (slash) which
    switches to the location-bar mode.  KDE file dialogs (KWrite, Kate, Dolphin)
    expose ``name='File name:'`` with ``ctype='edit'`` directly.

    F227: GNOME GTK3 file dialogs use Ctrl+L for the location bar (not ``/``).
    Xfce/Mousepad file dialogs have an unnamed Name field at the dialog top.

    F228: Xfce GTK dialogs (Mousepad) expose the **parent window's** AT-SPI
    tree, not the dialog's own elements.  ``uia_set_value`` after Ctrl+L
    therefore targets the document text area instead of the location bar
    entry.  Fix: after Ctrl+L, type directly into the focused location bar
    via ``paste_text`` instead of searching for an Edit element.

    Strategy:
    1. Try KDE: ``uia_set_value(dialog, path, name='File name:', ctype='edit')``
    2. Try Ctrl+L (GNOME GTK3) → ``uia_set_value`` on a *small* edit field
    3. If no small edit found, Ctrl+L again → ``paste_text`` directly
    4. Try ``/`` (older GTK) → same approach
    5. Falls back to ``paste_text`` in the focused field.

    Returns True iff the path was set (caller should press Enter or click
    Open/Save to commit)."""
    # KDE file dialog: "File name:" edit with rect
    ok = uia_set_value(dialog_wid, path, name="File name:", ctype="edit")
    if ok:
        return True

    # F228: Detect whether the dialog has its own *small* Edit element
    # (a filename entry, not a huge document text area).  A location-bar
    # entry is typically < 200 px tall; a document editor is > 300 px.
    def _has_small_edit(wid: int) -> bool:
        els = uia_find_all(wid, max_scan=400)
        for e in els:
            if e.get("type") == "Edit" and e.get("rect"):
                _, _, _, h = e["rect"]
                if h < 200:
                    return True
        return False

    # F227: Try Ctrl+L (GNOME GTK3 / Xfce location bar activation)
    chord(0x11, 0x4C)  # Ctrl+L
    time.sleep(pause)
    if _has_small_edit(dialog_wid):
        ok2 = uia_set_value(dialog_wid, path, ctype="edit")
        if ok2:
            return True
    # F228 + F230: No small edit → the dialog's location bar isn't in
    # AT-SPI.  Ctrl+L opened the breadcrumb location bar.  GTK3
    # autocomplete can corrupt long paths typed character-by-character,
    # so split into directory navigation + filename entry:
    #   1. Type directory in the Ctrl+L bar → Enter (navigates)
    #   2. The Name field re-gains focus after navigation
    #   3. Ctrl+A + type just the basename
    import posixpath
    dirname = posixpath.dirname(path)
    basename = posixpath.basename(path)
    if dirname:
        chord(0x11, 0x41)  # Ctrl+A
        time.sleep(0.05)
        tap(0x2E)  # Delete
        time.sleep(0.1)
        type_unicode(dirname + "/")
        time.sleep(0.3)
        tap(0x0D)  # Enter → navigate to directory
        time.sleep(0.8)
    # Type filename into the Name field (gets focus after navigation)
    chord(0x11, 0x41)  # Ctrl+A
    time.sleep(0.05)
    type_unicode(basename)
    time.sleep(0.3)
    return True


_CELLREF = re.compile(r"^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}$")


def goto_cell(win: int, ref: str, retries: int = 2, pause: float = 0.4) -> bool:
    """Navigate a spreadsheet to an arbitrary cell *by reference* (``goto_cell(win, "B2")``),
    purely by meaning and verified — the cell-navigation friction the JOURNAL frontier left open.

    A spreadsheet draws its grid as one canvas with no per-cell element, so there is
    nothing to ``uia_find("B2")``; and the Name Box (the cell-reference box) is a VCL
    ComboBox whose ``uia_focus`` returns True yet never actually takes keyboard focus (the
    "SetFocus lies" of the F190 family), so a typed reference lands in the sheet instead of
    the box. The reliable anchor is the meaning the provider *does* expose plus the geometry
    it *does* report: the Name Box is the one ComboBox whose displayed Name is itself a cell
    reference (it always shows the active cell), so find it by that meaning and *click* its
    centre — a real click focuses it where SetFocus lied — then select-all, type the
    reference and press Enter. That same box is the oracle: afterwards its Name is the new
    active cell, so the move is verified and retried (clearing any half-typed edit with Esc,
    and a leading Esc cancels any ambient in-cell edit first) before reporting a failure.
    Composed of hang-proof finds + click + keys, so no new COM and it
    cannot itself hang. Returns True iff the active cell became ``ref``."""
    if not _CELLREF.match(ref.strip()):
        return False  # not a single-cell reference — reject up front, never poison the box
    target = ref.strip().upper().replace("$", "")
    tap(0x1B)  # cancel any ambient in-cell edit so the walk starts from a clean grid
    time.sleep(0.15)

    def _namebox():
        top = [e for e in uia_find_all(win, ctype="combobox")
               if e.get("rect") and e["rect"][1] < 160]
        # Clean state: the Name Box is the combobox whose displayed Name *is* a cell
        # reference (it shows the active cell). Prefer that — it is meaning, not position.
        named = [e for e in top if _CELLREF.match((e.get("name") or "").strip())]
        if named:
            named.sort(key=lambda e: e["rect"][1])
            return named[0]
        # Poisoned/edit state: a rejected reference (or a half-typed one) stays in the box,
        # so its Name is no longer a cell reference and the meaning match fails. Fall back to
        # the geometry the provider always reports: the Name Box is the leftmost combobox of
        # the formula-bar row (lowest of the far-left column — the font pickers sit above it).
        # Finding it this way lets the click+Ctrl+A overwrite the bad text and recover.
        if not top:
            return None
        minx = min(e["rect"][0] for e in top)
        leftcol = [e for e in top if e["rect"][0] <= minx + 6]
        leftcol.sort(key=lambda e: -e["rect"][1])
        return leftcol[0]

    got = ""
    for _ in range(retries + 1):
        nb = _namebox()
        if not nb or not nb.get("rect"):
            tap(0x1B)  # ESC — bail out of any open editor, then retry the lookup
            time.sleep(0.2)
            continue
        _click_center(nb["rect"])
        time.sleep(pause)
        chord(0x11, 0x41)            # Ctrl+A — replace whatever the box holds
        time.sleep(0.1)
        type_unicode(ref)
        time.sleep(0.1)
        tap(0x0D)                    # Enter — commit the jump
        time.sleep(pause)
        cur = _namebox()
        got = (cur.get("name") if cur else "") or ""
        if got.strip().upper().replace("$", "") == target:
            return True
        tap(0x1B)                    # cancel a stray in-cell edit before retrying
        time.sleep(0.2)
    return False


# Virtual desktops (workspaces). A window on another workspace has no on-screen
# pixels (the same nothing-to-click as a minimized window, F192) — yet the semantic
# floor reaches it by provider identity all the same (F199). Read side lets the
# floor *see* which workspace a window lives on, and `window_on_current_desktop`
# answers the one cross-platform question that decides *meaning vs pixels*: does this
# window have pixels right now? On X11 the workspace identity is an integer index
# (EWMH); on Windows it is the desktop's GUID string (the documented
# IVirtualDesktopManager) — both compared for equality, never arithmetic. The act
# verbs (`set_desktop`/`move_window_to_desktop`) are EWMH on X11; on Windows the
# documented API cannot switch/count and refuses to move a *foreign* window
# (E_ACCESSDENIED), so those stay truthful no-ops there — the floor drives the
# off-workspace window in place by meaning instead. No-ops on a WM without desktops.
num_desktops = getattr(_be, "num_desktops", lambda: 1)
current_desktop = getattr(_be, "current_desktop", lambda: 0)
window_desktop = getattr(_be, "window_desktop", lambda win: 0)
window_on_current_desktop = getattr(_be, "window_on_current_desktop", lambda win: True)
set_desktop = getattr(_be, "set_desktop", lambda n: False)
move_window_to_desktop = getattr(_be, "move_window_to_desktop", lambda win, n: False)

# ---- pointer position (read side) ----------------------------------------- #
def cursor_pos() -> "tuple[int, int]":
    """Read where the pointer actually is, in screen pixels (F138).

    The whole pointer family *writes* position — :func:`move`, :func:`drag`,
    :func:`glide`, every click that takes ``(x, y)`` — but nothing ever *read* it
    back. That asymmetry bites in three real ways. (1) ``move`` sends *absolute*
    coordinates rescaled to the 0–65535 virtual-desktop range; on a DPI-scaled or
    multi-monitor desktop the landing pixel can differ from what was asked, and
    there was no way to confirm where the cursor truly came to rest. (2) A
    relative nudge — "5px right of wherever I am" for a slider or resize handle —
    is impossible without first knowing the current point. (3) Polite flows that
    move the cursor aside and then restore it had nothing to restore *to*. This
    reads the pointer's current position and returns ``(x, y)`` — the read-side
    dual of :func:`move`, closing the loop the pointer family left open."""
    return _be.cursor_pos()


def move_rel(dx: float, dy: float, steps: int = 1, delay: float = 0.0) -> "tuple[int, int]":
    """Move the pointer by a *relative* delta ``(dx, dy)`` — the motion :func:`move`
    cannot make (F261).

    Every pointer verb the floor had — :func:`move`, :func:`drag`, :func:`glide`,
    every click — addresses an *absolute* screen pixel. That is exactly right for a
    desktop, where the cursor and the coordinate you name are the same thing. But a
    whole class of surfaces *grabs* the pointer and reads only its **motion**: an FPS
    in mouse-look, a 3D editor's orbit drag, any Pointer-Lock canvas (WebGL games,
    map panners). They warp the OS cursor back to centre every frame and integrate
    the deltas, so an absolute warp to a fixed pixel produces *zero* net delta and the
    view never turns — verified live in AssaultCube: absolute ``move`` left the camera
    frozen; relative motion swung it. There was no verb that spoke deltas at all.

    This emits relative motion through the backend (XTEST ``FakeRelativeMotion`` on
    X11, ``SendInput`` without ``ABSOLUTE`` on Windows). ``steps`` splits the delta
    into that many equal relative events ``delay`` seconds apart: a large sweep sent as
    one giant jump can be clamped or skipped by a game that integrates per frame, so
    stepping makes a big turn land smoothly and predictably (the remainder is spread
    so the steps sum *exactly* to ``(dx, dy)`` — no rounding drift). ``steps=1`` (the
    default) is a single immediate event. Returns the integer ``(dx, dy)`` actually
    emitted. It is to :func:`move` what a turn of the head is to a step of the foot:
    the same body, but motion instead of a destination."""
    if steps < 1:
        raise ValueError("steps must be >= 1")
    if delay < 0:
        raise ValueError("delay must be >= 0")
    move_rel_leaf = getattr(_be, "move_rel", None)
    if move_rel_leaf is None:
        raise NotImplementedError("this OS backend has no relative pointer motion")
    tx, ty = int(round(dx)), int(round(dy))
    # Spread the total over `steps` so the running sum hits each integer target
    # exactly — no per-step rounding leaves the cursor short of the asked delta.
    sx = sy = 0
    for i in range(1, steps + 1):
        nx = int(round(tx * i / steps))
        ny = int(round(ty * i / steps))
        ex, ey = nx - sx, ny - sy
        if ex or ey or steps == 1:
            move_rel_leaf(ex, ey)
        sx, sy = nx, ny
        if delay and i < steps:
            time.sleep(delay)
    return (tx, ty)


def servo(locate, target: "tuple[float, float]", actuate=None, *,
          gain: "tuple[float, float] | None" = None, probe: float = 30.0,
          tol: float = 4.0, max_iter: int = 16, damping: float = 0.6,
          max_step: float = 400.0, settle: float = 0.03) -> dict:
    """Drive a *located* feature onto a *target* point through a relative actuator
    of **unknown scale** — closing the perceive→act loop (F262).

    F261 gave :func:`move_rel`: a relative actuator that turns an FPS camera (or
    pans a Pointer-Lock canvas, orbits a 3D view) by emitting motion deltas. But a
    relative actuator hides the one number absolute :func:`move` always knew — *how
    far one unit travels on screen*. ``move(x, y)`` lands on pixel ``(x, y)``; one
    ``move_rel`` count turns the camera by an angle, and how many **pixels** the
    target then slides depends on the field of view and the surface's own
    sensitivity — unknown to the floor, and (measured live in AssaultCube) only
    locally linear: ~1.3 px/count near centre, but a count large enough to "snap"
    overshoots and the feature leaves the window entirely. So a relative actuator
    *cannot* aim in one shot the way :func:`move` clicks in one shot: there is no
    delta to compute without first knowing the scale, and the scale must be
    *measured*, not assumed. Every realtime target task hit this same wall — react
    (F260) says *when*, move_rel (F261) says *turn*, but nothing *closed the loop*
    between seeing where a thing is and steering it where it should be.

    This is that loop, and nothing smaller is. ``locate()`` returns the feature's
    current ``(x, y)`` (e.g. a :func:`find_color` centroid or a :func:`match_template`
    match) or ``None`` if lost; ``target`` is where it should end up (e.g. the
    crosshair / viewport centre); ``actuate(dx, dy)`` emits a relative motion of
    ``dx, dy`` actuator units (defaults to :func:`move_rel`). With ``gain`` unknown
    (the common case) it first **calibrates**: one small ``probe`` nudge per axis,
    measuring the resulting pixel displacement to learn signed units-per-pixel —
    the sign too, so it never has to be told that turning the view right slides the
    world left. Then it steers proportionally — ``step = error * gain * damping``,
    clamped to ``max_step`` so a rough estimate cannot fling the feature out of
    sight — re-locating after each move (``settle`` lets the frame render) until the
    feature is within ``tol`` pixels of ``target`` or ``max_iter`` steps run out.
    ``damping`` < 1 keeps it from overshooting on an approximate gain (the loop
    converges geometrically rather than ringing).

    Returns ``{hit, iters, err, gain, pos, start, reason}``: ``hit`` True when the
    feature settled within ``tol``; ``err`` the final pixel distance; ``gain`` the
    ``(kx, ky)`` units-per-pixel used (the calibration is the reusable part — pass
    it back as ``gain`` to skip re-probing once learned); ``reason`` is ``"hit"``,
    ``"max_iter"``, or ``"lost"``. Call it once to snap onto a still target; call it
    repeatedly to *track* a moving one (each call a fresh closed-loop correction).
    It is to :func:`move_rel` what :func:`react_pixel` is to :func:`wait_pixel`: the
    same motion, but with the eyes open and the loop closed."""
    if probe == 0:
        raise ValueError("probe must be non-zero")
    if max_iter < 1:
        raise ValueError("max_iter must be >= 1")
    if damping <= 0:
        raise ValueError("damping must be > 0")
    if actuate is None:
        actuate = lambda dx, dy: move_rel(dx, dy)
    tx, ty = float(target[0]), float(target[1])

    def _clamp(v: float) -> int:
        return int(round(max(-max_step, min(max_step, v))))

    start = locate()
    if start is None:
        return {"hit": False, "iters": 0, "err": float("inf"), "gain": gain,
                "pos": None, "start": None, "reason": "lost"}

    if gain is None:
        # Calibrate: one probe per axis, measure the pixel displacement it causes.
        # The feature slides opposite the view turn, so the learned units-per-pixel
        # carries the correct sign and the steering below needs no sign convention.
        p0 = start
        actuate(probe, 0); time.sleep(settle)
        p1 = locate()
        if p1 is None:
            return {"hit": False, "iters": 0, "err": float("inf"), "gain": None,
                    "pos": None, "start": start, "reason": "lost"}
        actuate(0, probe); time.sleep(settle)
        p2 = locate()
        if p2 is None:
            return {"hit": False, "iters": 0, "err": float("inf"), "gain": None,
                    "pos": None, "start": start, "reason": "lost"}
        ddx, ddy = p1[0] - p0[0], p2[1] - p1[1]
        if ddx == 0 or ddy == 0:
            raise ValueError("could not calibrate gain: probe produced no "
                             "displacement (feature occluded, or probe too small)")
        gain = (probe / ddx, probe / ddy)

    kx, ky = gain
    iters = 0
    pos = locate()
    err = float("inf")
    for _ in range(max_iter):
        if pos is None:
            return {"hit": False, "iters": iters, "err": float("inf"),
                    "gain": gain, "pos": None, "start": start, "reason": "lost"}
        ex, ey = tx - pos[0], ty - pos[1]
        err = (ex * ex + ey * ey) ** 0.5
        if err <= tol:
            return {"hit": True, "iters": iters, "err": err, "gain": gain,
                    "pos": pos, "start": start, "reason": "hit"}
        sx, sy = _clamp(ex * kx * damping), _clamp(ey * ky * damping)
        if sx == 0 and sy == 0:
            # Sub-pixel residual the actuator's integer resolution cannot close.
            return {"hit": err <= tol, "iters": iters, "err": err, "gain": gain,
                    "pos": pos, "start": start, "reason": "hit" if err <= tol
                    else "max_iter"}
        actuate(sx, sy); time.sleep(settle)
        iters += 1
        pos = locate()
    return {"hit": err <= tol, "iters": iters, "err": err, "gain": gain,
            "pos": pos, "start": start, "reason": "hit" if err <= tol
            else "max_iter"}


def focus_window(match: str, settle: float = 0.25) -> dict | None:
    """Bring the window whose title contains ``match`` to the front, by name (F146).

    The floor's keyboard and clipboard always act on *whatever window holds
    focus* — fine in a single browser, but on a real desktop (the user's actual
    machine, many apps open) input silently lands in the wrong window. The
    official screenshot+click primitive has the same blind spot: it can click a
    visible pixel but cannot *address a window by identity* or raise an occluded
    one. This finds the right window among all top-levels (`list_windows`) and
    activates it (`activate_window`), so a subsequent ``type``/``tap``/paste
    reaches the intended app. Case-insensitive substring; most-recent match wins.
    Returns the chosen ``{"id", "title"}`` or ``None`` if no window matches."""
    m = match.lower()
    hit = None
    for w in list_windows():
        if m in (w.get("title") or "").lower():
            hit = w
    if hit is None:
        return None
    activate_window(hit["id"])
    if settle:
        time.sleep(settle)
    return hit


def wait_window(match: str, timeout: float = 10.0, settle: float = 0.0,
                interval: float = 0.1) -> dict | None:
    """Block until a top-level window whose title contains ``match`` exists, then
    return its ``{"id","title",...}`` — or ``None`` if none appears in ``timeout``
    seconds (F152).

    The screen is a process in time: launching an app, opening a dialog, or a new
    document all *create a window after a delay*. Code that lists/activates the
    window the instant after spawning races the window's birth and addresses
    nothing. F118's ``wait_for`` waits for *pixels* to appear, but pixels carry no
    identity — two same-looking windows are indistinguishable, and a window can
    exist while occluded with no visible pixels. This waits on window *identity*
    (``list_windows``), the dual of waiting on appearance. Case-insensitive
    substring; most-recent match wins. ``settle`` optionally sleeps once found."""
    deadline = time.time() + timeout
    m = match.lower()
    while True:
        hit = None
        for w in list_windows():
            if m in (w.get("title") or "").lower():
                hit = w
        if hit is not None:
            if settle:
                time.sleep(settle)
            return hit
        if time.time() >= deadline:
            return None
        time.sleep(interval)


def wait_window_closed(win: int, timeout: float = 10.0,
                       interval: float = 0.1) -> bool:
    """Block until window id ``win`` no longer exists, returning True once it is
    gone or False on timeout (F152) — the read that confirms a ``close_window``
    actually took, the closing dual of ``wait_window``."""
    deadline = time.time() + timeout
    while True:
        if not window_exists(win):
            return True
        if time.time() >= deadline:
            return False
        time.sleep(interval)


def wait_control(win: int, name=None, ctype=None, timeout: float = 8.0,
                 interval: float = 0.25, max_scan: int = 4000) -> "dict | None":
    """Block until a control matching ``name``/``ctype`` appears *inside* ``win`` by
    **meaning**, then return its ``uia_find`` dict (``{name,type,aid,help,rect}``) —
    or ``None`` on timeout. The semantic dual of :func:`wait_window` (whole new
    window) and :func:`wait_pixel` (a colour): a GUI is a process in time *within* a
    window too — clicking a menu item opens a dialog whose **OK** button appears a
    beat later; expanding a panel, switching a tab, or a list finishing its load all
    make a control *materialise in an existing window* after a delay. Acting the
    instant after the trigger races that birth and finds nothing; pixel waits are
    blind to whether the control is *operable* yet, only that something was drawn.
    This polls ``uia_find`` so the very next step can invoke/type against a control
    the floor has just confirmed is present — the synchronization every multi-step
    interaction needs, expressed in meaning rather than pixels. Returns ``None``
    (never raises) on a backend without UIA, so a caller can fall back to a pixel
    wait. Pure composition of :func:`uia_find`."""
    deadline = time.time() + timeout
    while True:
        hit = uia_find(win, name=name, ctype=ctype, max_scan=max_scan)
        if hit is not None:
            return hit
        if time.time() >= deadline:
            return None
        time.sleep(interval)


def wait_control_gone(win: int, name=None, ctype=None, timeout: float = 8.0,
                      interval: float = 0.25, max_scan: int = 4000) -> bool:
    """Block until a control matching ``name``/``ctype`` is **no longer** present in
    ``win`` (or ``win`` itself is gone), returning True once absent or False on
    timeout. The disappearance dual of :func:`wait_control`: the readiness signal of
    countless operations is something *vanishing* — a "Loading…"/spinner clearing, a
    progress dialog's controls going away, a validation error dismissing once a field
    is fixed. Waiting for the next control to appear is not enough when the gate is an
    old one leaving; this is that gate. Pure composition of :func:`uia_find`."""
    deadline = time.time() + timeout
    while True:
        if not window_exists(win) or uia_find(win, name=name, ctype=ctype,
                                              max_scan=max_scan) is None:
            return True
        if time.time() >= deadline:
            return False
        time.sleep(interval)


# ---- mouse gestures (platform-agnostic, built on the backend leaves) ------- #


def click(x: int | None = None, y: int | None = None, right: bool = False) -> None:
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    button = "right" if right else "left"
    _mouse_button(button, True)
    _mouse_button(button, False)


def double_click(x: int | None = None, y: int | None = None,
                 right: bool = False, gap: float = 0.05) -> None:
    """Two presses at one point within the double-click window (F122).

    :func:`click` fires a single click; a control bound to ``dblclick`` — a
    row that opens only on double-click, double-click-to-select-a-word, a
    handle that resets on double-tap — never answers it. This presses twice
    in quick succession at the *same* point so the window pairs them into a
    ``dblclick``. ``gap`` must stay under the system double-click threshold
    (default ~500 ms); a slower pair reads as two unrelated single clicks,
    which is exactly the friction this steps over."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    click(right=right)
    time.sleep(gap)
    click(right=right)


def press_hold(x: int | None = None, y: int | None = None,
               duration: float = 0.8, right: bool = False) -> None:
    """Press a point and hold it still for ``duration``, then release (F126).

    :func:`click` is instant — down and up in the same breath — and :func:`drag`
    holds but *moves*. Neither can satisfy a control that answers only a
    *sustained, stationary* press: a hold-to-confirm button, an autorepeat
    stepper, a long-press that arms a timer. This presses the button down, waits
    ``duration`` without moving, then releases — so a timer started on
    ``mousedown`` is allowed to fire before ``mouseup`` cancels it, which a
    click never permits."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    button = "right" if right else "left"
    _mouse_button(button, True)
    time.sleep(duration)
    _mouse_button(button, False)


def triple_click(x: int | None = None, y: int | None = None,
                 gap: float = 0.05) -> None:
    """Three presses at one point — select a whole line/paragraph (F125).

    The click-multiplicity ladder: one click places the caret, two
    (:func:`double_click`) select the word under it, three select the whole
    line or paragraph. A double-click can never reach the third rung — to
    grab a full line for replacement you need the triple. This presses three
    times at the same point, each ``gap`` apart and all inside the OS
    double-click window, so the page counts up to ``detail===3``."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    click()
    time.sleep(gap)
    click()
    time.sleep(gap)
    click()


def middle_click(x: int | None = None, y: int | None = None) -> None:
    """Press the middle (wheel) button at a point (F123).

    :func:`click` only encodes left and right; the channel had no third
    button at all. Middle-click is its own verb on the web — ``button===1``,
    the ``auxclick`` event, open-link-in-a-new-background-tab, paste-on-X11,
    autoscroll. A left or right click can never stand in for it. This sends
    one ``MIDDLEDOWN``/``MIDDLEUP`` pair so the page sees a true aux click."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    _mouse_button("middle", True)
    _mouse_button("middle", False)


def mod_click(x: int | None = None, y: int | None = None,
              *mods: int, right: bool = False) -> None:
    """Click with modifier keys held down through the press (F124).

    A plain :func:`click` *replaces* a selection — click item B and item A
    lets go. To extend a selection (Ctrl-click adds one, Shift-click takes a
    range) the modifier must be held *while* the mouse goes down, so the page
    reads ``e.ctrlKey`` / ``e.shiftKey`` on the click. The channel could press
    keys and could click, but never one inside the other; this holds each
    ``mods`` VK down, clicks, then releases them in reverse — the modifier is
    down across the whole button cycle, not merely before or after it."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)
    for vk in mods:
        key_down(vk)
    time.sleep(0.01)
    click(right=right)
    for vk in reversed(mods):
        key_up(vk)


def drag(x0: int, y0: int, x1: int, y1: int,
         steps: int = 24, pause: float = 0.01,
         hold: float = 0.05, right: bool = False) -> None:
    """Press at (x0,y0), glide to (x1,y1) in steps, release (F121).

    :func:`click` only presses a point; a slider thumb, a canvas stroke, a
    text selection, a list reorder all need a *held* move. This is that
    stroke: button down at the start, many small moves along the line,
    button up at the end. ``steps`` makes the motion continuous so
    drag-aware listeners (``mousemove`` while the button is held) see the
    path, not just the endpoints — a single jump from start to end reads
    as a teleport and most drag handlers ignore it."""
    button = "right" if right else "left"
    move(x0, y0)
    time.sleep(0.02)
    _mouse_button(button, True)
    time.sleep(hold)
    n = max(1, steps)
    for i in range(1, n + 1):
        mx = round(x0 + (x1 - x0) * i / n)
        my = round(y0 + (y1 - y0) * i / n)
        move(mx, my)
        time.sleep(pause)
    time.sleep(hold)
    _mouse_button(button, False)


def mod_drag(x0: int, y0: int, x1: int, y1: int, *mods: int,
             steps: int = 24, pause: float = 0.01,
             hold: float = 0.05, right: bool = False) -> None:
    """Drag with modifier keys held down through the whole stroke (F129).

    A plain :func:`drag` moves a handle freely. But a held modifier changes what
    the drag *means*: Shift constrains it to an axis (a straight horizontal or
    vertical move), Ctrl/Alt turns a move into a copy, a modifier-drag extends a
    selection. The handler reads ``e.shiftKey`` / ``e.ctrlKey`` on every
    ``mousemove`` of the stroke, so the modifier must be down across the entire
    drag — not merely tapped before it. This holds each ``mods`` VK down, runs
    the same stroke as :func:`drag`, then releases them in reverse. It is to
    ``drag`` what :func:`mod_click` is to ``click`` and :func:`mod_scroll`
    is to ``scroll`` — the third member of the modifier-held family."""
    for vk in mods:
        key_down(vk)
    time.sleep(0.01)
    drag(x0, y0, x1, y1, steps=steps, pause=pause, hold=hold, right=right)
    for vk in reversed(mods):
        key_up(vk)


def glide(x0: int, y0: int, x1: int, y1: int,
          steps: int = 24, pause: float = 0.01) -> None:
    """Move the cursor along a path with NO button held (F130).

    :func:`move` jumps the cursor straight to a point — one ``mousemove`` at the
    destination, nothing in between — and :func:`drag` glides but with a button
    *down*. Neither can trace a button-less path. Yet much of a GUI answers only
    to the cursor's *journey*, not its arrival: a hover trail, a parallax that
    tracks the pointer, a slider that scrubs on bare ``mousemove``, and above all
    a nested menu that keeps its submenu open only while the cursor crosses from
    parent into child — teleport onto the child and the parent's hover lapses, so
    the submenu never opens. This glides from ``(x0,y0)`` to ``(x1,y1)`` in many
    small steps with no button, so every element along the line sees the cursor
    pass through. It is :func:`drag` without the press — the hover twin of the
    held stroke."""
    move(x0, y0)
    time.sleep(pause)
    n = max(1, steps)
    for i in range(1, n + 1):
        mx = round(x0 + (x1 - x0) * i / n)
        my = round(y0 + (y1 - y0) * i / n)
        move(mx, my)
        time.sleep(pause)


def mod_taps(*mods: int, keys: "tuple[int, ...] | list[int]" = (),
             pause: float = 0.03) -> None:
    """Hold modifier keys down across a whole *sequence* of taps (F131).

    :func:`chord` presses a modifier with one key and releases both in the same
    breath — perfect for a single combo. But some input is a *run* under one
    sustained modifier: Shift held while several Arrow taps extend a selection
    one cell at a time, Alt held across a digit sequence to compose a code, a
    modifier held while several keys are struck and the result committed only on
    the modifier's *keyup*. A loop of :func:`chord` releases the modifier between
    every key, so each keystroke looks like its own combo and the run never
    coheres. This holds each ``mods`` VK down, taps every key in ``keys`` in
    order with the modifier still down, then releases the modifiers in reverse —
    one continuous hold across the sequence. It is to :func:`chord` what a held
    stroke is to a single press."""
    for vk in mods:
        key_down(vk)
    time.sleep(0.01)
    for k in keys:
        tap(k)
        time.sleep(pause)
    for vk in reversed(mods):
        key_up(vk)


def scroll(dy: int = 0, dx: int = 0,
           x: int | None = None, y: int | None = None,
           pause: float = 0.01) -> None:
    """Mouse-wheel scroll, one notch at a time (F119).

    The agent could move and click anywhere it could *see*, but it could only ever
    see one screenful: :func:`capture_rgb` is the viewport, and every reader and
    locator searches within it. Content past the fold — the rest of a page, a list
    below the window, a result that renders lower than the screen is tall — simply
    was not in the pixels, so :func:`locate_phrase` returned ``None`` for text that
    exists but is scrolled away, and nothing in the toolkit could bring it into
    view. Sight was bounded by the window frame.

    This is the wheel. ``dy`` notches scroll vertically — ``dy < 0`` rolls the
    wheel toward the user (the page moves *up*, revealing content *below*), ``dy >
    0`` rolls away (revealing content *above*) — and ``dx`` scrolls horizontally
    the same way; each notch is one ``WHEEL_DELTA`` event, sent over ``(x, y)`` when
    given so the wheel lands on the element under the cursor (a scroll pane, not
    just the page). After scrolling, a fresh :func:`capture_rgb` shows what rolled
    into the frame, and the readers and locators work on it unchanged — the window
    can now be moved across a surface larger than itself."""
    if x is not None:
        move(x, y)
        time.sleep(0.02)

    def wheel(notches: int, horizontal: bool) -> None:
        step = 1 if notches > 0 else -1
        for _ in range(abs(notches)):
            _mouse_wheel(step, horizontal)
            time.sleep(pause)

    if dy:
        wheel(dy, False)
    if dx:
        wheel(dx, True)


def mod_scroll(dy: int = 0, dx: int = 0, *mods: int,
               x: int | None = None, y: int | None = None,
               pause: float = 0.01) -> None:
    """Scroll the wheel with modifier keys held down through it (F128).

    A plain :func:`scroll` always *scrolls* — the page (or a pane) moves. But the
    same wheel under a held modifier means something else entirely: Ctrl+wheel
    *zooms* a browser, a map, an image viewer, an editor's font; Shift+wheel
    scrolls sideways. The page reads ``e.ctrlKey`` / ``e.shiftKey`` on each
    ``wheel`` event, so the modifier must be down *while* the notch fires —
    pressing Ctrl before and releasing after is not enough if the wheel lands in
    between with no key held. This holds each ``mods`` VK down, scrolls (the same
    wheel as :func:`scroll`, reusing its ``x``/``y`` placement), then releases
    them in reverse, so every notch carries the modifier. It is to ``scroll``
    what :func:`mod_click` is to ``click``."""
    for vk in mods:
        key_down(vk)
    time.sleep(0.01)
    scroll(dy=dy, dx=dx, x=x, y=y, pause=pause)
    for vk in reversed(mods):
        key_up(vk)


# ---- keyboard ------------------------------------------------------------- #
def tap(vk: int, hold: float = 0.0) -> None:
    """Press and release a key.

    ``hold`` (seconds) keeps the key down in between. Leave it ``0`` for
    event-driven toolkit widgets — Qt/GTK/wx menus, text fields, accelerators —
    which latch on the X ``KeyPress`` event itself, so a zero-duration press is
    seen (this is the historical behaviour, unchanged).

    But self-drawing surfaces — SDL/OpenGL games, emulators, custom canvases —
    don't act on the event; they sample key *state* once per frame and act on the
    rising edge they observe at a tick. A press whose down and up land between two
    ticks is never sampled and is silently dropped (F232: a zero-hold ``tap`` of
    Return/arrows moved nothing in SuperTux, while a held press did). Pass
    ``hold>=~0.1`` there so the press spans at least one input tick and is
    observed; one such press still yields one discrete action (the menu's repeat
    debounce caps it). For *sustained* input — walking a character, charging —
    use :func:`key_hold`, whose longer default integrates time-in-state."""
    key_down(vk)
    if hold > 0:
        time.sleep(hold)
    key_up(vk)


def chord(*vks: int) -> None:
    """Press keys in order, release in reverse (e.g. Ctrl+L, Ctrl+V)."""
    for vk in vks:
        key_down(vk)
    for vk in reversed(vks):
        key_up(vk)


def key_hold(vk: int, duration: float = 0.8) -> None:
    """Hold a key down for ``duration``, then release (F127).

    :func:`tap` presses and releases in the same breath — the key is down for
    essentially zero time. But many controls integrate over *how long* a key is
    held: a game that advances a character each frame while a direction key is
    down, a hold-to-charge action, a held modifier kept down across other
    events. For those, an instant ``tap`` accrues nothing. This holds the key
    down for ``duration`` so the time-in-state is real. It is the keyboard twin
    of :func:`press_hold`."""
    key_down(vk)
    time.sleep(duration)
    key_up(vk)


def type_unicode(text: str) -> None:
    """Inject text as trusted Unicode key events (bypasses the keyboard layout)."""
    return _be.type_unicode(text)


# Common virtual-key codes.
VK_RETURN, VK_TAB, VK_ESCAPE, VK_CONTROL, VK_MENU, VK_SHIFT = 0x0D, 0x09, 0x1B, 0x11, 0x12, 0x10
VK_L, VK_V, VK_A, VK_C = 0x4C, 0x56, 0x41, 0x43
VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN = 0x25, 0x26, 0x27, 0x28


# ---- clipboard (set_clipboard / get_clipboard come from the backend) ------- #
def paste_text(text: str) -> None:
    """F003: atomic paste — set clipboard, then Ctrl+V (one trusted event)."""
    set_clipboard(text)
    time.sleep(0.03)
    chord(VK_CONTROL, VK_V)


def read_selection(restore: bool = True, settle: float = 0.12) -> str:
    """F195: read the *current selection* as text through the universal copy channel.

    Many surfaces **draw** their content instead of placing it in the accessibility
    tree, so there is no element for ``uia_text`` / ``uia_get_value`` to read and they
    return empty: LibreOffice Calc renders its whole cell grid as one painted custom
    control (no per-cell UIA node — verified on this VM), and the same is true of most
    terminals, canvas-drawn code views and custom-painted lists. But that content is
    still *copyable*. The caller positions the selection by meaning + keyboard (click a
    cell, ``Ctrl+A`` a field, shift-arrow a range); this verb performs the copy and
    returns the text. It clears the clipboard to a sentinel first so a no-op copy
    returns ``""`` rather than a stale value, and (by default) restores the prior
    clipboard so the read leaves no trace. The complement of ``uia_text``: meaning for
    what is in the tree, the copy channel for what is only drawn."""
    prior = get_clipboard() if restore else None
    set_clipboard("")
    time.sleep(0.02)
    chord(VK_CONTROL, VK_C)
    time.sleep(settle)
    out = get_clipboard()
    if restore:
        set_clipboard(prior or "")
    return out


def omnibox_go(url: str) -> None:
    """Focus Chrome's address bar (Ctrl+L), atomic-paste a URL, Enter."""
    chord(VK_CONTROL, VK_L)
    time.sleep(0.05)
    paste_text(url)
    time.sleep(0.05)
    tap(VK_RETURN)


# ---- hand-rolled PNG encoder (stdlib only) -------------------------------- #
def _png(width: int, height: int, rgb: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)  # filter type 0
        raw += rgb[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))


def _decode_png_rgb(blob: bytes) -> "tuple[int, int, bytes]":
    """Decode a PNG produced by :func:`_png` (8-bit RGB, no interlace) back to
    ``(w, h, rgb)``. Supports the standard PNG row filters (None/Sub/Up/Average/
    Paeth) so it reads any baseline truecolour PNG, not only filter-0 ones. The
    inverse of :func:`_png`; used by :func:`set_clipboard_image` to load an image
    the floor wrote (a screenshot, a captured region) before placing it on the
    clipboard. Raises on a non-RGB/interlaced/16-bit PNG (honest, not silent)."""
    if blob[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    i, w, h, idat = 8, 0, 0, bytearray()
    while i < len(blob):
        n = struct.unpack(">I", blob[i:i + 4])[0]
        tag = blob[i + 4:i + 8]
        data = blob[i + 8:i + 8 + n]
        if tag == b"IHDR":
            w, h, bit, ctype, _, _, interlace = struct.unpack(">IIBBBBB", data)
            if bit != 8 or ctype != 2 or interlace != 0:
                raise ValueError("only 8-bit truecolour, non-interlaced PNG")
        elif tag == b"IDAT":
            idat += data
        elif tag == b"IEND":
            break
        i += 12 + n
    raw = zlib.decompress(bytes(idat))
    stride = w * 3
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        ft = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        if ft == 1:        # Sub
            for x in range(3, stride):
                line[x] = (line[x] + line[x - 3]) & 0xFF
        elif ft == 2:      # Up
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif ft == 3:      # Average
            for x in range(stride):
                a = line[x - 3] if x >= 3 else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xFF
        elif ft == 4:      # Paeth
            for x in range(stride):
                a = line[x - 3] if x >= 3 else 0
                b = prev[x]
                c = prev[x - 3] if x >= 3 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, bytes(out)


def get_clipboard_image(path: str) -> "str | None":
    """Materialise the image on the clipboard (``CF_DIB``) as a PNG at ``path`` and
    return that path, or ``None`` when the clipboard holds no bitmap. The image
    twin of :func:`get_clipboard`: when an app does "Copy" of a picture (a chart
    from a spreadsheet, a region from a screenshot tool, a selection in an image
    editor) the payload is a *bitmap*, invisible to the text and file clipboards.
    Once written, the floor's own perception (:func:`find_color`, template match,
    :func:`ocr`) reads it like any screenshot."""
    rgb = _get_clipboard_image_rgb()
    if not rgb:
        return None
    w, h, data = rgb
    with open(path, "wb") as f:
        f.write(_png(w, h, data))
    return path


def set_clipboard_image(path: str) -> bool:
    """Place the PNG at ``path`` on the clipboard as a ``CF_DIB``, so a Ctrl+V into
    Paint, a document, a chat box or any image target pastes it. The image twin of
    :func:`set_clipboard`. ``path`` is a PNG the floor can read (e.g. one it wrote
    via :func:`screenshot`)."""
    with open(path, "rb") as f:
        w, h, rgb = _decode_png_rgb(f.read())
    return bool(_set_clipboard_image_rgb(w, h, rgb))


def capture_rgb(x: int = 0, y: int = 0,
                w: "int | None" = None, h: "int | None" = None
                ) -> "tuple[int, int, bytes]":
    """Grab the whole desktop into memory as ``(w, h, rgb)`` (3 bytes/pixel,
    row-major, top-down) — the raw pixel channel the agent sees.

    The dimensions match ``screen_size()`` (the same space ``click`` normalises
    against), so a pixel located here is directly clickable. The grab itself is
    the backend's job (GDI ``BitBlt`` on Windows, ``XGetImage`` on Linux); both
    return this identical byte layout, so the perception side never sees the
    difference.

    With ``x/y/w/h`` it grabs only that sub-rectangle (a *foveal* window): a much
    smaller read, so it can be repeated far faster than a whole-screen grab. The
    returned buffer is ROI-local (its origin is the rectangle's top-left); use
    :func:`foveate` when you want screen-coordinate results back."""
    return _be.capture_rgb(x, y, w, h)


def pixel(x: int, y: int) -> "tuple[int, int, bytes]":
    """Read the colour of a *single* screen pixel as ``(r, g, b)``. The atom of
    perception: ``find_color`` and template matching grab and scan the whole
    desktop, but the commonest question — *what colour is this one spot right
    now?* (is the indicator green, has the cell filled, did the dot light up) —
    needs only one pixel. A 1×1 foveal ``capture_rgb`` is the cheapest read the
    floor can make, and the basis on which :func:`wait_pixel` polls."""
    _w, _h, rgb = capture_rgb(int(x), int(y), 1, 1)
    return (rgb[0], rgb[1], rgb[2])


def wait_pixel(x: int, y: int, rgb: "tuple[int, int, int]", tol: int = 12,
               timeout: float = 5.0, interval: float = 0.05) -> bool:
    """Block until the pixel at ``(x, y)`` comes within ``tol`` (per-channel) of
    ``rgb``, or ``timeout`` elapses; True if it matched, False on timeout.

    The floor could wait for a *window* to exist (:func:`wait_window`) but had no
    way to wait for a *visual* state — a button enabling, a spinner stopping, a
    progress bar reaching the end, a light turning green. Polling whole-screen
    grabs in a loop is wasteful; this watches one pixel cheaply. The visual-state
    dual of ``wait_window`` — perception-driven waiting, what a human does when
    they watch a screen for something to change."""
    deadline = time.monotonic() + timeout
    tr, tg, tb = rgb
    while True:
        r, g, b = pixel(x, y)
        if abs(r - tr) <= tol and abs(g - tg) <= tol and abs(b - tb) <= tol:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


def click_verify(x: int, y: int, check, tries: int = 3, settle: float = 0.3,
                 right: bool = False) -> dict:
    """Click a point and *confirm the effect landed*, re-clicking until it does
    or ``tries`` is spent (F276).

    :func:`click` is fire-and-forget: it presses and returns, blind to whether the
    press did anything. Most of the time it did — but a click fired a hair too
    early (the target still animating in, the recall phase not yet armed), landing
    a pixel off a control's live edge, or swallowed while the page was busy simply
    *vanishes*: no effect, no error, no life lost. On a memory board this shows as
    one tile that never lights though its neighbours clicked from the same batch
    do — a *systematic* miss no amount of frame-voting (F275) can recover, because
    the reading was right; the actuation dropped. The only cure is the loop a human
    does without thinking: click, glance to see it took, click again if it didn't.
    This owns that loop.

    ``check`` is a zero-argument predicate returning truthy once the click's own
    visible effect is present — typically ``lambda: osctl.pixel(x, y) matched`` or
    ``lambda: bool(find_color(lit, search=cell_bbox))``; :func:`wait_pixel` /
    :func:`find_color` compose straight in. After each press it waits up to
    ``settle`` for the effect (polling ``check`` a few times across that window, so
    a fast effect returns early), and re-presses only if still unconfirmed. If
    ``check`` is already truthy *before* the first press — the effect is present,
    the target was already in the wanted state — it returns immediately with
    ``clicks == 0``, so this is idempotent and safe to call on an already-set tile.

    Returns ``{"ok": bool, "clicks": how_many_presses_fired, "tries": tries}``.
    ``ok`` is whether ``check`` ever turned truthy; ``clicks`` lets a caller tell a
    first-try landing from one that needed nagging (a cheap health signal on how
    flaky actuation is)."""
    if check():
        return {"ok": True, "clicks": 0, "tries": tries}
    clicks = 0
    for _ in range(max(1, tries)):
        click(x, y, right=right)
        clicks += 1
        deadline = time.monotonic() + settle
        while True:
            if check():
                return {"ok": True, "clicks": clicks, "tries": tries}
            if time.monotonic() >= deadline:
                break
            time.sleep(min(0.05, settle / 4) if settle > 0 else 0)
    return {"ok": bool(check()), "clicks": clicks, "tries": tries}


def react_pixel(x: int, y: int, rgb: "tuple[int, int, int]", tol: int = 24,
                timeout: float = 5.0, interval: float = 0.0,
                act="click") -> dict:
    """Spin-watch the pixel at ``(x, y)`` and fire an action the *instant* it comes
    within ``tol`` of ``rgb`` — the reactive twin of :func:`wait_pixel` (F260).

    ``wait_pixel`` watches and returns a bool; the caller must then call
    :func:`click`, and ``click`` *moves* the cursor and sleeps 20 ms to let it land
    before pressing. In a reaction game the cursor is already on the target, so that
    move + settle is pure dead latency that the game scores against you — measured on
    the reaction-time test, a tight watch + ``click`` read 34-38 ms, ~20 ms of it the
    settle alone. Two costs hide here: the perceive→act handoff crosses back into the
    caller (a second verb call), and ``click`` always re-homes the pointer.

    This fuses perceive and act so there is *no* gap between them. It reads ``(x, y)``
    every ``interval`` seconds (``0.0`` = spin at full rate; a single-pixel read is the
    floor's cheapest grab, ~0.03 ms) until within ``tol`` of ``rgb``, then performs
    ``act`` in the same breath:

    - ``"click"`` / ``"press"`` — press+release the left button **where the cursor
      already sits**, with no move and no settle (pre-position with ``move(x, y)``
      before calling: this is the whole point — the reaction case);
    - ``"none"`` — only detect (``wait_pixel`` with a latency report instead of a bool);
    - a zero-argument *callable* — invoked once, at the detection instant (tap a key,
      click elsewhere, anything).

    Returns ``{matched, wait_ms, act_ms, polls, rgb}``: ``wait_ms`` is call→detect,
    ``act_ms`` is detect→action-returned (the gap this verb exists to crush), ``polls``
    the number of reads, ``rgb`` the colour last seen. On ``timeout`` it returns
    ``matched=False`` having fired nothing. It is to ``wait_pixel`` what a reflex is to
    a glance: the same watch, but the hand moves on the same edge the eye sees."""
    if not (isinstance(rgb, (tuple, list)) and len(rgb) == 3):
        raise ValueError("rgb must be an (r, g, b) triple")
    if timeout < 0 or interval < 0:
        raise ValueError("timeout and interval must be >= 0")
    if callable(act):
        fire = act
    elif act in ("click", "press"):
        def fire():
            _mouse_button("left", True)
            _mouse_button("left", False)
    elif act == "none":
        fire = None
    else:
        raise ValueError("act must be 'click', 'press', 'none' or a callable")
    tr, tg, tb = rgb
    t0 = time.monotonic()
    deadline = t0 + timeout
    polls = 0
    last = (0, 0, 0)
    while True:
        last = pixel(x, y)
        polls += 1
        r, g, b = last
        if abs(r - tr) <= tol and abs(g - tg) <= tol and abs(b - tb) <= tol:
            t_det = time.monotonic()
            if fire is not None:
                fire()
            t_act = time.monotonic()
            return {"matched": True, "wait_ms": (t_det - t0) * 1000.0,
                    "act_ms": (t_act - t_det) * 1000.0, "polls": polls,
                    "rgb": last}
        now = time.monotonic()
        if now >= deadline:
            return {"matched": False, "wait_ms": (now - t0) * 1000.0,
                    "act_ms": 0.0, "polls": polls, "rgb": last}
        if interval > 0:
            time.sleep(interval)


def screenshot(path: str) -> str:
    """Capture the whole virtual desktop to a PNG via GDI BitBlt."""
    w, h, rgb = capture_rgb()
    with open(path, "wb") as f:
        f.write(_png(w, h, rgb))
    return path


def find_color(target: tuple[int, int, int], tol: int = 24,
               rgb: bytes | None = None, size: tuple[int, int] | None = None,
               step: int = 1,
               search: tuple[int, int, int, int] | None = None) -> dict | None:
    """Locate a colour on the desktop purely by pixels (no DOM).

    Scans for pixels within ``tol`` (per-channel) of ``target`` and returns the
    centroid ``{x, y, count, bbox}`` in *screen* coordinates — exactly what
    ``osctl.click`` consumes — or ``None`` if the colour is absent. Pass an
    existing ``rgb``/``size`` to reuse one capture for several lookups.

    ``step`` is *acuity*: with ``step=1`` every pixel is examined (full acuity);
    with ``step=n`` only every n-th pixel on every n-th row is sampled, so the
    scan does ``~1/n²`` the work. A whole-screen scan in pure Python is millions
    of pixels and dominates a perceive→act loop (hundreds of ms); the retina's
    *periphery* is likewise low-resolution — it does not read every receptor.
    A coarse ``step`` finds *where* a solid region is in a fraction of the time
    (the centroid of a uniform blob is unbiased under regular subsampling); then
    re-locate at full acuity in a small window (see :func:`foveate`) to refine.
    ``count`` is the number of *matched samples* (≈ area/step²), so a threshold
    on ``count`` must account for ``step``. ``bbox`` is rounded to the sample grid.

    ``search`` (F240): an optional ``(minx, miny, maxx, maxy)`` window (screen
    coordinates, clamped to the capture) to scan, mirroring
    :func:`match_template`. ``match_template``'s own docstring prescribes the
    idiom "segment by colour to narrow the field, then match_template within it",
    yet without a window the colour step had to scan the whole desktop — so on a
    multi-window desktop it pulled in same-coloured blobs from other windows and
    chrome (a white Mahjongg tile face is also every white pixel of the side
    panel and neighbouring apps) and paid a full-screen scan for a board that
    occupies a fraction of it. Bounding the scan to the known region of interest
    makes the colour pre-filter both correct and cheap. Returned coordinates stay
    absolute regardless of the window."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    if search is None:
        bx0, by0, bx1, by1 = 0, 0, w - 1, h - 1
    else:
        bx0, by0, bx1, by1 = search
        bx0, by0 = max(0, bx0), max(0, by0)
        bx1, by1 = min(w - 1, bx1), min(h - 1, by1)
    tr, tg, tb = target
    s = max(1, int(step))
    if _np is not None:
        sub = (_np.frombuffer(rgb, dtype=_np.uint8).reshape(h, w, 3)
               [by0:by1 + 1:s, bx0:bx1 + 1:s].astype(_np.int16))
        d = _np.abs(sub - _np.array((tr, tg, tb), dtype=_np.int16))
        mask = (d <= tol).all(axis=2)
        n = int(mask.sum())
        if n == 0:
            return None
        ys, xs = _np.nonzero(mask)
        xa = xs * s + bx0
        ya = ys * s + by0
        return {"x": int(xa.sum()) // n, "y": int(ya.sum()) // n, "count": n,
                "bbox": (int(xa.min()), int(ya.min()),
                         int(xa.max()), int(ya.max()))}
    sx = sy = n = 0
    minx = miny = 1 << 30
    maxx = maxy = -1
    xstep = 3 * s
    for y in range(by0, by1 + 1, s):
        row = y * w * 3
        i = row + bx0 * 3
        for x in range(bx0, bx1 + 1, s):
            if (abs(rgb[i] - tr) <= tol and abs(rgb[i + 1] - tg) <= tol
                    and abs(rgb[i + 2] - tb) <= tol):
                sx += x
                sy += y
                n += 1
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
            i += xstep
    if n == 0:
        return None
    return {"x": sx // n, "y": sy // n, "count": n,
            "bbox": (minx, miny, maxx, maxy)}


def find_color_blobs(target: tuple[int, int, int], tol: int = 24,
                     rgb: bytes | None = None,
                     size: tuple[int, int] | None = None,
                     min_count: int = 1,
                     search: tuple[int, int, int, int] | None = None,
                     step: int = 1) -> list[dict]:
    """Segment a colour into its *separate* regions (F052).

    ``find_color`` collapses every matching pixel into one centroid — fine for a
    lone target, but when the same colour appears twice the mean lands in the
    empty gap *between* them and clicks nothing. This labels matching pixels into
    connected components (4-connectivity, union-find over only the matched
    pixels, so cost scales with the colour's area, not the screen) and returns
    one ``{x, y, count, bbox}`` per region in *screen* coordinates, sorted by
    pixel count (largest first). Pick by size or position; each centroid is a
    real, clickable target. Regions smaller than ``min_count`` are dropped.

    ``search`` (F240): an optional ``(minx, miny, maxx, maxy)`` window (screen
    coordinates, clamped to the capture) to scan, mirroring :func:`find_color`
    and :func:`match_template`. Bounding the colour segmentation to the known
    region of interest stops same-coloured regions in other windows/chrome from
    appearing as spurious blobs and avoids a whole-screen scan when the target
    occupies only a fraction of it. Returned coordinates stay absolute.

    ``step`` (F271): *acuity*, exactly as :func:`find_color` already has it but the
    multi-region segmenter never did. With ``step=1`` every pixel is examined; with
    ``step=n`` only every n-th pixel on every n-th row is sampled, so the scan does
    ``~1/n²`` the work and connectivity is judged on the *sample lattice* (a matched
    sample unions with the matched sample ``n`` to its left / ``n`` above). A solid
    blob's centroid is unbiased under regular subsampling, so a coarse pass finds
    *where* separate targets are for a fraction of the cost — the same trade
    ``find_color`` offers a lone target, now for *several*. ``count`` is matched
    *samples* (≈ area/n²), so a ``min_count`` threshold must account for ``step``,
    and ``bbox`` is rounded to the sample grid; re-locate at ``step=1`` in a small
    window (see :func:`foveate`) when a blob needs pixel-exact extents. A tight
    perceive→act loop over *distinct* same-coloured targets had to pay a full-
    resolution segmentation every frame (measured ~130 ms on a 1.5 MP field, ~6×
    the move+click it gated); ``step`` is how that loop buys back its rate."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    if search is None:
        bx0, by0, bx1, by1 = 0, 0, w - 1, h - 1
    else:
        bx0, by0, bx1, by1 = search
        bx0, by0 = max(0, bx0), max(0, by0)
        bx1, by1 = min(w - 1, bx1), min(h - 1, by1)
    tr, tg, tb = target
    s = max(1, int(step))
    stride = w * 3
    parent: dict[int, int] = {}

    def find(a: int) -> int:
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:  # path compression
            parent[a], a = root, parent[a]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    if _np is not None:
        sub = (_np.frombuffer(rgb, dtype=_np.uint8).reshape(h, w, 3)
               [by0:by1 + 1:s, bx0:bx1 + 1:s].astype(_np.int16))
        d = _np.abs(sub - _np.array((tr, tg, tb), dtype=_np.int16))
        mask = (d <= tol).all(axis=2)
        ys, xs = _np.nonzero(mask)  # row-major: matches the y-outer x-inner loop
        for x, y in zip((xs * s + bx0).tolist(), (ys * s + by0).tolist()):
            key = y * w + x
            parent[key] = key
            if x - s >= bx0 and (key - s) in parent:
                union(key - s, key)
            if y - s >= by0 and (key - s * w) in parent:
                union(key - s * w, key)
    else:
        for y in range(by0, by1 + 1, s):
            row = y * stride
            base = y * w
            up_base = base - s * w
            for x in range(bx0, bx1 + 1, s):
                i = row + x * 3
                if (abs(rgb[i] - tr) <= tol and abs(rgb[i + 1] - tg) <= tol
                        and abs(rgb[i + 2] - tb) <= tol):
                    key = base + x
                    parent[key] = key
                    if x - s >= bx0 and (key - s) in parent:
                        union(key - s, key)
                    if y - s >= by0 and (up_base + x) in parent:
                        union(up_base + x, key)

    agg: dict[int, dict] = {}
    for key in parent:
        root = find(key)
        x, y = key % w, key // w
        a = agg.get(root)
        if a is None:
            agg[root] = {"sx": x, "sy": y, "count": 1,
                         "minx": x, "miny": y, "maxx": x, "maxy": y}
        else:
            a["sx"] += x
            a["sy"] += y
            a["count"] += 1
            if x < a["minx"]:
                a["minx"] = x
            if x > a["maxx"]:
                a["maxx"] = x
            if y < a["miny"]:
                a["miny"] = y
            if y > a["maxy"]:
                a["maxy"] = y

    blobs = [{"x": a["sx"] // a["count"], "y": a["sy"] // a["count"],
              "count": a["count"],
              "bbox": (a["minx"], a["miny"], a["maxx"], a["maxy"])}
             for a in agg.values() if a["count"] >= min_count]
    blobs.sort(key=lambda b: b["count"], reverse=True)
    return blobs


def grid_lattice(points, tol=None) -> dict:
    """Structure an unordered bag of cell centres into a regular grid (F273).

    :func:`find_color` / :func:`find_color_blobs` hand back *where* the tiles are
    as an unordered bag of centroids; a board game needs them as a GRID — which
    row and column each occupies, the cell pitch, and the full lattice *including
    the cells that produced no blob* (an un-lit / empty / covered tile has no
    colour to segment, so it is simply missing from the bag). Boards also move:
    Visual Memory re-centres and *grows* its grid every level (3x3, then 4x4, …),
    so hard-coded cell coordinates rot immediately — the layout has to be inferred
    from what is on screen this frame. Nothing on the floor turned scattered
    centroids into that lattice; this does.

    ``points`` is an iterable of ``(x, y)`` or mappings with ``x``/``y`` (any other
    keys are preserved in the indexed output). Column lines are found by sorting
    the xs and splitting wherever the gap to the next exceeds ``tol`` — a run of
    near-equal xs is one column, its mean the line position — and rows likewise on
    the ys. ``tol`` defaults *per axis* to half that axis's median adjacent-line
    spacing (the pitch), so it scales to the tile size and is immune to sub-pixel
    centroid jitter without merging genuinely distinct lines. Each point is then
    indexed to its nearest column and row.

    Returns::

        {"rows": R, "cols": C,
         "xs": [x per column], "ys": [y per row],   # inferred line centres
         "pitch": (px, py),                          # median adjacent spacing
         "cells": [[pt or None] * C] * R,            # row-major; None where no point
         "points": [{**pt, "x", "y", "row", "col"}]} # every input, indexed

    ``cells`` is the click map (index ``[r][c]`` for the tile at that grid slot,
    ``None`` if nothing was detected there); ``xs``/``ys``/``pitch`` reconstruct a
    slot's centre even when it held no blob, so a solver can click a cell that is
    currently blank. Empty input yields a 0x0 lattice."""
    pts = []
    for p in points:
        if isinstance(p, dict):
            pts.append((float(p["x"]), float(p["y"]), p))
        else:
            pts.append((float(p[0]), float(p[1]), {"x": p[0], "y": p[1]}))
    if not pts:
        return {"rows": 0, "cols": 0, "xs": [], "ys": [],
                "pitch": (0.0, 0.0), "cells": [], "points": []}

    def cluster(vals, t):
        vs = sorted(vals)
        gaps = [vs[i + 1] - vs[i] for i in range(len(vs) - 1)]
        if t is None:
            # Split the adjacent gaps into two populations — small (jitter within
            # a line) and large (the pitch between lines) — at the biggest ratio
            # jump on a sorted, sub-pixel-floored copy. A ratio jump below ~3x
            # means one population (a single line): keep it whole.
            if not gaps:
                t = 1e9
            elif len(gaps) == 1:
                # two points: distinct coordinates are two lines
                t = gaps[0] * 0.5 if gaps[0] > 2.0 else gaps[0] + 1.0
            else:
                fg = sorted(max(g, 1.0) for g in gaps)
                best, bi = 1.0, -1
                for i in range(len(fg) - 1):
                    r = fg[i + 1] / fg[i]
                    if r > best:
                        best, bi = r, i
                if best >= 3.0:
                    t = (fg[bi] * fg[bi + 1]) ** 0.5
                else:
                    t = fg[-1] + 1.0
        lines, cur = [], [vs[0]]
        for i, g in enumerate(gaps):
            if g > t:
                lines.append(cur)
                cur = []
            cur.append(vs[i + 1])
        lines.append(cur)
        centres = [sum(c) / len(c) for c in lines]
        pitches = [centres[i + 1] - centres[i] for i in range(len(centres) - 1)]
        pitch = sorted(pitches)[len(pitches) // 2] if pitches else 0.0
        return centres, pitch

    tx, ty = (tol, tol) if not isinstance(tol, (tuple, list)) else tol
    xs, px = cluster([p[0] for p in pts], tx)
    ys, py = cluster([p[1] for p in pts], ty)

    def nearest(v, lines):
        return min(range(len(lines)), key=lambda i: abs(lines[i] - v))

    cells = [[None] * len(xs) for _ in range(len(ys))]
    indexed = []
    for x, y, orig in pts:
        c = nearest(x, xs)
        r = nearest(y, ys)
        rec = dict(orig)
        rec["x"], rec["y"], rec["row"], rec["col"] = x, y, r, c
        indexed.append(rec)
        if cells[r][c] is None:
            cells[r][c] = rec
    return {"rows": len(ys), "cols": len(xs), "xs": xs, "ys": ys,
            "pitch": (px, py), "cells": cells, "points": indexed}


def grid_index(lattice, points, max_dist=None) -> dict:
    """Index a *foreign* bag of points onto an *already-known* lattice (F274).

    :func:`grid_lattice` builds a lattice out of one point set and indexes *that*
    set. But the two point sets are often different things observed at different
    moments: the board's resting cell centres establish the lattice once (idle
    tiles, a :func:`detect_grid` result), and then a *separate*, transient reading
    — the tiles that flashed this round, the pieces on the board now, every white
    pixel-blob of a move — has to be snapped onto that fixed lattice and collapsed
    to *which cells* it touched. On the floor that meant hand-rolling, per reading,
    two ``min(lines, key=abs-distance)`` nearest-line searches (one per axis) and
    then bucketing repeat detections of one tile into a single click by averaging
    their centroids. This owns exactly that bookkeeping.

    ``lattice`` is anything carrying ``xs`` (column line centres) and ``ys`` (row
    line centres) — a :func:`grid_lattice` return, or a bare ``{"xs":…,"ys":…}``.
    ``points`` is the reading, in the same forms :func:`grid_lattice` takes:
    ``(x, y)`` tuples or mappings with ``x``/``y`` (extra keys are preserved).
    Each point is snapped to its nearest column and row. ``max_dist`` (scalar, or
    ``(dx, dy)`` per axis) drops a point as a *stray* when it lands farther than
    that from the nearest line on either axis — the guard that keeps a blob spilled
    outside the board, or noise between cells, from being mis-snapped onto a real
    tile; ``None`` (default) keeps every point.

    Returns::

        {"rows": R, "cols": C,
         "cells": [[agg or None] * C] * R,     # row-major, same shape as grid_lattice
         "occupied": [(row, col), …],          # sorted distinct touched cells
         "points": [{**pt, "x", "y", "row", "col"}],   # each kept point, indexed
         "dropped": [{**pt, "x", "y"}]}        # strays beyond max_dist

    ``agg`` for an occupied cell is ``{"x", "y", "n"}``: the centroid of the points
    that fell in it (the click target, robust to duplicate detections) and how many
    there were. Empty points, or a lattice with no lines, yield an empty result."""
    xs = list(lattice["xs"]) if lattice and lattice.get("xs") else []
    ys = list(lattice["ys"]) if lattice and lattice.get("ys") else []
    if isinstance(max_dist, (tuple, list)):
        mdx, mdy = float(max_dist[0]), float(max_dist[1])
    elif max_dist is None:
        mdx = mdy = None
    else:
        mdx = mdy = float(max_dist)

    def snap(v, lines):
        i = min(range(len(lines)), key=lambda k: abs(lines[k] - v))
        return i, abs(lines[i] - v)

    kept, dropped = [], []
    buckets: "dict" = {}
    if xs and ys:
        for p in points:
            if isinstance(p, dict):
                x, y, orig = float(p["x"]), float(p["y"]), p
            else:
                x, y, orig = float(p[0]), float(p[1]), {"x": p[0], "y": p[1]}
            c, dx = snap(x, xs)
            r, dy = snap(y, ys)
            if (mdx is not None and dx > mdx) or (mdy is not None and dy > mdy):
                rec = dict(orig); rec["x"], rec["y"] = x, y
                dropped.append(rec)
                continue
            rec = dict(orig)
            rec["x"], rec["y"], rec["row"], rec["col"] = x, y, r, c
            kept.append(rec)
            buckets.setdefault((r, c), []).append((x, y))

    cells = [[None] * len(xs) for _ in range(len(ys))]
    for (r, c), pts in buckets.items():
        n = len(pts)
        cells[r][c] = {"x": sum(q[0] for q in pts) / n,
                       "y": sum(q[1] for q in pts) / n, "n": n}
    return {"rows": len(ys), "cols": len(xs), "cells": cells,
            "occupied": sorted(buckets), "points": kept, "dropped": dropped}


def frame_consensus(frames, min_frac=0.5, key=None) -> dict:
    """Which observations persist across a *burst* of noisy frames (F275).

    A single screen-grab of a transient event lies: one frame misses a tile that
    is really lit, the next invents a phantom from an anti-alias edge or a
    half-drawn fade. Reading the event over *many* frames and keeping only what
    recurs is how you separate signal from flicker — the memorise flash holds its
    tiles for a dozen frames while a stray blob shows for one or two. On the floor
    this was hand-rolled twice: count how many frames each thing appeared in, keep
    the ones above a fraction of the frame count. This owns that majority vote.

    ``frames`` is a list of frames, each an iterable of *items* (cells ``(r, c)``,
    labels, blobs — anything). ``key`` maps an item to the identity that is voted
    on (default: the item itself, which must be hashable); an identity seen twice
    *within one frame* still counts as **one** frame-vote, so duplicate detections
    in a single grab do not stuff the ballot. An identity is kept when it appears
    in at least ``ceil(min_frac * len(frames))`` frames (``min_frac`` clamped to
    ``(0, 1]``; with it 0 or one frame, everything seen is kept).

    Returns ``{"kept": [identity…], "counts": {identity: frames_seen},
    "frames": F, "threshold": T, "items": {identity: [item…]}}`` — ``kept`` sorted
    by descending count then identity (the most-persistent first), ``items`` the
    original items grouped per identity (deduped within a frame) so a caller can
    average their positions for a click target. Empty input yields empty."""
    frames = list(frames)
    F = len(frames)
    idfn = key if key is not None else (lambda it: it)
    counts: "dict" = {}
    items: "dict" = {}
    for fr in frames:
        seen_here: "dict" = {}
        for it in fr:
            k = idfn(it)
            if k not in seen_here:            # dedup within a frame
                seen_here[k] = it
        for k, it in seen_here.items():
            counts[k] = counts.get(k, 0) + 1
            items.setdefault(k, []).append(it)
    frac = min(1.0, max(1e-9, min_frac))
    thr = 1 if F == 0 else max(1, math.ceil(frac * F))
    kept = sorted((k for k, n in counts.items() if n >= thr),
                  key=lambda k: (-counts[k], k))
    return {"kept": kept, "counts": counts, "frames": F,
            "threshold": thr, "items": items}


def foveate(target: tuple[int, int, int], center: tuple[int, int],
            radius: int = 80, tol: int = 24,
            locate=None) -> dict | None:
    """Locate ``target`` inside a small window around ``center`` (F142).

    The eye does not read its whole field at full acuity — a high-resolution
    *fovea* covers a tiny solid angle and is aimed where it expects the signal,
    which is why it can re-check a spot many times a second. This is that fovea:
    grab only a ``2·radius`` square around ``center`` (a fraction of the pixels of
    a whole-screen grab, so far cheaper to repeat) and run a normal locate inside
    it, then map the hit back to *screen* coordinates so the result drops straight
    into ``click``. Returns ``find_color``'s ``{x, y, count, bbox}`` (plus the
    ``roi`` used) in screen space, or ``None`` if ``target`` is not in the window —
    and *absence is information*: it means the thing has left the fovea (moved, or
    the aim was wrong), the cue to saccade with a full grab and re-acquire.

    ``locate`` defaults to :func:`find_color`; pass any ``(target, tol, rgb, size)``
    locator (e.g. a ``find_color_blobs`` wrapper) to foveate with it instead."""
    sw, sh = screen_size()
    cx, cy = int(center[0]), int(center[1])
    r = max(1, int(radius))
    x0 = max(0, min(cx - r, sw - 1))
    y0 = max(0, min(cy - r, sh - 1))
    w = max(1, min(2 * r, sw - x0))
    h = max(1, min(2 * r, sh - y0))
    rw, rh, rgb = capture_rgb(x0, y0, w, h)
    loc = (locate or find_color)(target, tol=tol, rgb=rgb, size=(rw, rh))
    if loc is None:
        return None
    loc["x"] += x0
    loc["y"] += y0
    if loc.get("bbox") is not None:
        a, b, c, d = loc["bbox"]
        loc["bbox"] = (a + x0, b + y0, c + x0, d + y0)
    loc["roi"] = (x0, y0, rw, rh)
    return loc


def reach(target: tuple[int, int, int], tol: int = 24, step: int = 4,
          radius: int = 90, lead: float = 0.03, gap: float = 0.012,
          click_fn=None) -> dict | None:
    """Click a target that may still be moving, by *predictive* foveated reach (F144).

    The honest failure this fixes (reproduced live): locate-then-click reads one
    snapshot, but a synthesised click lands tens of ms later, so on a moving
    element it hits where the target *used to be* — at 900 px/s the classic
    full-screen ``find_color``+click missed every time (~265 px off), because the
    232 ms whole-screen scan alone is ages of motion. Two corrections, both how
    the visuomotor system actually does it:

    1. **Acquire with the periphery, refine with the fovea.** A coarse ``step``
       scan finds *where* the target roughly is in a few ms (low-acuity, like
       peripheral vision), then :func:`foveate` re-reads that small window at full
       acuity — total acquire is ms, not hundreds of ms, so the target is still in
       the fovea when we look again.
    2. **Predict, don't chase.** Smooth pursuit does not aim where the target *is*
       (that image is already old by one neural delay); it estimates the target's
       velocity and aims where it *will be*. So sample the fovea twice (``gap`` s
       apart) for a velocity, then click the position extrapolated ``lead`` seconds
       ahead — ``lead`` being the perceive→click-lands latency. With ``lead=0`` this
       degrades to a pure (non-predictive) foveated reach.

    Returns ``{x, y, vx, vy, settled}`` — the *clicked* screen point and the
    measured pixel/second velocity — or ``None`` if the target was never found.
    ``click_fn`` defaults to :func:`click`; pass one to intercept (tests/dry-run)."""
    do_click = click_fn or click

    def acquire() -> dict | None:  # coarse, whole-screen (periphery)
        w, h, rgb = capture_rgb()
        return find_color(target, tol=tol, rgb=rgb, size=(w, h), step=step)

    a = acquire()
    if a is None:
        return None
    t0 = time.time()
    p0 = foveate(target, (a["x"], a["y"]), radius=radius, tol=tol) or a
    if gap > 0:
        time.sleep(gap)
    t1 = time.time()
    p1 = foveate(target, (p0["x"], p0["y"]), radius=radius, tol=tol)
    if p1 is None:                       # left the fovea → re-acquire (saccade)
        a = acquire()
        if a is None:
            return None
        p1 = foveate(target, (a["x"], a["y"]), radius=radius, tol=tol) or a
        t1 = time.time()
    dt = t1 - t0
    vx = (p1["x"] - p0["x"]) / dt if dt > 0 else 0.0
    vy = (p1["y"] - p0["y"]) / dt if dt > 0 else 0.0
    px = int(round(p1["x"] + vx * lead))
    py = int(round(p1["y"] + vy * lead))
    do_click(px, py)
    return {"x": px, "y": py, "vx": vx, "vy": vy,
            "settled": abs(vx) < 1.0 and abs(vy) < 1.0}


def steer(target: tuple[int, int, int], goal: int, axis: str = "x",
          tol: int = 24, step: int = 4, radius: int = 80,
          pos_key: int | None = None, neg_key: int | None = None,
          coast: float = 0.25, gap: float = 0.012, band: float = 8.0,
          taps: int = 10, settle: float = 1.2, max_ballistic: float = 4.0,
          perceive_fn=None) -> dict | None:
    """Drive a *keyboard-moved* control to a perceived ``goal`` by closed-loop servo (F145).

    The honest failure this fixes (reproduced live): some things move only while a
    key is **held** and *coast* after release (a momentum scrubber, a key-repeat
    slider, a game character). You cannot hit them open-loop — from one snapshot you
    can hold the key for a distance-estimated time, but the acceleration and the
    post-release coast are unknown, so you overshoot (live: 0/12 in-band, ~244 px).
    A click cannot help — the control is keyboard-driven. So do it the way the motor
    system does: a **ballistic** phase (hold the key toward the goal while *watching*),
    released *predictively* before arrival to leave room for the coast, then a
    **corrective** phase of small impulses until inside the goal band (saccade-and-
    correct). Eyes + hand, fused: perception is by pixels, motion is the real keyboard.

    ``goal`` is the target coordinate **on the chosen ``axis``** in *screen* pixels
    (e.g. the centre of a band located by :func:`find_color`). ``perceive_fn`` returns
    the controlled element's current ``(cx, cy)`` screen centre (default: a coarse
    :func:`find_color` of ``target`` refined in the fovea). ``pos_key``/``neg_key``
    are the keys that move it in the +/- axis direction (default arrow keys). ``coast``
    is the release lead as a fraction of the measured speed (stopping-distance ≈
    ``|v|·coast``); ``band`` is the half-width to land inside; ``taps`` short
    corrective ``key_hold`` pulses. Returns ``{x, y, err, reached, pulses}``."""
    ax = 0 if axis == "x" else 1
    if pos_key is None:
        pos_key = VK_RIGHT if ax == 0 else VK_DOWN
    if neg_key is None:
        neg_key = VK_LEFT if ax == 0 else VK_UP

    def perceive():
        if perceive_fn is not None:
            return perceive_fn()
        w, h, rgb = capture_rgb()
        loc = find_color(target, tol=tol, rgb=rgb, size=(w, h), step=step)
        if loc is None:
            return None
        f = foveate(target, (loc["x"], loc["y"]), radius=radius, tol=tol) or loc
        return (f["x"], f["y"])

    def rest():
        """Wait until the element stops moving (perceived Δ≈0) — proprioceptive
        'limb has come to rest'. A fixed sleep would re-perceive mid-coast and
        mis-correct; here we measure *that it actually stopped*. Require two
        consecutive sub-pixel deltas so a slow coast isn't mistaken for rest."""
        last = perceive()
        t = time.time()
        stable = 0
        while time.time() - t < settle:
            time.sleep(0.03)
            p = perceive()
            if p is None or last is None:
                last = p
                continue
            stable = stable + 1 if abs(p[ax] - last[ax]) < 1.0 else 0
            last = p
            if stable >= 2:
                return p
        return last

    cur = perceive()
    if cur is None:
        return None
    c = cur[ax]
    sign = 1 if goal > c else -1
    key = pos_key if sign > 0 else neg_key

    # Ballistic: hold toward the goal, watch by pixels, release predictively.
    key_down(key)
    prev, tprev = c, time.time()
    t0 = tprev
    try:
        while time.time() - t0 < max_ballistic:
            time.sleep(gap)
            p = perceive()
            if p is None:
                continue
            c = p[ax]
            tn = time.time()
            v = (c - prev) / (tn - tprev) if tn > tprev else 0.0
            prev, tprev = c, tn
            remaining = (goal - c) * sign
            if remaining <= abs(v) * coast or remaining <= 0:
                break
    finally:
        key_up(key)

    # Corrective: small impulses until the centre is inside the goal band. Wait
    # for actual rest before each measurement so we correct position, not coast.
    pulses = 0
    cur = rest() or cur
    for _ in range(taps):
        c = cur[ax]
        err = c - goal
        if abs(err) <= band:
            break
        key_hold(neg_key if err > 0 else pos_key, duration=0.02)
        pulses += 1
        cur = rest() or cur
    err = cur[ax] - goal
    return {"x": cur[0], "y": cur[1], "err": err,
            "reached": abs(err) <= band, "pulses": pulses}


def crop_rgb(rgb: bytes, size: tuple[int, int], bbox: tuple[int, int, int, int]
             ) -> tuple[bytes, int, int]:
    """Cut a ``(patch, pw, ph)`` sub-image out of a capture.

    Turns *what the agent saw there* (e.g. a ``find_color`` bbox) into a
    reusable reference patch for ``match_template`` — the bridge between seeing
    a thing once and recognising it elsewhere. ``bbox`` is inclusive
    ``(minx, miny, maxx, maxy)`` in the capture's coordinate space."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    pw, ph = x1 - x0 + 1, y1 - y0 + 1
    stride = w * 3
    out = bytearray(pw * ph * 3)
    for py in range(ph):
        src = (y0 + py) * stride + x0 * 3
        dst = py * pw * 3
        out[dst:dst + pw * 3] = rgb[src:src + pw * 3]
    return bytes(out), pw, ph


def capture_patch(bbox: tuple[int, int, int, int]) -> tuple[bytes, int, int]:
    """Grab *only* ``bbox`` as ``(patch, pw, ph)`` — a foveal :func:`capture_rgb`
    of just that inclusive ``(minx, miny, maxx, maxy)`` rectangle (F245).

    For an in-bounds ``bbox`` this is byte-for-byte identical to
    ``crop_rgb(capture_rgb()..., bbox)`` — but it asks ``XGetImage`` for the
    rectangle alone instead of the whole desktop, so it reads roughly the
    rectangle's fraction of the pixels (a board ROI is ~7% of a 1600x1200
    screen, measured ~14x faster per read). The high-rate pixel waiters
    (:func:`wait_for_change`, :func:`wait_until_stable`) poll a fixed region many
    times a second; grabbing the whole screen each tick just to throw away 93% of
    it is the avoidable cost (損之又損). This is the one read they should make."""
    x0, y0, x1, y1 = bbox
    pw, ph = x1 - x0 + 1, y1 - y0 + 1
    _w, _h, patch = capture_rgb(x0, y0, pw, ph)
    return patch, pw, ph


def wait_until_stable(bbox: tuple[int, int, int, int], settle: int = 3,
                      interval: float = 0.08, timeout: float = 6.0,
                      tol: int = 0, min_count: int = 1
                      ) -> dict:
    """Wait until a screen region stops changing, by pixels (F132, F244).

    ``wait_for_phrase`` waits for *text* to appear, but much of a GUI moves
    without ever spelling anything: a panel slides in, a spinner turns, a list
    reflows, a fade settles. Act mid-transition and the target is still in
    flight — the click lands where the thing *was*, not where it comes to rest.
    Nothing in the pixel channel waited for *motion to end*. This re-captures the
    ``bbox`` region every ``interval`` and compares it to the last capture; once
    ``settle`` consecutive captures match, the region is judged at rest. Returns
    ``{stable, changes, captures, elapsed}`` — ``stable`` is whether it settled
    before ``timeout``, ``changes`` how many times the region differed (proof it
    really was moving), so the caller can both wait and confirm something
    happened. The visual twin of ``wait_for_phrase``: one waits for a word, the
    other for stillness.

    Sameness is measured through :func:`region_diff` with ``tol``/``min_count``
    (F244): two captures *match* when fewer than ``min_count`` pixels differ by
    more than ``tol`` per channel. The defaults ``tol=0, min_count=1`` are exact
    byte-equality — identical to the original behaviour — but raising them lets a
    region settle past sub-pixel render jitter, a blinking caret, or a hover
    ring that would otherwise reset the ``settle`` counter forever. The same
    tolerant equality :func:`region_diff` was written to give the waits."""
    deadline = time.time() + timeout
    start = time.time()
    prev: bytes | None = None
    stable = changes = captures = 0
    while time.time() < deadline:
        patch, _pw, _ph = capture_patch(bbox)
        captures += 1
        same = prev is not None and (
            region_diff(patch, prev, tol=tol)["pixels"] < min_count)
        if same:
            stable += 1
            if stable >= settle:
                return {"stable": True, "changes": changes,
                        "captures": captures, "elapsed": time.time() - start}
        else:
            if prev is not None:
                changes += 1
            stable = 0
        prev = patch
        time.sleep(interval)
    return {"stable": False, "changes": changes,
            "captures": captures, "elapsed": time.time() - start}


def sample_color(bbox: tuple[int, int, int, int], rgb: bytes | None = None,
                 size: tuple[int, int] | None = None) -> dict:
    """Read the mean colour of a screen region — the inverse of find_color (F137).

    :func:`find_color` answers *where is this known colour?*; it forces you to
    name a colour up front. But often the colour is the very unknown: a status
    dot is green or red, a toggle's fill tells its state — and you cannot search
    for the answer you are trying to read. To guess and ``find_color`` each
    candidate is backwards. This crops ``bbox`` and averages it, returning
    ``{r, g, b, count}`` — the colour that is actually *there*, which the caller
    can then classify or compare. The dual of `find_color`: one maps colour→place,
    this maps place→colour. Pass an existing ``rgb``/``size`` to reuse a capture."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    patch, pw, ph = crop_rgb(rgb, (w, h), bbox)
    n = pw * ph
    if n == 0:
        raise ValueError("empty bbox")
    if _np is not None:
        s = _np.frombuffer(patch, dtype=_np.uint8).reshape(-1, 3).sum(axis=0)
        return {"r": int(s[0]) // n, "g": int(s[1]) // n,
                "b": int(s[2]) // n, "count": n}
    sr = sg = sb = 0
    for i in range(0, len(patch), 3):
        sr += patch[i]
        sg += patch[i + 1]
        sb += patch[i + 2]
    return {"r": sr // n, "g": sg // n, "b": sb // n, "count": n}


def sample_grid(bbox: tuple[int, int, int, int], cols: int, rows: int,
                rgb: bytes | None = None, size: tuple[int, int] | None = None,
                inset: float = 0.25, stat: str = "mean",
                quant: int = 24) -> list[list[dict]]:
    """Classify a regular ``cols``x``rows`` grid of cells by colour, from ONE
    capture — the grid generalisation of :func:`sample_color` (F247).

    Tetris, mines, sudoku, a chess board, a mahjongg layer: a recurring GUI is a
    fixed lattice of equal cells, and the question is *what is in every cell*.
    The floor only had :func:`sample_color`, which reads one region — so each of
    those games hand-rolls the same double loop, calling ``sample_color`` (or
    cropping) once per cell. That is two avoidable costs paid on every frame:
    the geometry is recomputed by every caller, and each call crops a fresh
    buffer and then averages the *whole* cell — hundreds of cells x hundreds of
    pixels of pure-Python summation, ~18 ms for a 10x20 board — which a real-time
    game (a falling piece) cannot spend per tick.

    This divides ``bbox`` into ``cols``x``rows`` equal cells and returns a
    ``rows``x``cols`` list of ``{r, g, b, count}`` cells. Two losses are cut
    (損之又損): it indexes straight into the one capture instead of allocating a
    crop per cell, and it reads only each cell's central window — ``inset`` is
    the fraction trimmed off every side (default ``0.25`` keeps the central half
    in each axis, ~a quarter of the pixels), which both skips the grid lines /
    borders between cells (so a separator never pollutes a cell's colour) and
    reads far fewer pixels. ``inset`` only changes which pixels are read, not the
    coordinate or packing convention, so each cell matches a centred
    ``sample_color``. Pass an existing ``rgb``/``size`` to reuse a capture (pair
    with :func:`capture_patch` to read just the board).

    ``stat`` chooses how a cell's pixels reduce to one colour:

    - ``"mean"`` (default) averages them — for a solid-filled cell the centre
      mean equals the whole-cell mean, and it matches a centred ``sample_color``.
    - ``"mode"`` returns the *fill* — the mean of the largest cluster of similar
      pixels — and is **immune to a foreground mark** painted on that fill. The
      mean of a cell conflates background and mark in proportion to how much of
      the cell the mark covers, so two cells with the *same* fill but differently
      sized marks read as *different* colours (and the discriminating signal, the
      fill, is lost): a minesweeper theme that tints the cell by its count (1 =
      green, 2 = tan) carries a dark digit whose ink grows with the count, so the
      mean of a "2" is dragged further from its tan fill than a "1" from its
      green — the very signal you want to read is corrupted by the very glyph
      sitting on it. ``"mode"`` buckets the cell's pixels into a coarse colour
      histogram (each channel quantised to ``quant``-wide bins, default 24),
      takes the most-populated bin (the fill always outvotes the glyph, which is
      a minority of the central window), and returns the *exact* mean of the
      pixels in that bin — a precise, mark-immune fill colour. ``count`` is the
      number of pixels that fell in the modal bin (its dominance); a near-solid
      cell approaches the full window. Reading the fill under a mark generalises
      past mines — a button's colour under its label, a card's colour under its
      number, a token's team colour under its symbol, or simply telling a covered
      cell from an empty one from a numbered one by fill alone, at any size where
      the glyph itself is too small to read."""
    if cols < 1 or rows < 1:
        raise ValueError("cols and rows must be >= 1")
    if not 0.0 <= inset < 0.5:
        raise ValueError("inset must be in [0.0, 0.5)")
    if stat not in ("mean", "mode"):
        raise ValueError("stat must be 'mean' or 'mode'")
    if not 1 <= quant <= 256:
        raise ValueError("quant must be in [1, 256]")
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    arr = (_np.frombuffer(rgb, dtype=_np.uint8).reshape(h, w, 3)
           if _np is not None else None)
    grid = []
    for r in range(rows):
        cy0 = y0 + r * ch
        iy0 = int(cy0 + ch * inset)
        iy1 = int(cy0 + ch * (1.0 - inset))
        if iy1 <= iy0:
            iy1 = iy0 + 1
        iy0 = max(0, min(iy0, h - 1))
        iy1 = max(iy0 + 1, min(iy1, h))
        row = []
        for c in range(cols):
            cx0 = x0 + c * cw
            ix0 = int(cx0 + cw * inset)
            ix1 = int(cx0 + cw * (1.0 - inset))
            if ix1 <= ix0:
                ix1 = ix0 + 1
            ix0 = max(0, min(ix0, w - 1))
            ix1 = max(ix0 + 1, min(ix1, w))
            if stat == "mean":
                if arr is not None:
                    cell = arr[iy0:iy1, ix0:ix1]
                    n = cell.shape[0] * cell.shape[1]
                    s = cell.reshape(-1, 3).sum(axis=0)
                    row.append({"r": int(s[0]) // n, "g": int(s[1]) // n,
                                "b": int(s[2]) // n, "count": n})
                    continue
                sr = sg = sb = n = 0
                for yy in range(iy0, iy1):
                    base = (yy * w + ix0) * 3
                    for k in range(0, (ix1 - ix0) * 3, 3):
                        sr += rgb[base + k]
                        sg += rgb[base + k + 1]
                        sb += rgb[base + k + 2]
                        n += 1
                row.append({"r": sr // n, "g": sg // n, "b": sb // n, "count": n})
            else:
                # Modal fill: bucket pixels into a coarse colour histogram,
                # accumulating each bin's exact channel sums, then return the
                # mean of the most-populated bin — the fill outvotes any mark.
                if arr is not None:
                    cell = arr[iy0:iy1, ix0:ix1].reshape(-1, 3).astype(_np.int64)
                    kb = 256 // quant + 1
                    codes = (cell[:, 0] // quant * kb
                             + cell[:, 1] // quant) * kb + cell[:, 2] // quant
                    uniq, first_idx, inv, counts = _np.unique(
                        codes, return_index=True, return_inverse=True,
                        return_counts=True)
                    sr = _np.zeros(uniq.size, dtype=_np.int64)
                    sg = _np.zeros(uniq.size, dtype=_np.int64)
                    sb = _np.zeros(uniq.size, dtype=_np.int64)
                    _np.add.at(sr, inv, cell[:, 0])
                    _np.add.at(sg, inv, cell[:, 1])
                    _np.add.at(sb, inv, cell[:, 2])
                    # match ``max(values, key=count)``: greatest count, ties
                    # broken by earliest insertion (smallest first-seen index).
                    cand = _np.nonzero(counts == counts.max())[0]
                    win = int(cand[_np.argmin(first_idx[cand])])
                    bn = int(counts[win])
                    row.append({"r": int(sr[win]) // bn, "g": int(sg[win]) // bn,
                                "b": int(sb[win]) // bn, "count": bn})
                    continue
                bins: "dict[tuple[int, int, int], list[int]]" = {}
                for yy in range(iy0, iy1):
                    base = (yy * w + ix0) * 3
                    for k in range(0, (ix1 - ix0) * 3, 3):
                        pr = rgb[base + k]
                        pg = rgb[base + k + 1]
                        pb = rgb[base + k + 2]
                        key = (pr // quant, pg // quant, pb // quant)
                        acc = bins.get(key)
                        if acc is None:
                            bins[key] = [1, pr, pg, pb]
                        else:
                            acc[0] += 1
                            acc[1] += pr
                            acc[2] += pg
                            acc[3] += pb
                best = max(bins.values(), key=lambda a: a[0])
                bn = best[0]
                row.append({"r": best[1] // bn, "g": best[2] // bn,
                            "b": best[3] // bn, "count": bn})
        grid.append(row)
    return grid


def grid_changes(prev: bytes, cur: bytes, bbox: tuple[int, int, int, int],
                 cols: int, rows: int, size: tuple[int, int],
                 inset: float = 0.25, tol: int = 0,
                 min_count: int = 1) -> list[tuple[int, int]]:
    """Return the ``(row, col)`` cells of a ``cols``x``rows`` lattice that changed
    between two captures — the per-cell :func:`locate_change` for grids (F250).

    Incremental grid games move one or a few cells per step: mines reveals a
    handful, sudoku fills one, a chess move touches two. Yet the reader
    (:func:`sample_grid` + a per-cell classify/OCR) re-reads *every* cell every
    step — for mines that is 64 OCR calls a round to learn that two cells moved,
    the dominant cost of driving the board (the round-cap stall seen live). That
    is the same waste F245/F246 cut for the pixel waiters — re-doing work on
    pixels that did not change — not yet cut for grids.

    Given the ``prev`` and ``cur`` captures (both packed RGB of ``size`` ``(w,h)``,
    e.g. two :func:`capture_patch` of the same board) and the *same*
    ``bbox``/``cols``/``rows``/``inset`` you pass :func:`sample_grid`, this
    compares only each cell's central window and returns the cells where more
    than ``min_count`` pixels differ by more than ``tol`` on any channel. The
    caller then re-classifies *only those* cells and reuses its prior reading for
    the rest. ``tol=0, min_count=1`` is exact (any single differing byte marks a
    cell); raise them to ignore a blinking cursor or anti-alias shimmer. The
    geometry — cell windows, bounds clamping, ``inset`` meaning — is identical to
    :func:`sample_grid`, so the ``(row, col)`` indices line up one-to-one; and
    like F246 each cell stops counting the instant the verdict is in
    (損之又損)."""
    if cols < 1 or rows < 1:
        raise ValueError("cols and rows must be >= 1")
    if not 0.0 <= inset < 0.5:
        raise ValueError("inset must be in [0.0, 0.5)")
    if min_count < 1:
        raise ValueError("min_count must be >= 1")
    w, h = size
    if len(prev) != len(cur):
        raise ValueError("prev and cur must be the same length")
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    changed = []
    for r in range(rows):
        cy0 = y0 + r * ch
        iy0 = int(cy0 + ch * inset)
        iy1 = int(cy0 + ch * (1.0 - inset))
        if iy1 <= iy0:
            iy1 = iy0 + 1
        iy0 = max(0, min(iy0, h - 1))
        iy1 = max(iy0 + 1, min(iy1, h))
        for c in range(cols):
            cx0 = x0 + c * cw
            ix0 = int(cx0 + cw * inset)
            ix1 = int(cx0 + cw * (1.0 - inset))
            if ix1 <= ix0:
                ix1 = ix0 + 1
            ix0 = max(0, min(ix0, w - 1))
            ix1 = max(ix0 + 1, min(ix1, w))
            n = 0
            hit = False
            for yy in range(iy0, iy1):
                base = (yy * w + ix0) * 3
                for k in range(0, (ix1 - ix0) * 3, 3):
                    if (abs(prev[base + k] - cur[base + k]) > tol
                            or abs(prev[base + k + 1] - cur[base + k + 1]) > tol
                            or abs(prev[base + k + 2] - cur[base + k + 2]) > tol):
                        n += 1
                        if n >= min_count:
                            hit = True
                            break
                if hit:
                    break
            if hit:
                changed.append((r, c))
    return changed


def ocr_grid(bbox: tuple[int, int, int, int], cols: int, rows: int,
             rgb: bytes | None = None, size: tuple[int, int] | None = None,
             inset: float = 0.18, whitelist: "str | None" = None,
             psm: int = 6, scale: int = 4, invert: "bool | str" = False,
             ink_tol: int = 50, ink_min: int = 6,
             xs: "list[int] | None" = None,
             ys: "list[int] | None" = None) -> list[list[str]]:
    """Read a ``cols``x``rows`` lattice of glyphs into a 2D array of strings, in
    one capture — the OCR grid that :func:`sample_grid` is for colour (F251).

    Reading a board of glyphs (a sudoku of digits, a chess rank of pieces, a
    mahjongg face) is a recurring need, but the floor only offered the single-
    region :func:`ocr_text` — so every caller (the sudoku and mines players both
    do) hand-rolls the *same* triple: the geometry double-loop, a per-cell
    ink/colour gate, and the ``whitelist``/``psm``/``scale`` tuning. Two costs
    repeat on every board: each caller re-derives that orchestration, and the
    naive version OCRs *every* cell — which is both slow (a sparse 9x9 sudoku is
    ~21 filled of 81, so ~60 wasted reads) and, worse, *wrong*: tesseract handed
    an empty bordered cell hallucinates a stray glyph (an empty grey sudoku cell
    reads as ``"a"``), so a reader with no gate mis-fills the board.

    This divides ``bbox`` into ``cols``x``rows`` equal cells with the *exact*
    geometry of :func:`sample_grid`/:func:`grid_changes` (same ``inset``, same
    bounds clamping, so the ``[r][c]`` indices line up one-to-one) and, for each
    cell, gates on ink before reading: it measures the cell's central window and
    counts pixels whose luminance deviates from the window mean by more than
    ``ink_tol``. A cell with fewer than ``ink_min`` such pixels is treated as
    blank — returned as ``""`` and **never sent to OCR** — which both removes the
    empty-cell hallucination and skips the dominant cost on a sparse board (the
    F250 lesson — don't read what holds nothing — applied to OCR). Only inked
    cells are passed to :func:`ocr_text` with the given ``whitelist``/``psm``/
    ``scale``/``invert``; its result is stripped and stored. Returns a
    ``rows``x``cols`` list of strings (``""`` = blank). Pass ``rgb``/``size`` to
    reuse a capture (pair with :func:`capture_patch` to read just the board).

    Two ways to place the cells. By default ``bbox`` is divided into equal cells
    (the :func:`sample_grid` convention). But a real board's pitch is rarely
    perfectly uniform — a sudoku's heavy 3x3 rules make some cells a pixel wider
    — and where colour sampling shrugs that off, an OCR crop does not: a couple
    of pixels of accumulated drift shifts a mid-board crop onto the cell edge,
    clips the glyph, and tesseract then reads *nothing*. So this also takes the
    exact column/row edges ``xs`` (``cols+1`` x-coords) and ``ys`` (``rows+1``
    y-coords) — precisely what :func:`detect_grid` returns — and when given uses
    each cell's true ``[xs[c], xs[c+1]]`` x ``[ys[r], ys[r+1]]`` box instead of
    the uniform split, so every crop is centred on its glyph. The intended
    pipeline is ``g = detect_grid(...); ocr_grid(g['bbox'], g['cols'], g['rows'],
    xs=g['xs'], ys=g['ys'], ...)``.

    The ink gate is polarity-agnostic (it measures deviation from the cell's own
    mean, so it fires for dark-on-light *and* light-on-dark without ``invert``);
    ``invert`` still controls what :func:`ocr_text` sees for the read itself.

    ``invert`` is normally a bool, applied to every cell alike. But one board can
    mix polarities *within itself* — a tetravex tile carries white digits on its
    dark triangles and black digits on its light ones, a themed grid flips ink per
    chip — and then no single bool reads them all: tesseract wants dark-on-light,
    so the wrong-polarity cells come back empty (F255). Pass ``invert="auto"`` to
    decide per cell: the gate already measured the cell's mean and its ink pixels
    (those deviating past ``ink_tol``); if that ink is *brighter* than the mean the
    glyph is light-on-dark, so the cell is read inverted, otherwise upright — and
    if the chosen polarity reads nothing, the opposite is tried before giving up.
    So a mixed-polarity board reads in one call without the caller pre-sorting
    cells by colour."""
    if cols < 1 or rows < 1:
        raise ValueError("cols and rows must be >= 1")
    if not 0.0 <= inset < 0.5:
        raise ValueError("inset must be in [0.0, 0.5)")
    if ink_min < 1:
        raise ValueError("ink_min must be >= 1")
    auto = isinstance(invert, str)
    if auto and invert != "auto":
        raise ValueError("invert must be a bool or \"auto\"")
    if xs is not None and len(xs) != cols + 1:
        raise ValueError(f"xs must have cols+1={cols + 1} entries, got {len(xs)}")
    if ys is not None and len(ys) != rows + 1:
        raise ValueError(f"ys must have rows+1={rows + 1} entries, got {len(ys)}")
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    grid = []
    for r in range(rows):
        # cell's vertical span: exact edges when ys given, else uniform split.
        ry0 = float(ys[r]) if ys is not None else y0 + r * ch
        rh = (ys[r + 1] - ys[r]) if ys is not None else ch
        iy0 = int(ry0 + rh * inset)
        iy1 = int(ry0 + rh * (1.0 - inset))
        if iy1 <= iy0:
            iy1 = iy0 + 1
        iy0 = max(0, min(iy0, h - 1))
        iy1 = max(iy0 + 1, min(iy1, h))
        row = []
        for c in range(cols):
            cx0 = float(xs[c]) if xs is not None else x0 + c * cw
            ccw = (xs[c + 1] - xs[c]) if xs is not None else cw
            ix0 = int(cx0 + ccw * inset)
            ix1 = int(cx0 + ccw * (1.0 - inset))
            if ix1 <= ix0:
                ix1 = ix0 + 1
            ix0 = max(0, min(ix0, w - 1))
            ix1 = max(ix0 + 1, min(ix1, w))
            # luminance of the central window — one pass for the mean, a second
            # to count pixels that deviate from it (the glyph ink).
            lums = []
            for yy in range(iy0, iy1):
                base = (yy * w + ix0) * 3
                for k in range(0, (ix1 - ix0) * 3, 3):
                    lums.append((rgb[base + k] * 299 + rgb[base + k + 1] * 587
                                 + rgb[base + k + 2] * 114) // 1000)
            n = len(lums)
            mean = sum(lums) // n if n else 0
            ink = 0
            ink_sum = 0          # luma of the deviating (ink) pixels, for auto
            for v in lums:
                if abs(v - mean) > ink_tol:
                    ink += 1
                    ink_sum += v
                    if ink >= ink_min and not auto:
                        break    # gate satisfied; auto needs the full ink stats
            if ink < ink_min:
                row.append("")
                continue
            if auto:
                # ink brighter than the cell mean => light-on-dark => read inverted.
                cell_inv = (ink_sum / ink) > mean
                text = ocr_text((ix0, iy0, ix1 - ix0, iy1 - iy0),
                                whitelist=whitelist, psm=psm, scale=scale,
                                invert=cell_inv, rgb=rgb, size=(w, h)).strip()
                if not text:     # wrong guess (or faint glyph) -> try the other
                    text = ocr_text((ix0, iy0, ix1 - ix0, iy1 - iy0),
                                    whitelist=whitelist, psm=psm, scale=scale,
                                    invert=not cell_inv, rgb=rgb, size=(w, h)).strip()
            else:
                text = ocr_text((ix0, iy0, ix1 - ix0, iy1 - iy0),
                                whitelist=whitelist, psm=psm, scale=scale,
                                invert=invert, rgb=rgb, size=(w, h)).strip()
            row.append(text)
        grid.append(row)
    return grid


def _luma_resample(rgb: bytes, w: int, ix0: int, iy0: int, ix1: int, iy1: int,
                   norm: int) -> list[int]:
    """Nearest-neighbour resample the window ``[ix0,ix1) x [iy0,iy1)`` of an RGB
    buffer ``w`` wide into a ``norm``x``norm`` flat luma vector — a cell of any
    pixel size becomes one fixed-length signature, so two cells (or a cell and a
    template) of *different* sizes are still comparable pixel-for-pixel."""
    cwid = ix1 - ix0
    chei = iy1 - iy0
    if _np is not None:
        flat = _np.frombuffer(rgb, dtype=_np.uint8)
        sy = iy0 + (_np.arange(norm) * chei) // norm
        sx = ix0 + (_np.arange(norm) * cwid) // norm
        base = (sy[:, None] * w + sx[None, :]) * 3
        r = flat[base].astype(_np.int32)
        g = flat[base + 1].astype(_np.int32)
        b = flat[base + 2].astype(_np.int32)
        return ((r * 299 + g * 587 + b * 114) // 1000).reshape(-1).tolist()
    out = []
    for j in range(norm):
        sy = iy0 + (j * chei) // norm
        rowbase = sy * w
        for i in range(norm):
            sx = ix0 + (i * cwid) // norm
            b = (rowbase + sx) * 3
            out.append((rgb[b] * 299 + rgb[b + 1] * 587 + rgb[b + 2] * 114) // 1000)
    return out


def _classify_lib(templates: "list[tuple[str, bytes, int, int]]",
                  inset: float, norm: int) -> "list[tuple[str, list[int]]]":
    """Resample each ``(label, patch, pw, ph)`` template to one ``norm``x``norm``
    luma signature, inset by the same fraction the cells are read at (so the score
    keys on the sprite, not the cell/checker shade behind it). Shared by
    :func:`classify_grid` and :func:`classify_boxes`; validates each template."""
    if not templates:
        raise ValueError("templates must be a non-empty list of (label, patch, pw, ph)")
    lib: "list[tuple[str, list[int]]]" = []
    for t in templates:
        if len(t) != 4:
            raise ValueError("each template must be (label, patch, pw, ph)")
        label, patch, pw, ph = t
        if pw < 1 or ph < 1:
            raise ValueError("template pw and ph must be >= 1")
        if len(patch) != pw * ph * 3:
            raise ValueError(f"template '{label}' patch must be pw*ph*3={pw * ph * 3}"
                             f" bytes, got {len(patch)}")
        tx0 = int(pw * inset)
        tx1 = max(tx0 + 1, int(pw * (1.0 - inset)))
        ty0 = int(ph * inset)
        ty1 = max(ty0 + 1, int(ph * (1.0 - inset)))
        lib.append((label, _luma_resample(patch, pw, tx0, ty0, tx1, ty1, norm)))
    return lib


def _box_signature(rgb: bytes, w: int, h: int,
                   box: "tuple[float, float, float, float]",
                   inset: float, ink_tol: int, ink_min: int,
                   norm: int) -> "list[int] | None":
    """Inset-crop ``box`` to its glyph-dominated centre, gate on ink, and return
    its ``norm``x``norm`` luma signature — or ``None`` when the box is blank
    (fewer than ``ink_min`` pixels deviating more than ``ink_tol`` from its own
    mean). The crop / inset / ink-gate / resample shared by :func:`_classify_box`
    (match against a library) and :func:`cluster_boxes` (group with no library),
    so a box that is clustered and one that is classified are measured from the
    exact same pixels."""
    bx0, by0, bx1, by1 = box
    bw = bx1 - bx0
    bh = by1 - by0
    ix0 = int(bx0 + bw * inset)
    ix1 = int(bx0 + bw * (1.0 - inset))
    if ix1 <= ix0:
        ix1 = ix0 + 1
    ix0 = max(0, min(ix0, w - 1))
    ix1 = max(ix0 + 1, min(ix1, w))
    iy0 = int(by0 + bh * inset)
    iy1 = int(by0 + bh * (1.0 - inset))
    if iy1 <= iy0:
        iy1 = iy0 + 1
    iy0 = max(0, min(iy0, h - 1))
    iy1 = max(iy0 + 1, min(iy1, h))
    if _np is not None:
        reg = (_np.frombuffer(rgb, dtype=_np.uint8).reshape(-1, w, 3)
               [iy0:iy1, ix0:ix1].astype(_np.int32))
        lum = (reg[:, :, 0] * 299 + reg[:, :, 1] * 587
               + reg[:, :, 2] * 114) // 1000
        n = lum.size
        mean = int(lum.sum()) // n if n else 0
        # the loop's early break only affects speed, not the ink < ink_min gate
        ink = int((_np.abs(lum - mean) > ink_tol).sum())
        if ink < ink_min:
            return None
        return _luma_resample(rgb, w, ix0, iy0, ix1, iy1, norm)
    lums = []
    for yy in range(iy0, iy1):
        base = (yy * w + ix0) * 3
        for k in range(0, (ix1 - ix0) * 3, 3):
            lums.append((rgb[base + k] * 299 + rgb[base + k + 1] * 587
                         + rgb[base + k + 2] * 114) // 1000)
    n = len(lums)
    mean = sum(lums) // n if n else 0
    ink = 0
    for v in lums:
        if abs(v - mean) > ink_tol:
            ink += 1
            if ink >= ink_min:
                break
    if ink < ink_min:
        return None
    return _luma_resample(rgb, w, ix0, iy0, ix1, iy1, norm)


def _classify_box(rgb: bytes, w: int, h: int,
                  box: "tuple[float, float, float, float]",
                  lib: "list[tuple[str, list[int]]]", npix: int, inset: float,
                  ink_tol: int, ink_min: int, norm: int,
                  empty_label: str, unknown_label: str,
                  max_score: "float | None") -> str:
    """Classify one cell/box against the resampled ``lib``: inset-crop, gate on
    ink (a box with fewer than ``ink_min`` pixels deviating more than ``ink_tol``
    from its own mean is blank → ``empty_label``, never scored), resample to a
    ``norm``x``norm`` luma signature and return the lowest mean-abs-diff label
    (``unknown_label`` when ``max_score`` is set and even the best exceeds it).
    The pixel core shared by :func:`classify_grid` and :func:`classify_boxes`."""
    sig = _box_signature(rgb, w, h, box, inset, ink_tol, ink_min, norm)
    if sig is None:
        return empty_label
    best = None
    best_label = unknown_label
    if _np is not None:
        sa = _np.asarray(sig, dtype=_np.int32)
        for label, tv in lib:
            s = int(_np.abs(sa - _np.asarray(tv, dtype=_np.int32)).sum())
            if best is None or s < best:
                best = s
                best_label = label
    else:
        for label, tv in lib:
            s = 0
            for a, b in zip(sig, tv):
                d = a - b
                s += d if d >= 0 else -d
            if best is None or s < best:
                best = s
                best_label = label
    if max_score is not None and best is not None and best / npix > max_score:
        return unknown_label
    return best_label


def classify_grid(bbox: tuple[int, int, int, int], cols: int, rows: int,
                  templates: "list[tuple[str, bytes, int, int]]",
                  rgb: bytes | None = None, size: tuple[int, int] | None = None,
                  inset: float = 0.18, ink_tol: int = 50, ink_min: int = 6,
                  norm: int = 32, empty_label: str = "", unknown_label: str = "?",
                  max_score: "float | None" = None,
                  xs: "list[int] | None" = None,
                  ys: "list[int] | None" = None) -> list[list[str]]:
    """Classify a ``cols``x``rows`` lattice of *sprites* against a labelled
    template library — the grid that :func:`match_template` is for one patch, and
    the appearance counterpart of :func:`ocr_grid` (which reads text) and
    :func:`sample_grid` (which reads colour) (F252).

    Some boards are neither colour nor text. A chess square is a vector glyph, a
    mahjongg face a tile picture, a minesweeper cell an icon: :func:`sample_grid`
    sees only that a piece is *present* and its shade (a black rook and a black
    queen sample to the *same* luma, so colour cannot tell type), and
    :func:`ocr_grid` reads nothing from a non-text glyph. The floor had only the
    single-patch :func:`match_template`, which *locates* one sprite — so reading a
    whole board means hand-rolling the same per-cell loop: crop the cell, score it
    against every candidate sprite, take the best, and gate out the empties.

    This divides ``bbox`` with the *exact* geometry of :func:`sample_grid`/
    :func:`ocr_grid` (same ``inset``, same bounds clamping, optional exact ``xs``/
    ``ys`` edges from :func:`detect_grid`, so the ``[r][c]`` indices line up
    one-to-one) and, for each cell: gates on ink exactly as :func:`ocr_grid` does
    (a cell with fewer than ``ink_min`` pixels deviating more than ``ink_tol``
    from its own mean is blank → ``empty_label``, never scored), then resamples
    the cell to a ``norm``x``norm`` luma signature and scores it against each
    template by mean-absolute-difference *per pixel*. Resampling to a fixed size
    is what makes the score comparable across templates (and cells) of unequal
    pixel size — a raw SAD favours whichever sprite happens to cover fewer pixels,
    and on an uneven ``xs``/``ys`` pitch no two cells are the same size. The
    lowest mean-diff label wins; if ``max_score`` is set and even the best exceeds
    it the cell is ``unknown_label`` (so an unexpected sprite — a highlighted
    square, a piece mid-animation — is flagged, not silently mislabelled).

    ``templates`` is a list of ``(label, patch, pw, ph)`` where ``patch`` is a
    ``pw*ph`` RGB buffer in the same format :func:`match_template` takes — the
    idiom is to harvest them once from a known frame (the chess start position
    gives all twelve pieces at known squares) by cropping cells with
    :func:`capture_patch`/:func:`crop_rgb`, then classify every later board with
    one call. Returns a ``rows``x``cols`` list of labels."""
    if cols < 1 or rows < 1:
        raise ValueError("cols and rows must be >= 1")
    if not 0.0 <= inset < 0.5:
        raise ValueError("inset must be in [0.0, 0.5)")
    if ink_min < 1:
        raise ValueError("ink_min must be >= 1")
    if norm < 1:
        raise ValueError("norm must be >= 1")
    if not templates:
        raise ValueError("templates must be a non-empty list of (label, patch, pw, ph)")
    if max_score is not None and max_score < 0:
        raise ValueError("max_score must be >= 0 or None")
    if xs is not None and len(xs) != cols + 1:
        raise ValueError(f"xs must have cols+1={cols + 1} entries, got {len(xs)}")
    if ys is not None and len(ys) != rows + 1:
        raise ValueError(f"ys must have rows+1={rows + 1} entries, got {len(ys)}")
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    # Resample every template to the same norm x norm luma signature, once: the
    # central window is glyph-dominated, so the score keys on the sprite, not the
    # checker/background shade behind it (a bishop on a light square must still
    # match a bishop harvested from a dark one).
    lib = _classify_lib(templates, inset, norm)
    npix = norm * norm
    x0, y0, x1, y1 = bbox
    cw = (x1 - x0 + 1) / cols
    ch = (y1 - y0 + 1) / rows
    grid = []
    for r in range(rows):
        ry0 = float(ys[r]) if ys is not None else y0 + r * ch
        rh = (ys[r + 1] - ys[r]) if ys is not None else ch
        row = []
        for c in range(cols):
            cx0 = float(xs[c]) if xs is not None else x0 + c * cw
            ccw = (xs[c + 1] - xs[c]) if xs is not None else cw
            row.append(_classify_box(rgb, w, h, (cx0, ry0, cx0 + ccw, ry0 + rh),
                                     lib, npix, inset, ink_tol, ink_min, norm,
                                     empty_label, unknown_label, max_score))
        grid.append(row)
    return grid


def classify_boxes(boxes: "list[tuple[int, int, int, int]]",
                   templates: "list[tuple[str, bytes, int, int]]",
                   rgb: bytes | None = None, size: tuple[int, int] | None = None,
                   inset: float = 0.18, ink_tol: int = 50, ink_min: int = 6,
                   norm: int = 32, empty_label: str = "", unknown_label: str = "?",
                   max_score: "float | None" = None) -> list[str]:
    """Classify a *list of arbitrary boxes* against a labelled template library —
    the lattice-free sibling of :func:`classify_grid` (F254).

    :func:`classify_grid` reads a sprite board only when it is a ``cols``x``rows``
    *lattice*. Many boards are not: a mahjongg layout is tiles stacked in offset
    3-D layers, a freecell/klondike spread is cards at ragged depths, a diffed
    frame yields change regions wherever they fell. The boxes are already in hand
    — from :func:`find_color_blobs` (segment the tile faces), :func:`detect_cascade`
    (the ``faceup`` box per pile), :func:`locate_change_blobs` (each changed
    region) — but to *read* them every caller re-rolls the same :func:`match_template`
    loop classify_grid already owns (crop, ink-gate, resample, argmin, threshold).
    This is that loop over an explicit box list: ``detect_*`` answers *where* the
    things are, ``classify_boxes`` answers *what* each one is.

    Scoring is identical to :func:`classify_grid` (they share the same core), so a
    library harvested once classifies both a lattice and a scatter: each box is
    inset by ``inset``, gated on ink (fewer than ``ink_min`` pixels deviating more
    than ``ink_tol`` from the box mean → ``empty_label``, never scored), resampled
    to a ``norm``x``norm`` luma signature and given the lowest mean-abs-diff label,
    or ``unknown_label`` when ``max_score`` is set and even the best exceeds it.
    ``boxes`` are *inclusive* ``(x0, y0, x1, y1)`` in screen coordinates — exactly
    the ``bbox`` :func:`find_color_blobs`/:func:`locate_change_blobs` return and
    :func:`crop_rgb` harvests templates from, so a box segmented one frame and its
    library harvested another line up to the pixel (a 1-px frame mismatch shifts a
    sharp glyph enough to fail its own self-match). Returns one label per box, in
    input order — empty ``boxes`` returns ``[]``."""
    if not 0.0 <= inset < 0.5:
        raise ValueError("inset must be in [0.0, 0.5)")
    if ink_min < 1:
        raise ValueError("ink_min must be >= 1")
    if norm < 1:
        raise ValueError("norm must be >= 1")
    if max_score is not None and max_score < 0:
        raise ValueError("max_score must be >= 0 or None")
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    lib = _classify_lib(templates, inset, norm)
    npix = norm * norm
    out = []
    for box in boxes:
        if len(box) != 4:
            raise ValueError("each box must be (x0, y0, x1, y1)")
        bx0, by0, bx1, by1 = box
        # inclusive box -> half-open rect, so the inset window matches the one
        # _classify_lib takes over a crop_rgb patch (also inclusive) pixel-for-pixel.
        out.append(_classify_box(rgb, w, h, (bx0, by0, bx1 + 1, by1 + 1), lib,
                                 npix, inset, ink_tol, ink_min, norm,
                                 empty_label, unknown_label, max_score))
    return out


def cluster_boxes(boxes: "list[tuple[int, int, int, int]]",
                  rgb: bytes | None = None, size: tuple[int, int] | None = None,
                  inset: float = 0.18, ink_tol: int = 50, ink_min: int = 6,
                  norm: int = 32, max_score: float = 32.0,
                  blank: int = -1) -> list[int]:
    """Group a list of boxes into discovered visual classes with *no* template
    library — the unsupervised sibling of :func:`classify_boxes` (F256).

    :func:`classify_boxes`/:func:`classify_grid` answer *what* each box is, but
    only once you have harvested a labelled template per class. On a board whose
    alphabet you do not know in advance you cannot: a mid-game chess position, an
    unfamiliar mahjongg tileset, the change-regions of a never-seen game offer no
    known frame to crop labels from. Yet you can still ask the cheaper question
    the library hand-rolling was answering all along — *which of these boxes look
    the same?* — and that needs no labels at all. (F254 already hand-rolled this
    inline for mahjongg: seed a library on first sight, start a new entry when the
    best match exceeds a radius. This is that leader-clustering loop made a
    primitive, so the next board need not re-roll it.)

    Each box is measured by the exact pixel core of :func:`classify_boxes` — shared
    via :func:`_box_signature`: inset to the glyph-dominated centre, gate on ink,
    resample to a ``norm``x``norm`` luma signature — so clustering boxes and later
    classifying the same boxes agree pixel-for-pixel. The boxes are then grouped by
    single-pass *leader clustering*: each box joins the nearest existing cluster
    whose exemplar is within ``max_score`` mean-absolute-difference per pixel, else
    it founds a new cluster (and becomes that cluster's exemplar). Cluster ids are
    assigned in order of first appearance — the first non-blank box is cluster 0 —
    so the result is deterministic and order-stable. A blank box (gated out before
    scoring, exactly as in :func:`classify_boxes`) is ``blank`` (default ``-1``),
    never clustered.

    ``max_score`` is the merge radius, in the same luma units as the
    :func:`classify_boxes` threshold (mean-abs-diff per pixel, 0–255): too small
    over-splits a class on incidental variation (the same chess piece on a light vs
    a dark square), too large merges distinct classes — there is normally a wide
    plateau between, and the exemplar-not-centroid rule keeps a cluster anchored to
    a real box rather than drifting as members accrue. ``boxes`` are *inclusive*
    ``(x0, y0, x1, y1)`` exactly as :func:`classify_boxes` takes. Returns one
    cluster id per box, in input order — empty ``boxes`` returns ``[]``."""
    if not 0.0 <= inset < 0.5:
        raise ValueError("inset must be in [0.0, 0.5)")
    if ink_min < 1:
        raise ValueError("ink_min must be >= 1")
    if norm < 1:
        raise ValueError("norm must be >= 1")
    if max_score < 0:
        raise ValueError("max_score must be >= 0")
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    npix = norm * norm
    exemplars: "list[list[int]]" = []
    out = []
    for box in boxes:
        if len(box) != 4:
            raise ValueError("each box must be (x0, y0, x1, y1)")
        bx0, by0, bx1, by1 = box
        # inclusive box -> half-open rect, matching classify_boxes pixel-for-pixel.
        sig = _box_signature(rgb, w, h, (bx0, by0, bx1 + 1, by1 + 1),
                             inset, ink_tol, ink_min, norm)
        if sig is None:
            out.append(blank)
            continue
        best = None
        best_i = -1
        for i, ex in enumerate(exemplars):
            s = 0
            for a, b in zip(sig, ex):
                d = a - b
                s += d if d >= 0 else -d
            if best is None or s < best:
                best = s
                best_i = i
        if best is not None and best / npix <= max_score:
            out.append(best_i)
        else:
            exemplars.append(sig)
            out.append(len(exemplars) - 1)
    return out


def label_regions(grid: "list[list]", background=None,
                  connectivity: int = 4) -> list[dict]:
    """Group a grid of cell labels into connected regions of equal label — the
    *labels → objects* layer that every reader feeds into (F258).

    The readers all answer "what is in each cell": :func:`sample_grid` a colour,
    :func:`ocr_grid` text, :func:`classify_grid` a sprite name. But a *thing* in a
    game is rarely one cell — a swell-foop move is a whole **connected group** of
    same-colour tiles, a klotski piece spans several cells, a flood-opened pocket
    in mines is a blob, a settled tetromino is four joined cells. The question
    after reading is therefore not "what is this cell" but "**which cells are the
    same object**", and the floor had no primitive for it: each game hand-rolled
    the identical flood fill over a reader's output. This is that flood fill, made
    a primitive — it consumes any reader's ``rows``x``cols`` label grid and
    returns its objects, so the perception splits cleanly into *read the cells*
    (a reader) then *assemble the cells into objects* (this).

    ``grid`` is a rectangular list of rows of hashable labels (the exact shape a
    reader returns; map a :func:`sample_grid` colour to a label first, e.g. snap
    to the nearest palette name). Returns a list of regions, each a
    ``{label, cells, size, bbox}`` where ``cells`` is the region's ``(r, c)``
    coordinates (row-major within the region, so ``cells[0]`` is a safe click
    target for any shape, unlike a bbox centre on an L), ``size`` is ``len(cells)``
    and ``bbox`` is the inclusive ``(r0, c0, r1, c1)``. Regions are ordered by
    first appearance in a row-major scan (deterministic). A label in
    ``background`` — one label, or a set/list of them — is never grouped (a
    swell-foop board with cleared cells, a mines board's covered cells); pass
    ``None`` to group every label. ``connectivity`` is 4 (orthogonal neighbours)
    or 8 (also diagonals — a five-or-more diagonal line, a chess king's reach)."""
    if not isinstance(grid, list) or not grid:
        raise ValueError("grid must be a non-empty list of rows")
    rows = len(grid)
    cols = len(grid[0])
    if cols == 0 or any(len(row) != cols for row in grid):
        raise ValueError("grid rows must be non-empty and of equal length")
    if connectivity not in (4, 8):
        raise ValueError("connectivity must be 4 or 8")
    if background is None:
        bg: set = set()
    elif isinstance(background, (set, list, tuple)):
        bg = set(background)
    else:
        bg = {background}
    if connectivity == 4:
        nbrs = ((-1, 0), (1, 0), (0, -1), (0, 1))
    else:
        nbrs = ((-1, 0), (1, 0), (0, -1), (0, 1),
                (-1, -1), (-1, 1), (1, -1), (1, 1))
    seen = [[False] * cols for _ in range(rows)]
    regions = []
    for sr in range(rows):
        for sc in range(cols):
            if seen[sr][sc]:
                continue
            label = grid[sr][sc]
            seen[sr][sc] = True
            if label in bg:
                continue
            # Flood the connected same-label cells with an explicit stack (a
            # board can be larger than the recursion limit).
            cells = [(sr, sc)]
            stack = [(sr, sc)]
            r0 = r1 = sr
            c0 = c1 = sc
            while stack:
                r, c = stack.pop()
                for dr, dc in nbrs:
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < rows and 0 <= nc < cols and not seen[nr][nc] \
                            and grid[nr][nc] == label:
                        seen[nr][nc] = True
                        cells.append((nr, nc))
                        stack.append((nr, nc))
                        if nr < r0:
                            r0 = nr
                        elif nr > r1:
                            r1 = nr
                        if nc < c0:
                            c0 = nc
                        elif nc > c1:
                            c1 = nc
            cells.sort()
            regions.append({"label": label, "cells": cells, "size": len(cells),
                            "bbox": (r0, c0, r1, c1)})
    return regions


_LINE_DIRS = {"h": (0, 1), "v": (1, 0), "d": (1, 1), "a": (1, -1)}


def line_runs(grid: "list[list]", background=None, min_len: int = 2,
              directions: "tuple[str, ...]" = ("h", "v", "d", "a")) -> list[dict]:
    """Find maximal straight runs of equal label along the grid's axes — the
    *N-in-a-row* predicate every line game's win/threat test reduces to (F259).

    :func:`label_regions` (F258) answers "which cells are one *blob*", but a blob
    is the wrong shape for the games whose whole rule is a **straight line**:
    connect-four wins on four collinear, gomoku / five-or-more on five, tic-tac-toe
    on three, and the F258 lesson itself punted "is this group a collinear run" back
    to the caller. Connected-components cannot answer it — eight-connectivity lumps
    a horizontal three, the diagonal touching it and the stack above into one blob
    and reports neither line; the run is a property of a *direction*, not of mere
    adjacency. Every line game therefore re-implemented the same four-axis scan over
    a reader's label grid. This is that scan, made a primitive.

    ``grid`` is a rectangular list of rows of hashable labels (the exact shape a
    reader returns; snap a :func:`sample_grid` colour to a palette label first).
    For each requested axis it returns every **maximal** run of two-or-more equal,
    non-``background`` cells — maximal meaning it cannot be extended at either end,
    so each run is reported once and never as a sub-run of a longer one. A run is a
    ``{label, cells, length, direction, start, end}`` where ``cells`` is ordered
    along the axis (``cells[0] == start``, ``cells[-1] == end``, each a ``(r, c)``),
    so a connect-four threat is just ``length >= 3`` and a win ``length >= 4`` with
    no extra geometry. Runs are ordered by ``directions`` first, then by ``start``
    row-major (deterministic).

    A label in ``background`` — one label, or a set/list — never forms a run (the
    empty cells of a board); pass ``None`` to run over every label. ``min_len``
    (default 2) is the shortest run kept — set it to the win length to get only
    wins, or to 1 to keep singletons. ``directions`` is any subset of ``"h"``
    (horizontal →), ``"v"`` (vertical ↓), ``"d"`` (diagonal ↘) and ``"a"``
    (anti-diagonal ↙), in the order you want them reported."""
    if not isinstance(grid, list) or not grid:
        raise ValueError("grid must be a non-empty list of rows")
    rows = len(grid)
    cols = len(grid[0])
    if cols == 0 or any(len(row) != cols for row in grid):
        raise ValueError("grid rows must be non-empty and of equal length")
    if min_len < 1:
        raise ValueError("min_len must be >= 1")
    if not directions:
        raise ValueError("directions must name at least one axis")
    for d in directions:
        if d not in _LINE_DIRS:
            raise ValueError("directions must be a subset of 'h','v','d','a'")
    if background is None:
        bg: set = set()
    elif isinstance(background, (set, list, tuple)):
        bg = set(background)
    else:
        bg = {background}
    out = []
    for d in directions:
        dr, dc = _LINE_DIRS[d]
        for sr in range(rows):
            for sc in range(cols):
                label = grid[sr][sc]
                if label in bg:
                    continue
                # Only a run's first cell starts it: the cell one step back along
                # the axis must be off-grid or a different label — so each maximal
                # run is found exactly once, never as a sub-run of a longer one.
                pr, pc = sr - dr, sc - dc
                if 0 <= pr < rows and 0 <= pc < cols and grid[pr][pc] == label:
                    continue
                cells = [(sr, sc)]
                r, c = sr + dr, sc + dc
                while 0 <= r < rows and 0 <= c < cols and grid[r][c] == label:
                    cells.append((r, c))
                    r, c = r + dr, c + dc
                if len(cells) >= min_len:
                    out.append({"label": label, "cells": cells,
                                "length": len(cells), "direction": d,
                                "start": cells[0], "end": cells[-1]})
    return out


def detect_grid(search: tuple[int, int, int, int],
                rgb: bytes | None = None, size: tuple[int, int] | None = None,
                stride: int = 2, k: float = 0.8, pmin: int = 8, tol: int = 5,
                min_cells: int = 3) -> dict | None:
    """Find a regular lattice — origin, cell pitch, and *how many* cells —
    inside ``search``, the companion that feeds :func:`sample_grid` (F248).

    :func:`sample_grid` answers "what is in every cell" but must be *told* the
    lattice (``bbox``, ``cols``, ``rows``). Every ruled-grid game re-derives that
    by hand with screen-specific magic — sudoku scans fixed pixel ranges for dark
    box-borders and hard-codes ``/9``; a generic table/board has nowhere to turn.
    The recurring structure a ruled grid actually presents is *periodic edges*:
    its cell separators are equally spaced lines, so the per-column / per-row edge
    energy spikes at every boundary. This finds those boundaries and fits the
    longest evenly-spaced chain through them — the lattice votes as one comb while
    stray edges (a digit, a glyph) fall off the comb and are skipped — then reads
    the cell count straight out of the chain length instead of assuming it.

    Returns ``{'bbox':(x0,y0,x1,y1), 'cols', 'rows', 'cw', 'ch', 'xs', 'ys'}`` —
    feed ``bbox``/``cols``/``rows`` straight to :func:`sample_grid` — or ``None``
    when no regular lattice of at least ``min_cells`` per axis is present.

    Scope (honest): this keys on the *separators* being the dominant periodic
    edge, which holds for ruled grids — sudoku, spreadsheets, calendars, go /
    bordered boards. It is **not** the tool for boards whose cells carry no
    separators (a Tetris well — find its bbox by colour) or where cell *content*
    out-weighs the lines (a chess mid-game, pieces drowning the rank/file edges);
    those supply geometry another way and pass their known dims to sample_grid.
    Pass ``rgb``/``size`` to reuse a capture; ``search`` narrows the scan (F240)."""
    x0, y0, x1, y1 = search
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    x0 = max(1, x0); y0 = max(1, y0); x1 = min(x1, w - 1); y1 = min(y1, h - 1)
    if x1 - x0 < 2 * pmin or y1 - y0 < 2 * pmin:
        return None

    def _lum(j: int) -> int:
        return (rgb[j] * 299 + rgb[j + 1] * 587 + rgb[j + 2] * 114) // 1000

    def _boundaries(axis: str) -> list[int]:
        # edge energy per line: |Δluma| across the boundary, summed over the
        # other axis (strided), then peaks (mean + k·std) clustered to centres.
        prof = []
        if axis == "x":
            for x in range(x0, x1 + 1):
                s = 0
                for y in range(y0, y1, stride):
                    base = (y * w + x) * 3
                    s += abs(_lum(base) - _lum(base - 3))
                prof.append((x, s))
        else:
            row = w * 3
            for y in range(y0, y1 + 1):
                s = 0
                for x in range(x0, x1, stride):
                    base = (y * w + x) * 3
                    s += abs(_lum(base) - _lum(base - row))
                prof.append((y, s))
        vals = [v for _, v in prof]
        n = len(vals)
        mean = sum(vals) / n
        var = sum((v - mean) ** 2 for v in vals) / n
        thr = mean + k * (var ** 0.5)
        peaks = [p for p, v in prof if v > thr]
        runs: list[list[int]] = []
        for i in peaks:
            if runs and i - runs[-1][-1] <= 3:
                runs[-1].append(i)
            else:
                runs.append([i])
        return [sum(r) // len(r) for r in runs]

    def _chain(c: list[int]) -> list[int]:
        # longest arithmetic progression (common difference within tol) through
        # the boundary candidates: the real lattice, robust to off-comb strays.
        best: list[int] = []
        for i in range(len(c)):
            for j in range(i + 1, len(c)):
                p = c[j] - c[i]
                if p < pmin:
                    continue
                chain = [c[i], c[j]]
                expect = c[j] + p
                for ct in c[j + 1:]:
                    if abs(ct - expect) <= tol:
                        chain.append(ct)
                        expect = ct + p
                    elif ct > expect + tol:
                        break
                if len(chain) > len(best):
                    best = chain
        return best

    xs, ys = _chain(_boundaries("x")), _chain(_boundaries("y"))
    if len(xs) - 1 < min_cells or len(ys) - 1 < min_cells:
        return None
    cols, rows = len(xs) - 1, len(ys) - 1
    return {"bbox": (xs[0], ys[0], xs[-1], ys[-1]),
            "cols": cols, "rows": rows,
            "cw": (xs[-1] - xs[0]) / cols, "ch": (ys[-1] - ys[0]) / rows,
            "xs": xs, "ys": ys}


def detect_cascade(search: tuple[int, int, int, int], cols: int,
                   rgb: bytes | None = None, size: tuple[int, int] | None = None,
                   xs: list[int] | None = None, bg: tuple[int, int, int] | None = None,
                   bg_tol: int = 60, fill: float = 0.5, gap: int = 6,
                   card_h: int | None = None, pitch: int | None = None,
                   inset: float = 0.18) -> dict | None:
    """Locate, per column, the **face-up (bottom) card** of an *overlapping*
    cascade pile — the thing you actually read and click — which
    :func:`detect_grid`'s uniform lattice cannot represent.

    :func:`detect_grid` answers ruled grids whose cells tile a rectangle at one
    pitch. A solitaire tableau is the opposite shape: ``cols`` piles of cards
    that *overlap* and run to *different* depths (one pile holds 1 card, another
    7), only the bottom card of each fully shown. Forcing a lattice on it yields
    a phantom ``cols × maxdepth`` grid whose cells mostly miss real cards, so
    every cascade game hand-rolls its own pile walk.

    Trying to segment *every* overlapped card is theme-brittle (back patterns and
    court-card frames mimic card-top lines). The robust invariant is coarser and
    enough: a pile is one **contiguous non-felt run** (cards touch, no felt
    between), so per column the run's top/bottom are unambiguous, and the
    **face-up card is the bottom ``card_h`` px** of that run (it is drawn on top,
    fully visible — felt lies just below it). Depth needn't be segmented: piles
    that differ by one card differ in height by one overlap ``pitch``, so
    ``depth ≈ round((height − card_h) / pitch) + 1``. With neither known they are
    inferred from the columns themselves — ``card_h`` = the shortest pile (a lone
    face-up card) and ``pitch`` = the modal positive gap between sorted pile
    heights — so a fresh deal needs no magic numbers.

    Per column returns ``{'present', 'top', 'bottom', 'height', 'depth',
    'faceup':(x0,y0,x1,y1)}`` (``faceup`` is the bottom card's clickable/readable
    box); plus top-level ``{'cols', 'xs', 'bg', 'card_h', 'pitch', 'cells':[...]}``
    — or ``None`` when ``search`` is degenerate. ``xs`` (e.g. straight from
    :func:`detect_grid`) reuses known column edges, else columns evenly split
    ``search``; ``bg`` defaults to the modal colour over ``search`` (the felt
    dominates the area). A row counts as card when ``>= fill`` of an inset centre
    band differs from ``bg`` by more than ``bg_tol``; runs bridge up to ``gap``
    felt rows so a thin separator never splits a pile, and the *longest* run per
    column is taken (a detached status bar / score line is ignored)."""
    x0, y0, x1, y1 = search
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    if cols < 1:
        raise ValueError("cols must be >= 1")
    x0 = max(0, x0); y0 = max(0, y0); x1 = min(x1, w - 1); y1 = min(y1, h - 1)
    if x1 - x0 < cols or y1 - y0 < 4:
        return None

    def _px(x: int, y: int) -> tuple[int, int, int]:
        j = (y * w + x) * 3
        return rgb[j], rgb[j + 1], rgb[j + 2]

    if xs is None:
        xs = [x0 + round(c * (x1 - x0) / cols) for c in range(cols + 1)]
    if len(xs) != cols + 1:
        raise ValueError("xs must hold cols+1 edges")

    if bg is None:
        # modal quantised colour over a strided sample: the felt dominates area
        hist: dict[tuple[int, int, int], int] = {}
        for y in range(y0, y1 + 1, 4):
            for x in range(x0, x1 + 1, 4):
                r, g, b = _px(x, y)
                q = (r >> 4, g >> 4, b >> 4)
                hist[q] = hist.get(q, 0) + 1
        qr, qg, qb = max(hist, key=hist.get)
        bg = (qr << 4 | 8, qg << 4 | 8, qb << 4 | 8)

    def _unlike_bg(r: int, g: int, b: int) -> bool:
        return abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > bg_tol

    def _pile(c: int) -> tuple[int, int] | None:
        # the column's longest contiguous card run (felt rows < gap bridged)
        a, b = xs[c], xs[c + 1]
        pad = int((b - a) * inset)
        bxa, bxb = a + pad, b - pad
        if bxb - bxa < 2:
            bxa, bxb = a, b
        step = max(1, (bxb - bxa) // 24)
        cols_n = len(range(bxa, bxb, step))
        runs: list[list[int]] = []
        miss = gap + 1
        for y in range(y0, y1 + 1):
            card = sum(1 for x in range(bxa, bxb, step)
                       if _unlike_bg(*_px(x, y))) / cols_n >= fill
            if card:
                if miss > gap:
                    runs.append([y, y])
                else:
                    runs[-1][1] = y
                miss = 0
            else:
                miss += 1
        if not runs:
            return None
        return tuple(max(runs, key=lambda r: r[1] - r[0]))

    piles = [_pile(c) for c in range(cols)]
    heights = sorted(p[1] - p[0] + 1 for p in piles if p)
    if card_h is None:
        card_h = heights[0] if heights else 0
    if pitch is None:
        diffs: dict[int, int] = {}
        for i in range(1, len(heights)):
            d = heights[i] - heights[i - 1]
            if d > 0:
                diffs[d] = diffs.get(d, 0) + 1
        pitch = max(diffs, key=diffs.get) if diffs else (card_h or 1)
    pitch = max(1, pitch)

    cells = []
    for c in range(cols):
        p = piles[c]
        if not p:
            cells.append({"present": False, "top": None, "bottom": None,
                          "height": 0, "depth": 0, "faceup": None})
            continue
        top, bottom = p
        height = bottom - top + 1
        depth = max(1, round((height - card_h) / pitch) + 1)
        fy0 = max(top, bottom - card_h + 1)
        cells.append({"present": True, "top": top, "bottom": bottom,
                      "height": height, "depth": depth,
                      "faceup": (xs[c], fy0, xs[c + 1], bottom)})

    return {"cols": cols, "xs": xs, "bg": bg,
            "card_h": card_h, "pitch": pitch, "cells": cells}


def locate_change(before: bytes, after: bytes, size: tuple[int, int],
                  tol: int = 12, min_count: int = 30,
                  search: tuple[int, int, int, int] | None = None) -> dict | None:
    """Find *where* the screen changed between two captures (F135).

    ``find_color`` needs the colour, ``locate_phrase`` needs the words — both
    require knowing the target in advance. But after an action the thing that
    appears is often unknown in both: a toast slides in at an unpredictable
    corner, a badge lights up somewhere on a toolbar, a newly-selected row
    highlights. You don't know its colour or text, only that *something* arrived.
    This diffs ``before`` against ``after`` pixel-by-pixel (per-channel ``tol``,
    so it ignores render noise the way :func:`region_diff` does) and returns the
    centroid and bounding box of the changed pixels — ``{x, y, count, bbox}`` in
    *screen* coordinates, exactly what :func:`click` consumes — or ``None`` if
    nothing changed past ``min_count`` pixels. It closes the loop the read stack
    left open: act, see *where* the world answered, then act there — without ever
    naming the target. The localiser to :func:`region_diff`'s counter.

    ``search`` (F242): an optional ``(minx, miny, maxx, maxy)`` window (screen
    coordinates, clamped to the capture) to diff, mirroring :func:`find_color`.
    A live GUI answers an action in more places than the one you care about —
    after a chess move the board's two squares change, but so do the status line,
    the move-history list and the title; whole-frame change folds them all into
    one centroid. Bound the diff to the region that matters and only its change
    is reported — the *narrow-the-field-first* discipline F240 gave colour."""
    w, h = size
    if len(before) != len(after):
        raise ValueError("captures differ in size")
    if search is None:
        bx0, by0, bx1, by1 = 0, 0, w - 1, h - 1
    else:
        bx0, by0, bx1, by1 = search
        bx0, by0 = max(0, bx0), max(0, by0)
        bx1, by1 = min(w - 1, bx1), min(h - 1, by1)
    if _np is not None:
        fb = _np.frombuffer(before, dtype=_np.uint8).reshape(h, w, 3)[by0:by1 + 1, bx0:bx1 + 1].astype(_np.int16)
        fa = _np.frombuffer(after, dtype=_np.uint8).reshape(h, w, 3)[by0:by1 + 1, bx0:bx1 + 1].astype(_np.int16)
        mask = (_np.abs(fa - fb) > tol).any(axis=2)
        n = int(mask.sum())
        if n < min_count:
            return None
        ys, xs = _np.nonzero(mask)
        xs = xs + bx0
        ys = ys + by0
        return {"x": int(xs.sum()) // n, "y": int(ys.sum()) // n, "count": n,
                "bbox": (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))}
    sx = sy = n = 0
    minx = miny = 1 << 30
    maxx = maxy = -1
    stride = w * 3
    for y in range(by0, by1 + 1):
        row = y * stride
        for x in range(bx0, bx1 + 1):
            i = row + x * 3
            if (abs(before[i] - after[i]) > tol
                    or abs(before[i + 1] - after[i + 1]) > tol
                    or abs(before[i + 2] - after[i + 2]) > tol):
                sx += x
                sy += y
                n += 1
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    if n < min_count:
        return None
    return {"x": sx // n, "y": sy // n, "count": n,
            "bbox": (minx, miny, maxx, maxy)}


def locate_change_blobs(before: bytes, after: bytes, size: tuple[int, int],
                        tol: int = 12, min_count: int = 30,
                        search: tuple[int, int, int, int] | None = None) -> list[dict]:
    """Segment screen change into its *separate* regions (F136).

    :func:`locate_change` collapses every changed pixel into one centroid — fine
    when a single thing arrives, but when two unrelated things change at once (a
    toast in one corner, a badge in another) the mean lands in the empty gap
    between them and clicks nothing. This is to :func:`locate_change` what
    :func:`find_color_blobs` is to :func:`find_color`: it labels the changed
    pixels into connected components (4-connectivity, union-find over only the
    changed pixels, so cost scales with the change's area, not the screen) and
    returns one ``{x, y, count, bbox}`` per region in *screen* coordinates,
    sorted by pixel count (largest first). Each centroid is a real, clickable
    target; regions smaller than ``min_count`` are dropped. The same friction
    (F052) once met on a static colour, now met on change itself.

    ``search`` (F242): an optional ``(minx, miny, maxx, maxy)`` window (screen
    coordinates, clamped to the capture) to segment, mirroring :func:`find_color`
    and :func:`locate_change`. Confining the diff to the region of interest is
    what makes a move *legible*: a chess move read over the whole frame returns
    the two moved squares tangled with the status line, history list and title;
    confined to the board it returns exactly the from- and to-squares — and the
    union-find runs over only the ROI's changed pixels, not the screen's."""
    w, h = size
    if len(before) != len(after):
        raise ValueError("captures differ in size")
    if search is None:
        bx0, by0, bx1, by1 = 0, 0, w - 1, h - 1
    else:
        bx0, by0, bx1, by1 = search
        bx0, by0 = max(0, bx0), max(0, by0)
        bx1, by1 = min(w - 1, bx1), min(h - 1, by1)
    stride = w * 3
    parent: dict[int, int] = {}

    def find(a: int) -> int:
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:  # path compression
            parent[a], a = root, parent[a]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    if _np is not None:
        fb = _np.frombuffer(before, dtype=_np.uint8).reshape(h, w, 3)[by0:by1 + 1, bx0:bx1 + 1].astype(_np.int16)
        fa = _np.frombuffer(after, dtype=_np.uint8).reshape(h, w, 3)[by0:by1 + 1, bx0:bx1 + 1].astype(_np.int16)
        mask = (_np.abs(fa - fb) > tol).any(axis=2)
        ys, xs = _np.nonzero(mask)  # row-major: y outer, x inner — matches the loop
        for x, y in zip((xs + bx0).tolist(), (ys + by0).tolist()):
            key = y * w + x
            parent[key] = key
            if x > 0 and (key - 1) in parent:
                union(key - 1, key)
            if y > 0 and (key - w) in parent:
                union(key - w, key)
    else:
        for y in range(by0, by1 + 1):
            row = y * stride
            base = y * w
            up_base = base - w
            for x in range(bx0, bx1 + 1):
                i = row + x * 3
                if (abs(before[i] - after[i]) > tol
                        or abs(before[i + 1] - after[i + 1]) > tol
                        or abs(before[i + 2] - after[i + 2]) > tol):
                    key = base + x
                    parent[key] = key
                    if x > 0 and (key - 1) in parent:
                        union(key - 1, key)
                    if y > 0 and (up_base + x) in parent:
                        union(up_base + x, key)

    agg: dict[int, dict] = {}
    for key in parent:
        root = find(key)
        x, y = key % w, key // w
        a = agg.get(root)
        if a is None:
            agg[root] = {"sx": x, "sy": y, "count": 1,
                         "minx": x, "miny": y, "maxx": x, "maxy": y}
        else:
            a["sx"] += x
            a["sy"] += y
            a["count"] += 1
            if x < a["minx"]:
                a["minx"] = x
            if x > a["maxx"]:
                a["maxx"] = x
            if y < a["miny"]:
                a["miny"] = y
            if y > a["maxy"]:
                a["maxy"] = y

    blobs = [{"x": a["sx"] // a["count"], "y": a["sy"] // a["count"],
              "count": a["count"],
              "bbox": (a["minx"], a["miny"], a["maxx"], a["maxy"])}
             for a in agg.values() if a["count"] >= min_count]
    blobs.sort(key=lambda b: b["count"], reverse=True)
    return blobs


def region_diff(a: bytes, b: bytes, tol: int = 0) -> dict:
    """Count how many pixels two equal-size RGB patches differ by (F134).

    ``wait_until_stable`` and ``wait_for_change`` judge sameness by exact
    byte-equality — and that is brittle. A real desktop jitters at the bottom
    bit: subpixel text rendering, a one-level antialiasing wobble, a gradient's
    dithering. A shift of ``+2`` per channel is invisible to the eye yet makes an
    exact compare report *every* pixel as changed, so "did it change?" fires on
    noise and "has it settled?" never settles. This compares ``a`` and ``b``
    pixel-by-pixel and counts those whose per-channel difference exceeds ``tol``,
    returning ``{pixels, total, frac}``. With ``tol=0`` it is the exact compare;
    raise ``tol`` to look past sensor/render noise and see only real change. It
    is the measured form of equality the two waits assumed — the foundation a
    robust change/settle test stands on.

    Fast path (F246): if ``a == b`` the two patches are byte-identical, so *no*
    pixel can differ by more than any ``tol >= 0`` — the answer is ``0`` without
    inspecting a single channel. This is exact, not an approximation, and it is
    the case the pixel waiters spend almost all their polls in: while an action
    is pending the watched region holds still, capture after capture comes back
    identical, and the bytes compare (a C-level ``memcmp``, microseconds) settles
    it instead of the ~per-pixel Python loop (tens of ms over a board-sized
    patch). Only the poll where something *actually* changed pays the full count
    — so the reported ``pixels`` stays exact while the idle polls cost nothing
    (損之又損: the diff the waits never needed to compute)."""
    if len(a) != len(b):
        raise ValueError("patches differ in size")
    total = len(a) // 3
    if a == b:
        return {"pixels": 0, "total": total, "frac": 0.0}
    if _np is not None:
        aa = _np.frombuffer(a, dtype=_np.uint8).reshape(-1, 3).astype(_np.int16)
        bb = _np.frombuffer(b, dtype=_np.uint8).reshape(-1, 3).astype(_np.int16)
        n = int((_np.abs(aa - bb) > tol).any(axis=1).sum())
        return {"pixels": n, "total": total,
                "frac": (n / total if total else 0.0)}
    n = 0
    for i in range(0, len(a), 3):
        if (abs(a[i] - b[i]) > tol or abs(a[i + 1] - b[i + 1]) > tol
                or abs(a[i + 2] - b[i + 2]) > tol):
            n += 1
    return {"pixels": n, "total": total,
            "frac": (n / total if total else 0.0)}


def wait_for_change(bbox: tuple[int, int, int, int],
                    baseline: bytes | None = None,
                    interval: float = 0.05, timeout: float = 5.0,
                    tol: int = 0, min_count: int = 1
                    ) -> dict:
    """Wait until a screen region *first differs* from a baseline (F133, F244).

    ``wait_until_stable`` waits for motion to *end*; ``wait_for_phrase`` waits for
    a *known word*. But the most common post-action wait is neither: after a
    click you often need to know merely that *something happened* — a button lit
    up, a badge appeared, a spinner began, a row got selected — without knowing
    the eventual text or colour, and before any of it has settled. Reading
    immediately races the change and sees the old frame, so the agent concludes
    nothing happened and acts twice. This captures (or accepts) a ``baseline``
    snapshot of the region, then re-captures every ``interval`` until a capture
    differs from it. Returns ``{changed, pixels, captures, elapsed}`` —
    ``changed`` is whether the onset arrived before ``timeout`` and ``pixels``
    how many differed at that moment. The idiom is
    ``baseline = crop; act(); wait_for_change(bbox, baseline)`` then optionally
    ``wait_until_stable``: catch the change beginning, then its coming to rest.
    The onset twin of ``wait_until_stable``'s cessation.

    Difference is measured through :func:`region_diff` with ``tol``/``min_count``
    (F244): the onset fires only once at least ``min_count`` pixels differ by
    more than ``tol`` per channel. The defaults ``tol=0, min_count=1`` are exact
    byte-equality — identical to the original behaviour — but raising them is
    what makes this a *meaningful*-change waiter rather than a *any-pixel* one:
    a blinking caret, a hover ring, a one-bit antialiasing wobble, or the mouse
    cursor passing through the region no longer counts as "it happened". This is
    the onset's half of the same tolerant equality :func:`region_diff` was
    written to give the waits — now ``wait_for_change`` is as robust to noise as
    ``locate_change``/``locate_change_blobs`` already are."""
    start = time.time()
    if baseline is None:
        baseline, _pw, _ph = capture_patch(bbox)
    deadline = start + timeout
    captures = 0
    while time.time() < deadline:
        patch, _pw, _ph = capture_patch(bbox)
        captures += 1
        pixels = region_diff(patch, baseline, tol=tol)["pixels"]
        if pixels >= min_count:
            return {"changed": True, "pixels": pixels, "captures": captures,
                    "elapsed": time.time() - start}
        time.sleep(interval)
    return {"changed": False, "pixels": 0, "captures": captures,
            "elapsed": time.time() - start}


def wait_for_color(target: tuple[int, int, int], tol: int = 24,
                   min_count: int = 30, interval: float = 0.05,
                   timeout: float = 5.0) -> dict | None:
    """Wait until a *specific* colour appears on screen (F139).

    ``wait_for_change`` waits for *any* difference, and that is exactly its
    weakness as a done-signal: a click usually starts a spinner, a skeleton
    shimmer, a progress bar — motion that is *not* the outcome — so the first
    change fires on the busy state and the agent proceeds as if finished. The
    real signal is often a particular colour arriving: a status dot going green,
    an error turning a field red, a toggle filling in. You cannot wait for that
    with ``wait_for_change`` (the spinner trips it first) nor with a bare
    ``find_color`` (it races the change and sees the old frame). This polls
    :func:`find_color` every ``interval`` until at least ``min_count`` pixels
    within ``tol`` of ``target`` exist, then returns its ``{x, y, count, bbox}``
    — already a click target — plus ``elapsed``; ``None`` if it never arrives by
    ``timeout``. It is to ``find_color`` what ``wait_for_phrase`` is to the text
    readers: the same locate, made patient. Waits for the *meaning*, not the
    motion."""
    start = time.time()
    deadline = start + timeout
    while time.time() < deadline:
        w, h, rgb = capture_rgb()
        r = find_color(target, tol=tol, rgb=rgb, size=(w, h))
        if r is not None and r["count"] >= min_count:
            r["elapsed"] = time.time() - start
            return r
        time.sleep(interval)
    return None


def wait_for_color_gone(target: tuple[int, int, int], tol: int = 24,
                        max_count: int = 30, interval: float = 0.05,
                        timeout: float = 5.0) -> dict:
    """Wait until a colour *leaves* the screen (F140).

    The disappearance twin of :func:`wait_for_color`. The blocker is often a
    coloured surface that must *go away* before you proceed: a loading veil tinted
    a brand colour, an error banner that stays red until the input is fixed, a
    modal backdrop. ``wait_until_stable`` is the wrong tool here — a *static*
    overlay is perfectly stable, so it reports "ready" while the veil still covers
    everything; and ``wait_for_change`` trips on any unrelated motion underneath.
    What you actually mean is "wait until *this colour* is essentially absent".
    This polls :func:`find_color` every ``interval`` until at most ``max_count``
    pixels within ``tol`` of ``target`` remain, then returns ``{gone, count,
    elapsed}`` — ``gone`` is whether it cleared before ``timeout``. The same patient
    polling as ``wait_for_color``, watching for the colour to thin out rather than
    arrive: appearance and vanishing are one waiting, faced two ways."""
    start = time.time()
    deadline = start + timeout
    last = -1
    while time.time() < deadline:
        w, h, rgb = capture_rgb()
        r = find_color(target, tol=tol, rgb=rgb, size=(w, h))
        last = r["count"] if r is not None else 0
        if last <= max_count:
            return {"gone": True, "count": last, "elapsed": time.time() - start}
        time.sleep(interval)
    return {"gone": False, "count": last, "elapsed": time.time() - start}


def match_template(patch: bytes, pw: int, ph: int, rgb: bytes | None = None,
                   size: tuple[int, int] | None = None,
                   search: tuple[int, int, int, int] | None = None,
                   step: int = 1, mask: bytes | None = None) -> dict | None:
    """Locate a reference patch by *appearance*, not colour (F053).

    ``find_color``/``find_color_blobs`` see only hue, so two regions that share
    a colour but differ in shape (a glyph, an icon, a button state) are
    indistinguishable to them — and position is an arbitrary tie-breaker. This
    slides the ``pw``x``ph`` RGB ``patch`` over the captured desktop and scores
    every offset by sum-of-absolute-difference on luma; the lowest score is the
    closest match. Returns ``{x, y, score, bbox}`` centred on the match in
    *screen* coordinates (``score`` 0 = identical), or ``None`` if the search
    area is smaller than the patch.

    Cost is ``search_area x patch_area``, so constrain ``search``
    ``(minx, miny, maxx, maxy)`` — typically a ``find_color_blobs`` bbox padded
    by a few pixels — to keep the slide cheap; raise ``step`` for a coarse pass.
    The idiom is colour to narrow the field, appearance to choose within it
    (少則得): segment by colour, then ``match_template`` each candidate and take
    the lowest score.

    ``mask`` (F234): an optional ``pw*ph`` byte buffer where a non-zero byte marks
    a *foreground* pixel to score and a zero byte is ignored. A sprite cropped
    from one background carries that background in its bounding box; against a
    *different* background the background pixels dominate the SAD (a template that
    scored 0 at rest jumped to tens of thousands one node over and could lock onto
    a look-alike). Masking the patch to the sprite's own silhouette scores only
    what is actually the sprite, so it relocates across changing backgrounds —
    the human channel of tracking a shape and ignoring the scenery. ``score`` then
    scales with the foreground pixel count, so compare scores only at equal masks."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    if search is None:
        sx0, sy0, sx1, sy1 = 0, 0, w - 1, h - 1
    else:
        sx0, sy0, sx1, sy1 = search
        sx0, sy0 = max(0, sx0), max(0, sy0)
        sx1, sy1 = min(w - 1, sx1), min(h - 1, sy1)
    aw, ah = sx1 - sx0 + 1, sy1 - sy0 + 1
    if aw < pw or ah < ph:
        return None
    pl = bytearray(pw * ph)
    for i in range(pw * ph):
        pl[i] = (patch[i * 3] * 299 + patch[i * 3 + 1] * 587
                 + patch[i * 3 + 2] * 114) // 1000
    # Per-row foreground columns (F234). With no mask every column counts, so this
    # is just ``tuple(range(pw))`` per row and the slide stays bit-identical to the
    # F233 path; with a mask only the sprite's own pixels are summed, so a changing
    # background no longer swamps the score. Precomputed once, the inner loop is
    # the same bare subtract over a flat tuple either way.
    if mask is None:
        cols = [tuple(range(pw))] * ph
    else:
        cols = [tuple(px for px in range(pw) if mask[py * pw + px])
                for py in range(ph)]
    # Precompute source luma over the search area *once* (F233). The first cut
    # recomputed each source pixel's luma inside the innermost loop, so every
    # overlapping window re-derived the same luma — ``area x patch_area`` luma
    # multiplies. A tightly scoped 240x240 search still cost ~33s, far too slow
    # to track a moving sprite frame-to-frame. One luma pass over the area
    # (``aw*ah`` pixels) collapses the inner loop to a bare integer subtract.
    if _np is not None:
        # Vectorised SAD (accelerates F053/F233): compute the *full* score field
        # over every offset. The pure-Python slide's early-abandon only prunes
        # provably-worse offsets, so the arg-min is identical; and numpy.argmin
        # returns the first minimum in C order (oy outer, ox inner) — the same
        # offset the strict ``s < best_s`` scan keeps. To stay O(offsets) in
        # memory (not O(offsets x patch)), accumulate one patch pixel at a time
        # by array-shifted subtraction rather than materialising every window.
        srca = (_np.frombuffer(rgb, dtype=_np.uint8).reshape(h, w, 3)
                [sy0:sy1 + 1, sx0:sx1 + 1].astype(_np.int32))
        al_np = (srca[:, :, 0] * 299 + srca[:, :, 1] * 587
                 + srca[:, :, 2] * 114) // 1000
        pv = _np.frombuffer(patch, dtype=_np.uint8)[:pw * ph * 3].reshape(ph, pw, 3).astype(_np.int32)
        pl_np = (pv[:, :, 0] * 299 + pv[:, :, 1] * 587 + pv[:, :, 2] * 114) // 1000
        m_np = (None if mask is None
                else _np.frombuffer(mask, dtype=_np.uint8)[:pw * ph].reshape(ph, pw) != 0)
        noy = (ah - ph) // step + 1
        nox = (aw - pw) // step + 1
        acc = _np.zeros((noy, nox), dtype=_np.int32)
        for dy in range(ph):
            rowsel = al_np[dy:dy + (noy - 1) * step + 1:step]  # (noy, aw)
            for dx in range(pw):
                if m_np is not None and not m_np[dy, dx]:
                    continue
                block = rowsel[:, dx:dx + (nox - 1) * step + 1:step]  # (noy, nox)
                acc += _np.abs(block - int(pl_np[dy, dx]))
        flat = int(acc.argmin())
        oy, ox = (flat // nox) * step, (flat % nox) * step
        score = int(acc.flat[flat])
        tx, ty = sx0 + ox, sy0 + oy
        return {"x": tx + pw // 2, "y": ty + ph // 2, "score": score,
                "bbox": (tx, ty, tx + pw - 1, ty + ph - 1)}
    al = bytearray(aw * ah)
    for ry in range(ah):
        src = ((sy0 + ry) * w + sx0) * 3
        dst = ry * aw
        for rx in range(aw):
            j = src + rx * 3
            al[dst + rx] = (rgb[j] * 299 + rgb[j + 1] * 587
                            + rgb[j + 2] * 114) // 1000
    best_s: int | None = None
    best_xy: tuple[int, int] | None = None
    for oy in range(0, ah - ph + 1, step):
        for ox in range(0, aw - pw + 1, step):
            s = 0
            for py in range(ph):
                abase = (oy + py) * aw + ox
                pbase = py * pw
                for px in cols[py]:
                    d = al[abase + px] - pl[pbase + px]
                    s += d if d >= 0 else -d
                # Early abandon (branch-and-bound): SAD only accumulates, so the
                # moment a partial score reaches the best full score this offset
                # can no longer win — stop scoring it. The arg-min is unchanged
                # (only provably-worse offsets are skipped), and once a good
                # match is in hand almost every other offset aborts after a row
                # or two — the order-of-magnitude win that makes real-time
                # sprite tracking practical.
                if best_s is not None and s >= best_s:
                    break
            else:
                if best_s is None or s < best_s:
                    best_s, best_xy = s, (sx0 + ox, sy0 + oy)
    if best_xy is None:
        return None
    score, tx, ty = best_s, best_xy[0], best_xy[1]
    return {"x": tx + pw // 2, "y": ty + ph // 2, "score": score,
            "bbox": (tx, ty, tx + pw - 1, ty + ph - 1)}


def match_template_all(patch: bytes, pw: int, ph: int, rgb: bytes | None = None,
                       size: tuple[int, int] | None = None,
                       search: tuple[int, int, int, int] | None = None,
                       step: int = 1, mask: bytes | None = None,
                       max_score: int | None = None,
                       min_sep: tuple[int, int] | None = None,
                       limit: int = 64) -> list[dict]:
    """Locate *every* occurrence of a reference patch, not just the best (F241).

    ``match_template`` answers "where is the one closest match" — its arg-min
    early-abandon is built to find a single winner. But a repeated-element GUI
    asks the opposite: a mahjongg board has many copies of each tile face, a
    card layout repeats ranks, an inventory/match-3 grid tiles one icon dozens
    of times. To pair or count them you need *all* the places an appearance
    occurs, and the only way to get them from the single-best primitive was to
    blank each hit and rescan — O(hits) full slides and a caller-managed mask.

    This scores every offset (same SAD-on-luma as ``match_template``, honouring
    ``mask``/``step``/``search``), keeps those at or below ``max_score``, then
    applies non-maximum suppression so each real instance yields one hit instead
    of a cluster of near-identical offsets. Returns a list of
    ``{x, y, score, bbox}`` (screen coords, centred on each match) sorted by
    ascending score, at most ``limit`` entries.

    ``max_score`` is the absolute SAD ceiling; when ``None`` it is derived from
    the best score as ``best + 0.04 * 255 * scored_pixels`` — i.e. tolerate ~4%
    average luma drift per pixel beyond the closest match, which keeps genuine
    anti-aliased/shadowed copies while rejecting different faces. ``min_sep``
    ``(dx, dy)`` is the NMS exclusion box (default the patch size) so two hits
    cannot overlap. Same costing as ``match_template`` (``search_area x
    patch_area``); constrain ``search`` to a ``find_color_blobs`` bbox."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    if search is None:
        sx0, sy0, sx1, sy1 = 0, 0, w - 1, h - 1
    else:
        sx0, sy0, sx1, sy1 = search
        sx0, sy0 = max(0, sx0), max(0, sy0)
        sx1, sy1 = min(w - 1, sx1), min(h - 1, sy1)
    aw, ah = sx1 - sx0 + 1, sy1 - sy0 + 1
    if aw < pw or ah < ph:
        return []
    if mask is None:
        scored = pw * ph
    else:
        scored = sum(1 for i in range(pw * ph) if mask[i])
    # When ``max_score`` is absent the ceiling is relative (best + margin).
    margin = int(0.04 * 255 * scored)
    fixed_ceil = max_score is not None
    hits: list[tuple[int, int, int]]
    if _np is not None:
        # Vectorised SAD field (accelerates F241, same math as match_template).
        # The pure-Python early-abandon only prunes offsets that provably exceed
        # the ceiling, so the surviving set is exactly {offset : SAD <= ceil};
        # numpy computes the full field and thresholds it identically. Hits are
        # taken in row-major order (numpy.nonzero) — the same order the double
        # loop appends — so the later stable sort-by-score ties break the same.
        srca = (_np.frombuffer(rgb, dtype=_np.uint8).reshape(h, w, 3)
                [sy0:sy1 + 1, sx0:sx1 + 1].astype(_np.int32))
        al_np = (srca[:, :, 0] * 299 + srca[:, :, 1] * 587
                 + srca[:, :, 2] * 114) // 1000
        pv = _np.frombuffer(patch, dtype=_np.uint8)[:pw * ph * 3].reshape(ph, pw, 3).astype(_np.int32)
        pl_np = (pv[:, :, 0] * 299 + pv[:, :, 1] * 587 + pv[:, :, 2] * 114) // 1000
        m_np = (None if mask is None
                else _np.frombuffer(mask, dtype=_np.uint8)[:pw * ph].reshape(ph, pw) != 0)
        noy = (ah - ph) // step + 1
        nox = (aw - pw) // step + 1
        acc = _np.zeros((noy, nox), dtype=_np.int32)
        for dy in range(ph):
            rowsel = al_np[dy:dy + (noy - 1) * step + 1:step]
            for dx in range(pw):
                if m_np is not None and not m_np[dy, dx]:
                    continue
                block = rowsel[:, dx:dx + (nox - 1) * step + 1:step]
                acc += _np.abs(block - int(pl_np[dy, dx]))
        best_s = int(acc.min())
        ceil = max_score if fixed_ceil else best_s + margin
        ys, xs = _np.nonzero(acc <= ceil)  # row-major, matches the loop order
        svals = acc[ys, xs].tolist()
        xl = (xs * step).tolist()
        yl = (ys * step).tolist()
        hits = [(svals[k], sx0 + xl[k], sy0 + yl[k]) for k in range(len(svals))]
    else:
        pl = bytearray(pw * ph)
        for i in range(pw * ph):
            pl[i] = (patch[i * 3] * 299 + patch[i * 3 + 1] * 587
                     + patch[i * 3 + 2] * 114) // 1000
        if mask is None:
            cols = [tuple(range(pw))] * ph
        else:
            cols = [tuple(px for px in range(pw) if mask[py * pw + px])
                    for py in range(ph)]
        al = bytearray(aw * ah)
        for ry in range(ah):
            src = ((sy0 + ry) * w + sx0) * 3
            dst = ry * aw
            for rx in range(aw):
                j = src + rx * 3
                al[dst + rx] = (rgb[j] * 299 + rgb[j + 1] * 587
                                + rgb[j + 2] * 114) // 1000
        # Single pass with the same arg-min early-abandon as ``match_template`` so
        # finding *all* hits costs no more per offset than finding the best one.
        # The abort bound tracks ``best_so_far + margin`` and only ever tightens,
        # so a true hit (s <= best_final + margin <= best_seen + margin) is never
        # aborted, while doomed offsets bail after a row or two instead of summing
        # every pixel. Stale candidates are filtered by the final ceiling below.
        ceil = max_score
        hits = []
        best_s = None
        for oy in range(0, ah - ph + 1, step):
            for ox in range(0, aw - pw + 1, step):
                s = 0
                abort = ceil if fixed_ceil else (
                    best_s + margin if best_s is not None else None)
                for py in range(ph):
                    abase = (oy + py) * aw + ox
                    pbase = py * pw
                    for px in cols[py]:
                        d = al[abase + px] - pl[pbase + px]
                        s += d if d >= 0 else -d
                    if abort is not None and s > abort:
                        break
                else:
                    if best_s is None or s < best_s:
                        best_s = s
                    if ceil is None or s <= ceil:
                        hits.append((s, sx0 + ox, sy0 + oy))
        if best_s is None:
            return []
        if not fixed_ceil:
            ceil = best_s + margin
            hits = [ht for ht in hits if ht[0] <= ceil]
    hits.sort(key=lambda t: t[0])
    if min_sep is None:
        sepx, sepy = pw, ph
    else:
        sepx, sepy = min_sep
    kept: list[dict] = []
    for s, tx, ty in hits:
        cx, cy = tx + pw // 2, ty + ph // 2
        if any(abs(cx - k["x"]) < sepx and abs(cy - k["y"]) < sepy
               for k in kept):
            continue
        kept.append({"x": cx, "y": cy, "score": s,
                     "bbox": (tx, ty, tx + pw - 1, ty + ph - 1)})
        if len(kept) >= limit:
            break
    return kept


def match_unique(patch: bytes, pw: int, ph: int, rgb: bytes | None = None,
                 size: tuple[int, int] | None = None,
                 search: tuple[int, int, int, int] | None = None,
                 step: int = 1, mask: bytes | None = None,
                 min_margin: float = 0.18, max_score: int | None = None,
                 require_unique: bool = True) -> dict | None:
    """Locate a patch, but only trust a match that is *distinctively* the best (F263).

    ``match_template`` returns the single lowest-SAD offset — always *a* point,
    with the same confidence whether the patch occurs once or many times, and no
    way to tell which. On a *periodic* surface that is a trap: a brick wall, a row
    of identical list items, a grid of like icons, a board of identical tiles all
    repeat, and which copy wins the arg-min is then decided by sub-pixel noise. A
    tracker that re-locates each frame silently jumps onto the wrong copy (a false
    lock), and downstream :func:`servo`/aim chases a phantom — and the single-best
    primitive cannot even report that the match was ambiguous. (Honesty note: in
    OpenArena the live walls/floor were *not* periodic enough to tie the real
    fine-step matcher — it located every sampled patch correctly; the measured gap
    was the missing *confidence*, with live margins ranging 0.15 on a busy floor to
    1.0 on a unique feature. The outright false-lock is reproduced where the motif
    truly repeats: a live patch tiled into a periodic strip.)

    This judges *trustworthiness* before returning a point. It scans for every
    instance (:func:`match_template_all`, one pass, NMS so each copy yields one
    hit), takes the best, and finds the best **rival** — the next instance at
    least a patch-size away. The match is unique only if that rival is clearly
    worse: ``margin = (rival.score - best.score) / rival.score`` in ``[0, 1)``,
    where ~0 means the rival is just as good (ambiguous) and larger means the
    winner stands alone. With ``require_unique`` (the default) an ambiguous match
    returns ``None`` — turning a silent false-lock into an honest "I cannot
    uniquely place this" — so it is a safe drop-in for ``match_template`` inside
    a tracking loop. With ``require_unique=False`` it always returns the dict so
    the caller can inspect ``unique``/``margin``/``rival`` and decide.

    Returns ``{x, y, score, bbox, margin, unique, rival}`` (screen coords,
    centred on the match; ``rival`` is the rival's ``{x, y, score}`` or ``None``
    when the patch occurs only once — then ``margin`` is ``1.0``). ``min_margin``
    is the distinctiveness threshold; ``max_score`` / ``search`` / ``step`` /
    ``mask`` behave as in :func:`match_template_all`. Cost is one
    ``match_template_all`` slide — constrain ``search`` for real-time use."""
    if not 0.0 <= min_margin < 1.0:
        raise ValueError("min_margin must be in [0, 1)")
    hits = match_template_all(patch, pw, ph, rgb=rgb, size=size, search=search,
                              step=step, mask=mask, max_score=max_score,
                              min_sep=(pw, ph), limit=8)
    if not hits:
        return None
    best = hits[0]
    rival = hits[1] if len(hits) > 1 else None
    if rival is None:
        margin = 1.0
    else:
        margin = (rival["score"] - best["score"]) / max(rival["score"], 1)
    unique = margin >= min_margin
    if require_unique and not unique:
        return None
    return {"x": best["x"], "y": best["y"], "score": best["score"],
            "bbox": best["bbox"], "margin": margin, "unique": unique,
            "rival": ({"x": rival["x"], "y": rival["y"], "score": rival["score"]}
                      if rival else None)}


def lead(samples, horizon: float = 0.0, min_samples: int = 2) -> "dict | None":
    """Estimate a tracked point's image-plane velocity and predict where it
    will be after ``horizon`` seconds (F264).

    ``servo`` (F262) drives a *located* feature onto a target, relocating each
    step — but every step it aims at where the feature *was* when it last
    looked. For a still target that is fine; for a moving one it is always a
    step behind. Practice measured it: panning a wall feature across the view
    at ~27 px/s, predicting the next frame by "assume it stays" (servo's
    implicit model) erred 15 px, while ``last + v·dt`` erred 2.9 px — the lag
    is one whole inter-frame displacement, and it is exactly the displacement a
    velocity estimate removes. Nothing in the floor turned a short history of
    locations into a *velocity*, so nothing could aim where the target is
    going rather than where it has been.

    ``samples`` is a sequence of ``(t, x, y)`` observations — ``t`` in seconds
    (any common origin), ``x``/``y`` in pixels, typically the centre of each
    :func:`match_unique` / :func:`locate_change_blobs` hit. Entries whose ``x``
    or ``y`` is ``None`` (a frame where the locate refused or lost the target)
    are skipped, so this pairs directly with the honest ``None`` of
    ``match_unique`` without the caller stitching gaps. Velocity is the
    least-squares slope of ``x(t)`` and ``y(t)`` — optimal for the zero-mean
    locate jitter the matcher leaves and naturally down-weighting a single
    noisy sample, rather than trusting the last pair alone.

    Returns ``None`` when fewer than ``min_samples`` valid points survive or
    every sample shares one instant (no time base to differentiate). Otherwise
    returns ``{vx, vy, speed, x, y, t, n, px, py, horizon}``: ``vx``/``vy`` px/s,
    ``x``/``y``/``t`` the latest observation, ``n`` points used, and ``px``/``py``
    the predicted *lead* point ``(x + vx·horizon, y + vy·horizon)`` — feed that
    to :func:`servo`/:func:`move_rel` as the aim point so the actuator targets
    the interception, not the trail. The model is constant-velocity (no
    acceleration): honest only out to roughly the horizon over which the
    target's motion stays straight — a step or few frames, which is the regime
    a relocating loop actually predicts into."""
    if min_samples < 2:
        min_samples = 2
    pts = [(float(t), float(x), float(y)) for (t, x, y) in samples
           if x is not None and y is not None]
    if len(pts) < min_samples:
        return None
    n = len(pts)
    tm = sum(p[0] for p in pts) / n
    xm = sum(p[1] for p in pts) / n
    ym = sum(p[2] for p in pts) / n
    stt = sum((p[0] - tm) ** 2 for p in pts)
    if stt <= 0.0:
        return None
    vx = sum((p[0] - tm) * (p[1] - xm) for p in pts) / stt
    vy = sum((p[0] - tm) * (p[2] - ym) for p in pts) / stt
    t_last, x_last, y_last = pts[-1]
    px = x_last + vx * horizon
    py = y_last + vy * horizon
    return {"vx": vx, "vy": vy, "speed": (vx * vx + vy * vy) ** 0.5,
            "x": x_last, "y": y_last, "t": t_last, "n": n,
            "px": px, "py": py, "horizon": horizon}


def consensus_shift(votes, tol: float = 8.0, min_support: float = 0.5,
                    min_votes: int = 4) -> "dict | None":
    """Recover the dominant image translation (camera / world shift) from a bag
    of noisy per-feature displacement ``votes``, refusing when no single shift
    actually explains the scene (F265).

    ``lead`` (F264) fits a velocity from one feature's history over *time*; this
    is its spatial twin — it fuses *many* features at one instant into a single
    global shift. Practice forced it. Panning a side-scroller (SuperTux), a
    block-flow over the foreground reads, between two frames, a uniform world
    translation — the scene has one depth, so geometrically one shift is right
    (unlike FPS yaw's rotational, range-dependent flow, which F264 rejected a
    global shift for). But the *measurement* is not clean: the repeating ice
    texture makes each :func:`match_unique` vote land a tile-fraction off, and a
    few blocks gross-mislock — so a plain mean is dragged toward the outliers
    and a median lands in the empty gap *between* vote clusters (measured: a
    real ~-26 px pan produced per-block votes spread -48..0 px with two stray
    votes at +128 and -128; the median read -20 px but only 31 % of blocks lay
    within a few px of it, so its confidence was unreadable). Nothing in the
    floor turned a cloud of disagreeing displacement votes into one shift *with
    a stated confidence*, nor refused when the votes had no agreement at all
    (a scene transition / death frame / motion past the search window scatters
    votes across the whole range with no dominant value).

    ``votes`` is an iterable of ``(dx, dy)`` displacements (e.g. one per tracked
    block); entries with a ``None`` component are dropped, so this pairs with
    :func:`match_unique`'s honest misses without the caller stitching gaps. The
    dominant shift is the ``(dx, dy)`` with the most votes within ``tol`` pixels
    (Chebyshev) of it — a coarse 2-D translation mode / Hough vote — refined to
    the mean of those inliers. ``tol`` should be on the order of the locate
    noise / feature spacing (a tile, here). Returns ``None`` when fewer than
    ``min_votes`` valid votes survive or the best shift's support (inlier
    fraction) is below ``min_support`` — the flow-domain analog of
    ``match_unique``'s margin gate: report a shift only when one shift commands
    a majority. Otherwise returns ``{dx, dy, support, inliers, n, tol}``:
    ``dx``/``dy`` the refined shift, ``support`` the inlier fraction in
    ``[0, 1]``, ``inliers`` their count, ``n`` total votes considered."""
    pts = [(float(dx), float(dy)) for (dx, dy) in votes
           if dx is not None and dy is not None]
    n = len(pts)
    if n < min_votes:
        return None
    best_idx = 0
    best_count = -1
    for i, (cx, cy) in enumerate(pts):
        c = 0
        for (dx, dy) in pts:
            if abs(dx - cx) <= tol and abs(dy - cy) <= tol:
                c += 1
        if c > best_count:
            best_count, best_idx = c, i
    cx, cy = pts[best_idx]
    inliers = [(dx, dy) for (dx, dy) in pts
               if abs(dx - cx) <= tol and abs(dy - cy) <= tol]
    support = len(inliers) / n
    if support < min_support:
        return None
    mx = sum(p[0] for p in inliers) / len(inliers)
    my = sum(p[1] for p in inliers) / len(inliers)
    return {"dx": mx, "dy": my, "support": support,
            "inliers": len(inliers), "n": n, "tol": tol}


def consensus_affine(votes, min_votes: int = 8, max_iter: int = 4,
                     outlier_k: float = 2.5, resid_floor: float = 2.0,
                     min_support: float = 0.5) -> "dict | None":
    """Fit a robust *affine* flow field to position-tagged displacement
    ``votes`` — the model a camera rotation needs and that ``consensus_shift``
    can only reject (F267).

    ``consensus_shift`` (F265) fits one global translation and, honestly, refuses
    a scene whose flow is not a single shift — its own docstring names FPS yaw as
    that case. Practice then pinned down *why*, and what the right model is.
    Yawing an OpenArena view by a fixed amount and reading per-block displacement
    over the viewport, the horizontal flow was not one value and was not a few
    discrete layers: it was a smooth, repeatable ramp down the frame — measured
    ``dx`` ``-72`` px across the top band, ``-60``, ``-48``, ``-36`` across the
    bottom, each band tight (IQR ~6 px), the histogram a gap-free plateau from
    ``-36`` to ``-72`` with no clusters. ``consensus_shift`` returned ``None``
    (correct: no single shift owns a majority), but nothing in the floor could
    *represent* that flow. A camera rotation / perspective pan produces exactly
    this — image velocity affine in image position — so the honest generalisation
    of a global shift is a global *affine* field, which also degrades back to a
    pure translation when its linear terms vanish (a side-scroller pan).

    ``votes`` is an iterable of ``(x, y, dx, dy)``: the image position ``(x, y)``
    of a tracked block and its measured displacement ``(dx, dy)`` (e.g. each from
    a :func:`match_unique` hit). Entries with any ``None`` component are dropped,
    pairing with the matcher's honest misses. Both components are fit as
    ``d = c0 + c1·x + c2·y`` by least squares; centring the seed positions makes
    the normal equations collapse to a 2x2 solve per component, with the constant
    term the mean displacement. The fit is made robust by iteratively trimming
    seeds whose residual exceeds ``median + outlier_k·MAD`` (never below
    ``resid_floor`` px, so a near-perfect fit is not over-pruned) and refitting,
    up to ``max_iter`` rounds or until the inlier set is stable — so a few gross
    mislocks or an independently-moving object do not bend the global field.

    Returns ``None`` when fewer than ``min_votes`` valid votes survive, when the
    seed positions are degenerate (collinear / single column or row, so a
    gradient is unidentifiable — an honest refusal rather than a wild
    extrapolation), or when the inlier fraction falls below ``min_support``.
    Otherwise returns ``{ax, bx, ay, by, support, inliers, n, rms, cx, cy}``:
    ``ax`` is ``(c0, c1, c2)`` for ``dx`` and ``ay`` likewise for ``dy`` (absolute
    image coords, so ``dx ≈ ax[0] + ax[1]·x + ax[2]·y``); ``bx``/``by`` are the
    same coefficients re-expressed about the seed centroid ``(cx, cy)`` as
    ``(mean_d, d/dx, d/dy)``, so ``bx[0]``/``by[0]`` are the shift at the frame
    centre (what to feed an aim loop) and ``bx[1:]``/``by[1:]`` the gradient (zero
    => a pure translation, i.e. the ``consensus_shift`` regime). ``support`` is
    the inlier fraction, ``rms`` the inlier residual in px."""
    pts = [(float(x), float(y), float(dx), float(dy))
           for (x, y, dx, dy) in votes
           if x is not None and y is not None and dx is not None and dy is not None]
    n = len(pts)
    if n < min_votes:
        return None

    def fit(idx):
        k = len(idx)
        cx = sum(pts[i][0] for i in idx) / k
        cy = sum(pts[i][1] for i in idx) / k
        sxx = sxy = syy = 0.0
        sxdx = sydx = sxdy = sydy = 0.0
        mdx = sum(pts[i][2] for i in idx) / k
        mdy = sum(pts[i][3] for i in idx) / k
        for i in idx:
            xc = pts[i][0] - cx
            yc = pts[i][1] - cy
            sxx += xc * xc
            sxy += xc * yc
            syy += yc * yc
            sxdx += xc * pts[i][2]
            sydx += yc * pts[i][2]
            sxdy += xc * pts[i][3]
            sydy += yc * pts[i][3]
        det = sxx * syy - sxy * sxy
        if abs(det) < 1e-6:
            return None
        # centred linear terms for dx and dy
        dx1 = (syy * sxdx - sxy * sydx) / det
        dx2 = (sxx * sydx - sxy * sxdx) / det
        dy1 = (syy * sxdy - sxy * sydy) / det
        dy2 = (sxx * sydy - sxy * sxdy) / det
        return cx, cy, mdx, mdy, dx1, dx2, dy1, dy2

    idx = list(range(n))
    res = None
    for _ in range(max_iter):
        res = fit(idx)
        if res is None:
            return None
        cx, cy, mdx, mdy, dx1, dx2, dy1, dy2 = res
        resid = []
        for i in range(n):
            xc = pts[i][0] - cx
            yc = pts[i][1] - cy
            ex = pts[i][2] - (mdx + dx1 * xc + dx2 * yc)
            ey = pts[i][3] - (mdy + dy1 * xc + dy2 * yc)
            resid.append((ex * ex + ey * ey) ** 0.5)
        sr = sorted(resid)
        med = sr[len(sr) // 2]
        mad = sorted(abs(r - med) for r in resid)[len(sr) // 2]
        thr = max(resid_floor, med + outlier_k * mad)
        new_idx = [i for i in range(n) if resid[i] <= thr]
        if len(new_idx) < min_votes:
            break
        if len(new_idx) == len(idx):
            idx = new_idx
            break
        idx = new_idx

    res = fit(idx)
    if res is None:
        return None
    cx, cy, mdx, mdy, dx1, dx2, dy1, dy2 = res
    inset = set(idx)
    inl = 0
    ss = 0.0
    for i in range(n):
        xc = pts[i][0] - cx
        yc = pts[i][1] - cy
        ex = pts[i][2] - (mdx + dx1 * xc + dx2 * yc)
        ey = pts[i][3] - (mdy + dy1 * xc + dy2 * yc)
        if i in inset:
            inl += 1
            ss += ex * ex + ey * ey
    support = inl / n
    if support < min_support:
        return None
    rms = (ss / inl) ** 0.5 if inl else 0.0
    # absolute-coord coefficients: d = c0 + c1*x + c2*y
    ax = (mdx - dx1 * cx - dx2 * cy, dx1, dx2)
    ay = (mdy - dy1 * cx - dy2 * cy, dy1, dy2)
    return {"ax": ax, "ay": ay,
            "bx": (mdx, dx1, dx2), "by": (mdy, dy1, dy2),
            "cx": cx, "cy": cy,
            "support": support, "inliers": inl, "n": n, "rms": rms}


def flow_residual(votes, field: "dict | None" = None, min_resid: float = 6.0,
                  cluster_radius: float = 40.0, min_cluster: int = 3,
                  min_votes: int = 8) -> "dict | None":
    """Find what moves *independently of the camera* — the seeds whose
    displacement disagrees with the global flow field, clustered into objects
    (F268).

    :func:`consensus_affine` (F267) fits the camera's egomotion as a global
    affine flow and *discards* the seeds that disagree with it as outliers. But
    those discarded seeds are not noise — under a moving camera they are the
    signal: a strafing bot, a thrown grenade, a lift, anything moving in the
    world rather than merely swept by the camera. Practice pins the gap:
    :func:`locate_change_blobs` segments raw frame change, but while the camera
    pans *every* pixel changes, so it floods — it cannot tell a moving object
    from the moving world. Subtracting a single :func:`consensus_shift`
    translation only works when the world's flow is one shift (it is not, for a
    yaw — F267). Nothing in the floor turned "motion relative to the modelled
    flow field" into "here is an object moving on its own, at this position,
    this fast."

    ``votes`` is an iterable of ``(x, y, dx, dy)`` (seed position + measured
    displacement, e.g. each a :func:`match_unique` hit) — the same input
    :func:`consensus_affine` takes. ``field`` is a fitted-affine result to
    subtract; when ``None`` it is fit here from ``votes`` (so the global model
    and the residual come from one call). Each seed's residual is its
    displacement minus the field's prediction at its position; seeds whose
    residual magnitude is at least ``min_resid`` px survive, and survivors are
    grouped by single-link spatial proximity (within ``cluster_radius`` px, the
    :func:`cluster_boxes` idiom) into objects. Each cluster of at least
    ``min_cluster`` seeds is reported as one independently-moving object
    ``{x, y, rdx, rdy, speed, n, bbox}``: ``x``/``y`` the residual-seed
    centroid (a clickable/aim point), ``rdx``/``rdy`` the mean residual velocity
    (its motion *after* the camera's is removed), ``speed`` its magnitude.

    Returns ``None`` when fewer than ``min_votes`` valid votes survive or the
    field cannot be fit (degenerate geometry). Otherwise returns
    ``{field, objects, n_resid, n}``: ``objects`` sorted by seed count (largest
    first), possibly empty — an honest "the whole scene is just the camera
    moving, nothing moves on its own", which is the correct answer for a pan
    over a static map and exactly what frame-diff cannot say."""
    pts = [(float(x), float(y), float(dx), float(dy))
           for (x, y, dx, dy) in votes
           if x is not None and y is not None and dx is not None and dy is not None]
    n = len(pts)
    if n < min_votes:
        return None
    if field is None:
        field = consensus_affine(pts, min_votes=min_votes)
        if field is None:
            return None
    ax, ay = field["ax"], field["ay"]
    resid = []
    for (x, y, dx, dy) in pts:
        px = ax[0] + ax[1] * x + ax[2] * y
        py = ay[0] + ay[1] * x + ay[2] * y
        rdx, rdy = dx - px, dy - py
        if (rdx * rdx + rdy * rdy) ** 0.5 >= min_resid:
            resid.append((x, y, rdx, rdy))
    # single-link spatial clustering of the residual seeds (leader/union by radius)
    m = len(resid)
    parent = list(range(m))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    r2 = cluster_radius * cluster_radius
    for i in range(m):
        xi, yi = resid[i][0], resid[i][1]
        for j in range(i + 1, m):
            dxx = xi - resid[j][0]
            dyy = yi - resid[j][1]
            if dxx * dxx + dyy * dyy <= r2:
                parent[find(i)] = find(j)
    groups: "dict[int, list[int]]" = {}
    for i in range(m):
        groups.setdefault(find(i), []).append(i)
    objects = []
    for members in groups.values():
        if len(members) < min_cluster:
            continue
        k = len(members)
        sx = sum(resid[i][0] for i in members) / k
        sy = sum(resid[i][1] for i in members) / k
        srdx = sum(resid[i][2] for i in members) / k
        srdy = sum(resid[i][3] for i in members) / k
        xs = [resid[i][0] for i in members]
        ys = [resid[i][1] for i in members]
        objects.append({"x": sx, "y": sy, "rdx": srdx, "rdy": srdy,
                        "speed": (srdx * srdx + srdy * srdy) ** 0.5, "n": k,
                        "bbox": (min(xs), min(ys), max(xs), max(ys))})
    objects.sort(key=lambda o: o["n"], reverse=True)
    return {"field": field, "objects": objects, "n_resid": m, "n": n}


def link_tracks(frames, max_gap: float = 60.0, max_skip: int = 1,
                min_len: int = 1) -> "list[dict]":
    """Associate per-frame point detections into temporal tracks (F270).

    F269 proved that a single frame-pair cannot tell a real mover from a
    deterministic match artifact — both make a residual cluster. The
    discriminator the data pointed at is time: a real mover persists across
    consecutive frames and translates coherently; a transient mismatch appears
    once and is gone; a camera-locked overlay (a HUD, the weapon) persists but
    stays pinned at a fixed screen position. :func:`flow_residual` says "what
    disagrees with the world *this frame*"; nothing in the floor said "what
    disagreed *coherently over time*". This is that verb.

    ``frames`` is a list — one entry per time step — of detection lists; each
    detection is a mapping with at least ``x`` and ``y`` (any other keys are
    preserved untouched) or an ``(x, y)`` pair. Linking is greedy
    nearest-neighbour, resolved per step in ascending-distance order so each
    detection and each open track is used at most once: a detection joins the
    nearest still-open track whose last point lies within ``max_gap`` px and at
    most ``max_skip + 1`` steps back (so ``max_skip=1`` bridges a one-frame
    drop-out), otherwise it starts a new track. Returns the tracks with at
    least ``min_len`` points, sorted longest-first, each::

        {"points": [{"t", "x", "y", "det"}, ...],
         "length": int,                 # how many frames it survived
         "span": float,                 # net start->end displacement (px)
         "net": (dx, dy),               # net screen translation
         "bbox": (minx, miny, maxx, maxy)}

    The caller reads persistence and span as the gate the floor could not give
    from one pair: ``length == 1`` is a flicker (transient noise); ``length > 1``
    with ``span`` near zero is a pinned overlay (camera-locked HUD/weapon);
    persistent *and* translating is a genuine independent mover. Live (panning
    OpenArena): linking collapsed 17 single-pair detections to 2 persistent
    tracks, dropping 15 flickers, and tagged the weapon band pinned."""
    def xy(d):
        if isinstance(d, dict):
            return float(d["x"]), float(d["y"])
        return float(d[0]), float(d[1])

    g2 = max_gap * max_gap
    tracks: "list[dict]" = []   # each: {"points": [...], "_last_t": int}
    for t, dets in enumerate(frames):
        norm = [(xy(d), d) for d in dets]
        # candidate (dist^2, det_index, track_index) over still-linkable tracks
        cands = []
        for di, ((dx, dy), _d) in enumerate(norm):
            for ti, tr in enumerate(tracks):
                if t - tr["_last_t"] > max_skip + 1:
                    continue
                lp = tr["points"][-1]
                dd = (dx - lp["x"]) ** 2 + (dy - lp["y"]) ** 2
                if dd <= g2:
                    cands.append((dd, di, ti))
        cands.sort(key=lambda c: c[0])
        used_d: "set[int]" = set()
        used_t: "set[int]" = set()
        for dd, di, ti in cands:
            if di in used_d or ti in used_t:
                continue
            (dx, dy), d = norm[di]
            tracks[ti]["points"].append({"t": t, "x": dx, "y": dy, "det": d})
            tracks[ti]["_last_t"] = t
            used_d.add(di)
            used_t.add(ti)
        for di, ((dx, dy), d) in enumerate(norm):
            if di in used_d:
                continue
            tracks.append({"points": [{"t": t, "x": dx, "y": dy, "det": d}],
                           "_last_t": t})
    out = []
    for tr in tracks:
        pts = tr["points"]
        if len(pts) < min_len:
            continue
        xs = [p["x"] for p in pts]
        ys = [p["y"] for p in pts]
        ndx, ndy = xs[-1] - xs[0], ys[-1] - ys[0]
        out.append({"points": pts, "length": len(pts),
                    "span": (ndx * ndx + ndy * ndy) ** 0.5,
                    "net": (ndx, ndy),
                    "bbox": (min(xs), min(ys), max(xs), max(ys))})
    out.sort(key=lambda tr: tr["length"], reverse=True)
    return out


def detect_sequence(levels, thresh: float = 0.4, refractory: int = 1,
                    baseline=None, peak=None) -> "list[dict]":
    """Recover the ordered activation sequence of several regions (F272).

    :func:`react_pixel` answers "when did *this* pixel cross a level" for a single
    point. A grid/board game asks it of *several* regions at once and cares about
    ORDER — Sequence Memory flashes N tiles one after another and you must
    reproduce the order; a Simon/whack-a-mole board is the same shape. Nothing on
    the floor turned "these regions' levels over time" into "which fired, and in
    what order"; the caller kept re-deriving it by hand — poll every region every
    frame, remember each one's previous level, detect the rising edge, and debounce
    a flash that spans several frames. This owns that bookkeeping.

    ``levels`` is a list — one entry per frame — of the regions' activation this
    frame: either a sequence of ``N`` scalars (region *i*'s level, higher = more
    active, e.g. mean/max luminance of a tile's patch) or a ``{name: scalar}``
    mapping (keys taken from the first frame and required in every frame). An event
    fires for a region on the frame its level first *rises* across that region's
    gate — edge-triggered, not level: while it stays above the gate no further
    event fires; it must fall back to the gate for ``refractory`` frames to re-arm,
    so one flash spanning many frames is one event and a tile that flashes twice is
    two. The gate is per-region, ``gate_i = base_i + thresh*(peak_i - base_i)``, so
    a dim region and a bright one are each judged on their own dynamic range; a
    flat region (``peak_i == base_i``) never fires. ``baseline`` / ``peak`` may be
    given explicitly (list or ``{name: scalar}``); by default each region's min /
    max over ``levels`` is used.

    Returns events in fire order::

        [{"region": i_or_name, "frame": int, "level": float}, ...]

    ties within a frame breaking by region order; empty when nothing crosses. Feed
    it a windowed :func:`capture_rgb` reduction per region per frame and it returns
    the sequence to replay."""
    ref = max(1, int(refractory))
    frames = list(levels)
    if not frames:
        return []
    first = frames[0]
    if isinstance(first, dict):
        keys = list(first.keys())

        def row(f):
            return [float(f[k]) for k in keys]
    else:
        keys = list(range(len(first)))

        def row(f):
            return [float(v) for v in f]

    mat = [row(f) for f in frames]
    n = len(keys)
    for r in mat:
        if len(r) != n:
            raise ValueError("every frame must have the same region count")

    def per_region(arg, default):
        if arg is None:
            return default
        if isinstance(arg, dict):
            return [float(arg[k]) for k in keys]
        seq = [float(v) for v in arg]
        if len(seq) != n:
            raise ValueError("baseline/peak length must match region count")
        return seq

    base = per_region(baseline, [min(r[i] for r in mat) for i in range(n)])
    pk = per_region(peak, [max(r[i] for r in mat) for i in range(n)])
    gate = [base[i] + thresh * (pk[i] - base[i]) for i in range(n)]

    armed = [True] * n
    below = [0] * n
    events: "list[dict]" = []
    for fi, r in enumerate(mat):
        for i in range(n):
            hot = r[i] > gate[i]
            if hot:
                below[i] = 0
                if armed[i]:
                    events.append({"region": keys[i], "frame": fi,
                                   "level": r[i]})
                    armed[i] = False
            else:
                below[i] += 1
                if below[i] >= ref:
                    armed[i] = True
    return events


_OCR_ENGINE: "str | None" = None

# Content-addressed OCR cache (F238). tesseract is spawned as a subprocess per
# call (~50 ms here), so a grid reader that re-reads every revealed cell each
# round pays that cost again for pixels that never changed (gnome-mines: a
# revealed number is immutable, yet read_board re-OCR'd all 59 of them every
# round → 3.1 s/round). The recognised text is a pure function of the exact
# greyscale crop + the parameters that reach tesseract, so memoising on that
# content hash is correctness-preserving: identical pixels and flags can only
# yield the identical string. Keyed on content (not coordinates), it also
# survives the whole region scrolling by one cell.
_OCR_CACHE: "dict[bytes, str]" = {}
_OCR_CACHE_MAX = 4096


def _ocr_engine() -> str:
    """Resolve the OCR engine binary once. Tesseract is an *optional* perception
    extension — the floor imports and runs without it; only OCR calls need it."""
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        import shutil
        _OCR_ENGINE = shutil.which("tesseract") or ""
    if not _OCR_ENGINE:
        raise RuntimeError(
            "ocr_text needs the 'tesseract' binary on PATH "
            "(install: apt-get install tesseract-ocr). It is an optional "
            "perception extension; the rest of the floor runs without it.")
    return _OCR_ENGINE


def _clamp_region(rx: int, ry: int, rw: int, rh: int,
                  fw: int, fh: int, orig) -> "tuple[int, int, int, int]":
    """Clamp ``(rx,ry,rw,rh)`` to the ``fw``x``fh`` frame; raise on an empty one.

    A crop computed by insetting a cell by a fixed margin can run off the frame
    (a margin wider than a small cell makes width negative, the F237 trap) or
    sit past a screen edge. Trim it to what is actually on the frame and reject
    only a region with nothing left, with a message that names the offender —
    never a downstream ``bytearray(negative)`` crash."""
    x0 = min(max(rx, 0), fw)
    y0 = min(max(ry, 0), fh)
    x1 = min(max(rx + rw, 0), fw)
    y1 = min(max(ry + rh, 0), fh)
    if x1 <= x0 or y1 <= y0:
        raise ValueError(
            f"ocr_text region is empty after clamping to {fw}x{fh}: {orig!r}")
    return x0, y0, x1 - x0, y1 - y0


def ocr_text(region: "tuple[int, int, int, int] | None" = None,
             whitelist: "str | None" = None, psm: int = 7,
             scale: int = 3, invert: bool = False,
             rgb: "bytes | None" = None,
             size: "tuple[int, int] | None" = None,
             fallback_psm: int = 6) -> str:
    """Read *text* off the screen by pixels with **zero prior atlas** — the
    cold-start reader for UIs that draw their own glyphs (canvas, OpenGL/SDL
    games, custom toolkits) where AT-SPI exposes geometry but no value (F231).

    The floor already reads canvas text dependency-free via the
    :func:`read_glyph`/:func:`read_text` atlas ladder, but that ladder needs a
    reference *atlas* — labelled glyphs — and an agent facing a font it has never
    seen cannot label one without first reading it. This breaks that chicken-and-
    egg: tesseract reads arbitrary glyphs with no atlas, so its output can label
    reference cells from which a fast :func:`read_glyph` atlas is built for the
    rest of the session (engine for the cold start, structure for the warm path).
    It is an *optional* extension (see :func:`_ocr_engine`) — the floor imports
    and runs without it, and the atlas ladder stays the default reader.

    Grabs ``region`` ``(x, y, w, h)`` (whole screen if ``None``), upscales by
    ``scale`` and greyscales it (small glyphs OCR poorly at native size), then
    pipes a hand-rolled PNG to tesseract and returns the recognised text,
    stripped.

    ``whitelist`` constrains the alphabet (e.g. ``"0123456789"`` for a score, or
    ``"12345678"`` for a minesweeper cell) — the single biggest accuracy win on
    short fixed-charset readouts. ``psm`` is tesseract's page-segmentation mode
    (7 = one text line, 10 = one character, 6 = a block). ``invert`` handles
    light-on-dark text. Pass an existing ``rgb``/``size`` to OCR several regions
    from one capture. Pairs with AT-SPI for *where* + OCR for *what* — the hybrid
    that drives self-drawn surfaces a semantic tree cannot describe.

    A caller's instinct on a lone digit is ``psm=10`` ("one character") — but on
    a tight, isolated glyph tesseract's line/char segmentation (7 and 10) treats
    the round digits ``4 6 8 9`` as stray ink and emits *nothing*, while block
    mode (6) reads them; a sudoku board that scored 66/81 under per-cell psm=10
    read 81/81 under psm=6 (F235). So when a ``whitelist`` read comes back empty
    yet the crop *holds ink*, this retries once in ``fallback_psm`` (block, 6) —
    turning a silent drop into a read without ever overriding a hit, and skipping
    genuinely blank cells so a ' '-means-empty caller (minesweeper) is unaffected.
    Feed the *greyscale* crop, never a hard 1-bit threshold: the anti-aliased
    edges are tesseract's signal, and binarising first is what drops those glyphs.
    Set ``fallback_psm=0`` to disable the retry."""
    import hashlib
    import subprocess
    if region is None:
        w, h, buf = capture_rgb()
        rx, ry = 0, 0
        rw, rh = w, h
    elif rgb is not None:
        if size is None:
            raise ValueError("size required when rgb is provided")
        fw, fh = size
        rx, ry, rw, rh = region
        # A computed crop (a cell inset by a fixed margin) can land partly or
        # wholly off the frame — clamp to the frame and reject only a truly
        # empty region with a clear message, never crash on a negative bytearray.
        rx, ry, rw, rh = _clamp_region(rx, ry, rw, rh, fw, fh, region)
        buf = bytearray(rw * rh * 3)
        for yy in range(rh):
            src = ((ry + yy) * fw + rx) * 3
            buf[yy * rw * 3:(yy + 1) * rw * 3] = rgb[src:src + rw * 3]
        buf = bytes(buf)
    else:
        rx, ry, rw, rh = region
        if rw <= 0 or rh <= 0:
            raise ValueError(
                f"ocr_text region must have positive width/height, got {region!r}")
        _w, _h, buf = capture_rgb(rx, ry, rw, rh)
        rw, rh = _w, _h
    # greyscale + optional invert + nearest-neighbour upscale
    g = bytearray(rw * rh)
    for i in range(rw * rh):
        lum = (buf[i * 3] * 299 + buf[i * 3 + 1] * 587
               + buf[i * 3 + 2] * 114) // 1000
        g[i] = 255 - lum if invert else lum
    s = max(1, int(scale))
    bw, bh = rw * s, rh * s
    up = bytearray(bw * bh * 3)
    for yy in range(bh):
        srow = (yy // s) * rw
        drow = yy * bw * 3
        for xx in range(bw):
            v = g[srow + xx // s]
            j = drow + xx * 3
            up[j] = up[j + 1] = up[j + 2] = v
    png = _png(bw, bh, bytes(up))
    key = hashlib.blake2b(
        b"\0".join((
            png,
            str(psm).encode(),
            str(scale).encode(),
            (whitelist or "").encode(),
            b"1" if invert else b"0",
        )),
        digest_size=16,
    ).digest()
    cached = _OCR_CACHE.get(key)
    if cached is not None:
        return cached

    engine = _ocr_engine()

    def _run(p: int) -> str:
        cmd = [engine, "stdin", "stdout", "--psm", str(p)]
        if whitelist:
            cmd += ["-c", "tessedit_char_whitelist=" + whitelist]
        out = subprocess.run(cmd, input=png, capture_output=True, timeout=20)
        return out.stdout.decode(errors="ignore").strip()

    res = _run(psm)
    # F235: line/char modes (7, 10) silently drop round glyphs on a tight crop;
    # block mode (6) reads them. Retry once when a whitelisted read came back
    # empty *and* the crop holds ink — never overriding a hit, and leaving a
    # genuinely blank cell empty (``g`` is the pre-upscale greyscale; ``bg`` is
    # its brightest = background, so a count of clearly-darker pixels is ink).
    if (not res and whitelist and fallback_psm and fallback_psm != psm):
        bg = max(g) if g else 0
        ink = sum(1 for v in g if v < bg - 40)
        if ink >= max(8, (rw * rh) * 3 // 200):
            res = _run(fallback_psm)
    if len(_OCR_CACHE) >= _OCR_CACHE_MAX:
        _OCR_CACHE.pop(next(iter(_OCR_CACHE)))
    _OCR_CACHE[key] = res
    return res


def wait_stable(target: tuple[int, int, int], tol: int = 24, move_tol: int = 3,
                settle_frames: int = 3, interval: float = 0.12,
                timeout: float = 6.0, radius: int = 80,
                scan_step: int = 4) -> dict | None:
    """Locate a colour only once it has stopped moving — by foveated pursuit (F054/F143).

    Every other primitive here reads a *single* ``capture_rgb`` snapshot, but a
    live UI animates: by the time a synthesised click lands, an element that was
    sliding/teleporting has moved on, so the click hits where the target *used to
    be*. The result is the usual ``find_color`` dict plus ``settled`` (bool),
    ``samples`` (int) and ``saccades`` (full-screen re-acquisitions).

    Why pursuit, not a fixed-rate full-screen poll. A whole-screen ``find_color``
    scan is *slow* (millions of pixels in Python), so a fixed poll samples the
    page only a few times a second — slower than a 180 ms animation step. Then two
    successive samples can land an even number of steps apart and read the *same*
    spot, so the motion is **undersampled** (Nyquist) and it can "settle" mid-flight.
    The eye does not solve this by staring at the whole wall faster; it *foveates* —
    a tiny high-acuity window it can re-read tens of times a second — and **pursues**
    the target, **saccading** only when the target leaves that window. So here:
    acquire once with a full grab, then track inside a ``2·radius`` fovea via
    :func:`foveate` at a fast poll. While the fovea keeps finding the target within
    ``move_tol`` it is at rest; hold that for a wall-clock ``settle_frames·interval``
    seconds and it is settled. The instant the target leaves the fovea — a teleport,
    or a slide past the window — that *absence* is the motion signal (大音希聲: the
    silence is the note): re-anchor with one full-screen saccade and keep pursuing.
    Because the dense sampling is foveal (cheap) the sampler always out-paces the
    motion, and because leaving the fovea resets the hold, it cannot false-settle
    mid-motion — on either platform, with no cadence tuning to a particular display.

    If the target never settles within ``timeout`` the last seen locate is returned
    with ``settled=False`` (or ``None`` if the colour was never found)."""
    deadline = time.time() + timeout
    hold = max(0.0, settle_frames * interval)
    # Foveal polling is cheap, so sample fast — far above any UI step — but cap the
    # rate so a stationary target does not busy-spin the CPU.
    pursue_dt = min(0.02, interval / 4) if interval > 0 else 0.0
    samples = 0
    saccades = 0
    last: dict | None = None
    anchor: tuple[int, int] | None = None
    anchor_t = 0.0

    def saccade() -> dict | None:  # full-screen re-acquire (coarse/peripheral)
        nonlocal samples, saccades
        w, h, rgb = capture_rgb()
        samples += 1
        saccades += 1
        # A saccade only needs to find *where* the target roughly is; the fovea
        # then refines it. So scan at low acuity (``scan_step``) — a whole-screen
        # full-acuity scan is hundreds of ms and would itself undersample motion.
        return find_color(target, tol=tol, rgb=rgb, size=(w, h), step=scan_step)

    # Acquire: saccade until the target is first seen (or time out).
    while time.time() < deadline:
        loc = saccade()
        if loc is not None:
            last = loc
            anchor = (loc["x"], loc["y"])
            anchor_t = time.time()
            break
        time.sleep(pursue_dt)

    # Pursue: foveate around the last known spot; saccade on loss.
    while anchor is not None and time.time() < deadline:
        loc = foveate(target, anchor, radius=radius, tol=tol)
        samples += 1
        if loc is None:                      # left the fovea → it moved
            loc = saccade()
            if loc is None:
                time.sleep(pursue_dt)
                continue
            last = loc
            anchor = (loc["x"], loc["y"])
            anchor_t = time.time()           # motion → restart the hold
            time.sleep(pursue_dt)
            continue
        last = loc
        if abs(loc["x"] - anchor[0]) <= move_tol \
                and abs(loc["y"] - anchor[1]) <= move_tol:
            if time.time() - anchor_t >= hold:
                loc["samples"] = samples
                loc["saccades"] = saccades
                loc["settled"] = True
                return loc
        else:                                # drifted within the fovea → recenter
            anchor = (loc["x"], loc["y"])
            anchor_t = time.time()
        time.sleep(pursue_dt)

    if last is not None:
        last["samples"] = samples
        last["saccades"] = saccades
        last["settled"] = False
    return last


def edge_map(rgb: bytes, size: tuple[int, int],
             bbox: tuple[int, int, int, int], thr: int = 40
             ) -> tuple[list[int], int, int]:
    """Reduce a region to its *structure* — a binary edge mask (F055).

    ``match_template`` scores absolute luma, so a uniform colour/brightness
    shift over the whole target swamps the shape difference: the *same* shape in
    a shifted colour scores worse than a *different* shape in the reference
    colour. An edge mask keeps only where luma *changes* (the gradient), which is
    where one region meets another — and that geometry is unchanged when the
    fill colour shifts. This returns ``(edges, ew, eh)`` where ``edges`` is a
    row-major list of 0/1 over the ``bbox``: 1 where the local gradient
    magnitude (``|dL/dx| + |dL/dy|``) exceeds ``thr``. Border pixels are 0.
    Pair with :func:`match_edges` / :func:`edge_hamming` to locate by shape."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    if _np is not None:
        lum = ((_np.frombuffer(rgb, dtype=_np.uint8).reshape(-1, w, 3)
                [y0:y0 + bh, x0:x0 + bw].astype(_np.int32)))
        lum = (lum[:, :, 0] * 299 + lum[:, :, 1] * 587
               + lum[:, :, 2] * 114) // 1000
        edges = _np.zeros((bh, bw), dtype=_np.int64)
        if bh > 2 and bw > 2:
            gx = lum[1:bh - 1, 2:bw] - lum[1:bh - 1, 0:bw - 2]
            gy = lum[2:bh, 1:bw - 1] - lum[0:bh - 2, 1:bw - 1]
            g = _np.abs(gx) + _np.abs(gy)
            edges[1:bh - 1, 1:bw - 1] = (g > thr)
        return edges.reshape(-1).tolist(), bw, bh
    lum = [0] * (bw * bh)
    for yy in range(bh):
        base = ((y0 + yy) * w + x0) * 3
        row = yy * bw
        for xx in range(bw):
            j = base + xx * 3
            lum[row + xx] = (rgb[j] * 299 + rgb[j + 1] * 587
                             + rgb[j + 2] * 114) // 1000
    edges = [0] * (bw * bh)
    for yy in range(1, bh - 1):
        row = yy * bw
        for xx in range(1, bw - 1):
            i = row + xx
            gx = lum[i + 1] - lum[i - 1]
            gy = lum[i + bw] - lum[i - bw]
            g = (gx if gx >= 0 else -gx) + (gy if gy >= 0 else -gy)
            if g > thr:
                edges[i] = 1
    return edges, bw, bh


def edge_hamming(a: list[int], b: list[int]) -> int:
    """Count differing pixels between two equal-length edge masks."""
    if _np is not None:
        return int((_np.asarray(a) != _np.asarray(b)).sum())
    return sum(1 for i in range(len(a)) if a[i] != b[i])


def match_edges(ref_edges: list[int], ew: int, eh: int,
                rgb: bytes | None = None, size: tuple[int, int] | None = None,
                search: tuple[int, int, int, int] | None = None,
                step: int = 1, thr: int = 40) -> dict | None:
    """Locate a reference *shape* irrespective of its colour (F055).

    Companion to :func:`match_template` for targets whose colour cannot be
    relied upon (gradients, photos, theme-shifted icons, hover/active states
    that recolour but do not reshape). ``ref_edges`` is an ``ew``x``eh`` mask
    from :func:`edge_map` of the reference; this slides that window over the
    search region, recomputing each candidate's edge mask the same way, and
    scores by :func:`edge_hamming`. Lowest score wins. Returns ``{x, y, score,
    bbox}`` centred on the match in *screen* coordinates, or ``None`` if the
    search area is smaller than the window.

    Cost is ``search_area x window_area``; constrain ``search`` (a
    ``find_color_blobs`` bbox padded a little) and the idiom holds — colour to
    narrow the field, *structure* to choose within it when colour itself has
    moved."""
    if rgb is None:
        w, h, rgb = capture_rgb()
    else:
        if size is None:
            raise ValueError("size required when rgb is provided")
        w, h = size
    if search is None:
        sx0, sy0, sx1, sy1 = 0, 0, w - 1, h - 1
    else:
        sx0, sy0, sx1, sy1 = search
        sx0, sy0 = max(0, sx0), max(0, sy0)
        sx1, sy1 = min(w - 1, sx1), min(h - 1, sy1)
    aw, ah = sx1 - sx0 + 1, sy1 - sy0 + 1
    if aw < ew or ah < eh:
        return None
    best: tuple[int, int, int] | None = None
    for oy in range(0, ah - eh + 1, step):
        for ox in range(0, aw - ew + 1, step):
            cand, _, _ = edge_map(rgb, (w, h),
                                  (sx0 + ox, sy0 + oy,
                                   sx0 + ox + ew - 1, sy0 + oy + eh - 1), thr)
            s = edge_hamming(ref_edges, cand)
            if best is None or s < best[0]:
                best = (s, sx0 + ox, sy0 + oy)
    if best is None:
        return None
    score, tx, ty = best
    return {"x": tx + ew // 2, "y": ty + eh // 2, "score": score,
            "bbox": (tx, ty, tx + ew - 1, ty + eh - 1)}


def edge_signature(rgb: bytes, size: tuple[int, int],
                   bbox: tuple[int, int, int, int],
                   nw: int = 48, nh: int = 48, thr: int = 24) -> list[int]:
    """A scale-invariant structural fingerprint of a region (F056).

    :func:`edge_map` / :func:`match_edges` are translation-only: the reference
    mask is a fixed pixel size, so the *same* shape rendered larger (browser
    zoom, high-DPI, a responsive re-layout) no longer aligns — and a *different*
    shape at the reference's own size can score better. This collapses that
    dependence on size: it area-averages the region's luma down to a fixed
    ``nw``x``nh`` grid and thresholds the gradient there, so any rendering of the
    same shape — whatever its pixel dimensions — reduces to the *same* signature.
    Compare two signatures with :func:`edge_hamming` (lower = more alike).

    Segmentation already yields each candidate's true ``bbox`` (hence its size),
    so the idiom is: segment by colour, take one signature per candidate at the
    canonical grid, and pick the lowest Hamming distance to the reference —
    structure that no longer cares how big the thing was drawn."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    if _np is not None:
        lum = (_np.frombuffer(rgb, dtype=_np.uint8).reshape(-1, w, 3)
               [y0:y0 + bh, x0:x0 + bw].astype(_np.int64))
        lum = (lum[:, :, 0] * 299 + lum[:, :, 1] * 587
               + lum[:, :, 2] * 114) // 1000
        # Integral image → every variable-size cell mean in one shot, exactly the
        # per-cell ``s // cnt`` the loop computes (floor division on non-neg sums).
        ii = _np.zeros((bh + 1, bw + 1), dtype=_np.int64)
        ii[1:, 1:] = lum.cumsum(0).cumsum(1)
        r0 = _np.array([ny * bh // nh for ny in range(nh)])
        r1 = _np.maximum(_np.array([(ny + 1) * bh // nh for ny in range(nh)]),
                         r0 + 1)
        c0 = _np.array([nx * bw // nw for nx in range(nw)])
        c1 = _np.maximum(_np.array([(nx + 1) * bw // nw for nx in range(nw)]),
                         c0 + 1)
        s = (ii[r1[:, None], c1[None, :]] - ii[r0[:, None], c1[None, :]]
             - ii[r1[:, None], c0[None, :]] + ii[r0[:, None], c0[None, :]])
        cnt = (r1 - r0)[:, None] * (c1 - c0)[None, :]
        gg = s // cnt  # (nh, nw)
        sig = _np.zeros((nh, nw), dtype=_np.int64)
        if nh > 2 and nw > 2:
            gx = gg[1:nh - 1, 2:nw] - gg[1:nh - 1, 0:nw - 2]
            gy = gg[2:nh, 1:nw - 1] - gg[0:nh - 2, 1:nw - 1]
            sig[1:nh - 1, 1:nw - 1] = (_np.abs(gx) + _np.abs(gy) > thr)
        return sig.reshape(-1).tolist()
    g = [0] * (nw * nh)
    for ny in range(nh):
        sy0 = y0 + ny * bh // nh
        sy1 = y0 + (ny + 1) * bh // nh
        if sy1 <= sy0:
            sy1 = sy0 + 1
        for nx in range(nw):
            sx0 = x0 + nx * bw // nw
            sx1 = x0 + (nx + 1) * bw // nw
            if sx1 <= sx0:
                sx1 = sx0 + 1
            s = cnt = 0
            for yy in range(sy0, sy1):
                base = yy * w * 3
                for xx in range(sx0, sx1):
                    j = base + xx * 3
                    s += (rgb[j] * 299 + rgb[j + 1] * 587
                          + rgb[j + 2] * 114) // 1000
                    cnt += 1
            g[ny * nw + nx] = s // cnt if cnt else 0
    sig = [0] * (nw * nh)
    for ny in range(1, nh - 1):
        for nx in range(1, nw - 1):
            i = ny * nw + nx
            gx = g[i + 1] - g[i - 1]
            gy = g[i + nw] - g[i - nw]
            if (gx if gx >= 0 else -gx) + (gy if gy >= 0 else -gy) > thr:
                sig[i] = 1
    return sig


def radial_profile(rgb: bytes, size: tuple[int, int],
                   bbox: tuple[int, int, int, int],
                   bins: int = 24, thr: int = 40) -> list[float]:
    """A rotation- *and* scale-invariant structural descriptor (F057).

    :func:`edge_signature` is scale-free but still orientation-bound: it
    resamples onto a fixed grid, so the *same* shape turned by 90° lights up
    entirely different cells and a *different* shape left at the reference's
    orientation can score a closer signature. This removes the angle too. It
    edges the region (:func:`edge_map`), finds the centroid of the edge pixels,
    measures each edge pixel's distance to that centroid, normalises by the
    largest such distance (kills scale), and histograms those normalised radii
    into ``bins`` buckets summed to 1. Rotating a shape about its centroid moves
    no pixel's radius, so the histogram is unchanged; rescaling divides every
    radius by the same factor, which the normalisation cancels. The histogram is
    therefore a fingerprint of the shape's *radial mass*, independent of how it
    is turned or sized. Compare two profiles with :func:`profile_l1` (lower =
    more alike). It discards angular order, so distinct shapes that happen to
    share a radial distribution can collide — pair with :func:`edge_signature`
    when orientation is in fact fixed; reach for this only when it can rotate."""
    edges, ew, _eh = edge_map(rgb, size, bbox, thr)
    pts = [(i % ew, i // ew) for i, v in enumerate(edges) if v]
    if not pts:
        return [0.0] * bins
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    ds = [((px - cx) ** 2 + (py - cy) ** 2) ** 0.5 for px, py in pts]
    mr = max(ds) or 1.0
    hist = [0] * bins
    for d in ds:
        hist[int(d / mr * (bins - 1) + 0.5)] += 1
    tot = sum(hist) or 1
    return [hc / tot for hc in hist]


def profile_l1(a: list[float], b: list[float]) -> float:
    """L1 (city-block) distance between two equal-length radial profiles."""
    return sum(abs(a[i] - b[i]) for i in range(len(a)))


def read_glyph(rgb: bytes, size: tuple[int, int],
               bbox: tuple[int, int, int, int],
               atlas: dict[str, list[int]],
               nw: int = 48, nh: int = 48, thr: int = 24) -> str:
    """Read which glyph occupies a region by matching an atlas (F058).

    The end of the perception ladder: when a control carries text the page draws
    straight onto a canvas — no DOM node, no distinguishing colour or outer shape,
    *only* the rendered character sets one button apart from its twin. Colour
    segmentation finds the tiles; structure tells them apart only if we already
    hold the target's own rendering. A fixed-size edge match against a reference
    *atlas* of candidate glyphs fails the moment the atlas was rendered at a
    different size than the live control (a `bold 80px` swatch vs a `bold 120px`
    button) — it reads every tile as the same letter. This classifies instead in
    the scale-free frame: it takes the region's :func:`edge_signature` and returns
    the ``atlas`` label whose signature is closest by :func:`edge_hamming`, so a
    glyph recognises itself however large it was drawn. ``atlas`` is
    ``{label: edge_signature(...)}`` built once from reference glyphs (rendered by
    the page itself on a scratch canvas, or captured from a known control). This
    is reading text from pixels reduced to its smallest honest form — not full
    OCR, but enough to pick the control that *says* the right thing."""
    sig = edge_signature(rgb, size, bbox, nw, nh, thr)
    return min(atlas, key=lambda k: edge_hamming(atlas[k], sig))


def read_glyph_conf(rgb: bytes, size: tuple[int, int],
                    bbox: tuple[int, int, int, int],
                    atlas: dict[str, list[int]],
                    nw: int = 48, nh: int = 48, thr: int = 24,
                    max_dist: float = 0.6, conf_k: float = 2.0,
                    unknown: str = "") -> str:
    """Read a glyph only when one atlas entry *clearly* fits (F107).

    :func:`read_glyph` returns ``min(atlas, key=…)`` — the *nearest* label, always.
    It has no way to say "I do not know this": point it at a glyph the atlas never
    held (a ``"Z"`` against an atlas of ``"ABCOKX"``) and it confidently returns the
    closest wrong letter. The closest of a bad lot is still returned as if it were
    read. ``read_glyph`` cannot express ignorance — that is its named boundary.

    The distance to the best match carries the missing signal, on two axes. A glyph
    that *is* in the atlas matches its own signature with a *small* Hamming distance
    relative to the live ink it sets, and beats every other atlas entry by a wide
    *margin*; an *unknown* glyph's nearest match is both far in absolute terms (it
    overlaps no reference well) and barely closer than the runner-up (nothing stands
    out). This reads the signature, then admits the best label only if it passes
    *both* gates: the nearest distance is ``<= max_dist`` times the live ink's set
    cells (a real fit, not the least-bad), *and* the runner-up is ``>= conf_k``
    times farther (a clear winner, not a coin-flip among look-alikes). Fail either
    and it returns ``unknown`` (``""`` by default) — it refuses to name what it
    cannot recognise.

    Honest only where the atlas entries are themselves distinguishable: hold two
    near-twins (``"O"`` and ``"0"``) and a true ``"O"`` may not clear ``conf_k`` —
    it refuses rather than guess between them, which is the honest answer when the
    reference cannot tell them apart. Empty ink → ``unknown``. Raise ``max_dist`` /
    lower ``conf_k`` to accept looser matches; lower ``max_dist`` / raise ``conf_k``
    to demand a tighter, more decisive fit before it will commit to a label."""
    sig = edge_signature(rgb, size, bbox, nw, nh, thr)
    on = sum(sig)
    if on == 0:
        return unknown
    scored = sorted((edge_hamming(atlas[k], sig), k) for k in atlas)
    best_d, best_k = scored[0]
    if best_d > max_dist * on:
        return unknown
    if len(scored) > 1 and scored[1][0] < conf_k * max(best_d, 1):
        return unknown
    return best_k


def segment_run(rgb: bytes, size: tuple[int, int],
                bbox: tuple[int, int, int, int],
                fg: tuple[int, int, int], tol: int = 60,
                gap: int = 2) -> list[tuple[int, int, int, int]]:
    """Split a horizontal text *run* into one bbox per glyph (F103).

    :func:`read_glyph` reads a *single* pre-isolated character; point it at a
    whole word and it reduces the entire ink to one ``edge_signature`` and
    returns one wrong label — you cannot read a string you have not first cut
    into letters. This cuts it: inside ``bbox`` it projects each column,
    marking the column *inked* if any pixel there is within ``tol`` of the
    foreground colour ``fg``, then walks the columns left-to-right opening a
    cell at the first inked column and closing it once ``gap`` consecutive blank
    columns prove the inter-letter space. Each cell is tightened to the actual
    inked rows so the returned bbox hugs the glyph (what ``edge_signature``
    wants). Returns the per-glyph bboxes in *reading order* (left to right).

    The cut is honest only where letters are parted by at least ``gap`` blank
    columns: glyphs that *touch* (tight kerning, script/italic overhang) share a
    column and merge into one cell — segmentation by projection cannot part what
    the rendering joined, and that is its named boundary, not a thing to fake.
    Lower ``gap`` cuts more eagerly (risking splitting a single wide glyph),
    raise it to keep close letters whole."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    tr, tg, tb = fg

    def inked_col(x: int) -> bool:
        for y in range(y0, y1 + 1):
            j = (y * w + x) * 3
            if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                    and abs(rgb[j + 2] - tb) <= tol):
                return True
        return False

    cols = [inked_col(x) for x in range(x0, x1 + 1)]
    cells: list[tuple[int, int]] = []
    start: int | None = None
    blanks = 0
    for i, ink in enumerate(cols):
        if ink:
            if start is None:
                start = i
            blanks = 0
        elif start is not None:
            blanks += 1
            if blanks >= gap:
                cells.append((x0 + start, x0 + i - blanks))
                start = None
                blanks = 0
    if start is not None:
        cells.append((x0 + start, x0 + len(cols) - 1 - blanks))

    out: list[tuple[int, int, int, int]] = []
    for cx0, cx1 in cells:
        miny, maxy = 1 << 30, -1
        for y in range(y0, y1 + 1):
            row = y * w * 3
            for x in range(cx0, cx1 + 1):
                j = row + x * 3
                if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                        and abs(rgb[j + 2] - tb) <= tol):
                    if y < miny:
                        miny = y
                    if y > maxy:
                        maxy = y
                    break
        if maxy >= 0:
            out.append((cx0, miny, cx1, maxy))
    return out


def split_run(rgb: bytes, size: tuple[int, int],
              bbox: tuple[int, int, int, int],
              fg: tuple[int, int, int], n: int, tol: int = 60,
              frac: float = 0.6) -> list[tuple[int, int, int, int]]:
    """Cut a run of ``n`` *touching* glyphs apart at the ink valleys (F104).

    :func:`segment_run` parts letters only where ``gap`` fully-blank columns
    separate them; tight kerning, an italic overhang or a script font joins two
    glyphs in a shared column and they merge into one wide cell — a blank-column
    cut cannot part what the rendering joined. The honest extra knowledge that
    *does* part them is the **glyph count** ``n``: when two letters merely touch,
    the seam between them is a local *minimum* in the per-column ink count (the
    pinch where only the overlap inks the column), shallower than either letter's
    own body. This counts the ink in every column of ``bbox``, finds the interior
    local minima, and takes the ``n - 1`` *shallowest* of them (those at or below
    ``frac`` of the peak column — a real pinch, not a letter's own waist) as the
    seams, cutting the run there and tightening each piece to its inked rows with
    :func:`segment_run`.

    This is honest only where the glyphs *touch* rather than *fuse*: it needs the
    count ``n`` (you must know how many letters to expect) and it assumes the
    inter-letter seams are the shallowest column minima — true when letters meet
    at a thin overlap, false when a stroke of one letter fully fills the seam
    column. It returns fewer than ``n`` cells when it cannot find ``n - 1`` honest
    seams: it parts what genuinely pinches and refuses to invent a cut where the
    ink runs solid. ``n <= 1`` (or no seam) yields the whole run as a single
    tightened cell."""
    x0, y0, x1, y1 = bbox
    w, _h = size
    tr, tg, tb = fg

    def whole() -> list[tuple[int, int, int, int]]:
        c = segment_run(rgb, size, bbox, fg, tol, gap=1)
        return c if c else [bbox]

    if n <= 1:
        return whole()
    prof = []
    for x in range(x0, x1 + 1):
        c = 0
        for y in range(y0, y1 + 1):
            j = (y * w + x) * 3
            if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                    and abs(rgb[j + 2] - tb) <= tol):
                c += 1
        prof.append(c)
    peak = max(prof) if prof else 0
    if peak == 0:
        return []
    mins: list[tuple[int, int]] = []
    for i in range(2, len(prof) - 2):
        if (prof[i] <= prof[i - 1] and prof[i] <= prof[i + 1]
                and prof[i] < prof[i - 2] and prof[i] < prof[i + 2]
                and prof[i] <= frac * peak):
            mins.append((prof[i], x0 + i))
    seams = sorted(x for _v, x in sorted(mins)[: n - 1])
    bounds = [x0] + seams + [x1]
    out: list[tuple[int, int, int, int]] = []
    for a, c in zip(bounds, bounds[1:]):
        cells = segment_run(rgb, size, (a, y0, c, y1), fg, tol, gap=1)
        out += cells if cells else [(a, y0, c, y1)]
    return out


def read_text(rgb: bytes, size: tuple[int, int],
              bbox: tuple[int, int, int, int],
              atlas: dict[str, list[int]],
              fg: tuple[int, int, int], tol: int = 60, gap: int = 2,
              n: int | None = None,
              nw: int = 48, nh: int = 48, thr: int = 24) -> str:
    """Read a multi-glyph text run from pixels (F103, kerned via F104).

    The rung above :func:`read_glyph`: where that reads one character we already
    isolated, this reads a *word the page drew straight onto a canvas* — no DOM,
    no per-letter node, only the rendered run. It :func:`segment_run`-s the run
    inside ``bbox`` by the foreground colour ``fg`` into per-glyph cells, then
    classifies each cell in the scale-free frame (:func:`read_glyph` against the
    reference ``atlas``), concatenating the labels in reading order into the
    string. ``atlas`` is ``{label: edge_signature(...)}`` built once from
    reference glyphs (rendered by the page on a scratch canvas, or captured from
    known controls) — exactly as :func:`read_glyph` consumes.

    Pass ``n`` (the expected glyph count) to read a run whose letters *touch*:
    when blank-column :func:`segment_run` yields fewer than ``n`` cells the
    letters share a column (tight kerning, overhang), and this falls back to
    :func:`split_run`, parting them at the ``n - 1`` shallowest column-ink valleys
    (F104). Without ``n`` it segments by blanks alone and reads only runs whose
    letters are parted by a gap.

    Still not full OCR: it reads only glyphs the ``atlas`` carries, and (without
    ``n``) only a run whose letters :func:`segment_run` can part; with ``n`` it
    parts touching glyphs but not ones that truly *fuse* (see :func:`split_run`).
    It returns ``""`` when nothing inked is found. This is reading a *string*
    reduced to its smallest honest form — segment by colour, read each by
    structure, in order."""
    cells = segment_run(rgb, size, bbox, fg, tol, gap)
    if n is not None and len(cells) < n:
        cells = split_run(rgb, size, bbox, fg, n, tol)
    return "".join(read_glyph(rgb, size, c, atlas, nw, nh, thr) for c in cells)


def read_text_conf(rgb: bytes, size: tuple[int, int],
                   bbox: tuple[int, int, int, int],
                   atlas: dict[str, list[int]],
                   fg: tuple[int, int, int], tol: int = 60, gap: int = 2,
                   n: int | None = None,
                   nw: int = 48, nh: int = 48, thr: int = 24,
                   max_dist: float = 0.6, conf_k: float = 2.0,
                   unknown: str = "?") -> str:
    """Read a run, *marking* each glyph the atlas cannot honestly name (F108).

    :func:`read_text` classifies every cell with :func:`read_glyph`, which returns
    the *nearest* atlas label no matter how badly it fits. Give it a line holding a
    glyph the atlas never carried (a ``"Z"`` inside ``"CZB"``) and it reads
    ``"CCB"``: the unknown letter is silently rewritten as the closest known one,
    and the string lies about a character it never recognised. The friction
    :func:`read_glyph_conf` cured for *one* glyph re-appears the moment a *line* is
    read, because :func:`read_text` never propagated the confidence up.

    This segments exactly as :func:`read_text` does (blank columns, or
    :func:`split_run` when ``n`` is given and the letters touch) but classifies each
    cell with :func:`read_glyph_conf`: a cell is named only when one atlas entry is
    both a good absolute fit and a clear winner, and is written as ``unknown``
    (``"?"`` by default) otherwise. The string therefore *shows* its gaps — every
    position the reader could not honestly resolve is a visible mark, not a
    fabricated letter — so a caller can tell ``"C?B"`` (one glyph unreadable) from
    ``"CAB"`` (read whole).

    Honest exactly where :func:`read_glyph_conf` is: the per-cell gates
    (``max_dist`` / ``conf_k``) decide each mark, and an atlas of indistinguishable
    near-twins will mark cells it cannot decide between rather than guess. Empty ink
    → ``""``; choose ``unknown=""`` to drop unreadable cells instead of marking them.
    """
    cells = segment_run(rgb, size, bbox, fg, tol, gap)
    if n is not None and len(cells) < n:
        cells = split_run(rgb, size, bbox, fg, n, tol)
    return "".join(read_glyph_conf(rgb, size, c, atlas, nw, nh, thr,
                                   max_dist, conf_k, unknown) for c in cells)


def read_words(rgb: bytes, size: tuple[int, int],
               bbox: tuple[int, int, int, int],
               atlas: dict[str, list[int]],
               fg: tuple[int, int, int], tol: int = 60, gap: int = 2,
               space_k: float = 1.8,
               nw: int = 48, nh: int = 48, thr: int = 24) -> str:
    """Read a line *with its word spaces* from pixels (F106).

    :func:`read_text` :func:`segment_run`-s a line into per-glyph cells and joins
    the labels with *nothing* between them — it records only *where* the inked
    cells are, never the *width* of the blank between them. Draw a line with a
    real word gap (``"OK  CAB"``) and it reads ``"OKCAB"``: the space the page
    left between words is dropped, because a blank column is a blank column to it
    whether it parts two letters or two words. ``read_text`` cannot tell an
    inter-letter gap from an inter-word gap — that is its named boundary.

    The gaps between cells carry the missing signal: they are *bimodal*. The gaps
    *inside* a word (between its letters) cluster small and roughly equal; the gap
    *between* words is markedly wider. This reads each cell as in :func:`read_text`,
    measures the horizontal blank between every adjacent pair, takes the median
    gap as the typical inter-letter spacing, and inserts a single ``' '`` wherever
    a gap is ``>= space_k`` times that median — a clear word seam, not a letter's
    own spacing. The labels join in reading order with spaces only at those seams.

    Honest only where the spacing is *bimodal*: it needs the letter gaps to
    cluster below the word gap (true for words of more than one letter). When the
    gaps are uniform — a single word, evenly-tracked display type where the word
    gap barely exceeds the letter gap — no gap clears the threshold and it reads
    the run as a single space-less word rather than inventing a break. It never
    splits a run it cannot read (empty ink → ``""``) and never guesses a space the
    spacing does not justify; raise ``space_k`` to demand a wider seam, lower it to
    split more eagerly."""
    cells = segment_run(rgb, size, bbox, fg, tol, gap)
    if not cells:
        return ""
    labels = [read_glyph(rgb, size, c, atlas, nw, nh, thr) for c in cells]
    if len(cells) == 1:
        return labels[0]
    gaps = [cells[i + 1][0] - cells[i][2] for i in range(len(cells) - 1)]
    srt = sorted(gaps)
    med = srt[len(srt) // 2]
    out = [labels[0]]
    for i, g in enumerate(gaps):
        if med > 0 and g >= space_k * med:
            out.append(" ")
        out.append(labels[i + 1])
    return "".join(out)


def segment_lines(rgb: bytes, size: tuple[int, int],
                  bbox: tuple[int, int, int, int],
                  fg: tuple[int, int, int], tol: int = 60,
                  gap: int = 4) -> list[tuple[int, int, int, int]]:
    """Split a text *block* into per-line bboxes by row-ink bands (F105).

    :func:`segment_run` and :func:`read_text` project ink down *columns* across
    the whole ``bbox`` — they assume a single horizontal line. Point them at two
    stacked lines and every column is inked by *both* lines at once: the column
    profile never falls blank between letters, the rows fuse vertically, and the
    run reads as garbage (live: an ``"OK"`` over ``"CAB"`` block reads ``'AXB'``,
    three merged columns, not the two words). A column cut cannot part rows the
    page stacked; that is :func:`read_text`'s named boundary.

    The orthogonal projection parts them. This counts ink per *row* of ``bbox``
    and groups the inked rows into bands separated by ``>= gap`` fully-blank rows
    — the inter-line leading. Each band is the tight vertical extent of one text
    line (x kept at the block's full width); reading order is top-to-bottom. It
    returns ``[]`` on blank ink: it parts only the blank leading the page left
    between lines and never invents a split inside a single line's x-height."""
    x0, y0, x1, y1 = bbox
    w, _h = size
    tr, tg, tb = fg

    def inked(y: int) -> bool:
        row = y * w * 3
        for x in range(x0, x1 + 1):
            j = row + x * 3
            if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                    and abs(rgb[j + 2] - tb) <= tol):
                return True
        return False

    bands: list[tuple[int, int, int, int]] = []
    start: int | None = None
    blanks = 0
    for y in range(y0, y1 + 1):
        if inked(y):
            if start is None:
                start = y
            blanks = 0
        elif start is not None:
            blanks += 1
            if blanks >= gap:
                bands.append((x0, start, x1, y - blanks))
                start = None
                blanks = 0
    if start is not None:
        bands.append((x0, start, x1, y1 - blanks))
    return bands


def read_block(rgb: bytes, size: tuple[int, int],
               bbox: tuple[int, int, int, int],
               atlas: dict[str, list[int]],
               fg: tuple[int, int, int], tol: int = 60, gap: int = 2,
               row_gap: int = 4,
               nw: int = 48, nh: int = 48, thr: int = 24) -> list[str]:
    """Read a multi-*line* text block from pixels (F105).

    The rung above :func:`read_text`: where that reads one horizontal run, this
    reads a *paragraph the page drew onto a canvas*. It :func:`segment_lines`-s
    the block into per-line bands by the blank leading between them (``row_gap``),
    then reads each band as an independent run with :func:`read_text`, returning
    one string per line in top-to-bottom order. A single-line block yields a
    one-element list (``read_text`` of the whole bbox); a blank region yields
    ``[]``. It still reads only glyphs the ``atlas`` carries and only lines a
    blank gap separates — it parts rows by absence of ink between them, never by
    guessing where a wrapped line *should* break."""
    bands = segment_lines(rgb, size, bbox, fg, tol, row_gap)
    if not bands:
        return []
    return [read_text(rgb, size, band, atlas, fg, tol, gap,
                      None, nw, nh, thr) for band in bands]


def detect_fg(rgb: bytes, size: tuple[int, int],
              bbox: tuple[int, int, int, int],
              q: int = 16, min_dist: int = 120
              ) -> tuple[tuple[int, int, int], tuple[int, int, int] | None]:
    """Recover the foreground (ink) colour of a region from its pixels (F109).

    Every reader below — :func:`segment_run`, :func:`read_text`, :func:`read_block`
    — demands the caller pass ``fg``, the text colour, and segments by proximity to
    it. But a control found by *layout* (a button's bounds, a label's box) arrives
    with no colour attached: you know *where* the text is, not what colour the page
    drew it. Without ``fg`` not one of those readers can run — the whole stack is
    blind to text whose colour it was not told in advance. That is the friction:
    location is not enough; reading needs the ink colour, and nothing here supplies
    it from the pixels themselves.

    The region carries the answer. A label is a large flat field of *background*
    pixels with a sparse scatter of *ink* on top: quantise the region to ``q``-step
    buckets and the background is simply the most frequent bucket, while the ink is
    the most frequent bucket that lies *far* from it (L1 distance ``> min_dist``).
    Anti-alias fringe colours sit *between* ink and background and are rarer than
    either, so they never win. This returns ``(bg, fg)`` — ``fg`` ready to hand to
    any reader (within its ``tol``, the quantised value still matches the true ink).

    Honest about absence: a *uniform* region (a blank panel, a solid fill) has no
    bucket far from its background, so ``fg`` is ``None`` — there is no ink to read,
    and it says so rather than promoting a fringe or noise pixel to "the colour".
    Feed a region that is mostly *not* its background (it fills more than half the
    box) and the roles invert as you would expect; this assumes the common case of
    sparse ink on a flat field, the shape a found control actually has."""
    w, _ = size
    x0, y0, x1, y1 = bbox
    hist: dict[tuple[int, int, int], int] = {}
    for y in range(y0, y1 + 1):
        row = y * w
        for x in range(x0, x1 + 1):
            j = (row + x) * 3
            key = (rgb[j] // q * q, rgb[j + 1] // q * q, rgb[j + 2] // q * q)
            hist[key] = hist.get(key, 0) + 1
    if not hist:
        return (0, 0, 0), None
    ranked = sorted(hist.items(), key=lambda kv: kv[1], reverse=True)
    bg = ranked[0][0]
    for col, _cnt in ranked[1:]:
        if sum(abs(a - b) for a, b in zip(col, bg)) > min_dist:
            return bg, col
    return bg, None


def learn_glyphs(rgb: bytes, size: tuple[int, int],
                 bbox: tuple[int, int, int, int],
                 label: str, fg: tuple[int, int, int] | None = None,
                 tol: int = 60, gap: int = 2,
                 nw: int = 48, nh: int = 48, thr: int = 24,
                 cells: list[tuple[int, int, int, int]] | None = None
                 ) -> dict[str, list[int]]:
    """Build a glyph ``atlas`` from a region whose text is *already known* (F198).

    Every reader below — :func:`read_glyph`, :func:`read_text`, :func:`read_region` —
    consumes an ``atlas`` of ``{label: edge_signature(...)}``, yet nothing here *built*
    one: each probe hand-rolled it from a fixture the test itself rendered (spaced
    swatches located by colour, zipped with the known string). That kept the whole
    perception ladder tethered to a fixture — you could only read a font you had first
    drawn yourself on a scratch canvas. The missing rung is the *teacher*: turn a patch
    of real on-screen text whose string you *do* know — a label whose caption the UIA
    tree reports, a cell you just typed, a word the app drew that you can name another
    way — into the atlas that then reads the *unknown* drawn text rendered in that same
    font. Truth begets truth: a known rendering teaches the reader to read the rest.

    Given the region's pixels and its true ``label``, this segments the run into one
    cell per non-space character (:func:`segment_run` by ``fg``; when the glyphs touch
    and yield too few cells it falls back to :func:`split_run` with the known count) and
    returns ``{char: edge_signature(cell)}`` — exactly the atlas the readers want,
    captured from the live rendering rather than a fixture. ``fg`` (the ink colour) may
    be omitted and is then recovered from the pixels by :func:`detect_fg`. A caller that
    has *already* cut the run may pass ``cells`` to skip segmentation (e.g. one isolated
    swatch per glyph). Repeated characters collapse to their last rendering (the same
    glyph, so harmless); spaces in ``label`` are skipped (they ink no cell).

    Honest only where the run can be *aligned* to its label: if segmentation cannot
    produce exactly one cell per non-space character — touching glyphs :func:`split_run`
    still cannot part, or stray ink — it returns ``{}`` rather than mislabel cells by a
    wrong-length zip (a shifted alignment would poison every later read). Empty ink or
    no recoverable ``fg`` likewise yields ``{}``. It teaches only what it can align with
    certainty; what it cannot, it declines to teach."""
    chars = [c for c in label if not c.isspace()]
    if not chars:
        return {}
    if cells is None:
        if fg is None:
            _bg, fg = detect_fg(rgb, size, bbox)
            if fg is None:
                return {}
        cells = segment_run(rgb, size, bbox, fg, tol, gap)
        if len(cells) < len(chars):
            cells = split_run(rgb, size, bbox, fg, len(chars), tol)
    if len(cells) != len(chars):
        return {}
    return {ch: edge_signature(rgb, size, c, nw, nh, thr)
            for ch, c in zip(chars, cells)}


def palette(rgb: bytes, size: tuple[int, int],
            bbox: tuple[int, int, int, int],
            q: int = 16, min_pop: float = 0.002, min_dist: int = 96
            ) -> list[tuple[int, int, int]]:
    """Recover *every* distinct colour in a region, frequency order (F110).

    :func:`detect_fg` answers "what is the one ink colour here?" — it returns the
    single most frequent bucket far from the background. But a region rarely holds
    just one ink: a status line draws a red word beside a green one, syntax
    highlighting paints three or four colours into one box, a label sits next to a
    coloured badge. Hand such a region to :func:`detect_fg` and it keeps only the
    most frequent ink and *silently drops the rest* — and since every reader
    (:func:`read_text`, :func:`read_block`) segments by a *single* ``fg``, the
    other-coloured words become unreadable. You cannot read what you were never
    told the colour of, and one ``fg`` can only name one colour.

    The region still carries the whole answer. Quantise to ``q``-step buckets and
    walk them in descending frequency, admitting a bucket only when it is at least
    ``min_dist`` (L1) from every colour already kept *and* holds at least
    ``min_pop`` of the region's pixels. The ``min_dist`` guard fuses each true
    colour's anti-alias fringe into the colour it edges (the fringe sits *between*
    two colours and is rarer than either, so it is never admitted as its own),
    and ``min_pop`` drops stray noise. The result is the region's palette: the
    background first (most pixels), then each ink, each ready to hand to a reader.

    Honest about the floor: a colour rarer than ``min_pop`` is not reported — a
    one-pixel speck is noise, not a colour the page meant to draw. Lower
    ``min_pop`` to surface fainter inks at the cost of admitting fringe; the
    default keeps only colours a reader could actually segment a glyph from."""
    w, _ = size
    x0, y0, x1, y1 = bbox
    hist: dict[tuple[int, int, int], int] = {}
    tot = 0
    for y in range(y0, y1 + 1):
        row = y * w
        for x in range(x0, x1 + 1):
            j = (row + x) * 3
            key = (rgb[j] // q * q, rgb[j + 1] // q * q, rgb[j + 2] // q * q)
            hist[key] = hist.get(key, 0) + 1
            tot += 1
    if not hist:
        return []
    floor = max(1, int(min_pop * tot))
    kept: list[tuple[int, int, int]] = []
    for col, cnt in sorted(hist.items(), key=lambda kv: kv[1], reverse=True):
        if cnt < floor:
            break
        if all(sum(abs(a - b) for a, b in zip(col, c)) > min_dist for c in kept):
            kept.append(col)
    return kept


def read_region(rgb: bytes, size: tuple[int, int],
                bbox: tuple[int, int, int, int],
                atlas: dict[str, list[int]],
                tol: int = 60, gap: int = 2,
                nw: int = 48, nh: int = 48, thr: int = 24,
                q: int = 16, min_pop: float = 0.002, min_dist: int = 96) -> str:
    """Read *all* text in a region, across every colour, in reading order (F111).

    :func:`read_text` segments by a *single* ``fg`` — :func:`segment_run` marks a
    column inked only where a pixel sits within ``tol`` of that one colour. Hand it
    a region holding two differently-coloured words (a red ``"OK"`` beside a green
    ``"GO"``, a black label next to a coloured value) and it reads only the run of
    its given colour: every other-coloured glyph is *background* to it, and the
    line comes back half-read. :func:`palette` (F110) can now *name* every ink in
    the region, but naming is not reading — there was still no primitive that turns
    the whole multi-coloured region into the string a human sees.

    This is that primitive. It asks :func:`palette` for the region's colours, drops
    the first (the background — the most pixels are the field the text sits on), and
    for *each* remaining ink :func:`segment_run`-s the region by that colour into
    per-glyph cells. Every cell from every ink is then gathered and **sorted by its
    left edge**, so the glyphs fall back into the single left-to-right order the eye
    reads regardless of which colour drew them, and each is classified in the
    scale-free frame (:func:`read_glyph` against ``atlas``). The labels join into the
    region's full text: ``"OKGO"`` where one ``fg`` read only ``"OK"``.

    Honest about its frame. It reads each ink as a *run of glyphs*: an ink that is a
    solid fill (a coloured badge, a progress bar) has no inter-glyph blanks and
    segments as one wide cell that :func:`read_glyph` will mislabel — ``read_region``
    reads the *text* colours of a region, not its decorations, and the caller scopes
    ``bbox`` to a text area. Ordering is by left edge, so words separated in x merge
    correctly; truly interleaved colours (a single word painted letter-by-letter in
    alternating inks) order by each glyph's own column, which is still reading order.
    Empty region (no ink above :func:`palette`'s floor) → ``""``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    cells: list[tuple[int, tuple[int, int, int, int]]] = []
    for ink in inks:
        for c in segment_run(rgb, size, bbox, ink, tol, gap):
            cells.append((c[0], c))
    cells.sort(key=lambda t: t[0])
    return "".join(read_glyph(rgb, size, c, atlas, nw, nh, thr) for _, c in cells)


def read_region_words(rgb: bytes, size: tuple[int, int],
                      bbox: tuple[int, int, int, int],
                      atlas: dict[str, list[int]],
                      tol: int = 60, gap: int = 2, space_k: float = 1.8,
                      nw: int = 48, nh: int = 48, thr: int = 24,
                      q: int = 16, min_pop: float = 0.002,
                      min_dist: int = 96) -> str:
    """Read all text in a region across every colour, *with its word spaces* (F113).

    :func:`read_region` (F111) gathers every ink's glyph cells, sorts them by left
    edge and joins the labels with *nothing* between them — so a two-colour line
    ``"OK GO"`` (red ``OK`` beside green ``GO``) reads ``"OKGO"``: the word gap the
    page left is dropped, exactly as :func:`read_text` dropped it before F106.
    :func:`read_words` (F106) recovers the space, but it :func:`segment_run`-s by a
    *single* ``fg``, so on that two-colour line it reads only one colour's word
    (``"OK"`` given red, ``"GO"`` given green) — never the whole line with its seam.

    This composes the two. As :func:`read_region`, it asks :func:`palette` for the
    region's inks (dropping the background) and :func:`segment_run`-s each ink into
    per-glyph cells, gathering every cell from every colour and sorting by left
    edge — the single left-to-right order the eye reads. Then, as :func:`read_words`,
    it measures the horizontal blank between adjacent cells, takes the median as the
    typical inter-letter gap, and inserts a single ``' '`` wherever a gap is
    ``>= space_k`` times that median — a word seam, regardless of which colours sit
    on either side. ``"OK GO"`` where :func:`read_region` read ``"OKGO"`` and
    :func:`read_words` read only ``"OK"``.

    Honest where :func:`read_region` and :func:`read_words` are: it reads a single
    *line* (use :func:`read_block_region` first to part stacked lines), each ink as
    a run of glyphs, and only splits where the spacing is *bimodal* — a region whose
    cells are evenly tracked yields no seam rather than an invented space. Empty
    region (no ink above :func:`palette`'s floor) → ``""``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    cells: list[tuple[int, int, int, int]] = []
    for ink in inks:
        cells.extend(segment_run(rgb, size, bbox, ink, tol, gap))
    if not cells:
        return ""
    cells.sort(key=lambda c: c[0])
    labels = [read_glyph(rgb, size, c, atlas, nw, nh, thr) for c in cells]
    if len(cells) == 1:
        return labels[0]
    gaps = [cells[i + 1][0] - cells[i][2] for i in range(len(cells) - 1)]
    srt = sorted(gaps)
    med = srt[len(srt) // 2]
    out = [labels[0]]
    for i, g in enumerate(gaps):
        if med > 0 and g >= space_k * med:
            out.append(" ")
        out.append(labels[i + 1])
    return "".join(out)


def read_block_region(rgb: bytes, size: tuple[int, int],
                      bbox: tuple[int, int, int, int],
                      atlas: dict[str, list[int]],
                      tol: int = 60, gap: int = 2, row_gap: int = 4,
                      nw: int = 48, nh: int = 48, thr: int = 24,
                      q: int = 16, min_pop: float = 0.002,
                      min_dist: int = 96) -> list[str]:
    """Read a multi-*line*, multi-*colour* block, line by line, in order (F112).

    The two readers above each see only half of a coloured paragraph.
    :func:`read_block` (F105) parts the lines — but by a *single* ``fg``, so
    :func:`segment_lines` bands rows only where *that one colour* inks them: give
    it a block whose first line is red and second green and it finds one band and
    reads ``["RED"]``, the green line invisible (live). :func:`read_region` (F111)
    reads *every* colour — but it flattens the whole ``bbox`` into one x-sorted run,
    so two stacked lines interleave by column: ``"OK GO"`` over ``"NO BY"`` reads
    ``"ONOKGBYO"``, every word shattered across the line break. One reader keeps the
    colours and loses the rows; the other keeps the rows and loses the colours.

    This keeps both. It asks :func:`palette` for the block's inks, then bands the
    rows the way :func:`segment_lines` does but counting a row inked when *any* ink
    touches it (not one named ``fg``) — so a line of any colour, or of several,
    raises its own band, parted from its neighbours by ``>= row_gap`` blank rows of
    leading. Each band, top-to-bottom, is then handed to :func:`read_region`, which
    reads that line across all its colours in left-to-right order. The result is one
    string per line: ``["OKGO", "NOBY"]`` where ``read_region`` alone read
    ``"ONOKGBYO"`` and ``read_block`` alone read only the lines of its one colour.

    Honest in the same frame as its parts: it parts rows only by the blank leading
    the page left between lines (never guessing a wrap inside an x-height), reads
    only glyphs the ``atlas`` carries, and reads *text* colours, not solid-fill
    decorations. A block with no ink above :func:`palette`'s floor → ``[]``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    if not inks:
        return []
    bands = _band_rows(rgb, size, bbox, inks, tol, row_gap)
    return [read_region(rgb, size, band, atlas, tol, gap, nw, nh, thr,
                        q, min_pop, min_dist) for band in bands]


def _band_rows(rgb: bytes, size: tuple[int, int],
               bbox: tuple[int, int, int, int],
               inks: list[tuple[int, int, int]],
               tol: int, row_gap: int) -> list[tuple[int, int, int, int]]:
    """Band a region's rows into per-line bboxes by *any* ink (F112/F114).

    A row counts as inked when *any* colour in ``inks`` touches it (not one named
    ``fg``), so a line of any colour — or of several — raises its own band, parted
    from its neighbours by ``>= row_gap`` blank rows of leading. Shared by
    :func:`read_block_region` and :func:`read_block_region_words` so the two read a
    block by the *same* rows, differing only in how each band is then read."""
    x0, y0, x1, y1 = bbox
    w, _h = size

    def inked(y: int) -> bool:
        row = y * w * 3
        for x in range(x0, x1 + 1):
            j = row + x * 3
            pr, pg, pb = rgb[j], rgb[j + 1], rgb[j + 2]
            for ir, ig, ib in inks:
                if (abs(pr - ir) <= tol and abs(pg - ig) <= tol
                        and abs(pb - ib) <= tol):
                    return True
        return False

    bands: list[tuple[int, int, int, int]] = []
    start: int | None = None
    blanks = 0
    for y in range(y0, y1 + 1):
        if inked(y):
            if start is None:
                start = y
            blanks = 0
        elif start is not None:
            blanks += 1
            if blanks >= row_gap:
                bands.append((x0, start, x1, y - blanks))
                start = None
                blanks = 0
    if start is not None:
        bands.append((x0, start, x1, y1 - blanks))
    return bands


def read_block_region_words(rgb: bytes, size: tuple[int, int],
                            bbox: tuple[int, int, int, int],
                            atlas: dict[str, list[int]],
                            tol: int = 60, gap: int = 2, row_gap: int = 4,
                            space_k: float = 1.8,
                            nw: int = 48, nh: int = 48, thr: int = 24,
                            q: int = 16, min_pop: float = 0.002,
                            min_dist: int = 96) -> list[str]:
    """Read a multi-*line*, multi-*colour* block *with its word spaces* (F114).

    :func:`read_block_region` (F112) parts a coloured paragraph into lines and reads
    each across every colour — but through :func:`read_region`, which joins a line's
    glyph cells with *nothing* between them. So a block whose lines each carry a word
    seam, ``"OK GO"`` over ``"NO BY"``, reads ``["OKGO", "NOBY"]``: the rows are kept,
    the colours are kept, but every word gap inside a line is dropped — the F113
    friction, now one level up at block scope. :func:`read_region_words` (F113)
    recovers a line's seams, but it flattens the *whole* ``bbox`` into one x-sorted
    run, so handed a two-line block its lines interleave by column and every word
    shatters across the line break. One reader keeps the rows and loses the seams;
    the other keeps the seams and loses the rows.

    This keeps both. It bands the block's rows exactly as :func:`read_block_region`
    does (:func:`_band_rows`, a row inked by *any* palette ink, lines parted by
    ``>= row_gap`` blank leading), then reads each band, top-to-bottom, with
    :func:`read_region_words` instead of :func:`read_region` — so every line comes
    back across all its colours *and* with the ``' '`` at each word seam its spacing
    is bimodal about. The result is one spaced string per line:
    ``["OK GO", "NO BY"]`` where :func:`read_block_region` read ``["OKGO", "NOBY"]``
    and :func:`read_region_words` alone scrambled the rows together.

    Honest in the union of its parts' frames: it parts rows only by the blank leading
    the page left between lines (never a wrap inside an x-height), reads each line's
    inks as runs of glyphs, splits a line only where its spacing is *bimodal* (an
    evenly-tracked line yields no invented space), reads only glyphs the ``atlas``
    carries, and reads *text* colours, not solid-fill decorations. A single-line
    block is ``[read_region_words(...)]``; a block with no ink above
    :func:`palette`'s floor → ``[]``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    if not inks:
        return []
    bands = _band_rows(rgb, size, bbox, inks, tol, row_gap)
    return [read_region_words(rgb, size, band, atlas, tol, gap, space_k,
                              nw, nh, thr, q, min_pop, min_dist)
            for band in bands]


def _line_words(rgb: bytes, size: tuple[int, int],
                bbox: tuple[int, int, int, int],
                atlas: dict[str, list[int]],
                tol: int, gap: int, space_k: float, nw: int, nh: int, thr: int,
                q: int, min_pop: float, min_dist: int
                ) -> list[tuple[str, tuple[int, int, int, int]]]:
    """Read one line's words as ``(label, bbox)`` pairs in reading order (F115/F117).

    The shared spine under :func:`locate_word` and :func:`locate_phrase`: it
    gathers every ink's glyph cells across ``bbox`` (:func:`palette` +
    :func:`segment_run`), sorts them left-to-right, groups them into words at the
    *bimodal* seam (a gap ``>= space_k`` times the median cell gap — the F113
    boundary), reads each group (:func:`read_glyph` against ``atlas``), and returns
    each word's label paired with the union bbox of its cells (tight to the word's
    ink, in :func:`capture_rgb`/:func:`click` screen coordinates). One *line*: band
    a block first. Empty region → ``[]``."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    cells: list[tuple[int, int, int, int]] = []
    for ink in inks:
        cells.extend(segment_run(rgb, size, bbox, ink, tol, gap))
    if not cells:
        return []
    cells.sort(key=lambda c: c[0])
    gaps = [cells[i + 1][0] - cells[i][2] for i in range(len(cells) - 1)]
    med = sorted(gaps)[len(gaps) // 2] if gaps else 0
    groups: list[list[tuple[int, int, int, int]]] = []
    cur = [cells[0]]
    for i, g in enumerate(gaps):
        if med > 0 and g >= space_k * med:
            groups.append(cur)
            cur = []
        cur.append(cells[i + 1])
    groups.append(cur)
    out: list[tuple[str, tuple[int, int, int, int]]] = []
    for grp in groups:
        label = "".join(read_glyph(rgb, size, c, atlas, nw, nh, thr) for c in grp)
        out.append((label, (min(c[0] for c in grp), min(c[1] for c in grp),
                            max(c[2] for c in grp), max(c[3] for c in grp))))
    return out


def locate_word(rgb: bytes, size: tuple[int, int],
                bbox: tuple[int, int, int, int],
                atlas: dict[str, list[int]], target: str,
                tol: int = 60, gap: int = 2, space_k: float = 1.8,
                nw: int = 48, nh: int = 48, thr: int = 24,
                q: int = 16, min_pop: float = 0.002,
                min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Find a word by its *text* and return *where* it sits — its bbox (F115).

    Every reader from F103 on answers *what* the pixels say and throws the rest
    away: :func:`segment_run` knows each glyph's bbox, but :func:`read_region` and
    :func:`read_region_words` fold those cells into a single joined string and the
    positions are gone. So an agent that has just *read* ``"GO"`` off a ``<canvas>``
    button still cannot *press* it — there is no DOM node for :func:`Browser.click`
    to find, and the pixel finders (:func:`find_color`, :func:`template_match`)
    locate by *colour* or *bitmap*, never by the *word* the eye actually read.
    Reading and acting were split: you could name the text or you could find a
    shape, but not click the text you named.

    This closes that loop. It gathers every ink's glyph cells across the region
    (:func:`palette` + :func:`segment_run`, as :func:`read_region_words`), sorts
    them left-to-right and groups them into words at the same *bimodal* gap a seam
    lives in (a run of cells, then a gap ``>= space_k`` times the median cell gap,
    then the next word). Each group is read in the scale-free frame
    (:func:`read_glyph` against ``atlas``) and compared to ``target``; the first
    group whose label matches returns the **union bbox of its cells** — tight to the
    word's ink, in the same screen coordinates :func:`capture_rgb` and
    :func:`click` share. Hand that bbox's centre to :func:`click` and the agent
    presses the very word it read.

    Honest in the frame of its readers: ``target`` is a *single* word (it matches a
    run between seams, never a string with its own space), it reads only glyphs the
    ``atlas`` carries and *text* colours, not solid-fill decorations, and it parts
    words only where the spacing is bimodal. A word the region does not hold — or
    that the atlas cannot spell — returns ``None`` rather than a guessed location;
    repeated words return the *leftmost* match (reading order)."""
    for label, box in _line_words(rgb, size, bbox, atlas, tol, gap, space_k,
                                  nw, nh, thr, q, min_pop, min_dist):
        if label == target:
            return box
    return None


def locate_labels(rgb: bytes, size: tuple[int, int],
                  bbox: tuple[int, int, int, int],
                  labels: list[str], fg: tuple[int, int, int],
                  tol: int = 60, gap: int = 4, axis: str = "x",
                  min_w: int = 4) -> dict[str, tuple[int, int, int, int]]:
    """Map an ordered list of *known* labels to their rects by run-segmentation
    alone — no glyph atlas (F181).

    Every reader from F103 on (:func:`read_text`, :func:`locate_word`) needs an
    ``atlas`` of the target font's glyphs, and the only way the floor could build
    one was rendering reference glyphs *itself* on a browser scratch canvas — so
    it stayed literate only on the web and blind to every *native* canvas app
    (Blender, a CAD viewport, a video timeline) whose font it cannot reproduce.
    Harvesting an atlas from the app's *own* rendering founders one rung lower, on
    *glyph* segmentation: a ~9px proportional anti-aliased label fuses or splits
    its letters unreliably (``"File"`` cuts into four, ``"Render"`` shatters into
    twelve), so per-character reading is lost — that is the named boundary of the
    atlas path on small native type.

    But you do not need to *read* a menu bar / dropdown / toolbar / tab strip to
    *act* on it: it is an *ordered sequence of known labels* parted by *wide* blank
    space, and item-level gaps are far larger and far more reliable than the
    inter-letter gaps that defeat glyph segmentation. With ``axis="x"`` this
    :func:`segment_run`-s ``bbox`` by the foreground colour ``fg`` into
    blank-*column*-separated runs (a horizontal bar/tab strip); with ``axis="y"``
    it parts the region into blank-*row*-separated bands (a vertical dropdown — the
    even more reliable case, since menu rows are spaced wider than letters are
    tall). Either way, *only when* the run count equals ``len(labels)`` it returns
    ``{label: rect}`` pairing each label to its run in reading order — a click
    target for every label, located by meaning, in the screen frame
    :func:`capture_rgb` and :func:`click` share, independent of pixel coordinates,
    window position or theme. Hand any rect's centre to :func:`click` to press the
    label you named.

    Honest boundary: it commits only when it can form *exactly* ``len(labels)``
    bands; if it cannot, it returns ``{}`` rather than risk pairing a label to the
    wrong box. It locates *known* labels in *known* order; it does not read unknown
    text (that is the atlas path, bounded above). Choose ``fg`` as the label ink
    colour; ``gap`` only seeds the fast path below.

    Two segmenters, fast then count-driven (F181). The fast path is a single fixed
    ``gap`` blank-run cut (:func:`segment_run` on ``x``, :func:`_segment_rows` on
    ``y``) — it nails *uniform* strips (a menu bar, a plain dropdown) in one pass.
    But a real menu is rarely uniform: the File menu interleaves shortcut text,
    submenu arrows and several separator rules, so *no* single ``gap`` yields the
    right band count (too small splits a separator in two, too large fuses two
    items). The robust path borrows the exact discipline of :func:`split_run`,
    which parts *touching glyphs* by cutting at the ``n-1`` deepest valleys once it
    is told the glyph count ``n``: here the honest extra knowledge is the *label*
    count, so when the fast path's band count ≠ ``len(labels)`` we cut the ink
    profile at its ``len(labels)-1`` **widest blank valleys** — exactly enough cuts
    to make exactly that many bands, robust to uneven item spacing because it ranks
    gaps relatively instead of thresholding them absolutely. It still degrades
    honestly: if there are fewer than ``len(labels)-1`` interior gaps, or any band
    comes out empty, it yields ``{}`` rather than a mispairing."""
    if axis == "y":
        cells = [c for c in _segment_rows(rgb, size, bbox, fg, tol, gap)
                 if c[3] - c[1] + 1 >= min_w]
        if len(cells) != len(labels):
            cells = _reject_thin(
                _segment_rows_n(rgb, size, bbox, fg, len(labels), tol),
                cross="x", min_w=min_w)
    else:
        cells = [c for c in segment_run(rgb, size, bbox, fg, tol, gap)
                 if c[2] - c[0] + 1 >= min_w]
        if len(cells) != len(labels):
            cells = _reject_thin(
                _segment_cols_n(rgb, size, bbox, fg, len(labels), tol),
                cross="y", min_w=min_w)
    if len(cells) != len(labels):
        return {}
    return {lab: cells[i] for i, lab in enumerate(labels)}


def _reject_thin(cells: list[tuple[int, int, int, int]], cross: str,
                 min_w: int, frac: float = 0.2) -> list[tuple[int, int, int, int]]:
    """Guard the count-driven path against a *count match with bad alignment*
    (F181). When :func:`_ink_runs_cut` is fed a profile with a spurious extra
    valley (e.g. shortcut text or an icon column in the File menu), it can still
    return the requested band count but with one cut displaced — leaving a band
    that hugs a 2–3px sliver of stray ink instead of a real label. Such a band is
    betrayed by its *cross-axis* extent (a real menu label is wide on ``y`` / tall
    on ``x``); if the thinnest band falls below both ``min_w`` and ``frac`` of the
    widest, the segmentation is untrustworthy, so this returns ``[]`` (→ caller
    yields ``{}``) rather than hand back a confident-but-wrong mapping."""
    if not cells:
        return cells
    ext = [(c[3] - c[1] + 1) if cross == "y" else (c[2] - c[0] + 1)
           for c in cells]
    floor = max(min_w, int(frac * max(ext)))
    return [] if min(ext) < floor else cells


def _segment_rows(rgb: bytes, size: tuple[int, int],
                  bbox: tuple[int, int, int, int],
                  fg: tuple[int, int, int], tol: int = 60,
                  gap: int = 4) -> list[tuple[int, int, int, int]]:
    """Split a vertical stack into one bbox per row — the transpose of
    :func:`segment_run` (F181). A row is *inked* if any pixel in it is within
    ``tol`` of ``fg``; rows are opened at the first inked row and closed once
    ``gap`` consecutive blank rows prove the inter-item space, then each band is
    tightened to its inked columns so the rect hugs the label. Returns bands in
    top-to-bottom reading order."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    tr, tg, tb = fg

    def inked_row(y: int) -> bool:
        base = y * w * 3
        for x in range(x0, x1 + 1):
            j = base + x * 3
            if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                    and abs(rgb[j + 2] - tb) <= tol):
                return True
        return False

    rows = [inked_row(y) for y in range(y0, y1 + 1)]
    bands: list[tuple[int, int]] = []
    start: int | None = None
    blanks = 0
    for i, ink in enumerate(rows):
        if ink:
            if start is None:
                start = i
            blanks = 0
        elif start is not None:
            blanks += 1
            if blanks >= gap:
                bands.append((y0 + start, y0 + i - blanks))
                start = None
                blanks = 0
    if start is not None:
        bands.append((y0 + start, y0 + len(rows) - 1 - blanks))

    out: list[tuple[int, int, int, int]] = []
    for ry0, ry1 in bands:
        minx, maxx = 1 << 30, -1
        for y in range(ry0, ry1 + 1):
            base = y * w * 3
            for x in range(x0, x1 + 1):
                j = base + x * 3
                if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                        and abs(rgb[j + 2] - tb) <= tol):
                    if x < minx:
                        minx = x
                    if x > maxx:
                        maxx = x
        if maxx >= 0:
            out.append((minx, ry0, maxx, ry1))
    return out


def _ink_runs_cut(inked: list[bool], n: int) -> list[tuple[int, int]]:
    """Cut the inked extent of ``inked`` into exactly ``n`` index-bands at its
    ``n-1`` *widest* interior blank runs (F181). This is the 1-D heart of the
    count-driven path shared by :func:`_segment_rows_n` / :func:`_segment_cols_n`,
    and the direct analogue of :func:`split_run` for glyphs: given the count ``n``
    it ranks gaps *relatively* (widest first) instead of thresholding them by an
    absolute ``gap``, so it parts items whose spacing is uneven (separators next to
    tight rows). Cuts land in the *middle* of each chosen blank run so each band
    keeps its item's ink. Returns ``[]`` when the inked span holds fewer than
    ``n-1`` interior gaps — honest 'cannot part into n' rather than a guess."""
    idx = [i for i, v in enumerate(inked) if v]
    if not idx:
        return []
    lo, hi = idx[0], idx[-1]
    if n <= 1:
        return [(lo, hi)]
    runs: list[tuple[int, int]] = []
    s: int | None = None
    for i in range(lo, hi + 1):
        if not inked[i]:
            if s is None:
                s = i
        elif s is not None:
            runs.append((s, i - 1))
            s = None
    if len(runs) < n - 1:
        return []
    ordered = sorted(runs, key=lambda r: r[1] - r[0] + 1, reverse=True)
    widest, rest = ordered[:n - 1], ordered[n - 1:]
    # Honest separation guard: the n-1 cuts may only be trusted if the *narrowest
    # chosen* gap is clearly wider than the *widest rejected* one. Otherwise the
    # cut is ambiguous — e.g. asking for one band too many on a uniform menu bar
    # forces a cut at an inter-*letter* gap no wider than the ones left uncut, which
    # would split a word. When item-gaps do not stand out from letter-gaps, refuse
    # (→ ``[]`` → caller yields ``{}``) rather than fabricate a band boundary.
    if rest:
        narrow_cut = widest[-1][1] - widest[-1][0] + 1
        wide_skip = rest[0][1] - rest[0][0] + 1
        if narrow_cut < 1.6 * wide_skip:
            return []
    mids = sorted((r[0] + r[1]) // 2 for r in widest)
    bands: list[tuple[int, int]] = []
    start = lo
    for m in mids:
        bands.append((start, m))
        start = m + 1
    bands.append((start, hi))
    return bands


def _segment_rows_n(rgb: bytes, size: tuple[int, int],
                    bbox: tuple[int, int, int, int],
                    fg: tuple[int, int, int], n: int,
                    tol: int = 60) -> list[tuple[int, int, int, int]]:
    """Count-driven row split (F181): part ``bbox`` into exactly ``n`` row-bands
    by :func:`_ink_runs_cut` over the inked-row profile, then tighten each band to
    its inked pixels. Returns fewer than ``n`` rects (→ caller yields ``{}``) when
    the region cannot honestly be parted into ``n`` non-empty bands."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    tr, tg, tb = fg

    def inked_row(y: int) -> bool:
        base = y * w * 3
        for x in range(x0, x1 + 1):
            j = base + x * 3
            if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                    and abs(rgb[j + 2] - tb) <= tol):
                return True
        return False

    rows = [inked_row(y) for y in range(y0, y1 + 1)]
    out: list[tuple[int, int, int, int]] = []
    for i0, i1 in _ink_runs_cut(rows, n):
        minx, maxx, miny, maxy = 1 << 30, -1, 1 << 30, -1
        for y in range(y0 + i0, y0 + i1 + 1):
            base = y * w * 3
            for x in range(x0, x1 + 1):
                j = base + x * 3
                if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                        and abs(rgb[j + 2] - tb) <= tol):
                    minx = x if x < minx else minx
                    maxx = x if x > maxx else maxx
                    miny = y if y < miny else miny
                    maxy = y if y > maxy else maxy
        if maxx >= 0:
            out.append((minx, miny, maxx, maxy))
    return out


def _segment_cols_n(rgb: bytes, size: tuple[int, int],
                    bbox: tuple[int, int, int, int],
                    fg: tuple[int, int, int], n: int,
                    tol: int = 60) -> list[tuple[int, int, int, int]]:
    """Count-driven column split (F181) — the ``x`` transpose of
    :func:`_segment_rows_n`: part ``bbox`` into exactly ``n`` column-bands at the
    ``n-1`` widest blank columns, then tighten each to its inked pixels."""
    w, _h = size
    x0, y0, x1, y1 = bbox
    tr, tg, tb = fg

    def inked_col(x: int) -> bool:
        for y in range(y0, y1 + 1):
            j = (y * w + x) * 3
            if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                    and abs(rgb[j + 2] - tb) <= tol):
                return True
        return False

    cols = [inked_col(x) for x in range(x0, x1 + 1)]
    out: list[tuple[int, int, int, int]] = []
    for i0, i1 in _ink_runs_cut(cols, n):
        minx, maxx, miny, maxy = 1 << 30, -1, 1 << 30, -1
        for x in range(x0 + i0, x0 + i1 + 1):
            for y in range(y0, y1 + 1):
                j = (y * w + x) * 3
                if (abs(rgb[j] - tr) <= tol and abs(rgb[j + 1] - tg) <= tol
                        and abs(rgb[j + 2] - tb) <= tol):
                    minx = x if x < minx else minx
                    maxx = x if x > maxx else maxx
                    miny = y if y < miny else miny
                    maxy = y if y > maxy else maxy
        if maxx >= 0:
            out.append((minx, miny, maxx, maxy))
    return out


def locate_block_word(rgb: bytes, size: tuple[int, int],
                      bbox: tuple[int, int, int, int],
                      atlas: dict[str, list[int]], target: str,
                      tol: int = 60, gap: int = 2, row_gap: int = 4,
                      space_k: float = 1.8,
                      nw: int = 48, nh: int = 48, thr: int = 24,
                      q: int = 16, min_pop: float = 0.002,
                      min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Find a word anywhere in a multi-*line* block and return its bbox (F116).

    :func:`locate_word` (F115) finds a word *in a single line*: it sorts every
    cell in the ``bbox`` by left edge and groups them by the gaps between. Hand it
    a two-line block and its lines interleave by column exactly as
    :func:`read_region_words` scrambled before F114 — a word on the second line
    has its cells shuffled in among the first line's, so its run never forms and
    the word is unfindable (or a bogus group spanning two lines reads as noise).
    The reach :func:`locate_word` opened was line-deep; a paragraph closed it
    again.

    This bands the block's rows first, exactly as :func:`read_block_region` and
    :func:`read_block_region_words` do (:func:`_band_rows`, a row inked by *any*
    palette ink, lines parted by ``>= row_gap`` blank leading), then runs
    :func:`locate_word` within each band, top band to bottom, returning the bbox of
    the first band that holds ``target``. So a word is found *where it sits in the
    paragraph* — its cells grouped only against its own line's neighbours, never a
    line above or below — and its bbox, in the screen frame :func:`capture_rgb` and
    :func:`click` share, is the place to press it.

    Honest in the union of its parts' frames: it parts rows only by the blank
    leading the page left between lines, reads each line's words at the bimodal
    seam, reads only glyphs the ``atlas`` carries and *text* colours, and returns
    the first match top-to-bottom then left-to-right (reading order). A word no
    line holds — or the atlas cannot spell — returns ``None``, not a guess."""
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    if not inks:
        return None
    for band in _band_rows(rgb, size, bbox, inks, tol, row_gap):
        hit = locate_word(rgb, size, band, atlas, target, tol, gap, space_k,
                          nw, nh, thr, q, min_pop, min_dist)
        if hit is not None:
            return hit
    return None


def locate_phrase(rgb: bytes, size: tuple[int, int],
                  bbox: tuple[int, int, int, int],
                  atlas: dict[str, list[int]], target: str,
                  tol: int = 60, gap: int = 2, row_gap: int = 4,
                  space_k: float = 1.8,
                  nw: int = 48, nh: int = 48, thr: int = 24,
                  q: int = 16, min_pop: float = 0.002,
                  min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Find a multi-*word* phrase and return the bbox spanning it (F117).

    :func:`locate_word`/:func:`locate_block_word` (F115/F116) reach a *single*
    word: each matches one run between seams, so a button labelled across a word
    space — ``Sign In``, ``Add To Cart``, here ``OK GO`` — is unfindable. Ask
    :func:`locate_word` for ``"OK GO"`` and it never matches (no single run carries
    the space); ask it for ``"OK"`` and you get only that word's box, its centre
    landing on *half* the button, not its middle. The locators could name where one
    word sits but not where a labelled control — a *run of words* — spans.

    This matches a phrase. It bands the block's rows (:func:`_band_rows`, as
    :func:`locate_block_word`) and within each line reads the words in order
    (:func:`_line_words`, the F115 spine), then slides a window over that line's
    word labels for the consecutive run equal to ``target`` split on spaces. The
    first match returns the **union bbox of exactly those words** — the whole
    label's extent, whose centre is the control's true middle, in
    :func:`capture_rgb`/:func:`click` screen coordinates. A one-word ``target`` is
    :func:`locate_block_word`; a phrase no line carries in order → ``None``.

    Honest in its parts' frames: the words must be *consecutive on one line* (it
    never stitches a phrase across a line break or out of reading order), it parts
    words only at the bimodal seam, reads only ``atlas`` glyphs and *text* colours,
    and returns the first match top-to-bottom, left-to-right. A phrase the page
    never wrote — or the atlas cannot spell — returns ``None``, not a guess."""
    want = target.split(" ")
    if not want:
        return None
    inks = palette(rgb, size, bbox, q, min_pop, min_dist)[1:]
    if not inks:
        return None
    n = len(want)
    for band in _band_rows(rgb, size, bbox, inks, tol, row_gap):
        words = _line_words(rgb, size, band, atlas, tol, gap, space_k,
                            nw, nh, thr, q, min_pop, min_dist)
        labels = [w[0] for w in words]
        for i in range(len(words) - n + 1):
            if labels[i:i + n] == want:
                boxes = [w[1] for w in words[i:i + n]]
                return (min(b[0] for b in boxes), min(b[1] for b in boxes),
                        max(b[2] for b in boxes), max(b[3] for b in boxes))
    return None


def wait_for_phrase(bbox: tuple[int, int, int, int],
                    atlas: dict[str, list[int]], target: str,
                    timeout: float = 5.0, interval: float = 0.15,
                    tol: int = 60, gap: int = 2, row_gap: int = 4,
                    space_k: float = 1.8,
                    nw: int = 48, nh: int = 48, thr: int = 24,
                    q: int = 16, min_pop: float = 0.002,
                    min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Wait until a word or phrase *appears* on screen, then return its bbox (F118).

    Every locator from F115 on reads a *single frame*: it asks :func:`capture_rgb`
    once and finds the target in that snapshot. But a GUI is a process in time — a
    result paints after a click, a page settles after a load — so the one capture
    an agent takes the instant it acts catches the screen *before* the word it
    waits for, and :func:`locate_phrase` honestly returns ``None`` for text that is
    a heartbeat from existing. Acting and observing were one tick apart: you could
    find what is already drawn, but not *wait* for what is coming. An agent that
    clicks and reads in the same breath reads the old screen.

    This closes the act → observe → act loop. It re-captures the screen on a fixed
    cadence (``interval`` seconds) and runs :func:`locate_phrase` over ``bbox`` each
    time, returning the moment the target first appears — its bbox in the same
    screen frame :func:`capture_rgb` and :func:`click` share, ready to press. If the
    text never shows within ``timeout`` seconds it returns ``None`` rather than
    blocking forever or guessing a place. So ``click(button); box =
    wait_for_phrase(field, atlas, "DONE"); click(box…)`` reads the screen as it
    *becomes*, not as it *was*.

    Honest in :func:`locate_phrase`'s frame at every poll (banded rows, bimodal
    seams, ``atlas`` glyphs, text colours, reading order) and honest about time: it
    promises only to look until the deadline, and a target that never arrives —
    or the atlas cannot spell — returns ``None``."""
    deadline = time.monotonic() + timeout
    while True:
        w, h, rgb = capture_rgb()
        hit = locate_phrase(rgb, (w, h), bbox, atlas, target, tol, gap, row_gap,
                            space_k, nw, nh, thr, q, min_pop, min_dist)
        if hit is not None:
            return hit
        if time.monotonic() >= deadline:
            return None
        time.sleep(interval)


def scroll_to_phrase(bbox: tuple[int, int, int, int],
                     atlas: dict[str, list[int]], target: str,
                     step: int = 5, max_steps: int = 40,
                     x: int | None = None, y: int | None = None,
                     settle: float = 0.25,
                     tol: int = 60, gap: int = 2, row_gap: int = 4,
                     space_k: float = 1.8,
                     nw: int = 48, nh: int = 48, thr: int = 24,
                     q: int = 16, min_pop: float = 0.002,
                     min_dist: int = 96) -> tuple[int, int, int, int] | None:
    """Scroll until a word or phrase comes into view, then return its bbox (F120).

    :func:`scroll` (F119) can reach past the fold, but only by a *guessed* amount:
    the caller must know how many notches the target lies below, and a fixed roll
    over- or under-shoots — too few and the word never enters the frame, too many
    and it flies past the top and out again (the F119 probe lost ``GO`` at the
    first overshoot). And :func:`locate_phrase` still only reads the one screenful
    it is handed. To *find* text on a surface taller than the window you must
    search and scroll together, and know when to stop.

    This marries the two. It looks for ``target`` in the current frame
    (:func:`locate_phrase` over ``bbox``); finding it, returns its bbox at once.
    Else it rolls the wheel down ``step`` notches over ``(x, y)`` (the region's
    centre by default) and looks again, walking the surface one screenful at a
    time, up to ``max_steps`` rolls — so ``box = scroll_to_phrase(field, atlas,
    "SUBMIT")`` brings a button anywhere down a long page into view and hands back
    where to press it, the window walking itself to the text instead of the caller
    counting notches.

    It bounds the search by ``max_steps`` rather than by pixels-stopped-changing,
    and that is deliberate honesty: a long blank stretch scrolls past while the
    captured screen does not change a single byte (the scrollbar thumb does not
    register in a GDI grab), so "the frame held still" cannot tell *bottomed out*
    from *still travelling through emptiness* — a pixel-only reader simply has no
    truthful bottom signal, and pretending one (stopping on a still frame) would
    abandon a target that lies just past the blank. So it promises only to look
    across ``max_steps`` successive screenfuls; set ``max_steps`` to cover the
    surface (``page_height / screenful`` rolls of ``step``).

    Honest in its parts' frames at every step (banded rows, bimodal seams,
    ``atlas`` glyphs, text colours) and honest about its reach: it reads only what
    each roll reveals and declares failure only after exhausting ``max_steps``.
    Leaves the surface scrolled at wherever it found the target (or as far as it
    walked); a word no screenful within reach holds — or the atlas cannot spell —
    returns ``None``."""
    if x is None:
        x = (bbox[0] + bbox[2]) // 2
    if y is None:
        y = (bbox[1] + bbox[3]) // 2
    for i in range(max_steps):
        w, h, rgb = capture_rgb()
        hit = locate_phrase(rgb, (w, h), bbox, atlas, target, tol, gap, row_gap,
                            space_k, nw, nh, thr, q, min_pop, min_dist)
        if hit is not None:
            return hit
        if i < max_steps - 1:
            scroll(dy=-step, x=x, y=y)
            time.sleep(settle)
    return None


# ==== F277–F302: the application-floor arc (reconstructed) ================== #
# The arc that took the floor from "controls a screen" to "operates the
# machine as a user does": launching apps with the a11y bus lit, speaking
# hotkeys as words, accepting window records everywhere, and reading text
# through the AT-SPI Text interface.

# uia_table_cell (F311): reach one cell of a spreadsheet/grid by (row, col)
# through the AT-SPI Table interface. LibreOffice Calc exposes a sheet of a
# million lazy rows — no tree walk ever reaches cell A3, and find_all's node
# budget is *right* to give up. Table.get_accessible_at is the O(1) door the
# toolkit built for exactly this. sheet_cell() speaks 'A3' directly.
uia_table_cell = getattr(_be, "uia_table_cell",
                         lambda win, row=0, col=0, name=None, ctype=None,
                         focus=False: None)


def _cell_ref(ref: str):
    """'A3' → (row=2, col=0). Column letters little-endian base-26."""
    i = 0
    while i < len(ref) and ref[i].isalpha():
        i += 1
    col = 0
    for ch in ref[:i].upper():
        col = col * 26 + (ord(ch) - 64)
    return int(ref[i:]) - 1, col - 1


def sheet_cell(win, ref: str, name=None, ctype=None, focus: bool = False):
    """Read one spreadsheet cell by its human ref ('A3', 'BC12'). Returns the
    cell record (with .text carrying what the cell shows) or None. focus=True
    also moves the app's cursor to the cell (coordinate-free — Calc reports
    cell extents shifted by the header row, so never click the rect)."""
    r, c = _cell_ref(ref)
    return uia_table_cell(win, row=r, col=c, name=name, ctype=ctype, focus=focus)


# uia_text (F286): read what a text-bearing surface *says* through the AT-SPI
# Text iface (worker-isolated like every semantic verb). The tree dual of
# read_selection: meaning for what is exposed, the copy channel for what is
# only drawn.
uia_text = getattr(_be, "uia_text", lambda win, name=None, ctype=None: "")
# set_num_desktops (F292): the write dual of num_desktops — grow/shrink the
# workspace set itself, completing the full workspace lifecycle.
set_num_desktops = getattr(_be, "set_num_desktops", lambda n: False)
num_desktops = getattr(_be, "num_desktops", lambda: 1)
current_desktop = getattr(_be, "current_desktop", lambda: 0)
set_desktop = getattr(_be, "set_desktop", lambda n: False)
move_window_to_desktop = getattr(_be, "move_window_to_desktop", lambda win, n: False)
window_desktop = getattr(_be, "window_desktop", lambda win: 0)


def _win_id(win) -> int:
    """F277: window-handle composition. list_windows/wait_window yield window
    *records* ``{"id","title",…}`` but the verbs took bare ids, so every call
    site paid a ``w["id"]`` toll and the one time it was forgotten the verb
    silently acted on garbage. Every window-taking verb now accepts either."""
    if isinstance(win, dict):
        return int(win["id"])
    if win is None:
        raise ValueError("window verb got None (upstream launch/find/wait "
                         "returned nothing — check its result before acting)")
    return int(win)


def _wrap_win_verbs():
    g = globals()
    for nm in ("activate_window", "close_window", "window_exists", "window_geometry",
               "move_window", "window_state", "set_window_state", "window_pid",
               "terminate_window", "set_window_topmost", "is_window_topmost",
               "window_desktop", "move_window_to_desktop",
               "window_on_current_desktop",
               "uia_name", "uia_children", "uia_find", "uia_find_all", "uia_invoke",
               "uia_get_value", "uia_set_value", "uia_focus", "uia_click",
               "uia_select", "uia_is_selected", "uia_toggle", "uia_toggle_state",
               "uia_expand", "uia_collapse", "uia_expand_state", "uia_text",
               "uia_table_cell", "sheet_cell"):
        fn = g.get(nm)
        if fn is None:
            continue

        def mk(f):
            def wrapped(win, *a, **kw):
                return f(_win_id(win), *a, **kw)
            wrapped.__name__ = getattr(f, "__name__", "wrapped")
            wrapped.__doc__ = getattr(f, "__doc__", None)
            return wrapped
        g[nm] = mk(fn)


_wrap_win_verbs()


_type_unicode_raw = type_unicode


def type_unicode(text: str) -> None:  # noqa: F811 — deliberate re-bind (F278)
    """F278: '\\n' in typed text becomes a real Return press. The X keysym path
    types LF as a glyph most toolkits ignore, so multi-line typing silently
    collapsed to one line; splitting on newlines and tapping Return between
    segments makes typed text mean what a person typing it would mean."""
    parts = text.split("\n")
    for i, part in enumerate(parts):
        if part:
            _type_unicode_raw(part)
        if i < len(parts) - 1:
            tap(VK_RETURN)
            time.sleep(0.03)


# F284: the full VK alphabet, and hotkeys as words. chord() took raw VK codes,
# so every accelerator call site carried magic numbers; hotkey('ctrl+shift+e')
# says what a keyboard shortcut *is*.
_VK_BY_NAME = {
    "ctrl": 0x11, "control": 0x11, "alt": 0x12, "menu": 0x12, "shift": 0x10,
    "win": 0x5B, "super": 0x5B, "meta": 0x5B, "cmd": 0x5B,
    "enter": 0x0D, "return": 0x0D, "esc": 0x1B, "escape": 0x1B, "tab": 0x09,
    "space": 0x20, "backspace": 0x08, "delete": 0x2E, "del": 0x2E,
    "insert": 0x2D, "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pgup": 0x21, "pagedown": 0x22, "pgdn": 0x22,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "comma": 0xBC, "period": 0xBE, "minus": 0xBD, "plus": 0xBB, "equals": 0xBB,
    "slash": 0xBF, "semicolon": 0xBA, "quote": 0xDE, "backslash": 0xDC,
    "bracketleft": 0xDB, "bracketright": 0xDD, "grave": 0xC0,
}
for _c in range(26):
    _VK_BY_NAME[chr(ord("a") + _c)] = 0x41 + _c
for _c in range(10):
    _VK_BY_NAME[str(_c)] = 0x30 + _c
for _c in range(1, 13):
    _VK_BY_NAME[f"f{_c}"] = 0x70 + _c - 1


def hotkey(spec: str, *more: str, hold: float = 0.0) -> None:
    """F284: speak a keyboard shortcut as the word it is — ``'ctrl+shift+e'``,
    ``'alt+f4'``, ``'ctrl+l'``. Presses in order, releases in reverse (the
    chord discipline); ``hold`` keeps the chord down for state-sampling
    surfaces (see :func:`tap`).

    F317: ``hotkey('ctrl', 'z')`` — the pyautogui-shaped spelling — used to
    bind ``'z'`` to *hold* and die comparing str to int. Both spellings are
    natural enough that the floor should speak them; extra positional args
    now join the chord."""
    if more:
        spec = "+".join((spec,) + tuple(more))
    vks = []
    for part in spec.replace(" ", "").split("+"):
        vk = _VK_BY_NAME.get(part.lower())
        if vk is None:
            raise ValueError(f"hotkey: unknown key {part!r}")
        vks.append(vk)
    # F318: never leave a chord half-pressed. An exception between the downs
    # and the ups (bad `hold`, a dying display connection) left Ctrl stuck
    # down for the whole session — every later keystroke and click silently
    # became Ctrl+<x> (Esc opened KDE's System Activity, clicks toggled
    # selections). The downs are now always unwound.
    pressed = []
    try:
        for vk in vks:
            key_down(vk)
            pressed.append(vk)
        if hold > 0:
            time.sleep(hold)
    finally:
        for vk in reversed(pressed):
            key_up(vk)


def replace_text(text: str, settle: float = 0.08) -> None:
    """F300: put a field into a KNOWN state before typing. Prefilled fields
    (a highscore dialog with the previous name, a rename box with the old
    name) make blind typing *append*, not replace — select-all, delete, then
    type, so the field afterwards holds exactly ``text``."""
    chord(VK_CONTROL, VK_A)
    time.sleep(settle)
    tap(0x2E)  # VK_DELETE
    time.sleep(settle)
    if text:
        type_unicode(text)


def bbox_of(obj):
    """F289: one verb from *any* located thing to its screen box (x, y, w, h).
    uia records carry ``rect=(x,y,w,h)``, windows carry geometry dicts, pixel
    verbs hand back 4-tuples — every call site was recomposing corners by
    hand. Returns None when the thing has no on-screen box."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        if "rect" in obj:
            return tuple(obj["rect"]) if obj["rect"] else None
        if "id" in obj:
            g = window_geometry(obj)
            return (g["x"], g["y"], g["w"], g["h"]) if g else None
        if {"x", "y", "w", "h"} <= set(obj):
            return (obj["x"], obj["y"], obj["w"], obj["h"])
    if isinstance(obj, (tuple, list)) and len(obj) == 4:
        return tuple(obj)
    g = window_geometry(obj)   # bare window id
    return (g["x"], g["y"], g["w"], g["h"]) if g else None


def center_of(obj):
    """Centre point of :func:`bbox_of` — where a click on it should land."""
    r = bbox_of(obj)
    if r is None:
        return None
    return (r[0] + r[2] // 2, r[1] + r[3] // 2)


def click_center(obj, right: bool = False) -> bool:
    """Click the centre of any located thing (uia record / window / rect)."""
    c = center_of(obj)
    if c is None:
        return False
    click(c[0], c[1], right=right)
    return True


def _session_bus() -> str | None:
    """F303: FIND the session bus before speaking on it. On a VNC/plasma
    ground the desktop's dbus-daemon was started by dbus-launch and its
    address (an abstract socket) never reaches a fresh shell's environment —
    so every dbus word (including lighting the a11y bus, hence the entire
    semantic floor) fails with 'No such file or directory'. Discover it:
    env var if set; else any same-uid process that carries it; else the
    abstract ``@/tmp/dbus-*`` sockets in /proc/net/unix, probed with a real
    dbus call. The winning address is exported so the AT-SPI workers and
    every launched app inherit it."""
    import os
    import subprocess
    cands = []
    a = os.environ.get("DBUS_SESSION_BUS_ADDRESS")
    if a:
        cands.append(a)
    uid = os.getuid()
    try:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            p = f"/proc/{pid}"
            try:
                if os.stat(p).st_uid != uid:
                    continue
                with open(p + "/environ", "rb") as f:
                    for kv in f.read().split(b"\0"):
                        if kv.startswith(b"DBUS_SESSION_BUS_ADDRESS="):
                            cands.append(kv.split(b"=", 1)[1].decode())
            except OSError:
                continue
    except OSError:
        pass
    try:
        with open("/proc/net/unix") as f:
            for ln in f:
                cols = ln.split()
                if cols and cols[-1].startswith("@/tmp/dbus-"):
                    cands.append("unix:abstract=" + cols[-1][1:])
    except OSError:
        pass
    for addr in dict.fromkeys(cands):
        try:
            # NB: probe with --session + env, not --address=: dbus-send in
            # address mode speaks peer-to-peer and the daemon rejects it
            # ('tried to send a message other than Hello').
            env = dict(os.environ, DBUS_SESSION_BUS_ADDRESS=addr)
            r = subprocess.run(
                ["dbus-send", "--session", "--print-reply",
                 "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus",
                 "org.freedesktop.DBus.GetId"],
                capture_output=True, timeout=3, env=env)
            if r.returncode == 0:
                os.environ["DBUS_SESSION_BUS_ADDRESS"] = addr
                return addr
        except Exception:
            continue
    return None


_a11y_lit = [False]


def _light_a11y() -> None:
    """F281: the semantic floor lights its own ground. AT-SPI registration is
    gated on the session a11y flag; on a fresh VM it is off, so every launched
    app would come up semantically dark. Flip org.a11y.Status.IsEnabled (and
    the GTK gsettings twin) once per session before the first launch."""
    if _a11y_lit[0]:
        return
    _a11y_lit[0] = True
    _session_bus()          # F303: make sure we are on the desktop's bus
    import subprocess
    for cmd in (
        ["dbus-send", "--session", "--type=method_call",
         "--dest=org.a11y.Bus", "/org/a11y/bus",
         "org.freedesktop.DBus.Properties.Set", "string:org.a11y.Status",
         "string:IsEnabled", "variant:boolean:true"],
        ["gsettings", "set", "org.gnome.desktop.interface",
         "toolkit-accessibility", "true"],
    ):
        try:
            subprocess.run(cmd, capture_output=True, timeout=5)
        except Exception:
            pass


def launch(argv, wait_title: str | None = None, timeout: float = 20.0,
           env: dict | None = None):
    """F282 (+F283, F287): start an application the way the floor needs it —
    a11y-lit and tracked to its window.

    * lights the session a11y bus first (F281) and exports the per-toolkit
      bridge variables (``GTK_MODULES=gail:atk-bridge``, ``QT_ACCESSIBILITY=1``,
      …) so the app registers on the semantic floor at *process birth* — a11y
      is decided when the process starts, not later (F302);
    * resolves the binary against PATH **plus /usr/games** (F287 — Debian puts
      every game there and login shells see it, but a bare Popen does not);
    * watches ``list_windows`` and returns the NEW window record that appears
      (title containing ``wait_title`` if given), or None on timeout — so the
      caller holds the window, not just a pid."""
    import os
    import shlex
    import shutil
    import subprocess
    if isinstance(argv, str):
        argv = shlex.split(argv)
    argv = list(argv)
    path = os.environ.get("PATH", "") + os.pathsep + "/usr/games"
    exe = shutil.which(argv[0], path=path)
    if exe:
        argv[0] = exe
    _light_a11y()
    e = dict(os.environ)
    e.update({"GTK_MODULES": "gail:atk-bridge", "QT_ACCESSIBILITY": "1",
              "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1", "GNOME_ACCESSIBILITY": "1"})
    e.pop("NO_AT_BRIDGE", None)
    if env:
        e.update(env)
    before = {w["id"] for w in list_windows()}
    try:
        proc = subprocess.Popen(argv, env=e, start_new_session=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        # F306: an absent binary is an ordinary answer, not a crash \u2014 the floor
        # speaks in None (like every locate verb) so the caller can decide to
        # install, substitute, or report.
        return None
    deadline = time.time() + timeout
    while time.time() < deadline:
        for w in list_windows():
            if w["id"] in before:
                continue
            if wait_title is None or wait_title.lower() in (w.get("title") or "").lower():
                w["pid"] = proc.pid
                return w
        if proc.poll() is not None and wait_title is None:
            break
        time.sleep(0.25)
    return None


_omnibox_go_raw = omnibox_go


def omnibox_go(url: str) -> None:  # noqa: F811 — deliberate re-bind (F280)
    """F280: the omnibox verb *aims at a browser* first. Ctrl+L means
    'focus address bar' only inside a browser window; fired at whatever holds
    focus it types into documents. Find and raise a browser window, then do
    the atomic focus/paste/Enter."""
    for w in list_windows():
        t = (w.get("title") or "").lower()
        if any(b in t for b in ("chrome", "chromium", "firefox", "falkon",
                                "konqueror", "epiphany", "edge")):
            activate_window(w)
            time.sleep(0.25)
            break
    _omnibox_go_raw(url)


def read_selection_retry(tries: int = 4, settle: float = 0.15,
                         restore: bool = True) -> str:
    """F279: X selection transfer is asynchronous — a fixed post-copy sleep
    races the owner. Retry the read until the clipboard turns non-empty (or
    tries run out), which converts a timing guess into an observed fact."""
    out = ""
    for _ in range(max(1, tries)):
        out = read_selection(restore=restore, settle=settle)
        if out:
            return out
        time.sleep(settle)
    return out


if __name__ == "__main__":
    print("screen:", screen_size())
    rt = "agentctl osctl clipboard round-trip \u2713"
    set_clipboard(rt)
    print("clipboard ok:", get_clipboard() == rt)
    out = screenshot("osctl_desktop.png")
    import os as _os
    print("screenshot:", out, _os.path.getsize(out), "bytes")
