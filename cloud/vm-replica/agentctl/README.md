# agentctl

A dependency-free toolkit that lets an agent operate a **real GUI** the way a
human does — drive Chrome through the DevTools Protocol *and* the OS input/pixel
floor underneath it. Pure Python standard library; no `pip install`.

It is grown from friction, not designed up front. The record of *why* each
primitive exists lives in [`JOURNAL.md`](./JOURNAL.md) — read that first.

## Layout

| file | role |
|---|---|
| `cdp.py` | Minimal Chrome DevTools Protocol client: hand-rolled RFC 6455 WebSocket, JSON-RPC correlation, a background reader thread, execution-context tracking, and a fire-and-forget `send` for on-thread handlers. |
| `browser.py` | Human-like gestures over CDP: `navigate`, `click`/`click_text`, `type_text`/`insert_text`, `set_value`, `set_file_input`, `expect_dialog`, `wait_for`/`wait_change`, shadow-piercing `exists`, `screenshot`. |
| `osctl.py` | The floor below the DOM (platform-agnostic): mouse+keys, clipboard, `omnibox_go` (atomic address-bar paste), a screen grab with a dependency-free PNG encoder, plus the whole gesture + perception (locate/read/template/wait) vocabulary. Includes a **fovea** — `capture_rgb(x,y,w,h)` ROI grab + `foveate()` — and a foveated-pursuit `wait_stable`. Selects an OS backend at import. |
| `_osbackend_win.py` | Windows leaf primitives: `SendInput` mouse/keys, clipboard, GDI `BitBlt` capture (whole screen or a source sub-rectangle). |
| `_osbackend_x11.py` | Linux leaf primitives: X11 + XTEST mouse/keys, selection-owner clipboard, `XGetImage` capture (whole screen or a sub-rectangle; pure `ctypes`, no `python-xlib`). |
| `test_live.py` | End-to-end proof. Drives a real Chrome through every friction family. |

## Prerequisites

- A Chrome with remote debugging on `127.0.0.1:29229`
  (`chrome --remote-debugging-port=29229`).
- Python 3.11+ (only the standard library is used).
- Cross-platform: `osctl.py` picks `_osbackend_win` on Windows and
  `_osbackend_x11` on Linux (X11 + XTEST; needs `libX11`/`libXtst` and a reachable
  `DISPLAY`). `cdp.py` + `browser.py` are platform-agnostic. macOS has no backend
  yet.
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
osctl.screenshot("desktop.png")           # GDI capture of the whole screen
```

## Run the proof

```bash
python test_live.py          # 14/14 checks against a real browser
```
