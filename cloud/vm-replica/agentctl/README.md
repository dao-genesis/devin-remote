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
| `osctl.py` | The floor below the DOM (platform-agnostic): mouse+keys, clipboard, `omnibox_go` (atomic address-bar paste), a screen grab with a dependency-free PNG encoder, the whole gesture + perception (locate/read/template/wait) vocabulary, **and the semantic floor** (`uia_*`) — see below. Includes a **fovea** — `capture_rgb(x,y,w,h)` ROI grab + `foveate()` — a **low-acuity periphery** (`find_color(..., step=n)` coarse scan), a foveated-pursuit `wait_stable`, and a **predictive reach** (`reach()`: acquire→foveate→estimate velocity→click where the target *will be*) for clicking still-moving targets, plus a **closed-loop keyboard servo** (`steer()`: ballistic key-hold→predictive release→rest-then-correct) for driving a *keyboard-moved* momentum control to a perceived goal, and **window addressing** (`list_windows()`/`activate_window()`/`focus_window(name)`: EWMH on X11, `EnumWindows`/`SetForegroundWindow` on Windows) so input reaches the *intended* window among many, not just whatever holds focus — which composes into a **cross-window clipboard relay** (`set_clipboard` → `focus_window(name)` → terminal-paste chord), delivering copied content into a window *by identity*; and **window geometry + move** (`window_geometry(id)` / `move_window(id,x,y,w,h)`) so a window pushed *off* the visible screen — which raising cannot rescue — can be relocated back into reach; and **virtual-desktop addressing** (`num_desktops`/`current_desktop`/`window_desktop`, a `desktop` field on `list_windows`, plus `set_desktop(n)` to *go there* and `move_window_to_desktop(id,n)` to *bring it here*) so a window on another workspace — which has no on-screen pixels at all — can be reached. Selects an OS backend at import. |
| `_osbackend_win.py` | Windows leaf primitives: `SendInput` mouse/keys, clipboard, GDI `BitBlt` capture (whole screen or a source sub-rectangle), window enumerate/activate (`EnumWindows`/`SetForegroundWindow`), geometry/move (`GetWindowRect`/`SetWindowPos`). |
| `_osbackend_x11.py` | Linux leaf primitives: X11 + XTEST mouse/keys, selection-owner clipboard, `XGetImage` capture (whole screen or a sub-rectangle; pure `ctypes`, no `python-xlib`), window enumerate/activate (EWMH `_NET_CLIENT_LIST`/`_NET_ACTIVE_WINDOW`), geometry/move (`XGetGeometry`+`XTranslateCoordinates` / EWMH `_NET_MOVERESIZE_WINDOW`), virtual desktops (EWMH `_NET_CURRENT_DESKTOP`/`_NET_NUMBER_OF_DESKTOPS`/`_NET_WM_DESKTOP`), and the **AT-SPI semantic floor** (`libatspi.so.0` bound by pure `ctypes`: map an X window → its accessible frame by `_NET_WM_PID`, walk the toolkit's own control tree). |
| `_uia_win.py` | Windows semantic floor: the UIAutomation COM tree bound by `ctypes` — the Windows dual of the AT-SPI binding above. Carries the full verb set (toggle/select/expand/range-value/scroll/text) plus `uia_find_item`, which realizes a *virtualized* list item via `ItemContainerPattern` (F183); `uia_find` matches Name/AutomationId/HelpText and `uia_find_all` reads a whole collection by meaning (F184). |
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
- `uia_invoke` — fire a control's default action with no pixels; **falls through
  to a real click** on the rect when a control exposes no action (text regions,
  canvases — JOURNAL F179), so invoke-by-meaning answers for *any* visible control.
- `uia_click` — the union made explicit: locate by meaning, deliver a real click.
- `uia_get_value` / `uia_set_value` / `uia_focus` — read/write a field's text and
  give it keyboard focus, by meaning.
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
- `uia_text` — read a region's full text (multiline, Unicode) via TextPattern.
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
