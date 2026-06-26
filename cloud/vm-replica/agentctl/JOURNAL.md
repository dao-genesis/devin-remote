# agentctl — friction journal

This file is the spine of the project. `agentctl` is not designed top-down; it
**grows from friction**. The loop is always the same:

1. Try to operate a *real* GUI surface the way a human would.
2. Hit a concrete failure — a "friction" `Fnnn`.
3. Understand the *actual* mechanism (never paper over it).
4. Let the smallest robust primitive that dissolves that friction emerge.
5. Re-run live until it holds.

> 反也者，道之動也。 The frictions are the motion of the work; the primitives are
> what is left when the friction is gone. We do not invent capabilities we have
> not been forced to grow.

Every primitive below is validated live against a real Chrome on the CDP
endpoint (`127.0.0.1:29229`) via `test_live.py` — **14/14 checks green**.

---

## The stack

| layer | file | what it is |
|---|---|---|
| transport | `cdp.py` | hand-rolled RFC 6455 WebSocket + CDP JSON-RPC, reader thread, context map |
| gesture | `browser.py` | human-like primitives over CDP: click / type / wait / pierce / dialogs / files |
| OS floor | `osctl.py` | `SendInput` mouse+keys, clipboard, omnibox, GDI screenshot — the things *outside* the DOM |
| proof | `test_live.py` | drives the real browser end-to-end, one round per friction family |

Two perception channels, on purpose:
- **DOM channel** (`evaluate`, `deepQuery`) — structured, exact, fast.
- **Pixel channel** (`osctl.screenshot`, GDI BitBlt → hand-rolled PNG) — sees what
  the DOM cannot (native chrome, other windows, canvas).

---

## Friction taxonomy

### F001 / F002 — per-character typing races and drops
**Surface:** entering text into inputs.
**Mechanism:** dispatching one key event per character interleaves with the
page's own input handlers and IME; characters reorder or vanish, and non-ASCII
(`中文`) cannot be expressed as keycodes at all.
**Primitive:** `browser.type_text` / `insert_text` → a single `Input.insertText`.
One atomic, trusted insertion. Unicode just works.
**Proof:** R2 types `the quick brown fox 中文 123` and reads back the exact value
*and* a fired `input` event.

### F003 — the omnibox eats keystrokes (autocomplete)
**Surface:** typing a URL into Chrome's address bar (outside the DOM).
**Mechanism:** the omnibox's autocomplete mutates the field between keystrokes,
so per-char typing yields a corrupted URL.
**Primitive:** `osctl.omnibox_go` → focus with `Ctrl+L`, set the clipboard, paste
with `Ctrl+V` (one trusted event), `Enter`. Clipboard paste is atomic; nothing to
interleave with.
**Proof:** R9 navigates purely through the address bar and lands on `OMNI-OK`.

### F005 — the DOM is not the whole screen
**Surface:** native file dialogs, other windows, `<canvas>`, the address bar.
**Mechanism:** CDP sees the page; it does not see OS chrome or pixels the page
didn't draw via the DOM.
**Primitive:** `osctl` — `SendInput`, clipboard, and a GDI `BitBlt` screenshot
encoded by a dependency-free PNG writer. The pixel channel.
**Proof:** `osctl.screenshot` captures the real desktop (Chrome + taskbar + clock),
verified as a valid 1280×720 PNG.

### F006 — JS dialog deadlock *(deepened this session)*
**Surface:** a click that triggers `confirm()` / `alert()` / `prompt()`.
**Mechanism (two layers):**
1. A synchronous dialog blocks the renderer, so the `Input.dispatchMouseEvent`
   that caused it never replies until the dialog is answered. If the command
   loop waits on that reply, it is stuck. → fixed earlier with a **background
   reader thread** that keeps pumping protocol events.
2. *But that was not enough.* The dialog auto-handler runs **on the reader
   thread**. If it answers the dialog with a blocking `call()` (which waits for a
   reply only the reader thread can deliver), the thread waits on itself —
   deadlock. Observed as `CDP timeout … Input.dispatchMouseEvent`.
**Primitive:** `CDP.send` — a fire-and-forget frame writer. `_on_dialog` answers
with `handle_dialog(wait=False)` → `send("Page.handleJavaScriptDialog")`. No reply
is needed, so nothing blocks the thread that must keep reading.
**Proof:** R4 arms `expect_dialog(accept=True)`, clicks the trigger, and observes
`accepted` — no timeout.
**Lesson:** any handler executing on the reader thread must be strictly
non-blocking. The thread that delivers replies may never wait for one.

### F008 — cross-frame evaluation
**Surface:** reading/operating content inside an `<iframe>`.
**Mechanism:** each frame is its own JS execution context; `Runtime.evaluate`
against the top context cannot see a child frame's DOM.
**Primitive:** subscribe to `Runtime.executionContextCreated/Destroyed`, keep a
live `contexts` map, and evaluate with an explicit `contextId`.
**Proof:** R5 finds the iframe's own context and reads `inside-iframe` from it.

### F009 — native file chooser cannot be clicked away
**Surface:** `<input type=file>`.
**Mechanism:** clicking it opens an OS file dialog that CDP input cannot reliably
drive, and that blocks.
**Primitive:** `browser.set_file_input` → `DOM.setFileInputFiles` sets the files
directly, no OS dialog. Pairs with `osctl` for the rare cases the dialog is
unavoidable.
**Proof:** R6 sets a file with no chooser and observes the `change` event carry
the filename.
**Sub-friction discovered:** `setFileInputFiles` fires `change` **but not**
`input` — which matches real pickers — and dispatches it **asynchronously**, so an
observer must *wait* for the echo rather than read instantly (same family as F043).

### F024 — click misses without a prior move
**Surface:** clicking by coordinates.
**Mechanism:** the renderer's hit-test uses the last pointer position; dispatching
`mousePressed` without first moving the pointer hits the wrong element.
**Primitive:** every `browser.click_xy` emits `mouseMoved` to the target first,
then press/release.
**Proof:** R3 clicks a button by visible text and the title flips to `clicked!`.

### F043 — async re-render: reading the wrong frame in time
**Surface:** content that updates after a tick (`setTimeout`, fetch, framework
re-render).
**Mechanism:** reading immediately after an action catches the stale value (or a
transient intermediate one).
**Primitive:** `browser.wait_for` (poll a predicate) and `wait_change`
(snapshot → detect change → settle), so we observe the *final* state.
**Proof:** R8 clicks, then `wait_change` reports `start -> final`.

### Shadow DOM — `querySelector` is blind to shadow roots
**Surface:** web components / custom elements.
**Mechanism:** `document.querySelector` does not pierce `shadowRoot`s.
**Primitive:** `window.__agentctl.deepQuery` walks open shadow roots; `browser`
uses it for `exists` / `click` / `type`.
**Proof:** R7 — plain `querySelector('.deep')` is `false`; `deep_query` finds the
button inside the shadow root.

### Test-harness friction — `id="name"` collides with `window.name`
Not a product friction, but recorded because it cost real debugging time: a
fixture used `<div id=name>`, and `name` resolves to the special global
`window.name` (always a string), so `name.textContent=…` is a silent no-op.
Always reference elements via `document.getElementById` and avoid reserved global
ids. (Honest note: the first green-vs-red flip here was the harness, not the
browser primitive — we fixed the test, not faked the result.)

---

## Frontier (next honest rounds)

These are *not yet built* — they are the next real surfaces to push into. Each
will only grow a primitive once a real failure is reproduced.

- **R-next: hover-only menus** — content that appears only on `mouseover` and
  vanishes on move; needs a hover-hold that survives hit-test churn.
- **R-next: drag & drop (HTML5 DnD)** — `dragstart/dragover/drop` with
  `DataTransfer`, not just pointer moves.
- **R-next: scroll-virtualized lists** — items that only exist in the DOM near the
  viewport; needs scroll-until-found.
- **R-next: cross-origin iframes** — separate processes; may need per-target
  sessions (`Target.attachToTarget` + `sessionId`).
- **R-next: canvas / WebGL surfaces** — no DOM at all; pure pixel channel + OS
  input.
- **R-next: focus & IME composition** — composed input for CJK via real IME, not
  just `insertText`.

> 為學者日益，聞道者日損。 We add primitives only by subtracting frictions.
