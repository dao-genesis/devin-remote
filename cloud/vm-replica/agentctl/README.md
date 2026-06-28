# agentctl

A dependency-free toolkit that lets an agent operate a **real GUI** the way a
human does — and then better. It drives Chrome through the DevTools Protocol
*and* the OS floor underneath it, on **both Windows and Linux/X11**, perceiving
the screen through **two senses at once**: *pixels* (capture + locate/read) and
*meaning* (the accessibility tree — UIA on Windows, AT-SPI on Linux). Pure Python
standard library; no `pip install`, no Selenium, no `pyautogui`, no `gi`.

It is grown from friction, not designed up front. The record of *why* each
primitive exists lives in [`JOURNAL.md`](./JOURNAL.md) — read that first.

## Why not just screenshot-and-click?

The official screenshot→reason→click loop spends a full vision round-trip per
step and aims at pixels it inferred. This floor keeps that path as the universal
fallback but reaches for the cheaper, surer one first — so it wins on the axes
that matter:

- **Efficiency** — `omnibox_go` pastes a URL atomically instead of typing it key
  by key; `uia_find` locates a control by name in one bus round-trip instead of a
  screenshot + OCR; the closed-loop servos (`reach`/`steer`) hit moving targets
  without a human-in-the-loop retry.
- **Precision & accuracy** — a control is found by its *name/role* and acted on
  at the toolkit's own reported rect, not at a guessed pixel; text is set through
  the field's own value channel, exact and Unicode-safe.
- **Stability** — every leaf call declares its `ctypes` `argtypes`/`restype`
  (a truncated 64-bit handle is a segfault, see JOURNAL F177/F178); no a11y bus
  means the semantic verbs degrade to truthful empties, never a crash.
- **Usability** — one flat vocabulary (`osctl.*`, `browser.*`) reads like intent.
- **Extensibility** — primitives are added only when a real friction forces one;
  each is the smallest robust verb that dissolves it.
- **Compatibility** — one API, two grounds: `osctl` selects the backend at import,
  so the same script runs on Windows and Linux.

## Layout

| file | role |
|---|---|
| `cdp.py` | Minimal Chrome DevTools Protocol client: hand-rolled RFC 6455 WebSocket, JSON-RPC correlation, a background reader thread, execution-context tracking, and a fire-and-forget `send` for on-thread handlers. |
| `browser.py` | Human-like gestures over CDP: `navigate`, `click`/`click_text`, `type_text`/`insert_text`, `set_value`, `set_file_input`, `expect_dialog`, `wait_for`/`wait_change`, shadow-piercing `exists`, `screenshot`. |
| `osctl.py` | The floor below the DOM (platform-agnostic): mouse+keys, clipboard, `omnibox_go` (atomic address-bar paste), a screen grab with a dependency-free PNG encoder, the whole gesture + perception (locate/read/template/wait) vocabulary, **and the semantic floor** (`uia_*`) — see below. Includes a **fovea** — `capture_rgb(x,y,w,h)` ROI grab + `foveate()` — a **low-acuity periphery** (`find_color(..., step=n)` coarse scan), a foveated-pursuit `wait_stable`, and a **predictive reach** (`reach()`: acquire→foveate→estimate velocity→click where the target *will be*) for clicking still-moving targets, plus a **closed-loop keyboard servo** (`steer()`: ballistic key-hold→predictive release→rest-then-correct) for driving a *keyboard-moved* momentum control to a perceived goal, and **window addressing** (`list_windows()`/`activate_window()`/`focus_window(name)`: EWMH on X11, `EnumWindows`/`SetForegroundWindow` on Windows) so input reaches the *intended* window among many, not just whatever holds focus — which composes into a **cross-window clipboard relay** (`set_clipboard` → `focus_window(name)` → terminal-paste chord), delivering copied content into a window *by identity*; and **window geometry + move** (`window_geometry(id)` / `move_window(id,x,y,w,h)`) so a window pushed *off* the visible screen — which raising cannot rescue — can be relocated back into reach; and **virtual-desktop addressing** (`num_desktops`/`current_desktop`/`window_desktop`, plus `window_on_current_desktop(id)` — the one cross-platform read that says whether a window has on-screen pixels *right now* — and, where the ground supports it, `set_desktop(n)` to *go there* and `move_window_to_desktop(id,n)` to *bring it here*) so a window on another workspace — which has no on-screen pixels at all — can be *seen* and reached by meaning. On X11 the workspace is an EWMH integer index; on Windows it is the documented `IVirtualDesktopManager`'s GUID identity (F199; the switch/move/count verbs there live only in the build-fragile *internal* interface, so they stay truthful no-ops and the floor drives the off-workspace window in place by meaning). Selects an OS backend at import. |
| `_osbackend_win.py` | Windows leaf primitives: `SendInput` mouse/keys, clipboard, GDI `BitBlt` capture (whole screen or a source sub-rectangle), window enumerate/activate (`EnumWindows`/`SetForegroundWindow`), geometry/move (`GetWindowRect`/`SetWindowPos`), show-state (`IsIconic`/`IsZoomed`/`ShowWindow`), and **virtual-desktop reads** via the documented `IVirtualDesktopManager` COM (`IsWindowOnCurrentVirtualDesktop`/`GetWindowDesktopId`, F199). |
| `_osbackend_x11.py` | Linux leaf primitives: X11 + XTEST mouse/keys, selection-owner clipboard, `XGetImage` capture (whole screen or a sub-rectangle; pure `ctypes`, no `python-xlib`), window enumerate/activate (EWMH `_NET_CLIENT_LIST`/`_NET_ACTIVE_WINDOW`), geometry/move (`XGetGeometry`+`XTranslateCoordinates` / EWMH `_NET_MOVERESIZE_WINDOW`), virtual desktops (EWMH `_NET_CURRENT_DESKTOP`/`_NET_NUMBER_OF_DESKTOPS`/`_NET_WM_DESKTOP`), and the **AT-SPI semantic floor** (`libatspi.so.0` bound by pure `ctypes`: map an X window → its accessible frame by `_NET_WM_PID`, walk the toolkit's own control tree). |
| `_uia_win.py` | Windows semantic floor: the UIAutomation COM tree bound by `ctypes` — the Windows dual of the AT-SPI binding above. Carries the full verb set (toggle/select/expand/range-value/scroll/text) plus `uia_find_item`, which realizes a *virtualized* list item via `ItemContainerPattern` (F183); `uia_find` matches Name/AutomationId/HelpText and `uia_find_all` reads a whole collection by meaning (F184); also `tray_icons()`, which enumerates the system-tray notification area by meaning so an app with no top-level window is still reachable (F200). |
| `test_live.py` | End-to-end proof. Drives a real Chrome (and native apps) through every friction family — **~800 live checks across 137 rounds**. |

## The semantic floor (`uia_*`) — perceive and act by *meaning*

Below the pixels, a toolkit exposes its own controls — role, name, geometry, and
the text/value/action channels — through an accessibility tree. The floor binds
it on both grounds (UIA on Windows, AT-SPI on Linux) behind one vocabulary:

- `uia_name` / `uia_children` — read a window's accessible name; enumerate the
  *real* controls inside it (what X11 child-window enumeration can never see).
- `uia_find(win, name=, ctype=)` — locate a control by meaning, returning its
  screen **rect** (plus `aid`/`help`): the bridge that turns *meaning* into geometry
  the pixel floor can act on. `name` is matched against the accessible Name **and**
  the **AutomationId** **and** the **HelpText** (tooltip) — so an *icon* button that
  leaves its Name empty (paint.net's tool/color strip) is still reachable by its
  stable semantic handle, e.g. `name="foreColorRectangle"` (F184).
- `uia_find_all(win, name=, ctype=)` — the **plural** of `uia_find`: every matching
  descendant as a list. Where `uia_children` sees only *direct* children, this reads
  a whole **collection** by meaning — a file manager's rows, a result set — that
  lives far below the top window (F184).
- `uia_rows(win, container_ctype=)` — rebuild a details/report view's **rows** from a
  *flattened* tree. A multi-column list often scatters each cell into a separate
  sibling (the name in an `edit`, the size/date in `text`s) with no per-row parent, so
  `uia_find_all` cannot say which cells belong together. This regroups them by geometry
  — cluster by vertical band, order by x, drop the row-wrapper that merely repeats the
  name — returning `[[cell, …], …]` in visual row/column order (JOURNAL F196).
- `uia_invoke` — fire a control's default action with no pixels; **falls through
  to a real click** on the rect when a control exposes no action (text regions,
  canvases — JOURNAL F179), so invoke-by-meaning answers for *any* visible control.
  **Modal-safe**: the synchronous Invoke runs on a timed daemon thread, so a button
  whose handler opens a *modal* dialog returns control after `timeout` instead of
  freezing the agent (JOURNAL F193).
- **Every `uia_*` locate/read verb is hang-proof** (JOURNAL F194): each runs on an
  abandonable daemon worker with its own COM apartment + UIA, joined with a timeout,
  so a pathological provider that wedges a single COM call deep in a descendant search
  (a native file dialog's virtualised shell list view stalls `FindAll` *and* a manual
  tree-walk) makes the verb return its empty default instead of freezing the agent.
- `uia_click` — the union made explicit: locate by meaning, deliver a real click.
- `uia_drag` — the held-stroke dual of `uia_click`: locate a *source* and a *target*
  control by meaning and run a genuine press-glide-release between them (reorder a
  track, move a list row). The grip is the item's **leading edge**, not its centre —
  a track's centre is its body, where a press means *select*, not *move* (JOURNAL
  F190b). In-process drags land; a header that only sorts, or an OLE file-drop target,
  is named as out of reach (synthetic motion can't speak the OLE protocol).
- `uia_get_value` / `uia_set_value` / `uia_focus` — read/write a field's text and
  give it keyboard focus, by meaning. `uia_set_value` writes via the UIA ValuePattern
  but **trusts it only when a read-back confirms the value**, because the pattern lies
  two ways: it can *refuse* the write (wxWidgets number fields return `SetValue` failure,
  F189) or *fake* it (a Qt Scintilla code editor returns `SetValue` success yet writes
  nothing, F190). Unconfirmed, it reaches the **keyboard floor** focused by a *real click*
  on the field's centre (UIA `SetFocus` also lies on such widgets) — select-all, type —
  so "set this field" holds whether the toolkit models a truthful pattern, a lying one,
  or only lets a person type.
- `uia_toggle` / `uia_toggle_state` — flip and read a checkbox/switch.
- `uia_select` / `uia_is_selected` — pick a list/tab/radio item and read whether
  it is chosen. `uia_select` tries `SelectionItemPattern` first, then **falls back to
  Invoke** for controls that mean "choose me" but model only InvokePattern — e.g. a Qt
  `QTabBar` tab, which is *invoked*, not *selected* (JOURNAL F187).
- `uia_expand` / `uia_collapse` / `uia_expand_state` — open/close a combobox or
  tree node and read its state.
- `uia_range_value` / `uia_set_range_value` — read `{value,min,max}` of a slider/
  progress bar and set it to a number with no mouse drag.
- `uia_scroll_into_view` — bring an element below the fold into the viewport.
- `uia_text` — read a region's full text (multiline, Unicode) via TextPattern, and
  **falls back to the element's accessible Name** when no TextPattern is present: a
  custom-drawn editor (Notepad++/Scintilla) carries no TextPattern and is invisible to
  the native `window_text`, yet publishes its whole buffer as a `Pane`'s Name — the Name
  *is* the tree's report of that element's text, so the read is truth, not a guess (F191).
- `read_selection(restore=True)` — read content that is **drawn, not in the tree**.
  Some surfaces paint their content with no element behind it — LibreOffice Calc renders
  its whole cell grid as one custom control (`uia_text` over the sheet returns only
  `"Sheet Sheet1"`, never a cell), as do most terminals and canvas-drawn views. Such
  content is still *copyable*: the caller positions the selection by meaning + keyboard
  (click a cell, `Ctrl+A` a field, shift-arrow a range), this verb does the `Ctrl+C` and
  returns the text, clearing the clipboard to a sentinel first (a no-op copy returns `""`,
  not a stale value) and restoring the prior clipboard. The cross-platform complement of
  `uia_text` — meaning for the tree, the copy channel for pixels (JOURNAL F195).
- `uia_find_item(win, item, container_ctype=)` — reach an item a long **virtualized**
  list (WPF/UWP/WinUI) has not materialized into the tree, where plain `uia_find`
  finds nothing: asks the container (UIA `ItemContainerPattern`) to *realize* it by
  name, scrolls it into view, and returns its now-visible rect (JOURNAL F183).
- `uia_menu(win, *path)` — invoke a **menu path** by meaning, e.g.
  `uia_menu(win, "Edit", "Preferences")`. A dropdown opens as a *separate top-level
  popup window* (Qt/wx/Win32), so its items are invisible to a `uia_find` scoped to the
  app window; this opens the menubar item then finds each further name as a `menuitem`
  in **whatever** window it popped into and clicks it (opening a submenu, or firing the
  action on the last). Composed of `uia_find`+`list_windows`+`click`, so one
  implementation serves every backend. Proven on FreeCAD/KiCad/Shotcut (JOURNAL F185).
- `menu_windows()` — enumerate open **popup menus** of *any* toolkit. A popup menu is
  recognised by its **shape** — a titleless, owned `WS_POPUP` window (plus the native
  `#32768` class) — not by a per-toolkit class allow-list, so it sees Win32 `#32768`,
  LibreOffice/VCL `SALTMPSUBFRAME`, Qt/wx popups alike; ownership filters out shell
  furniture like the taskbar (JOURNAL F188). A
  right-click context menu / classic Win32 dropdown opens in a *titleless* window, so
  `list_windows` (titled top-levels only) never returns it; this finds it by window
  *class*, so its items can be read and clicked by meaning (JOURNAL F186).
- `uia_context(win, target, *path)` — right-click an element by meaning, then pick from
  its **context menu** by meaning, e.g. `uia_context(win, "report.pdf", "Open with",
  "Notepad")`. Finds `target` in `win`, right-clicks it, and walks `path` through
  `menu_windows()` exactly as `uia_menu` walks a menubar. The two menu verbs share one
  walk that searches `list_windows()`+`menu_windows()`, so both native and Qt/wx menus,
  menubar and context, are driven by one code path (JOURNAL F186).
- `goto_cell(win, ref)` — navigate a spreadsheet to an arbitrary cell **by reference**,
  e.g. `goto_cell(win, "B2")`. The grid is one drawn canvas with no per-cell element, and
  the Name Box is a VCL ComboBox whose `uia_focus` lies; so this *clicks* the meaning-found
  Name Box (a real click focuses it), types the reference, and verifies the jump via the
  box's own readback — with a geometry fallback that self-heals a box left poisoned by a
  rejected reference, and an up-front reject of non-references (JOURNAL F197).
- `tray_icons()` / `tray_invoke(name)` / `tray_context(name, *path)` — operate an app
  resident **entirely in the system tray**, which owns *no* top-level window (the deepest
  zero-pixel surface: absent from `list_windows`, its only presence a `NotifyIcon` inside the
  untitled `Shell_TrayWnd`). `tray_icons()` enumerates the notification area *by meaning* —
  scoped to the `"…Notification Area"` toolbars + overflow flyout, so taskbar buttons
  (Start/Search/Task View) are excluded — returning each icon's `{name,help,aid,rect}`;
  `tray_context` right-clicks an icon by meaning then walks its `#32768` context menu via the
  same `menu_windows()` path as `uia_context`. Proven `_probe_tray.py` 8/8 on a hidden-Form
  NotifyIcon fixture (JOURNAL F200). `[]`/no-op on a backend with no Windows tray.
- `window_opaque(win)` — True when a window has **pixels but no operable meaning**: its a11y
  tree exposes only the OS window frame (caption buttons + System menu), no application control.
  The inverse of the zero-pixel frontier — a GTK app on Windows (Inkscape's whole client area is
  one opaque UIA `Pane`; File/Edit/the palette are invisible), a game, a bare `<canvas>`. It
  disambiguates `uia_find → None` ("wrong name" vs "no semantic surface here"), so the floor can
  *switch channels deliberately* — drive by **pixels+keyboard** (`screenshot`/`find_color`/`pixel`
  + `tap`/`drag`/`click`) where meaning is absent. Proven `_probe_opaque.py` 7/7 (and live on real
  Inkscape: rectangle drawn + filled #FF0000 entirely by keys+pixels) (JOURNAL F201).
- `get_clipboard_files()` / `set_clipboard_files(paths, move=False)` — the **file clipboard**
  (`CF_HDROP`), the non-text twin of `set_clipboard`/`get_clipboard`: a Ctrl+C in Explorer puts a
  *file list*, not text, so the text channel reads `""`. These read the dropped-file list
  (`DragQueryFileW`) and originate one (hand-built `DROPFILES` + the `"Preferred DropEffect"` format
  Explorer needs to copy vs. move), so the floor can see what a user copied and paste files into any
  shell target. Proven `_probe_clipfiles.py` 7/7 incl. a live Explorer Ctrl+V copy (JOURNAL F202).
  Windows-only; `[]`/`False` no-op on X11 (the `text/uri-list` selection) until a real failure.
- `get_clipboard_image(path)` / `set_clipboard_image(path)` — the **image clipboard** (`CF_DIB`),
  the third clipboard tongue (text / files / image). An app's "Copy" of a picture is a bitmap,
  invisible to the text and file clipboards. These materialise a copied image as a PNG the floor's
  own perception (`find_color`/template/`ocr`) reads — a screenshot by another name — and originate
  one to paste into Paint/docs. Reuses the floor's `zlib` PNG codec (`_png` + `_decode_png_rgb`), no
  new dep. Proven `_probe_clipimage.py` 6/6 (pixel-exact round-trip + reads an external app's
  `Clipboard.SetImage`) (JOURNAL F203). Reads 24/32-bit DIBs; `None` on exotic DIBs; Windows-only.
- `uia_focused()` — the element holding **keyboard focus** right now, desktop-wide, as
  `{name,type,aid,help,rect,pid}` or `None`. The dual of `uia_find`: not "where is control X" but
  "where will my keystrokes land?" — the keyboard's twin of the mouse cursor. Lets the floor verify a
  focus move landed (clicked the right field, Tab went where intended, no dialog stole focus, and via
  `pid` that focus is in the target app) *before* committing input. Pure read. Proven `_probe_focus.py`
  5/5 (focus tracked field→button, pid = owner, typing lands where it points) (JOURNAL F204).
- `screen_observe(deep=False)` — **one structured per-step observation**: `{active, focus, windows:[{id,
  title,rect,active,opaque,actions:[{name,type,aid,rect}…]}]}`. The perception primitive the public
  AI-GUI frameworks are built around (UFO's control inventory, OmniParser/Agent-S's set-of-marks),
  assembled purely from `list_windows`+`active_window`+`window_geometry`+`window_opaque`+`uia_find_all`+
  `uia_focused`. Inventories the **foreground** window's actionable controls by default (background
  windows listed without a scan unless `deep=True`); flags `opaque` windows so the agent knows to use
  pixels. No new OS binding. Proven `_probe_observe.py` 6/6 (JOURNAL F205).
- `wait_control(win, name=, ctype=, timeout=8)` / `wait_control_gone(...)` — wait for a control to
  **appear / disappear by meaning** inside a window (returns the `uia_find` dict / bool). The semantic,
  in-window dual of `wait_window` (new window) and `wait_pixel` (a colour): a dialog's OK button appears
  a beat after its trigger, a spinner clears later — synchronization every multi-step interaction needs,
  expressed in meaning not pixels. Pure composition of `uia_find`; `None`/`False` (never raises) without
  UIA so a caller can fall back to a pixel wait. Proven `_probe_waitctl.py` 5/5 against a window that
  mutates after it is up (JOURNAL F206).
- `uia_set_value(win, value, name=, ctype=)` — sets a field **by meaning**, hardened by F207 (forward
  practice on a real Notepad++ Replace dialog whose label+combo+edit were all named `"Replace with:"`):
  when no `ctype` is pinned it now targets the **actionable** control, not its same-named static caption,
  and the keyboard-floor fallback is held to a **read-back proof** — it returns `False` (rather than a
  data-destroying false success) when a write into a read-only/label target changes nothing, while staying
  optimistic only for fields whose value cannot be read back at all. Proven `_probe_setvalue.py` 5/5
  (JOURNAL F207).

Proven live on **both** grounds. On Linux/AT-SPI: `name`, `children`, `find`,
`invoke`, `click`, `focus`, `get_value`, `set_value` (F177–F182). On Windows/UIA:
the full set above is exercised end-to-end against a first-class UIA provider —
`_probe_winverbs.py` drives a WPF fixture **15/15 green** (F183). The verbs report
what a control *is* and never crash on what it lacks: against a poorer provider
(e.g. WinForms, whose legacy-MSAA→UIA bridge omits RangeValue/ScrollItem/Text/
ComboBox-expand) the missing patterns return *truthful empties*, not errors —
so the floor degrades by control, not by platform. `uia_find_item` is additive and
Windows-only today; AT-SPI returns `None` until an equivalent realize-verb is
forced there.

### The backend GUI — operate a window with *zero* pixels

Because the semantic verbs address a control by its provider (identity), not its
screen geometry, they reach a window that has **no on-screen pixels at all** — one
that is **minimized** (its rect collapses off-screen to `(-32000,-32000)`). The
official screenshot→click loop is defined by pixels and cannot touch such a window;
this floor drives it whole. `_probe_backend.py` runs a WPF fixture **9/9 green while
minimized** — value write+read-back, toggle, ListBox select, range set, tree expand,
Invoke (→ `PONG`), multiline-Unicode text read — and asserts the window never left
minimized, so every act used zero pixels (F192). The honest boundary: any verb that
falls through to a *real click* (a control exposing no pattern; `uia_set_value`'s
keyboard-floor fallback for a lying ValuePattern; a collapsed ComboBox whose item is
realized only by its dropdown popup) needs pixels and stops at the minimized wall —
the pattern channel reaches through, the pixel channel truthfully cannot.

The same is true *by workspace*: a window on **another virtual desktop** has no on-screen
pixels either, and the semantic floor drives it just the same — `_probe_vdesk.py` runs a WPF
fixture parked on a second Windows desktop **8/8 green** (value write+read-back, Invoke→`PONG`,
multiline-Unicode text read) while `window_on_current_desktop` correctly reports it dark (F199).
The floor learned to *see* that axis on Windows through the documented `IVirtualDesktopManager`
(`window_desktop`/`current_desktop` as the workspace's GUID identity), so it can choose meaning
over the useless pixel channel — and it declines to *fake* what the documented API forbids
(`MoveWindowToDesktop` returns `E_ACCESSDENIED` for a foreign window; switch/count live only in
the build-fragile internal interface), driving the window in place instead.

## Prerequisites

- A Chrome with remote debugging on `127.0.0.1:29229`
  (`chrome --remote-debugging-port=29229`).
- Python 3.11+ (only the standard library is used).
- Cross-platform: `osctl.py` picks `_osbackend_win` on Windows and
  `_osbackend_x11` on Linux (X11 + XTEST; needs `libX11`/`libXtst` and a reachable
  `DISPLAY`). `cdp.py` + `browser.py` are platform-agnostic. macOS has no backend
  yet.
- The **semantic floor** needs the accessibility runtime present: on Linux,
  `at-spi2-core` installed and the process carrying the desktop session's
  `DBUS_SESSION_BUS_ADDRESS` (the a11y bus is then auto-discovered); on Windows,
  UIAutomation is built in. Absent it, `uia_*` return empty defaults — the
  pixel/keystroke floor remains fully functional.
- Running `test_live.py`: a few multi-colour OCR fixtures locate the white "field"
  as the whole viewport and inset a fixed fraction, so they assume the **viewport ≈
  the canvas**. Run the browser at a content-sized window (~1320 wide), not
  maximised on a much wider screen, or the inset clips the leftmost glyph of the
  left-aligned word. See `_probe_region_clip.py` and JOURNAL F141.

## Quick start

```python
from browser import Browser

b = Browser()                       # attaches to the live Chrome tab
b.navigate("https://example.com")
print(b.title())                    # 'Example Domain'
b.click_text("More information...")
b.type_text("#search", "hello 中文") # atomic, Unicode-safe
```

OS-level (outside the DOM):

```python
import osctl
osctl.omnibox_go("https://example.com")   # drive the address bar itself
osctl.screenshot("desktop.png")           # capture the whole screen
```

By meaning (the semantic floor — no pixels guessed):

```python
win = osctl.focus_window("KWrite")["id"]      # address a window by identity
btn = osctl.uia_find(win, name="Save",        # locate a control by what it IS
                     ctype="button")          # -> {'name','ctype','rect'}
osctl.uia_invoke(win, name="New")             # act by meaning (click-fallback if no action)
osctl.uia_set_value(win, "hello 中文",         # write a field's text directly
                    ctype="text")
```

## Run the proof

```bash
python test_live.py          # ~800 live checks against a real browser + native apps
```
