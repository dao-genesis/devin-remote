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

### F044 — click-by-text lands on the wrong (wider) element *(honest correction)*
**Surface:** `click_text("Learn more")` on `example.com` — a link that should
navigate to `iana.org`.
**First (wrong) diagnosis:** the click was dispatched, `click_text` returned
`True`, yet `location.href` never changed. The tempting conclusion was *"CDP
synthetic `Input.dispatchMouseEvent` is not trusted input, so the browser won't
follow `<a href>` on a simulated click."* **That was false** — easy to believe,
never verified, and it would have excused a real bug as a platform limit.
**Real mechanism:** `byText` ranked candidates only by shortest `textContent`.
The `<a>Learn more</a>` and its wrapping `<p>` have *identical* text
(`"Learn more"`), and `walk()` yields the ancestor `<p>` first, so the wider
paragraph box (≈770 px) won the tie. Its geometric center sat on paragraph
whitespace, not the 80 px anchor — `elementFromPoint` at the click point
returned `P`, not `A`. The click was real; it just hit the wrong target.
**Primitive:** `byText` now ranks by *interactivity* first (`A`/`BUTTON`/form
controls > `role=button|link` > `onclick`/`tabindex` > none), then shortest
text, then **smallest bounding-box area** (the leaf). The anchor now wins; the
synthetic click follows the link and navigates to `www.iana.org`.
**Proof:** after the fix, `elementFromPoint` returns `A`, and `location.href`
becomes `https://www.iana.org/help/example-domains`.
**Lesson (道法自然):** a synthetic click *does* follow links — the floor was
never the limit. When something "can't" work, suspect your own aim before
blaming the platform; verify with `elementFromPoint` instead of inventing a law.

### F045 — the test harness crashes on a legacy console codepage
**Surface:** `python test_live.py` from a fresh Windows shell (no
`PYTHONIOENCODING` set) aborts mid-run with
`UnicodeEncodeError: 'charmap' codec can't encode...` — *before* any check can
fail or pass. The toolkit drove the browser fine; the harness just couldn't
*print* its own results.
**Mechanism:** Python binds `sys.stdout` to the console codepage (e.g. `cp1252`
on this VM). The result lines carry Unicode — CJK from the type-tests and the
`—` em-dash detail separator — which cp1252 cannot encode, so the very act of
reporting blows up. Forcing UTF-8 via `PYTHONIOENCODING=utf-8` masked it, but a
plain `python test_live.py` (exactly what the environment blueprint runs) would
crash in any future session.
**Primitive:** at import time the harness reconfigures `sys.stdout`/`sys.stderr`
to `encoding="utf-8", errors="backslashreplace"` when `.reconfigure` exists, so
output is codepage-independent and never raises on an unrepresentable glyph.
**Proof:** `unset PYTHONIOENCODING; python test_live.py` → `14/14 checks passed`.
**Lesson (道法自然):** the report channel is part of the system. A tool that
can act but cannot *speak its result* on the plainest console is not yet whole;
make the floor (stdout) tolerate reality (any glyph) instead of demanding the
environment be configured first.

### Test-harness friction — `id="name"` collides with `window.name`
Not a product friction, but recorded because it cost real debugging time: a
fixture used `<div id=name>`, and `name` resolves to the special global
`window.name` (always a string), so `name.textContent=…` is a silent no-op.
Always reference elements via `document.getElementById` and avoid reserved global
ids. (Honest note: the first green-vs-red flip here was the harness, not the
browser primitive — we fixed the test, not faked the result.)

### F046 — hover-only menus: the click lands on the visible ancestor
**Surface:** a CSS `:hover` submenu — `<div id=menu>Menu<div class=submenu>
<button>Settings</button></div></div>` with `#menu:hover .submenu{display:block}`
(hidden otherwise). A human moves onto *Menu*, the submenu drops down, then
clicks *Settings*. Driving it the obvious way — `click_text("Settings")` — does
not fail loudly; it returns success and *nothing happens*.
**Mechanism:** while the submenu is `display:none` it has a zero-size box, so the
real `<button>` is not hittable and `byText` (which filters on visibility) skips
it. But the *visible* trigger `#menu` has textContent `"Menu Settings"`, so the
ranker happily matches the ancestor `div`, centers on it, and clicks — a real
click on the wrong element. Title stays `hover`. The failure hides as a pass.
**Primitive:** `hover_reveal(trigger, target)` moves the pointer onto the trigger
(CDP `mouseMoved`, setting `:hover`), then `wait_visible(target)` polls
`__agentctl.visible()` until the submenu actually lays out. Only then does
`click_text` find the now-visible button and land on it. The follow-up click is a
single `mouseMoved`→press straight to the item center, so the pointer never
crosses a gap that would re-close a detached menu mid-move (no intermediate
hit-tests). `is_visible`/`wait_visible` are the new shadow-piercing visibility probes.
**Proof:** R10 — naive click leaves the title `hover`; after `hover_reveal` the
same click flips it to `SET-OK`. `18/18 checks passed`.
**Lesson (道法自然):** a click that "succeeds" on the wrong target is worse than
one that fails — it lies. The primitive does not force the menu; it *waits for
the surface to become real* (`wait_visible`) before acting, then moves in one
stroke. 弱也者，道之用也 — yield to the page's own timing rather than fight it.

### F047 — HTML5 drag-and-drop: the native pointer drop is nondeterministic
**Surface:** a `draggable=true` element dragged onto a dropzone whose `drop`
handler reads `dataTransfer.getData(...)` set during `dragstart`. The human
gesture is press-move-release.
**Mechanism (measured, not assumed):** driving it with raw CDP pointer events —
`mousePressed` at source, N×`mouseMoved`, `mouseReleased` at target — is *flaky in
a way that depends on the move pattern*. Live probe over identical fixtures:
`1 move → drop fired`, `2 moves → dragstart fired but the drop was silently
lost (title unchanged)`, `5 moves @20ms → drop fired`. Chrome's internal drag
controller couples to the OS drag loop and only sometimes promotes the moves into
a completed drop. A "drag" that starts but never drops is the worst failure: it
looks like motion happened.
**Primitive:** `dnd(source, target)` skips the lossy pointer path and synthesizes
the exact DOM event chain a real drag produces —
`dragstart→dragenter→dragover→drop→dragend` — sharing **one** `DataTransfer`
across all five, so `setData` in `dragstart` is readable by `getData` in `drop`,
precisely what the page's handlers expect. Endpoints resolved via `deepQuery`
(pierces shadow). Determinism check: synthetic path landed **10/10** drops vs the
native path's intermittent loss.
**Proof:** R11 — title goes `dnd` → `DROP:payload`. `21/21 checks passed`.
**Lesson (道法自然):** do not fight the drag controller's hidden timing. The page
speaks a five-event protocol with a single shared parcel (`DataTransfer`); speak
*that* exactly, and the drop always lands. 為者敗之 — forcing the pointer fails;
matching the page's own contract succeeds.

### F048 — scroll-virtualized lists: the row does not exist until you reach it
**Surface:** a 1000-row list in a 200px viewport that only materializes the ~10
rows around the current scroll offset (`scroll`→re-render). A human flicks down
until *Item 800* appears, then clicks it.
**Mechanism:** virtualization keeps only the visible window in the DOM, so before
scrolling, `byText("Item 800")` returns nothing and `click_text` simply fails —
there is no element to hit. Querying harder does not help; the row literally is
not there. Scrolling is not cosmetic, it is what *creates* the target.
**Primitive:** `scroll_until(found_js, container)` steps the container's
`scrollTop`, pauses (`settle`) for the list to re-render, and re-tests, returning
as soon as the predicate holds. `scroll_to_text(text, container)` builds the
`byText` predicate. A saturation guard compares successive scroll positions and
stops the moment scrolling no longer advances, so a genuinely-absent row fails
*fast* (≈1.3s) instead of spinning `max_steps`. After it returns, `click_text`
lands normally.
**Proof:** R12 — `Item 800` absent → naive click False → `scroll_to_text` brings
it in → click yields `CLICK:800`; `Item 99999` returns False quickly.
`26/26 checks passed`.
**Lesson (道法自然):** you cannot grasp what has not yet come into being. The
primitive does not search harder, it *moves the world until the thing exists*,
then acts — and knows when to stop (saturation) rather than chase a phantom.
天下之物生於有，有生於無 — scroll calls the row out of nothing.

### F049 — cross-origin iframes: the parent's JS is walled off from the child
**Surface:** a page that embeds a frame from a *different origin* —
`<iframe src="http://127.0.0.1:8902/c">` inside a page served from
`127.0.0.1:8901` (same IP, different port ⇒ different origin). A human just
reads the child's text or clicks its button; the agent, scripting from the
parent, cannot.
**Mechanism:** the same-origin policy forbids the parent *document* from
touching a cross-origin child: `iframe.contentDocument` is `null` (or throws
`SecurityError`), so neither parent script nor `deepQuery` — which walks
`document`/shadow roots from the top frame — can see `#secret`. Querying harder
from the parent can never cross this wall; the wall is by design. But the child
is not invisible to *everyone*: Chrome gives it its own **execution context**,
which CDP reports via `Runtime.executionContextCreated` (already tracked since
F008) with the child's distinct `origin`/`frameId`. CDP evaluates *per context*
at the renderer level, **beneath** the same-origin policy, which governs
document-to-document access, not the debugger.
**Primitive:** `frames()` lists every execution context (incl. cross-origin
children); `eval_in_frame(match, expr)` resolves the context whose `origin`
substring (e.g. a port) or exact `frameId` matches — preferring the freshest —
waits briefly for it to register (`wait_frame`), then evaluates `expr` directly
in it via `Runtime.evaluate{contextId}`. This both *reads* (`#secret` text) and
*acts* (`element.click()`) inside the child. An absent frame returns `None`
fast rather than hanging.
**Proof:** R13 — parent `contentDocument` is `null` and `deepQuery('#secret')`
fails (the wall is real), yet `eval_in_frame("8902", …)` reads `CHILD-SECRET-42`,
clicks the child's button, and observes its state become `CHILD-CLICKED`; a
non-existent frame returns `None` in <0.5s. `32/32 checks passed`.
**Lesson (道法自然):** do not batter the wall the page raised on purpose —
`為者敗之`. Stop addressing the child *through* the parent (the forbidden path)
and address it *as itself*, on the channel that was never walled. 無有入於無間 —
the formless (a per-context eval) enters where there is no gap. *(Note: here the
cross-origin child stays in-process, so its context appears on the page session;
a true out-of-process iframe (cross-site) would surface only under
`Target.setAutoAttach` + `sessionId`. We built for the friction reproduced, not
the one imagined.)*

### F050 — canvas targets: there is no DOM node, only pixels
**Surface:** a target painted on `<canvas>` — a magenta rectangle drawn with
`fillRect`, whose `click` handler hit-tests by `offsetX/offsetY`. A human just
*sees* the coloured patch and clicks it.
**Mechanism:** `<canvas>` is a single opaque element; everything inside is paint,
not DOM. `deepQuery`, `byText`, `click_text` — every structural channel — is
blind, because there is genuinely nothing there to match: no node, no text, no
attribute. The target exists *only* as pixels on the screen. This is the one
surface where the DOM perception channel is not merely awkward but absent; the
agent must fall back to the other channel it has — its eyes.
**Primitive:** `osctl.capture_rgb()` grabs the whole desktop (GDI `BitBlt`) into
an in-memory RGB buffer whose dimensions equal `screen_size()` — the *same*
space `osctl.click` normalises against, so a pixel found is a pixel clickable
with no DOM→screen coordinate math. `osctl.find_color(target, tol)` scans for
pixels within per-channel tolerance and returns the blob's centroid `{x,y,count,
bbox}` in screen coordinates (or `None` — absence is reported, never
hallucinated). Locate → `osctl.click(centroid)` → the canvas's own handler
fires. Perception and action both happen purely in pixel/OS space, beneath the
DOM entirely — the GUI's bottom layer.
**Proof:** R14 — DOM search finds nothing and `click_text` fails (the target is
invisible to structure); `find_color((255,0,255))` locates the 6300-px blob at
its true centroid, an OS click there flips the title to `CANVAS-HIT`, and the
*state change is re-confirmed through the same pixel channel* (the patch is now
green). An off-screen colour returns `None`. `39/39 checks passed`.
**Lesson (道法自然):** 五色令人目盲 only when you insist on one kind of seeing.
When structure dissolves (no DOM), do not force it back into being — change the
organ of perception. The agent has two eyes, DOM and pixel; on canvas only the
second one opens. 視之不足見，用之不可既 — what cannot be read can still be seen
and acted upon.

> *Harness honesty (F049 teardown):* the two cross-origin fixture servers first
> ran single-threaded; Chrome's keep-alive held the socket and `shutdown()`
> intermittently deadlocked behind it. Switched to `ThreadingHTTPServer` +
> daemon threads + `HTTP/1.0` so teardown can never block on a held connection.
> The friction was in the *test*, not the primitive — fixed honestly, not hidden.

### F051 — CJK input: the value arrives but the *composition* never happens
**Surface:** a field that is *gated on the IME composition lifecycle* — it
commits text only on `compositionend` (CJK type-ahead, pinyin search-as-you-go,
rich editors that suppress `input` while `isComposing`). A human types romaji,
watches candidates resolve (你→你好), and presses space/enter to commit.
**Mechanism:** our two existing text channels both deliver the *final*
characters but produce none of the composition events. `Input.insertText` fires
a single `input:你好` — no `compositionstart`, no `compositionend`; the gated
field never reacts (proven: `0,0,0` start/update/end). `osctl.type_unicode`
(KEYEVENTF_UNICODE) fires per-char `keydown`+`input` with `isComposing=false` —
still no composition. The text was *present* but the *event shape the page waits
for* was absent. We were delivering the destination without the journey the page
subscribes to.
**Primitive:** `browser.compose(selector, text, stages=…)` drives CDP
`Input.imeSetComposition` — the renderer's own IME entry point, beneath any
keyboard layout. It walks candidate `stages` (default: progressive prefixes,
or explicit `["ni","你","你好"]`), each emitting `compositionstart`/
`compositionupdate` with `isComposing=true`, then commits via `insert_text`,
firing `compositionend` — the exact lifecycle a human IME produces.
`commit=False` leaves the composition open; `selector=None` composes into the
focused field.
**Proof:** R15 — `insert_text("你好")` sets the value yet leaves the gated field
uncommitted (`0,0,0`, `out` empty); `compose(None,"你好",["ni","你","你好"])`
yields `1,4,1` (start once, updates through every candidate, end once), the
value is `你好`, and the compositionend-gated field finally reads
`COMMITTED:你好`. `44/44 checks passed`.
**Lesson (道法自然):** 大音希聲 — the page is not listening for the loud final
characters, it is listening for the quiet shape of *becoming*. To deliver only
the result is to skip the very signal subscribed to. 反者道之動 — go back through
the gradual motion (start→update→end), and the formed text enters where the
finished text could not. Address the page on the event it actually awaits.

### F052 — one colour in two places: the average is a target that isn't there
**Surface:** two identical magenta squares on a canvas — one decoy, one the real
target. A human sees *two* patches and aims at the right one. F050's
`find_color` sees only "magenta".
**Mechanism:** `find_color` reduces every matching pixel to a single centroid —
the *mean* position. With one region that mean is its centre; with two it is the
midpoint of the gap *between* them, a point that belongs to neither square.
Acting on it is worse than seeing nothing: the agent confidently clicks empty
canvas (proven: flat centroid at x≈297 between regions at x≈107 and x≈487 → the
click reports `MISS`). The colour channel told the truth (magenta is here) but
the *aggregation* invented a phantom target by averaging two real ones.
**Primitive:** `osctl.find_color_blobs(target, tol, min_count)` labels the
matching pixels into connected components — union-find with 4-connectivity over
*only* the matched pixels, so cost scales with the colour's area, not the whole
screen — and returns one `{x, y, count, bbox}` per distinct region in screen
coordinates, sorted by area. Now the two squares come back as two real
centroids; choose by size or position (here the right-most) and the OS click
lands dead-on (`TARGET-HIT`). `49/49 checks passed`.
**Lesson (道法自然):** 少則得，多則惑 — collapse the many into one number and you
gain a tidy answer but lose the truth; the mean of two things is often a third
thing that does not exist. Do not average what is plural. Let each region stand
as itself (萬物並作), then choose — perception must preserve multiplicity before
the will selects among it.

---

## Frontier (next honest rounds)

These are *not yet built* — they are the next real surfaces to push into. Each
will only grow a primitive once a real failure is reproduced.

- **R-next: out-of-process (cross-site) iframes** — when the child context does
  *not* appear on the page session; needs `Target.setAutoAttach` + per-target
  `sessionId` routing (the plumbing for which already exists in `cdp.py`).
- **R-next: template-match locate** — when competing regions share the *same*
  colour and differ only in shape/glyph; segmentation (F052) separates them but
  cannot say *which* is the target — that needs matching a small reference patch
  by appearance, not colour.

> 為學者日益，聞道者日損。 We add primitives only by subtracting frictions.
