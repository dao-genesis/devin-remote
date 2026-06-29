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

import re
import struct
import sys
import time
import zlib

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
                     search: tuple[int, int, int, int] | None = None) -> list[dict]:
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
    occupies only a fraction of it. Returned coordinates stay absolute."""
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

    for y in range(by0, by1 + 1):
        row = y * stride
        base = y * w
        up_base = base - w
        for x in range(bx0, bx1 + 1):
            i = row + x * 3
            if (abs(rgb[i] - tr) <= tol and abs(rgb[i + 1] - tg) <= tol
                    and abs(rgb[i + 2] - tb) <= tol):
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


def wait_until_stable(bbox: tuple[int, int, int, int], settle: int = 3,
                      interval: float = 0.08, timeout: float = 6.0
                      ) -> dict:
    """Wait until a screen region stops changing, by pixels (F132).

    ``wait_for_phrase`` waits for *text* to appear, but much of a GUI moves
    without ever spelling anything: a panel slides in, a spinner turns, a list
    reflows, a fade settles. Act mid-transition and the target is still in
    flight — the click lands where the thing *was*, not where it comes to rest.
    Nothing in the pixel channel waited for *motion to end*. This re-captures the
    ``bbox`` region every ``interval`` and compares it byte-for-byte to the last
    capture; once ``settle`` consecutive captures are identical, the region is
    judged at rest. Returns ``{stable, changes, captures, elapsed}`` — ``stable``
    is whether it settled before ``timeout``, ``changes`` how many times the
    region differed (proof it really was moving), so the caller can both wait and
    confirm something happened. The visual twin of ``wait_for_phrase``: one waits
    for a word, the other for stillness."""
    deadline = time.time() + timeout
    start = time.time()
    prev: bytes | None = None
    stable = changes = captures = 0
    while time.time() < deadline:
        w, h, rgb = capture_rgb()
        patch, _pw, _ph = crop_rgb(rgb, (w, h), bbox)
        captures += 1
        if prev is not None and patch == prev:
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
    sr = sg = sb = 0
    for i in range(0, len(patch), 3):
        sr += patch[i]
        sg += patch[i + 1]
        sb += patch[i + 2]
    return {"r": sr // n, "g": sg // n, "b": sb // n, "count": n}


def locate_change(before: bytes, after: bytes, size: tuple[int, int],
                  tol: int = 12, min_count: int = 30) -> dict | None:
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
    naming the target. The localiser to :func:`region_diff`'s counter."""
    w, h = size
    if len(before) != len(after):
        raise ValueError("captures differ in size")
    sx = sy = n = 0
    minx = miny = 1 << 30
    maxx = maxy = -1
    stride = w * 3
    for y in range(h):
        row = y * stride
        for x in range(w):
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
                        tol: int = 12, min_count: int = 30) -> list[dict]:
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
    (F052) once met on a static colour, now met on change itself."""
    w, h = size
    if len(before) != len(after):
        raise ValueError("captures differ in size")
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

    for y in range(h):
        row = y * stride
        base = y * w
        up_base = base - w
        for x in range(w):
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
    robust change/settle test stands on."""
    if len(a) != len(b):
        raise ValueError("patches differ in size")
    n = 0
    for i in range(0, len(a), 3):
        if (abs(a[i] - b[i]) > tol or abs(a[i + 1] - b[i + 1]) > tol
                or abs(a[i + 2] - b[i + 2]) > tol):
            n += 1
    total = len(a) // 3
    return {"pixels": n, "total": total,
            "frac": (n / total if total else 0.0)}


def wait_for_change(bbox: tuple[int, int, int, int],
                    baseline: bytes | None = None,
                    interval: float = 0.05, timeout: float = 5.0
                    ) -> dict:
    """Wait until a screen region *first differs* from a baseline (F133).

    ``wait_until_stable`` waits for motion to *end*; ``wait_for_phrase`` waits for
    a *known word*. But the most common post-action wait is neither: after a
    click you often need to know merely that *something happened* — a button lit
    up, a badge appeared, a spinner began, a row got selected — without knowing
    the eventual text or colour, and before any of it has settled. Reading
    immediately races the change and sees the old frame, so the agent concludes
    nothing happened and acts twice. This captures (or accepts) a ``baseline``
    snapshot of the region, then re-captures every ``interval`` until a capture
    differs from it. Returns ``{changed, captures, elapsed}`` — ``changed`` is
    whether the onset arrived before ``timeout``. The idiom is
    ``baseline = crop; act(); wait_for_change(bbox, baseline)`` then optionally
    ``wait_until_stable``: catch the change beginning, then its coming to rest.
    The onset twin of ``wait_until_stable``'s cessation."""
    start = time.time()
    if baseline is None:
        w, h, rgb = capture_rgb()
        baseline, _pw, _ph = crop_rgb(rgb, (w, h), bbox)
    deadline = start + timeout
    captures = 0
    while time.time() < deadline:
        w, h, rgb = capture_rgb()
        patch, _pw, _ph = crop_rgb(rgb, (w, h), bbox)
        captures += 1
        if patch != baseline:
            return {"changed": True, "captures": captures,
                    "elapsed": time.time() - start}
        time.sleep(interval)
    return {"changed": False, "captures": captures,
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


_OCR_ENGINE: "str | None" = None


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
    import subprocess
    engine = _ocr_engine()
    if region is None:
        w, h, buf = capture_rgb()
        rx, ry = 0, 0
        rw, rh = w, h
    elif rgb is not None:
        if size is None:
            raise ValueError("size required when rgb is provided")
        fw, fh = size
        rx, ry, rw, rh = region
        buf = bytearray(rw * rh * 3)
        for yy in range(rh):
            src = ((ry + yy) * fw + rx) * 3
            buf[yy * rw * 3:(yy + 1) * rw * 3] = rgb[src:src + rw * 3]
        buf = bytes(buf)
    else:
        rx, ry, rw, rh = region
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


if __name__ == "__main__":
    print("screen:", screen_size())
    rt = "agentctl osctl clipboard round-trip \u2713"
    set_clipboard(rt)
    print("clipboard ok:", get_clipboard() == rt)
    out = screenshot("osctl_desktop.png")
    import os as _os
    print("screenshot:", out, _os.path.getsize(out), "bytes")
