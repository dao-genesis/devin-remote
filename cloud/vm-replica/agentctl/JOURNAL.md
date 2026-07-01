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
endpoint (`127.0.0.1:29229`) — and, from F177 on, against native apps on the
agent's own Linux/X11 VM — via `test_live.py`: **~800 live checks across 137
friction rounds**. (The count below grows round by round; the totals quoted in
early entries are that round's running total, not the final figure.)

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

### F053 — two things the same colour, the same size: only the shape tells them apart
**Surface:** two magenta squares, identical in colour *and* size, differing only
by the black glyph painted inside — one holds a cross (the target), one a
triangle (the decoy). A human reads the *shapes* and aims at the cross. F052's
`find_color_blobs` now correctly sees *two* regions, but both report the same
colour and the same area; nothing in the colour channel distinguishes them.
**Mechanism:** segmentation recovered the plurality (good) but the tie-breaker
left to the caller is *position*, and position is arbitrary. Here the target is
the LEFT square, so the natural R16 heuristic — "take the right-most" — lands
confidently on the *decoy* (`DECOY`). The information that separates them is not
where they are or what colour they are; it is what they *look like*. Colour and
position are exhausted — appearance is the only remaining channel.
**Primitive:** `osctl.crop_rgb(rgb, size, bbox)` cuts a reference patch out of a
capture (turning *what was seen there once* into something recognisable
elsewhere), and `osctl.match_template(patch, pw, ph, …, search, step)` slides
that patch over a region and scores every offset by sum-of-absolute-difference
on luma — lowest score is the closest match — returning `{x, y, score, bbox}`
centred in screen coordinates. The idiom is *colour to narrow the field,
appearance to choose within it*: `find_color_blobs` gives the candidates, then
`match_template` scores each one's bbox against the reference. The cross scores
`0` (it *is* the reference); the triangle scores `116764`. The agent picks the
left target by appearance and the OS click lands dead-on (`TARGET-HIT`).
`57/57 checks passed`.
**Lesson (道法自然):** 瞽者善聽，聾者善視 — when one sense is exhausted, the way
forward is *another* sense, not a louder guess on the same one. Colour had given
all it could; forcing a position heuristic onto it (為者敗之) only manufactures a
confident wrong answer. Let each channel speak in its own register — hue to
gather, shape to decide — and the thing names itself.

---

### F054 — a single snapshot is already a lie about a moving target
**Surface:** a magenta square animates — toggling between two far-apart spots,
then coming to rest at a third. A human waits for it to stop before reaching for
it. Every primitive so far (`find_color`, `find_color_blobs`, `match_template`)
reads *one* `capture_rgb` snapshot.
**Mechanism:** perception and action are not simultaneous. A snapshot fixes the
target's position at time *t*, but the synthesised click lands at *t+δ* — and in
that gap a live element has moved on. The capture was *true when taken* and
*false when acted on*. Proven: capture the square mid-animation, let it come to
rest, then click the captured coordinate → it lands where the square *was*,
hitting bare canvas (`MISS`). The colour channel was right; it was *stale*. No
amount of better locating fixes this — the flaw is acting on a frozen past.
**Primitive:** `osctl.wait_stable(target, tol, move_tol, settle_frames,
interval, timeout)` samples the `find_color` centroid repeatedly and returns
only once it holds within `move_tol` pixels for `settle_frames` consecutive
samples — i.e. the motion has actually come to rest — handing back the *present*
position (`{…, settled, samples}`). Now the click is aimed at where the target
*is*, and it lands dead-on (`HIT`). If it never settles within `timeout`, the
last seen locate is returned with `settled=False` so the caller decides.
`62/62 checks passed`, deterministic across three runs.
**Lesson (道法自然):** 重為輕根，靜為躁君 — stillness governs motion; do not act on
the first restless glimpse. 大音希聲 — listen to the page's own rhythm and let the
target come to rest before reaching for it; the patient hand, not the fast one,
lands true (躁勝寒，靚勝炅，請靚可以為天下正).

---

### F055 — the same shape in another colour, the wrong shape in the right colour
**Surface:** two tiles, one segmentable colour, each holding a glyph drawn in a
*different* colour from a captured reference. The LEFT tile is the **same shape**
as the reference (a ring) but recoloured (white → black); the RIGHT tile is a
**different shape** (a solid disk) painted in the reference's *own* colour. A
human reads "ring" instantly and ignores that it darkened. `match_template`
(F053) cannot — it scores absolute luma.
**Mechanism:** sum-of-absolute-difference on luma is dominated by the *uniform*
part of the difference. Recolouring a shape changes every one of its pixels by a
large constant, so the matching shape racks up a huge score (`538812`), while a
*different* shape that merely fills a small hole in the reference's colour scores
far lower (`105250`). Appearance-matching therefore picks the **decoy** — the
wrong shape — because colour, not shape, drives the metric. The signal we want
(geometry) is swamped by the signal we don't (fill colour).
**Primitive:** `osctl.edge_map(rgb, size, bbox, thr)` reduces a region to a
binary edge mask — 1 where the local luma gradient `|dL/dx|+|dL/dy|` exceeds
`thr`, i.e. only where one region *meets* another. That boundary geometry is
exactly what survives a uniform recolour. `osctl.match_edges(ref_edges, ew, eh,
…, search, step)` slides the reference mask over a region and scores each offset
by `edge_hamming` (count of differing edge pixels); lowest wins, returning
`{x, y, score, bbox}` in screen coordinates. Proven against the same scene: the
same-shape target scores `63`, the wrong-shape decoy `280` — edge-match picks the
recoloured ring and the click lands `TARGET-HIT`, where luma-match landed on the
decoy. `70/70 checks passed`, deterministic across three runs. The idiom layers:
colour to narrow the field (`find_color_blobs`), appearance when colour is
trustworthy (`match_template`), **structure** when colour itself has moved
(`match_edges`).
**Lesson (道法自然):** 大成若缺 — the ring is *defined by its hole*; what is
absent carries the shape, and only the edge mask, which keeps boundaries and
discards fill, can read it. 反也者，道之動也 — do not chase the loud, uniform
difference (colour); attend to where things *change* (the gradient), for that is
where form lives. Each sense answers a different lie: hue when colour is true,
patch when shape is plain, edge when colour deceives.

---

### F056 — the same shape drawn bigger, the wrong shape at the right size
**Surface:** the reference ring reappears, but **larger** — the page zoomed, ran
at a higher DPI, or re-laid-out responsively — beside a **different shape** (a
disk) drawn at the reference's *own* pixel size. A human still reads "ring"
regardless of how big it was rendered. `match_edges` (F055) cannot: its
reference mask is a fixed `ew`×`eh` pixel grid.
**Mechanism:** a fixed-size edge mask is implicitly translation-only. When the
matching shape is rendered at `1.5×`, its boundaries fall on entirely different
pixels than the reference mask expects, so the Hamming distance explodes
(`19298`) — while the wrong shape, sharing the reference's *size*, aligns its
(few) edges and scores far lower (`281`). Structure-match therefore picks the
**decoy** again, this time because *scale*, not colour, has moved. Re-sampling
the thin edge mask directly does not help (`694` vs `281`): a one-pixel contour
resamples into noise.
**Primitive:** `osctl.edge_signature(rgb, size, bbox, nw, nh, thr)` collapses the
size dependence *before* edging. It area-averages the region's luma down to a
fixed `nw`×`nh` canonical grid (default 48×48) and thresholds the gradient
*there*, so any rendering of the same shape — whatever its pixel dimensions —
reduces to the **same** signature; compare two with `edge_hamming`. Segmentation
already gives each candidate's true `bbox` (hence its size), so the idiom is:
segment by colour, take one signature per candidate at the canonical grid, pick
the lowest distance to the reference. Proven against the rescaled scene: the
bigger-but-correct ring scores `24`, the right-size-but-wrong disk `117` — the
signature picks the rescaled ring and the click lands `TARGET-HIT`, where the
fixed mask landed on the decoy. `78/78 checks passed`, deterministic across
three runs. The perception ladder now reads: hue (`find_color_blobs`) → patch
(`match_template`) → rigid structure (`match_edges`) → **scale-free structure**
(`edge_signature`).
**Lesson (道法自然):** 大方無隅，大器晚成 — the great form has no fixed corner and
no fixed measure; to know a shape you must first stop measuring it in the frame
of how big it happened to be drawn. 為者敗之 — forcing the mask to the literal
pixels fails the moment the world rescales; yield instead to a frame the shape
shares with all its renderings, and the likeness is simply there. Each register
discards one more accident — first position, then colour, now size — keeping only
what is essentially the thing.

### F057 — the same shape turned, the wrong shape left upright
**Surface:** the reference glyph (a horizontal bar) reappears **rotated 90°** —
the page re-laid-out, an icon spun, a control rotated under transform — beside a
**different** glyph (a wide ellipse) left at the reference's *own* orientation. A
human still reads "bar" however it is turned. `edge_signature` (F056) cannot: it
is scale-free but still orientation-bound.
**Mechanism:** the signature resamples the region onto a fixed `nw`×`nh` grid, so
turning the bar 90° lights up *entirely different cells* — its signature distance
explodes (`520`) — while the same-orientation ellipse, sharing the reference's
upright layout, aligns its cells and scores far lower (`194`). Signature-match
therefore picks the **decoy** yet again, this time because *angle*, not size or
colour, has moved.
**Primitive:** `osctl.radial_profile(rgb, size, bbox, bins, thr)` discards the
angle. It edges the region, finds the centroid of the edge pixels, measures each
edge pixel's distance to that centroid, normalises by the largest such distance
(killing scale too), and histograms those normalised radii into `bins` buckets
summed to 1. Rotating a shape about its centroid moves *no* pixel's radius, so
the histogram is unchanged; rescaling divides every radius by one factor the
normalisation cancels. Compare two with `osctl.profile_l1` (lower = more alike).
It discards angular order, so it is deliberately *less* specific than the
signature — pair it with `edge_signature` when orientation is fixed; reach for it
only when the thing can turn. Proven against the rotated scene: the turned-but-
correct bar scores `0.000`, the upright-but-wrong ellipse `0.393` — the profile
picks the rotated bar and the click lands `TARGET-HIT`, where the signature
landed on the decoy. `85/85 checks passed`, deterministic across three runs. The
perception ladder now reads: hue (`find_color_blobs`) → patch (`match_template`)
→ rigid structure (`match_edges`) → scale-free structure (`edge_signature`) →
**rotation-&-scale-free structure** (`radial_profile`).
**Lesson (道法自然):** 大方無隅 — the great form has no corner; to recognise a
thing you must stop pinning it to the one orientation it happened to face. 反也
者，道之動也 — turning is the way's own motion; meet it not by forcing the mask
back upright but by choosing a frame (radius about the centre) in which turning
*does not move anything at all*. The register grows by giving up one more
specificity — angular order — and keeping only what rotation leaves invariant;
each such surrender is also a narrowing of what the descriptor can tell apart, so
it is reached for last, not first (重為輕根：the heavier, more specific registers
ground the lighter, more invariant ones).

### F058 — two controls identical but for the word they bear
**Surface:** two magenta buttons, **same** colour, **same** size, **same** outer
shape — the only thing that sets them apart is the white **glyph** the page draws
onto the canvas ("A" vs "B"). No DOM node carries the text; no colour or contour
distinguishes them. A human reads the letter and clicks the right one. Every
register up to `radial_profile` is blind here: they describe the tile, not the
character on it.
**Mechanism:** colour segmentation finds both tiles; structure could tell them
apart only with the target's *own* rendering in hand. The honest tool we have is
a reference **atlas** of candidate glyphs — but rendered at a different size than
the live buttons (`bold 80px` swatch vs `bold 120px` button). A fixed-size edge
match against that atlas is defeated by the size gap exactly as F056 was: it
reads *both* live buttons as the same letter (`target→A`, `decoy→A`), so it
cannot read text at all.
**Primitive:** `osctl.read_glyph(rgb, size, bbox, atlas)` classifies in the
scale-free frame built in F056. It takes the region's `edge_signature` and
returns the `atlas` label whose signature is closest by `edge_hamming`; the atlas
is `{label: edge_signature(...)}` built once from reference glyphs (the page's own
scratch-canvas rendering, or a captured known control). Because the comparison is
scale-free, a glyph recognises itself however large it was drawn: the live "A"
button reads `A` (`131` vs `339`), the "B" button reads `B` (`213` vs `357`), and
the click lands `TARGET-HIT` on the button that *says* "A". `92/92 checks
passed`, deterministic across three runs. This is reading text from pixels
reduced to its smallest honest form — not full OCR, but enough to pick the control
that says the right thing. The perception ladder is now complete from raw hue to
rendered meaning: hue (`find_color_blobs`) → patch (`match_template`) → rigid
structure (`match_edges`) → scale-free structure (`edge_signature`) →
rotation-&-scale-free structure (`radial_profile`) → **rendered glyph**
(`read_glyph`).
**Lesson (道法自然):** 道隱無名，始制有名 — the page hides its meaning behind nameless
pixels; naming begins only when we render the candidate names ourselves and let
the thing match the name it already wears. 不行而知 — we do not OCR the whole
world; we carry only the few glyphs that matter and recognise among them, 少則得.
And it builds on what came before rather than replacing it: `read_glyph` is
`edge_signature` pointed at a labelled atlas — the highest register is the lowest
one given a name to match against (大器晚成：the great vessel is the simple tool,
late-completed, by being aimed).

---

### F059 — a cross-SITE iframe the connection cannot see into
**Surface:** a parent page embeds an iframe whose `src` is a *different site*
(`https://example.com`). The child clearly loads (`window.frames.length === 1`)
and a human reads it without thinking. But `eval_in_frame` (F049) — which served
us for same-IP/different-port children — returns `None`: there is no execution
context for the child on the page session at all. The frame is invisible to every
DOM tool we have.
**Mechanism:** Chrome **site isolation** puts a cross-*site* document in its own
renderer **process**, reachable only through its own CDP **target/session**.
R13's cross-origin child (same IP, different port) was *same-site* and shared the
page's process, so its context still showed up on the page session. A cross-site
child does not: its `Runtime.executionContextCreated` is emitted on a session that
was never attached, so it never reaches us. The page session is not walled off by
choice — it simply is not connected to that process.
**Primitive:** auto-attach plus per-session routing, in `cdp.py`. On connect we
call `Target.setAutoAttach{autoAttach, flatten:true}`; when a child target
attaches we record its `sessionId`, enable `Runtime`/`Page` in it (fire-and-forget
on the reader thread, per the F006 deadlock rule), and recurse so nested OOP
frames attach too. Child contexts are keyed by `"<sessionId>:<contextId>"` (their
ids are unique only within their own session), and `evaluate` resolves that key to
the real session-local `contextId` and routes the command with its `sessionId`.
One websocket now reaches every frame, in-process or not. `eval_in_frame` is
unchanged at the call site: it reads `Example Domain` across the process boundary,
edits the child's `<h1>`, and reads the change back; an absent frame still returns
`None` fast. `99/99 checks passed`, deterministic across three runs.
**Lesson (道法自然):** 將欲取之，必固與之 — to reach the walled child we did not push
against the same-origin wall (為者敗之); we let the browser hand us a session for it
and simply went through the door it opened. 玄德：長而不宰 — each new frame attaches
and governs its own context; we route to it without flattening its identity into
the parent's. The lowest layer (`cdp.py`) grew so the highest call (`eval_in_frame`)
need not change — 大制無割, the great tailoring leaves no seam.

### F060 — a new tab the connection never followed
**Surface:** a `target=_blank` link (or `window.open`) is clicked. A human sees a
new tab pop to the front and simply works in it. We click it, and a new page target
**does** appear in `/json/list` — but `document.title` still reads the *opener*.
Everything we evaluate, type, or click lands on the old tab. The new tab is on
screen yet completely undriveable.
**Mechanism:** a new top-level tab is its own **page target** with its own devtools
websocket. Unlike F059's cross-site *child frame* — which Chrome auto-attaches to the
opener's session because it belongs to the same page — a sibling **top-level** target
is attached to nobody. `Target.setAutoAttach` only cascades to subframes of the page
we are on, not to brand-new pages. So our one connection stays bolted to the opener;
the new tab emits its contexts on a socket we never opened.
**Primitive:** `Browser.switch_page(match)` (+ `pages()`), backed by a re-entrant
`CDP.connect`. We list page targets over HTTP, find the one whose url/title contains
`match`, **close the current websocket and connect to that tab's own
`webSocketDebuggerUrl`**, then re-inject helpers. `connect()` now clears its
per-connection state (contexts, sessions, listeners) so the old tab's bookkeeping
never leaks into the new one and listeners are not double-registered. The result is
the programmatic act of *clicking the new tab*: after `switch_page("s-…")` we read
its `<h1>`, `click_text("go")` drives it, and `switch_page("8931/")` returns to the
opener; an absent tab fails fast. `108/108 checks passed`, deterministic ×3.
**Lesson (道法自然):** 不行而知，不見而名 — we did not try to force the opener's session
to peer into a tab it was never connected to (為者敗之); we let the browser keep each
tab whole and simply moved our attention to where the action already was. 知人者智，自知者明
— the connection learned to *know which page it is on* and to let go of the old one
(`connect` clears itself) before taking up the new; 為學日益，為道日損 — the primitive
grows by what it releases, not only by what it adds.

### F061 — a click the overlay ate, and the success that lied
**Surface:** we locate a button, read its bounding box, and click its center. The
call returns `True` — yet the page never reacted. A transparent fixed scrim (a
modal backdrop, a cookie wall, a sticky header at 0.001 opacity) covers the
viewport: the button shows through visually, but every click lands on the scrim.
`elementFromPoint(center)` resolves to `scrim`, not the button. The element is
*visible* by every DOM test (`offsetParent`, rects, computed style) and still
unreachable. Worse, the old `click` reported success because it dispatched a
mouse event at a coordinate — it never checked *what* would receive it.
**Mechanism:** a trusted click is delivered by the compositor to whatever paints
**topmost** at (x,y), via hit-testing — not to the element we queried. Visibility
and hit-testability are different questions: `visible(el)` asks "does it paint?",
hit-testing asks "is it on top *here*?". An overlay with a higher stacking order
(or simply later in paint order) intercepts the event regardless of opacity. A
human never has this bug: they aim at the spot that *looks* clickable and, if a
wall is in the way, they see the wall.
**Primitive:** `hitPoint(el)` (helper JS) + `Browser._hit_point_of`, wired into
`click(require_hit=True)`. We scroll the element into view, then probe nine points
across its box (center, edges, inner corners) and return the first where
`elementFromPoint` resolves back to the element *or a descendant* — the visible
spot a human would actually aim for. If every sampled point is covered we report
`occluded:true` with the `blocker`, and `click` **refuses to fire** rather than
dispatching an event that lands on the scrim and lies about success. Partial
occlusion (top half walled) is handled by aiming at the clear lower point;
`require_hit=False` preserves a deliberate geometric click for callers that want
it. `117/117 checks passed`, deterministic ×3.
**Lesson (道法自然):** 信言不美，美言不信 — a click that *claims* success without
verifying it reached the target is a beautiful lie; we made `click` speak the
truth even when the truth is "I could not reach it." 為者敗之 — we did not force a
synthetic event through a wall; we looked for the door the layout already leaves
open (the uncovered point) and, finding none, declined to act rather than pretend.
知止不殆 — knowing when *not* to click is itself a capacity that exceeds blind
screenshot-and-tap.

### F062 — a dropdown whose list the page never paints
**Surface:** a native `<select>`. A human clicks it, the operating system draws a
popup list of options, they pick a row. We try the same: click the select, then
click where the third row *appears* (~3 row-heights below). The value never
changes, `onchange` never fires. The popup is **OS-drawn** — it is not in the DOM
and not on the page's painted surface, so a coordinate click where the row looks
to be lands on the page behind it (or on nothing). And `set_value` — built for
`<input>`/`<textarea>` via the `HTMLInputElement.value` setter — throws
`TypeError: Illegal invocation` when called on a `<select>` (wrong prototype).
Both of our reach paths (pixel and value) miss.
**Mechanism:** the option list is a native widget rendered by the browser/OS
*outside* the web contents — there are no `elementFromPoint` hits for its rows and
no pixels of it in a page screenshot. The selection state lives in the
`HTMLSelectElement`: its `value`/`selectedIndex` and its `<option>` children. A
human's *intent* ("choose Blue") maps to an option, not to a screen coordinate;
chasing the coordinate is imitating the human's hand while ignoring the human's
goal.
**Primitive:** `Browser.select_option(selector, value|label|index)`. It finds the
`<option>` matching the criterion (exact `value`, trimmed visible `label`, or
positional `index`), sets the choice through the **real**
`HTMLSelectElement.prototype.value` setter (so a framework's value tracker sees
the change instead of being bypassed), aligns `selectedIndex`, and dispatches
bubbling `input`+`change`. No popup is ever opened; the selection is made
semantically and the page reacts exactly as if a human had picked the row — only
faster and without the OS round-trip. An option that does not exist returns
`False` rather than inventing a selection. `125/125 checks passed`, deterministic
×3.
**Lesson (道法自然):** 為者敗之 — forcing a click into a popup the page cannot even
paint is pushing against a wall; we stopped chasing the OS-drawn pixels and acted
where the state actually lives (執大象，天下往 — hold the great image and the rest
follows). 知止不殆 — when the option is absent we decline rather than fabricate.
The human opens, scrolls, and clicks; we go straight to the meaning of the act —
和其光，同其塵 — matching the page's own mechanism instead of miming the hand.

### F063 — a text box with no text box: the contenteditable editor
**Surface:** a rich editor — a comment body, a Slack/Gmail compose area, a Notion
block. To the eye it is just a place to type, and a human selects-all and types
over the old text. But it is a `<div contenteditable>`, not an `<input>`: it has
**no `.value`**. `set_value` (the `HTMLInputElement.value` setter) throws
`Illegal invocation` on a div, and `type_text`'s clear step — `el.value=''` — is a
silent no-op, so the old text survives and the new text *merges* into it:
typing `NEW` into `OLD TEXT` yields `OLD TEXTNEW`, not `NEW`.
**Mechanism:** a contenteditable host keeps its content as **child DOM nodes**, not
a string property; the editor's own model is driven by `beforeinput`/`input`
events, not by assigning a value. A human's "replace everything" is two real acts:
put a selection across the whole contents (Ctrl+A), then type — which deletes the
selection and inserts. Poking a `.value` that does not exist skips the only
channel the editor listens on.
**Primitive:** `Browser.set_editable(selector, text)`. It focuses the editor,
selects its entire contents through the **Selection API**
(`Range.selectNodeContents` + `getSelection().addRange`), then issues
`Input.insertText` over CDP — which replaces the selection and fires genuine
`beforeinput`/`input`, so the editor's internal model updates exactly as if a human
had typed. `OLD TEXT` becomes `REPLACED` cleanly, with one real `input` event; a
target that is not an editable host returns `False` rather than pretending. The
perception/actuation ladder now reaches **rich editors**. `130/130 checks passed`,
deterministic ×3.
**Lesson (道法自然):** 為者敗之 — assigning a `.value` the div never had is forcing a
door that isn't there; we used the editor's own channel (selection + insertText)
instead. 反者道之動 — the way forward was to *subtract* the old contents first
(select-all) before adding the new, the same two-beat motion a human makes. 信言
不美 — when the host isn't editable we say `False`, not a flattering success.

### F064 — a file you can only give by letting go of it
**Surface:** a dropzone — the dashed rectangle on Slack, Gmail, an avatar uploader
that says "drop a file here". A human drags a file out of the OS file manager and
releases it over the region. There is **no `<input type=file>`** anywhere: `F009
set_file_input` has no node to target. And a coordinate drag (`dnd`, F047) moves
DOM nodes within the page — it carries no file — so the dropzone's `drop` handler
reads `e.dataTransfer.files` and finds it empty. Both file paths we own miss.
**Mechanism:** the only thing the page ever receives from an OS file-drop is a
`drop` **event** whose `DataTransfer` holds a `File`; the OS drag itself is
invisible to the page. The handler doesn't care how the `DataTransfer` was filled,
only that `files[0]` is a real `File` it can `FileReader`-read. The human's gesture
(drag from desktop, release) is just packaging — the payload is the event.
**Primitive:** `Browser.drop_file(selector, name, content, mime)`. It builds a real
`File([content], name, {type})` inside a fresh `DataTransfer`, then dispatches
`dragenter`→`dragover`→`drop` at the target's centre, forcing `dataTransfer` onto
each event (the `DragEvent` constructor leaves it `null`). The dropzone fires its
handler exactly once, `files[0].name`/`.type` are correct, and a `FileReader`
reads the bytes back verbatim — the page cannot tell it from a human's drop. An
absent target returns `False`. `137/137 checks passed`, deterministic ×3.
**Lesson (道法自然):** 弱者道之用 — we stopped trying to *drag* (mime the hand) and
gave the page the one thing it actually consumes (the event with the file); the
soft, indirect path is the working one. 大巧若拙 — no OS round-trip, no pixel
chase; the file is handed over where the page reaches for it. 信言不美 — an absent
dropzone is declined, not faked.

### F065 — a stroke is a path, not two endpoints
**Surface:** a drawing canvas — a signature pad, a sketch box, a map lasso. A human
sweeps a pen and the surface records the whole **path**: `pointerdown`, many
`pointermove`, `pointerup`. Our `drag` (F047 family) walks a *straight line*
between two endpoints — 20 samples that are all collinear (perpendicular deviation
`0`). A pad that asks you to *draw* something (or an anti-bot check that rejects a
ruler-straight signature) is never satisfied: the gesture has the right endpoints
but the wrong shape.
**Mechanism:** the canvas has no DOM for its strokes — the drawing lives in the
*sequence* of pointer positions it receives. What distinguishes a signature from a
line is the curvature carried by the intermediate points; `drag`'s linear
interpolation throws exactly that away. Chrome turns each CDP `mouseMoved` into a
`pointermove`, so the renderer will faithfully record any polyline we walk — we
just have to walk the real one.
**Primitive:** `Browser.draw_path(points)`. Press at the first point, emit a real
`mouseMoved` through **every** intermediate point in order (preserving curvature),
release at the last — one connected, arbitrarily-curved stroke. A 26-point arc is
recorded with a perpendicular deviation of `59px` (a true bend) and the `pointerup`
lands; a straight `drag` over the same span deviates `0`. Fewer than two points
returns `False`. The actuation ladder now reaches **continuous gestures**, not just
discrete clicks. `143/143 checks passed`, deterministic ×3.
**Lesson (道法自然):** 大直若屈 — the great straight looks bent: a real signature is
*not* a straight line, and forcing the shortest path (`drag`) is the lie; we follow
the curve the hand would. 為者敗之 — we stop interpolating a line through a surface
that measures the curve. 少則得 — fewer than two points is no stroke, so we decline
rather than invent one.

---

### F066 — a paste runs the editor's pipeline; writing text bypasses it
**Surface:** a rich editor that *transforms* what you paste — a comment box that
turns a bare URL into a link chip, a notes app that sanitises pasted HTML, a
spreadsheet that splits a tab-separated paste into cells, a markdown field that
renders on paste. We can already *write* text into such a field (`set_editable`
F063, `type_text`), but writing puts the **raw** characters straight into the DOM:
the editor's `paste` handler never fires, so the URL stays literal where a human's
Ctrl+V would have produced a chip. Right text, wrong representation.
**Mechanism:** a human's paste is not "characters appear" — it is a `paste` event
whose `clipboardData` (a `DataTransfer`) carries the payload in one or more
flavours (`text/plain`, `text/html`). The editor reads `getData(...)`, calls
`preventDefault`, and inserts *its own* transformed nodes. Setting `.value` or
`textContent` skips that event entirely; the transform code path is simply never
entered. The `ClipboardEvent` constructor, like `DragEvent`, leaves `clipboardData`
`null`, so a naïve `new ClipboardEvent('paste')` carries nothing.
**Primitive:** `Browser.paste_into(selector, text, html=None)`. Focus the target,
populate a fresh `DataTransfer` with the `text/plain` (and optional `text/html`)
flavours, and dispatch a real `ClipboardEvent('paste')` with `clipboardData`
forced on via `Object.defineProperty`. The editor's own paste logic runs: in the
live round a pasted `https://example.com` is rewritten by the page into
`<a>[link]</a>`, while `set_editable` of the same string leaves raw text and never
fires the handler. Absent target returns `False`. `150/150 checks passed`,
deterministic ×3.
**Lesson (道法自然):** 反者道之動 — we stop pushing characters *in* and instead
hand the editor the clipboard it expects, letting its own pipeline do the work
(無為而無不為: we do nothing to the DOM ourselves, yet the chip appears). 弱者道之用
— the soft channel (a data-bearing event) accomplishes what the forceful one
(writing nodes) cannot. 信言不美 — no target, no paste; we return `False` instead
of pretending.

---

### F067 — a context menu answers the right button, not the left
**Surface:** an app that replaces the OS menu with its own — a file manager's row
actions, an editor's spell menu, a data grid's cell options. The menu (and every
item inside it) only appears on the `contextmenu` event. Our `click` (and the
whole click family) dispatches the **left** button exclusively, so `contextmenu`
never fires: the menu stays `display:none` and its `Delete`/`Rename`/… items are
unreachable no matter how precisely we aim.
**Mechanism:** `contextmenu` is raised by the *right* button, not by a second
left click. Chrome surfaces a right-button `Input.dispatchMouseEvent` press as a
real `contextmenu` DOM event at the cursor — the same event a human's right-click
produces — which the app's handler turns into a positioned menu. We still want the
hit-verified aim point (F061) so we don't fire the right-click into an overlay and
lie about it.
**Primitive:** `Browser.context_click(selector)`. Resolve the same `hitPoint`
`click` uses (refusing an occluded target under `require_hit`), then dispatch a
**right**-button press/release there. Live: a left click bumps `__left` but leaves
`__ctx==0` and the menu hidden; `context_click` raises `contextmenu` once, the
app's menu becomes visible, and its `Delete` item is then clickable. Absent target
returns `False`. `157/157 checks passed`, deterministic ×3.
**Lesson (道法自然):** 知其雄，守其雌 — knowing the dominant (left) button is not
enough; the menu lives behind the one we'd overlook. 反者道之動 — the answer is
the *other* button, not more of the same. 信言不美 — no target, no menu; we decline
rather than pretend a right-click landed.

---

### F068 — a shortcut is a modifier *held while* a key is tapped, not a bare key
**Surface:** an app that binds real work to a keyboard chord — Ctrl+B bolds,
Ctrl+S saves, Ctrl+Enter submits, Shift+Tab walks back a field. The handler reads
`e.ctrlKey`/`e.shiftKey`/… to decide. Our `press_key` (F0xx) sends a *bare* key
with no modifier state, so `s` alone is not Ctrl+S: the guard `if(e.ctrlKey)` is
false, the binding never matches, and the shortcut is simply dead — the key falls
through as if typed into the document.
**Mechanism:** a chord is not one event — it is the modifier key pressed *down*
first (so every event in between reports `ctrlKey==true`), then the main key
tapped *while the modifier is held*, then the modifier released. Chrome's
`Input.dispatchKeyEvent` needs both: the held modifier delivered as its own
`keyDown` (with the correct `windowsVirtualKeyCode`) **and** the `modifiers`
bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8) set on the main key's events. Omit either
and `e.ctrlKey` stays false.
**Primitive:** `Browser.key_chord(key, ctrl=…, shift=…, alt=…, meta=…)`. Press each
requested modifier key (accumulating the bitmask), tap the main key with that mask
set, then release the key and the modifiers in reverse order. Live: pressing bare
`s` does nothing to `__saved`, while `key_chord('s', ctrl=True)` fires the page's
Ctrl+S handler once and `__saved` flips. `162/162 checks passed`, deterministic ×3.
**Lesson (道法自然):** 一生二，二生三 — the chord is born of order: modifier *before*
key, release *after*; the sequence is the meaning. 大音希聲 — the modifier makes no
mark of its own, yet without it the key says nothing the app hears. 信言不美 — we
report exactly what fired, not what we wished had.

---

### F069 — a segmented field advances on each key, not on one inserted string
**Surface:** a field that splits its value across one input *per character* and
moves focus inside a `keydown` handler — an OTP/passcode strip, a card-number
group, a "type each digit" box. The advance logic reads `e.key` on every
keystroke. Our `type_text` delivers the whole string with a single
`Input.insertText`: one `input` event on the *first* box and **no `keydown` at
all**, so the handler never runs, focus never hops, and only box one is touched
(`1234` → `1___`). Right characters, wrong destination.
**Mechanism:** a human does not paste a string into a segmented field — they tap
one key at a time, and *between* taps the page itself moves focus to the next box.
What the page needs is a stream of real `keyDown`/`keyUp` events each carrying a
faithful `e.key`/`e.code`; `Input.insertText` carries none of that. Whatever holds
focus at the moment of each keyDown receives that character — including a box that
was handed focus by its predecessor's handler one event earlier.
**Primitive:** `Browser.type_keys(text)`. For each character, resolve a key
descriptor (`key`/`code`/`windowsVirtualKeyCode`) and dispatch a real `keyDown`
(with the inserted `text` too, so plain fields still get the char) then `keyUp`.
Focus walks box to box exactly as under a human's fingers. Live: `type_text`
leaves `1___` and fires zero keydowns; `type_keys('1234')` fills `1234` across all
four boxes via four real keydowns. `165/165 checks passed`, deterministic ×3.
**Lesson (道法自然):** 大器免成 — the value is not stamped whole; it is completed
key by key, each tap making room for the next. 守柔曰強 — the patient per-key stream
reaches where the forceful single insert cannot. 信言不美 — we report exactly which
keys fired and where focus landed, not a string we wished had stuck.

---

### F070 — a custom pane turns on the wheel, not on scrollTop
**Surface:** a scroller that is not a native scroll container — a zoomable map, a
carousel, an "infinite" feed that loads more on wheel, a virtualized pane that
translates its own content. It has no scrollbar; it listens for `wheel` at the
cursor and moves its content itself. `scroll_until(container=…)` does
`c.scrollTop += step`, which such a pane silently discards (`off` stays `0`); and
`scroll(dy)` *does* dispatch a real wheel, but at a fixed page-centre point
(`400,300`), so when the pane sits elsewhere the wheel lands on the wrong element
and the pane never moves.
**Mechanism:** the pane only advances on a `wheel` event delivered *over itself*.
Assigning `scrollTop` to a non-scrolling element is a no-op; a wheel at the wrong
coordinates is consumed by whatever is under those coordinates. A human points at
*that* pane and turns the wheel — the event must carry the pane's own centre.
**Primitive:** `Browser.wheel_at(selector, dy, dx=0)` resolves the element's centre
and dispatches `Input.dispatchMouseEvent` `mouseWheel` there, so the pane's own
`wheel` handler fires; `Browser.wheel_until(found_js, selector, …)` steps it until
a condition holds (letting the pane re-render between turns). Live: a scrollTop
scroll and a fixed-centre wheel both leave `off==0`; `wheel_until` over the pane's
centre drives `off` past the target. Absent pane returns `False`. `170/170 checks
passed`, deterministic ×3.
**Lesson (道法自然):** 圖難於其易 — we stop forcing a scrollbar that isn't there and
give the pane the one signal it answers. 其安易持 — aim at the thing itself, not the
middle of the screen. 信言不美 — no pane, no wheel; we return `False` rather than
spin against a target that isn't there.

---

### F071 — selecting a word / paragraph, not just placing a caret
**Surface:** grabbing a *span of text* — to bold it, copy it, highlight/annotate,
or trigger a define-on-select popover.
**Friction:** every one of those gates on a **non-collapsed** `Selection`. A plain
`click` collapses the caret to a zero-width point, so `getSelection().toString()`
is `''` and the formatting button (and the popover) never enables. There is no
`.value` to set and no API call the app is watching — it watches the user's drag
or multi-tap. Worse, the obvious "click the element" lands on the *centre of its
layout box*, which for a block is far past the glyphs, in blank space — a
double-click there selects nothing.
**Mechanism:** Chrome turns a mouse press carrying `clickCount:2` into a
word-level selection and `clickCount:3` into a paragraph-level one — the same
escalation a human's repeated taps produce. And a `Range.selectNodeContents(el)`
reports `getClientRects()`, the rectangles the *text* actually occupies, so we can
aim at a real word instead of the box centre.
**Primitive:** `Browser.click_n_xy(x,y,count)` presses/releases with escalating
`clickCount`; `Browser.select_word(selector)` aims at the first text rect's centre
and double-clicks, returning the selected string; `Browser.select_paragraph`
triple-clicks for the whole block. Live: a plain click leaves `__sel==''` and Bold
disabled; `select_word` returns a single word (`'gamma'`) and flips Bold on;
`select_paragraph` returns the whole line; an absent target returns `None`.
`176/176 checks passed`, deterministic ×3.
**Lesson (道法自然):** 其安易持，其未兆易謀 — selection is held before it is acted
on; we make the held state first, then the toolbar follows by itself. 大方無隅 —
the block's box has no honest corner to aim at; we aim at the text's own edge.
信言不美 — no text, no selection; we return `None` rather than report a caret as a
grab.

---

### F072 — drag-selecting an arbitrary character range
**Surface:** styling/quoting/renaming a *precise span* — bolding exactly two of
four words, quoting half a sentence, grabbing part of a label.
**Friction:** `select_word`/`select_paragraph` (F071) only snap to whole words or
blocks. There is no `clickCount` for "two-and-a-half words", so neither granularity
can isolate `"beta gamma"` out of `"alpha beta gamma delta"`. The only thing that
reaches it is a real *drag* from the first glyph to the last.
**Mechanism:** Chrome grows the `Selection` character by character as the cursor
moves **with the left button held down** — and the move events must carry that
button state (`buttons:1`) or the frame's selection controller never treats them
as a drag. The caret pixel for a character offset comes from collapsing a `Range`
at that offset inside the right text node and reading its rect.
**Primitive:** `Browser._caret_point_of(selector, offset)` walks the element's text
nodes to the offset and returns the caret x/y; `Browser.select_range(selector,
start, end)` presses at the start caret, moves through to the end caret carrying
`buttons:1`, and releases — exactly the drag a human makes. Live: `select_range(6,
16)` returns `'beta gamma'`, `(0,5)` returns `'alpha'`, an absent target returns
`None`. `180/180 checks passed`, deterministic ×3.
**Lesson (道法自然):** 弱者道之用 — the move only works while it stays *soft*, the
button held but not re-pressed; carrying the button state is what makes the drag
real. 為之於未有 — we compute the caret before we press, so the drag has somewhere
honest to start and end.

---

### F073 — setting a custom slider to a precise value
**Surface:** a volume / brightness / price-range / zoom control built from
`<div>`s — drag a handle along a rail to a value.
**Friction:** there is nothing to *write*. `set_value` reaches for a `.value`
setter that a `<div>` has no descriptor for and throws *Illegal invocation*. The
slider exposes no `scrollTop` either. It listens for `pointerdown` on the **thumb**
and `pointermove` along the **track**, mapping the cursor's fraction of the rail to
its value — so a plain `click` on the track does nothing (the press never lands on
the handle), and `select_range`'s text-drag (F072) has no notion of a value.
**Mechanism:** the only input the slider believes is a real drag of its handle:
press at the thumb, move across the track with the button held (`buttons:1`, so a
handler reading `e.buttons` still counts it as a drag), release at the target
fraction. The value is the cursor's fraction of `track.getBoundingClientRect()`,
so resolving both rects lets us aim at any fraction.
**Primitive:** `Browser._rect_of(selector)` returns an element's viewport rect;
`Browser.set_slider(thumb, track, fraction, axis="x")` presses the thumb centre,
steps to `fraction` along the track carrying `buttons:1`, and releases. Live:
`set_slider(0.73)` lands value `73`, `0.20` lands `20`, an absent handle returns
`False`; `set_value` on the same `<div>` raises and a plain click leaves it at `0`.
`187/187 checks passed`, deterministic ×3.
**Lesson (道法自然):** 大成若缺 — the slider looks finished but has no value to set;
its completeness is in the gesture, not a property. 柔弱勝剛強 — we don't force a
write the element refuses; we yield to the drag it actually listens for.

---

### F074 — clicking inside a closed shadow root
**Surface:** a packaged web component — a design-system button, a payment field,
a media player's controls — built with `attachShadow({mode:'closed'})`, which
renders on screen but seals its internals from every script.
**Friction:** there is no path *through the page* to the inner element. A closed
root sets `host.shadowRoot` to `null`, so `deepQuery` (which walks
`el.shadowRoot`) sees nothing, `document.querySelector('#go')` returns nothing,
and `click('#go')` returns `False` — yet a human points at the visible button and
clicks it without a thought. Visible ≠ reachable-by-selector.
**Mechanism:** the closed root is sealed only to *page JavaScript*. The CDP DOM
domain still sees it: `DOM.getDocument{pierce:true}` returns every shadow root
(each tagged `shadowRootType:"closed"`) as a node, and `DOM.querySelector` run
*within that node's id* resolves selectors in its subtree. From the matched node
`DOM.getBoxModel` gives the on-screen quad, whose centre is where a human would
aim.
**Primitive:** `Browser._pierce_node(selector)` collects the document plus every
(nested) shadow root from a pierced `DOM.getDocument` and queries each in document
order; `Browser._point_of_node(nid)` reads its content-box centre;
`Browser.click_shadow(selector)` clicks that point with a real trusted event.
Live: the host's `shadowRoot` is `null`, `deepQuery`/`click` both fail on `#go`,
but `click_shadow('#go')` fires the sealed button's own handler; an absent
selector returns `False`. `193/193 checks passed`, deterministic ×3.
**Lesson (道法自然):** 塞其悶，閉其門 — the component closes its doors, but the door
is closed only to those who knock from inside the page; the body that observes
from outside (CDP) still walks straight in. 不窺於牖，以知天道 — we do not peer
through the page's window at all; we read the layout the renderer already drew and
aim where a hand would.

---

### F075 — typing into an input inside a closed shadow root
**Surface:** a sealed component that holds an *editable* field — a design-system
search box, a packaged payment input, a chat composer in a closed root.
**Friction:** `click_shadow` (F074) can *press* a sealed control, but typing is a
different blindness. `type_text`/`set_value` resolve their target with `deepQuery`,
which is `null` past a closed root, so both return `False` and the field keeps its
old value — a human, meanwhile, just clicks it and types.
**Mechanism:** the keystrokes need no selector at all — they flow to whatever
holds focus. So the only missing piece is *putting focus inside the sealed root*.
`DOM.focus` acts on a CDP node id (not a page selector), so the same pierced node
that F074 clicks can be focused; then a real `keyDown`/`keyUp` per character lands
in the field. Clearing first needs the editing command, not a blind keystroke:
Ctrl+A select-all only fires Chrome's *Select All* if the event carries the real
`code:"KeyA"` and `windowsVirtualKeyCode:65` — a bare `key:"a"` is ignored and the
new text merely prepends (`OLD` → `agent123LD`).
**Primitive:** `Browser.type_shadow(selector, text, clear=True)` pierces the closed
root (:meth:`_pierce_node`), focuses the node via `DOM.focus`, optionally
select-all (a fully-described Ctrl+A chord) + Delete, then dispatches per-character
`keyDown`/`keyUp` carrying `key`/`code`/`text`. Live: `deepQuery`, `set_value` and
`type_text` all fail on the sealed `#inp` (it keeps `OLD`), but `type_shadow`
leaves exactly `agent123`; an absent selector returns `False`. `200/200 checks
passed`, deterministic ×3.
**Lesson (道法自然):** 機在目 — the keystrokes go where the eye (focus) is, not where
the name points; move focus and the typing follows. 名亦既有，夫亦將知止 — a half-named
chord (`key` without `code`/VK) is no name the browser answers to; only the full
descriptor invokes the command.

---

### F076 — rubber-band (marquee) selecting a group of items
**Surface:** a file grid / photo board / canvas where you select *several* items
at once by pressing on empty space and dragging a rectangle across them.
**Friction:** there is no element to click. A plain `click` presses *on* one item
(or on the void, which selects nothing), and `dnd` (F047) presses on a *source
element* and drops on a *target* — it has no empty-void press and no rectangle.
The selection is the *geometry of a band*, recomputed on every `pointermove`
against each item's box; none of our gestures carry a moving rectangle over empty
space.
**Mechanism:** the band handler listens for a `pointerdown` whose target is the
container itself (the void), records the start point, and on each held-button move
toggles every item whose box intersects the `min/max` rectangle. So the gesture is
a real press-drag-release that *starts on empty space* and carries `buttons:1`
through the moves; the value is the corners, not whatever is under the cursor.
**Primitive:** `Browser.marquee(container, x0, y0, x1, y1)` takes the two corners
as fractions `[0,1]` of the container's box (resolution-independent), presses the
first corner on the void, steps diagonally to the second carrying `buttons:1`, and
releases. Live: a plain click selects `[]`; a band from the top-left corner across
three items selects exactly `[0,1,2]` (not the far item `3`); a tighter band
reselects only `[0]`; an absent container returns `False`. `206/206 checks
passed`, deterministic ×3.
**Lesson (道法自然):** 大方無隅 — the great square has no corners to grab; we select it
by sweeping the void between the things, not by touching any one of them. 反者道之動
— the band is born from where *nothing* is, and from that emptiness the whole group
is moved.

---

### F077 — Ctrl+click to build a discontiguous (multi) selection
**Surface:** a list / file grid / table where you pick *several non-adjacent* rows
by holding Ctrl (Meta on mac) and clicking each one in turn.
**Friction:** a plain `click` (F061) carries no modifier, so every handler reading
`e.ctrlKey` sees `false` and *replaces* the selection instead of *toggling* — clicking
0, then 2, then 4 ends with only `{4}`. `marquee` (F076) drags a *contiguous*
rectangle and therefore cannot skip the items in between; there is no gesture in the
ladder that adds one item to an existing set while leaving a gap.
**Mechanism:** the row's `click` listener branches on `e.ctrlKey || e.metaKey`: with
the modifier it flips that item's membership in a `Set`; without it, it clears the
set and adds only the clicked item. The deciding signal is the modifier *bit on the
mouse event itself*, not a separate keystroke — Chrome's `Input.dispatchMouseEvent`
takes a `modifiers` bitmask (Ctrl = 2) that becomes `event.ctrlKey` at the listener.
**Primitive:** `Browser.ctrl_click(selector)` aims at the same hit-verified point as
`click` (refusing if an overlay covers it — F061 honesty), then presses and releases
with `modifiers:2` on every mouse event. Live: plain clicks on 0,2,4 collapse to
`[4]`; `ctrl_click` on 0,2,4 accumulates to `[0,2,4]`; a second `ctrl_click` on 2
toggles it back out to `[0,4]`; an absent target returns `False`. `214/214 checks
passed`, deterministic ×3.
**Lesson (道法自然):** 同出而異名 — the same press, named differently by one held bit,
gives opposite meanings (replace vs. add). 知其雄，守其雌 — to gather the scattered
you must *withhold* the default (the collapse) and hold the modifier; restraint, not
force, is what lets the set grow without erasing itself.

---

### F078 — Shift+click to select a contiguous range
**Surface:** a file manager / mail list / table where you click one row, then
Shift+click another to select the entire run between them.
**Friction:** a plain `click` carries no modifier, so a handler reading
`e.shiftKey` sees `false` and merely re-anchors — Shift+clicking row 4 after row 1
ends with only `{4}` instead of `{1,2,3,4}`. `ctrl_click` (F077) toggles a *single*
item and never fills the span; nothing in the ladder draws a contiguous range.
**Mechanism:** the row's `click` listener branches on `e.shiftKey` and an `anchor`
the page recorded on the last plain click: with Shift it clears the set and adds
every index between `min(anchor,i)` and `max(anchor,i)`; without it, it re-anchors.
The deciding signal is again the modifier bit on the mouse event — `modifiers:8`
(Shift) in `Input.dispatchMouseEvent` becomes `event.shiftKey`.
**Primitive:** `Browser.shift_click(selector)` shares `ctrl_click`'s hit-verified
core (`_modifier_click`, refusing if occluded — F061) and presses/releases with the
Shift bit. Typical use is `click(first)` then `shift_click(last)`. Live: a plain
second click leaves `[4]`; anchor `r1` + `shift_click(r4)` fills `[1,2,3,4]`;
re-anchor `r3` + `shift_click(r0)` fills the backward range `[0,1,2,3]`; an absent
target returns `False`. `222/222 checks passed`, deterministic ×3.
**Lesson (道法自然):** 大成若缺 — the range is completed not by touching each thing
but by naming two ends and letting the span between fill itself. 萬物負陰而抱陽 —
ctrl (toggle one) and shift (span the run) are the yin and yang of the same press;
held apart, they cover every selection a human makes with a mouse.

### F079 — Walk a multi-level hover submenu to a depth-3 leaf
**Surface:** a menubar / cascading menu where File > Export > PDF only lays out
once its whole ancestor chain is hovered — hovering File reveals Export, hovering
Export reveals the PDF row.
**Friction:** the leaf has a zero-size `display:none` box until the path is open,
so a direct `click('#pdf')` fails (nothing is even hit) and `byText` cannot target
it. `hover_reveal` (F046) opens exactly *one* level — it reveals Export but the
depth-3 PDF stays hidden; nothing in the ladder walks a chain. The ancestors also
stay open only while the pointer remains within the menu subtree, so a naive jump
straight at the leaf would cross a gap that re-closes the menu.
**Mechanism:** CSS `li:hover > ul { display:block }` keeps a submenu open while the
cursor is over its parent *or* any descendant. Since each deeper `ul` is a descendant
of the one above, hovering the chain in order (File, then Export) leaves every level
laid out at once; a single-move `click` onto the leaf lands within the open subtree
and so does not collapse it. The path must be traversed level by level, waiting for
each to lay out before moving onto it.
**Primitive:** `Browser.hover_chain(selectors)` hovers each selector in turn,
waiting for it to become visible before the move, leaving the whole chain open;
`Browser.menu_select(path)` hovers `path[:-1]` open and clicks `path[-1]` — the whole
File > Export > PDF gesture in one call. Live: the leaf is hidden and a direct click
fires nothing; `hover_reveal` opens only the first level; `menu_select` walks the
chain and the PDF handler fires; `hover_chain` alone leaves a sibling leaf reachable;
a wrong path and an empty path both return `False`. `233/233 checks passed`,
deterministic ×3.
**Lesson (道法自然):** 圖難於其易，為大於其細 — the deep leaf is reached not by
lunging at it but by opening each easy level in order until the hard one lies open.
千里之行，始於足下 — a chain is walked one foothold at a time; keep each parent held
and the far rung reveals itself.

### F080 — Pointer-driven drag-to-reorder of a sortable list
**Surface:** a SortableJS / drag-handle list (todo rows, playlist, kanban column)
where you grab a row and drag it to a new slot, and the list reorders live as you
move.
**Friction:** the list reorders by listening to raw `mousedown`/`mousemove`/`mouseup`
— it never touches the HTML5 drag API. `dnd` (F047) synthesizes
`dragstart/dragover/drop` DragEvents, which this handler does not listen to, so the
order is left completely unchanged. `marquee` (F076) presses on empty *void* and
drags a rectangle to band-select; it grabs no row at all. Nothing in the ladder
grabs a specific element and carries it along a live pointer path.
**Mechanism:** `mousedown` on a row stores it as the dragged node; each `mousemove`
walks the siblings and `insertBefore`s the dragged node ahead of the first sibling
whose vertical midpoint the cursor has passed (else appends it last); `mouseup`
drops. The reorder is recomputed *every* `mousemove`, so the cursor must actually
travel through the intervening rows carrying `buttons:1` — a single jump would skip
the splice. The deciding signal is the live stream of `buttons:1` moves, not a
DragEvent.
**Primitive:** `Browser.drag_reorder(source, target, after=False)` presses on the
source row's hit-verified point (refusing if occluded — F061), steps the cursor in
~10px increments toward the target carrying `buttons:1` so the live reorder runs each
frame, and releases; `after` aims past the target's midpoint (lands after) else above
it (lands before). Live: `dnd` leaves `ABCD` untouched; `drag_reorder(A, C,
after=True)` yields `BCAD`; `drag_reorder(D, B, after=False)` yields `ADBC`; an absent
source or target returns `False`. `241/241 checks passed`, deterministic ×3.
**Lesson (道法自然):** 弱者道之用 — the soft, continuous stream of small moves is what
works where the one hard DragEvent is ignored; the list yields only to the gesture it
is actually listening for. 圖難於其易 — to move a row across three slots, cross each
midpoint in turn rather than leaping the whole gap.

---

### F081 — Reveal an element clipped out of a scroll container
**Surface:** a row sitting inside an `overflow:auto` panel (a settings list, a long
dropdown, a chat backlog) that has been scrolled out of the panel's clip box — the
row is fully laid out in the DOM, it is merely scrolled past the visible window.
**Friction:** `click('#row15')` returns `False` and fires nothing. The row's
`getBoundingClientRect` coordinates fall *outside* the panel's clip rectangle, so at
that point `elementFromPoint` returns the container's edge, not the row; `_hit_point_of`
sees every probe point occluded and `click` honestly refuses (F061). A human would
just scroll the panel and click — but the ladder had no gesture to *scroll a clipped
row back into its own container*. `scroll_until` (F048) does not apply: that is for
*virtual* lists where the row is absent from the DOM until mounted; here the row
already exists, it is only clipped.
**Mechanism:** an element scrolled outside its scrollable ancestor's clip is painted
nowhere, so hit-testing at its layout coordinates resolves to whatever *is* painted
there (the container border). `Element.scrollIntoView({block:'center'})` walks the
element's own scrollable-ancestor chain and scrolls each one so the element lands in
the visible window — exactly the panels a human would drag. Once it is inside the clip
again it paints, and `elementFromPoint` resolves back to it.
**Primitive:** `Browser.scroll_into_view(selector)` injects helpers, locates the
element (returning `False` if absent), calls `scrollIntoView({block:'center',
inline:'center'})`, then polls `_hit_point_of` until the hit point is no longer
occluded (returns `True`) or the timeout expires (returns `False`). The poll makes it
an *honest* check: it returns `True` only when scrolling alone actually exposes the
element, and `False` when a *real* overlay (not mere clipping) still covers it — so it
distinguishes scroll-fixable clipping from overlay-occlusion that scrolling cannot
cure. Live: a clipped `#row15` reports `occluded` and `click` refuses; after
`scroll_into_view` the click fires the handler; an already-visible target returns
`True`; an absent selector returns `False`. `249/249 checks passed`, deterministic ×3.
**Lesson (道法自然):** 知止不殆 — `click` refusing the clipped row (F061) was not a
failure but knowing-when-not-to-act; the new gesture does not override that honesty,
it removes the *cause* (scrolls the row into view) and then lets the honest click
proceed. 見小曰明 — distinguish the small difference between a row merely clipped
(curable by scrolling) and one truly buried under an overlay (not), and act only on
the curable one.

---

### F082 — Double-click to activate an element
**Surface:** a file icon, a list row, a rename-on-double-click label, an editable
grid cell — anything that *opens* or *commits* only when you double-click it, where a
single click merely selects.
**Friction:** `double_click`-gated handlers never fire. A single `click('#file')`
dispatches one `click` event and the `dblclick` handler stays silent (the file never
opens). Calling `click` *twice* does not fix it either: each `click_xy` carries
`clickCount:1`, so Chrome's user-agent never raises its click-counter and so never
synthesises a `dblclick` — yet `click` cheerfully returns `True` both times, lying
about having opened the file. `click_n_xy` (F071) *does* escalate `clickCount`, but
only at raw screen coordinates for *text* selection (word/paragraph) — it has no
hit-verification, so it would fire blindly through an overlay.
**Mechanism:** Chrome turns a press/release with `clickCount:1` immediately followed
by a press/release with `clickCount:2` (same button, same point) into a `dblclick`
event — the counter, not two independent clicks, is what the UA folds into the
gesture. CDP exposes the counter directly via `Input.dispatchMouseEvent`'s
`clickCount`.
**Primitive:** `Browser.double_click(selector)` reuses the honest hit point (F061) —
refusing if every probe spot is occluded — then calls `click_n_xy(x, y, 2)` at that
point, dispatching the clickCount:1→clickCount:2 sequence Chrome reads as a
`dblclick`. Live: a single (and a repeated) `click` leaves `__open` at 0; one
`double_click` fires the handler exactly once and the label reads `OPENED`; a
transparent veil makes it refuse (`False`, nothing opened); an absent selector returns
`False`. `257/257 checks passed`, deterministic ×3.
**Lesson (道法自然):** 信言不美 — two cheerful single clicks that each *say* success
are not a double-click; the truthful gesture is the one Chrome actually folds into a
`dblclick`, and the primitive that refuses through a veil tells the truth where the
naive one would lie. 同出而異名 — single-click (select) and double-click (open) flow
from the same press, differing only by the counter; naming the counter is what
separates selecting from opening.

---

## F083 — press-and-hold to confirm (`press_hold`) · R47

**Friction:** A "hold to delete", "press and hold to confirm", press-to-talk, or
a long-press menu commits only when the button stays physically down for some
dwell. The handler arms a timer on `mousedown` and fires only if `mouseup` has
*not* arrived when it elapses. `click` presses and releases within a millisecond,
so the dwell timer is always cancelled first — the action never commits — yet
`click` returns `True` and lies about having confirmed.
**Mechanism:** the gesture is not an event but a *duration*: the page reads real
time between `mousedown` and `mouseup` (or samples `buttons & 1` while it waits).
CDP lets us hold that interval open — dispatch `mousePressed`, then genuinely
wait, then `mouseReleased` — so the button is held down for as long as the dwell
needs, exactly as a human finger would.
**Primitive:** `Browser.press_hold(selector, hold=0.6)` aims at the honest hit
point (F061), refuses if occluded, moves there, dispatches `mousePressed`
(`buttons:1`), sleeps `hold` seconds while the page's dwell timer runs, then
`mouseReleased`. Live: an instant `click` leaves `__done` at 0; `press_hold(hold=0.8)`
past the 500ms dwell commits exactly once and reads `DELETED`; a `hold=0.15`
shorter than the dwell releases too early and does not commit; a transparent veil
makes it refuse (`False`); an absent selector returns `False`. `264/264 checks
passed`, deterministic ×3.
**Lesson (道法自然):** 弱者道之用 — the soft act here is *waiting*, not striking;
the page yields not to a harder click but to a patient one that simply stays.
天下之至柔，馳騁於天下之致堅 — keeping the button gently down past the dwell is
what the rigid instantaneous click can never do; duration, not force, is the key.

---

## F084 — pinch-zoom a pane with Ctrl+wheel (`zoom_at`) · R48

**Friction:** A slippy map, an image/PDF viewer, or a diagram canvas distinguishes
*zoom* from *pan* by the wheel's Ctrl modifier — `if(e.ctrlKey) zoom; else pan;` —
which is exactly what Chrome folds a trackpad pinch into. `wheel_at` (F070)
dispatches a `mouseWheel` carrying no modifiers, so it can only ever reach the
*pan* branch: the pane scrolls but never scales, yet `wheel_at` returns `True`
and lies about having zoomed. A human pinches; we had no pinch.
**Mechanism:** `Input.dispatchMouseEvent{type:mouseWheel}` accepts the same
`modifiers` bitmask as a mouse event (Ctrl=2). The page's `wheel` handler reads
`e.ctrlKey` off the synthesised event, so a wheel with `modifiers:2` is routed to
the zoom path while an unmodified one pans — the modifier *is* the difference
between scrolling and scaling.
**Primitive:** `Browser.zoom_at(selector, steps=1, out=False)` aims at the honest
hit point (F061) — refusing if occluded, since a wheel is delivered to the topmost
element under the point and an overlay would swallow it — then dispatches
`mouseWheel` with `modifiers:2` and `deltaY<0` to zoom in (`out=True` →
`deltaY>0`), `steps` times. Live: a plain `wheel_at` leaves `__zoom` at 0 (only
`__pan`); `zoom_at(steps=2)` fires the zoom branch twice and scales up while pan
stays put; `zoom_at(out=True)` drives the scale back down; a transparent veil →
`False` (nothing zoomed); an absent selector → `False`. `272/272 checks passed`,
deterministic ×3.
**Lesson (道法自然):** 道生一，一生二 — pan and zoom are two faces of one wheel,
parted only by a single held key; naming that key (the Ctrl modifier) is what
lets the same gesture become two. 同出而異名 — same wheel out, different name in.

---

## F085 — keyboard-activate a keydown-only control (`key_activate`) · R49

**Friction:** A great many custom and ARIA controls bind their action to a
*keydown* of Enter or Space on a *focused* element — `role="button"` divs,
listbox options, custom checkboxes, menu items — and ignore the mouse outright.
`click` (F061) dispatches a pointer click the `keydown` handler never hears, so
the action stays dead while `click` returns `True` and lies. A human reaches such
a control by Tab-then-Enter, not the mouse. Sharper still: when a transparent
overlay occludes the pointer, `click` honestly *refuses* — but the keyboard can
still reach a focused element, a second door standing open where the first is
walled.
**Mechanism:** `Input.dispatchKeyEvent` delivers to `document.activeElement`, not
to a coordinate, so it bypasses pointer hit-testing (and thus pointer occlusion)
entirely. An element only receives keys if it can hold focus — native controls,
or anything with `tabindex`; a bare `<div>` cannot. So focusing and checking
`el===document.activeElement` is an honest test of keyboard-reachability.
**Primitive:** `Browser.key_activate(selector, key="Enter")` locates the element
(deepQuery / by-text), focuses it and verifies it actually took focus (no
`tabindex` / not focusable → `False`, an honest no), then dispatches a faithful
`keyDown`/`keyUp` for Enter (vk 13) or Space (vk 32) so the handler reads the
right `e.key`. Live: a `click` leaves `__fire` at 0; `key_activate` fires it once
with Enter, again with Space; under a transparent veil `click` returns `False`
while `key_activate` *still* fires it (`__fire` 3); a non-focusable `<div>` →
`False`; an absent selector → `False`. `280/280 checks passed`, deterministic ×3.
**Lesson (道法自然):** 天下之至柔，馳騁於天下之致堅 — the softest thing (a
keystroke that carries no coordinate) rides through where the hardest push (a
pointer click against an overlay) is stopped cold. When one door is walled,
knowing the other door exists — and that it needs only focus, not force — is the
whole art. 無有入於無間: the formless enters where there is no gap.

---

## F086 — arrow-key step a keyboard-only slider (`key_step`) · R50

**Friction:** Sliders, spinners, listboxes, menubars, radio groups, date pickers,
tab strips — a huge family of widgets move *only* on `keydown` of
Arrow/Home/End/Page keys against a focused element, and ignore the mouse. A
`role="slider"` advances on `ArrowRight`; clicking it is a no-op and
`key_activate` (F085, Enter/Space) never moves it either — yet both return `True`
and lie. Setting a precise value is *N taps of an arrow*, not a click at a guessed
pixel.
**Mechanism:** `Input.dispatchKeyEvent` delivers to `document.activeElement`, and
the widget's `keydown` handler reads `e.key` to decide its step direction. So the
exact thing that distinguishes "increment" from "decrement" from "no-op" is the
*named navigation key* — `ArrowRight` vs `ArrowLeft` vs anything else — carried on
a faithful key event (right `key`/`code`/`windowsVirtualKeyCode`).
**Primitive:** `Browser.key_step(selector, key="ArrowRight", times=1)` looks the
key up in a navigation table (Arrows/Home/End/Page/Tab/Escape/Backspace/Delete →
`False` for anything unknown, a refusal not a guess), focuses the element with the
shared honest focus check (`_focus`, factored out of `key_activate`), then
dispatches the key `times` times. Live: a click and an Enter both leave the slider
at 5; `ArrowRight×3` → 8, `ArrowLeft×2` → 6, a default single tap → 7; a
non-focusable element → `False`; an absent selector → `False`; an unknown key →
`False` and the value is untouched. `288/288 checks passed`, deterministic ×3.
**Lesson (道法自然):** 知其雄，守其雌 — the value already sits at 5; you do not
seize it to a pixel, you nudge it one notch at a time toward where it should rest.
為者敗之 — clicking *forces* and fails; stepping *follows* the widget's own grammar
(its key bindings) and succeeds. The strong grab loses; the soft tap arrives.

---

## F087 — triple-click to select a whole line / paragraph (`triple_click`) · R51

**Friction:** To replace an entire line of text — a title field, a chat draft, one
paragraph in a rich editor — a human triple-clicks to select the block, then types
over it. A single `click` only drops a caret (selects *nothing*) and `double_click`
(F082) selects a single *word*; neither can grab the line, yet both return `True`
and lie about having selected it.

**Mechanism:** The only thing distinguishing word-select from line-select is the
click counter Chrome folds successive `mousedown`s into. A caret is `clickCount:1`,
a word is `clickCount:2`, a paragraph is `clickCount:3` — and Chrome only raises
that counter when one uninterrupted press/release sequence escalates 1→2→3 at the
*same point*. Two separate `click`s never reach 3; `click_n_xy(...,3)` does.

**Primitive:** `Browser.triple_click(selector)` resolves the honest hit point
(F061 — nine probes inside the box, refusing if every spot is occluded), then drives
`click_n_xy(x,y,3)`. Returns `True` once the triple fires, `False` if the element is
absent or occluded.

**Live (R51):** a single click selects `''`; `double_click` selects just `delta`;
`triple_click` selects the whole `alpha beta gamma delta`; under a transparent veil
`triple_click` → `False` and nothing is selected; an absent selector → `False`.
`294/294 checks passed`, deterministic ×3.

**Lesson (道法自然):** 慎終如始，則無敗事 — the same gesture (a press at one point)
yields caret, word, or line depending only on how far it is carried; the line is not
seized by force but by letting the count ripen to three. 信言不美 — two clicks that
each "succeed" are not a triple-click; the honest gesture is the one Chrome truly
folds into `clickCount:3`.

---

## F088 — drag a splitter handle by an exact pixel delta (`drag_by`) · R52

**Friction:** Resizing a pane — dragging the divider between a sidebar and the
content, a column-resize grip, a split-view bar — sets a size from *how far the
cursor travelled*, not from where it landed. There is no destination element to
aim at: the result you want is the delta itself ("make this 120px wider"). A
plain `click` presses and releases at one point — zero travel — so the divider
does not move; `drag_reorder` (F080) slides to a *target element's* midpoint and
so lands at that element's uncontrolled layout position (in the probe it widened
to 628, not a chosen size); `set_slider` (F073) needs a bounded *track* to map a
fraction onto, which a free splitter has not got.

**Mechanism:** The handle grabs on `mousedown` (recording the start x and the
panel's current width) and on every `mousemove` recomputes `width = startW +
(e.clientX − startX)`. The size is a running integral of the cursor's pixel
offset, so only a real press-move-release that *carries* the pointer by the exact
delta — with `buttons:1` live on each move so the handler's drag stays armed —
reproduces it. A single click integrates to nothing.

**Primitive:** `Browser.drag_by(selector, dx, dy)` resolves the handle's honest
hit point (F061 — refuses if every probe spot is occluded, like `click`), presses
there, steps the cursor by exactly `(dx, dy)` in ~10px increments carrying
`buttons:1`, and releases at the offset point. Returns `True` once the gesture
fires, `False` if the handle is absent or occluded.

**Live (R52):** a panel starts at 200px; a `click` on the grip leaves it at 200;
`drag_by(+120)` widens it to ~320; `drag_by(-80)` narrows it to ~240; under a
transparent veil `drag_by` → `False` and the width does not budge; an absent
handle → `False`. `301/301 checks passed`, deterministic ×3.

**Lesson (道法自然):** 圖難於其易，為大於其細 — a size is not chosen by pointing
at a destination but by accumulating small honest steps; the divider obeys the
*path*, not the endpoint. 信言不美 — a `click` that "succeeds" on the grip has
moved nothing; the truthful gesture is the one that carries the pointer the whole
delta.

---

## F089 — middle-click to fire an `auxclick` handler (`middle_click`) · R53

**Friction:** Open-link-in-new-tab affordances, a tab strip's middle-click-to-close,
an X11-style middle-click paste pad, any control gated on `event.button===1` answer
only to the *middle* (wheel) button. A left `click` carries `button:"left"` — DOM
button `0` — and Chrome folds it into a `click` event, so the `auxclick` handler
never runs, yet `click` still returns `True`: a silent lie of success. The bare
`click_xy` does accept a `button` argument, but it is purely geometric — no hit
verification — and omits the `buttons:4` bitmask a faithful middle press carries, so
it would fire blindly through an overlay.

**Mechanism:** Chrome only synthesizes an `auxclick` (with `button:1`) from a press
and release that both carry the middle button identity. The press must set
`button:"middle"` with the `buttons:4` mask held; the release clears it to `0`. A
left-button sequence at the same pixel produces a `click`, never an `auxclick` — the
distinction is the button, not the coordinate.

**Primitive:** `Browser.middle_click(selector)` resolves the honest hit point
(F061 — refusing if every probe spot is occluded), then dispatches a middle
`mousePressed` (`buttons:4`) / `mouseReleased` (`buttons:0`) at that point — exactly
the sequence Chrome turns into an `auxclick` with `button:1`. Returns `True` once it
fires, `False` if the element is absent or occluded.

**Live (R53):** a plain `click` on the pad bumps the left-button counter and fires no
`auxclick` (yet returns `True`); `middle_click` fires `auxclick` with `button:1` and
does *not* also register a left click; under a transparent veil `middle_click` →
`False` and no `auxclick` fires; an absent selector → `False`. `308/308 checks
passed`, deterministic ×3.

**Lesson (道法自然):** 名可名也，非恒名也 — a "click" is not one thing; the button
that carries it is its true name. To wake a middle-only handler you must press the
button it actually listens for, not merely land on the right pixel. 信言不美 — the
left click that "succeeds" never reached the handler at all.

---

## F090 — right-button drag to pan a viewport (`right_drag_by`) · R54

**Friction:** A map that pans on right-drag, a 3D viewport that orbits, a node
editor that box-selects with the right button — these latch on a `mousedown` whose
`button===2`, then read each `mousemove` only while `buttons & 2` is held, and on
release `preventDefault` the context menu so the gesture reads as a drag rather than
a menu request. `drag_by` (F088) carries the *left* button (`buttons:1`), so its
held moves never satisfy the `buttons & 2` guard — the pane does not move one pixel,
yet `drag_by` returns `True`: a silent lie. `context_menu` (F067) does press the
right button, but only to *raise the menu* — it presses and releases in place,
dragging nothing. The friction is button identity carried across a held drag.

**Mechanism:** Chrome delivers `mousemove` events with `buttons:2` between a right
`mousePressed` and `mouseReleased` only when each move itself carries the
`buttons:2` mask; the live pan handler runs once per such frame. A context menu
still fires on release, but an app that pans on right-drag suppresses it — the
gesture is judged by the held-button moves, not by the menu.

**Primitive:** `Browser.right_drag_by(selector, dx, dy)` resolves the honest hit
point (F061), refuses if occluded, presses the right button (`buttons:2`), steps
the cursor along `(dx, dy)` carrying `buttons:2` so the pan handler runs each frame,
then releases at the offset point (`buttons:0`). Returns `True` once the drag
completes, `False` if the handle is absent or occluded.

**Live (R54):** a left `drag_by` over a right-drag pad leaves `panx` at `0` (the
`buttons&2` guard never fires) though it returns `True`; `right_drag_by(+60)` pans
to exactly `60` and `right_drag_by(-25)` back to exactly `35`; under a transparent
veil `right_drag_by` → `False` and `panx` stays `35`; an absent selector → `False`.
`315/315 checks passed`, deterministic ×3.

**Lesson (道法自然):** 知其雄，守其雌 — to pan a right-drag pane you must hold the
button it watches for, not the one that happens to be under your hand. The honest
drag refuses through an overlay rather than pretend a gesture it cannot land.

---

## F091 — touch tap to wake a touch-only handler (`tap`) · R55

**Friction:** A mobile-first carousel, a swipeable gallery, a custom control
built on a touch library answer only to `touchstart` / `touchend` and ignore the
mouse entirely. A `click` (F060) produces a mouse sequence and a synthesized
`click` — Chrome does *not* manufacture a `touchstart` from it — so the touch
handler never runs, yet `click` returns `True`: a silent lie. The friction is
input *modality*: the element listens on the touch channel, and the mouse channel
is the only one a click drives.

**Mechanism:** CDP's `Input.dispatchTouchEvent` injects a real touch point.
A `touchStart` at the element followed by a `touchEnd` makes Chrome fire
`touchstart` / `touchend` (and, as a real device would, a compatibility `click`).
That is the gesture a touch-only handler is waiting for; the mouse path never
reaches it.

**Primitive:** `Browser.tap(selector)` resolves the honest hit point (F061),
refuses if every probe spot is occluded, then dispatches a `touchStart` there
followed by a `touchEnd`. Returns `True` once it fires, `False` if the element is
absent or occluded.

**Live (R55):** a `click` on a touch-only pad leaves `ts` at `0` (the touch
handler never sees the mouse) though it returns `True` and bumps the
compatibility `clk`; `tap` raises `ts` to exactly `1`; under a transparent veil
`tap` → `False` and `ts` stays `1`; an absent selector → `False`.
`328/328 checks passed`, deterministic ×3.

**Lesson (道法自然):** 知其雄，守其雌 — to wake a touch handler you must touch,
not click; the mouse is the wrong channel and pressing it harder will not help.
The honest tap refuses through an overlay rather than pretend a finger it cannot
land.

---

## F092 — touch swipe to drive a touchmove carousel (`swipe`) · R56

**Friction:** A touch carousel advances by a finger drag, a pull-to-refresh pane
reads the touch travel, a bottom-sheet is flung by `touchmove` distance — all
gated on a *moving* touch, never on the mouse. `drag_by` (F088) carries mouse
`buttons:1` moves, which a `touchmove` listener never sees, so the carousel
stays at zero though `drag_by` returns `True`; `tap` (F091) touches but does not
travel, so a distance-based swipe reads no displacement. The friction is a held
touch that must *move*.

**Mechanism:** Between a `touchStart` and a `touchEnd`, each `touchMove` carrying
the moved point makes Chrome fire `touchmove`; the live swipe handler runs once
per such frame and reads the running displacement from the start point. Stepping
the point along `(dx, dy)` reproduces a faithful finger drag.

**Primitive:** `Browser.swipe(selector, dx, dy)` resolves the honest hit point
(F061), refuses if occluded, presses a touch point, steps it along `(dx, dy)`
issuing `touchMove` events so the swipe handler runs each frame, then lifts with
`touchEnd`. Returns `True` once the swipe completes, `False` if the element is
absent or occluded.

**Live (R56):** a left `drag_by` over a touch carousel leaves `dist` at `0` (no
`touchmove` ever fires) though it returns `True`; `swipe(+120)` drives `dist` to
exactly `120` and `swipe(-60)` to exactly `-60`; under a transparent veil
`swipe` → `False` and `dist` stays `-60`; an absent selector → `False`.
`328/328 checks passed`, deterministic ×3.

**Lesson (道法自然):** 大器免成 — a swipe is not a tap struck harder nor a mouse
drag relabelled; it is the one gesture that both touches and travels. The honest
swipe refuses through an overlay rather than pretend a flick it cannot land.

---

## F093 — two-finger pinch to zoom a gesture view (`pinch`) · R57

**Friction:** A map that scales on a two-finger pinch, an image viewer that zooms
to the pinch midpoint, a photo gallery that reads the spread between two fingers
— these compute the *distance* between two simultaneous touch points each
`touchmove` and gate on `e.touches.length===2`. `swipe` (F092) carries a single
travelling touch, so the two-finger distance never changes and the view stays at
scale `1` though `swipe` returns `True`; `zoom_pane` (F068) sends a `ctrl`+wheel,
which a pinch-only handler that counts fingers never sees. The friction is finger
*count*: the view answers only to a pair that spreads or closes.

**Mechanism:** Two touch points dispatched together in one `dispatchTouchEvent`
(`id:0` and `id:1`) make Chrome present `e.touches.length===2`; stepping both
points symmetrically apart or together each `touchMove` changes the inter-finger
distance, so the live pinch handler runs per frame and reads the running scale
as `dist(touches)/base`. A base gap that grows from 20px to 80px reads as 4×; a
gap that closes from 20px to 10px reads as 0.5×.

**Primitive:** `Browser.pinch(selector, amount)` resolves the honest hit point
(F061), refuses if occluded, places two points astride the center separated by a
small base gap, then steps them symmetrically apart (`amount>0`) or together
(`amount<0`) issuing two-point `touchMove` events so the pinch handler runs each
frame, and lifts both with `touchEnd`. Returns `True` once the pinch completes,
`False` if the element is absent or occluded.

**Live (R57):** a one-finger `swipe` over a pinch view leaves `scale` at `1` (the
handler ignores a single touch) though it returns `True`; `pinch(+60)` spreads a
20px base to 80px → `scale` exactly `4`; `pinch(-10)` closes it to 10px → `scale`
exactly `0.5`; under a transparent veil `pinch` → `False` and `scale` stays
`0.5`; an absent selector → `False`. `335/335 checks passed`, deterministic ×3.

**Lesson (道法自然):** 二生三 — one finger can touch and travel but cannot make a
gesture; only a *pair* whose separation changes spells zoom. The honest pinch
refuses through an overlay rather than pretend a spread it cannot land.

---

## F094 — two-finger rotate to twist a gesture view (`rotate`) · R58

**Friction:** A map that spins to a heading, an image editor that turns a layer
to a two-finger twist, a knob driven by a circular gesture — these read the
*angle* of the line between two simultaneous touch points each `touchmove` and
never look at the spread. `pinch` (F093) moves the two points apart or together,
so their separation changes but the angle between them holds — a rotate-only
handler sees nothing and the view stays at `0°` though `pinch` returns `True`;
`swipe` (F092) carries a single travelling touch that has no angle at all. The
friction is the *orientation* of a finger pair: the view answers only to a twist
that holds the distance and turns the line.

**Mechanism:** Two touch points dispatched together (`id:0` and `id:1`) on
opposite ends of a fixed-radius diameter through the center make Chrome present
`e.touches.length===2`; turning both around the center each `touchMove` changes
`atan2(dy, dx)` of the line between them while `hypot(dx, dy)` is held constant,
so a live rotate handler reads the running angle (normalized to `[-180, 180]`)
and a pinch handler reads no scale change. A line that turns from `0°` to `90°`
reads as a quarter-turn clockwise; the inter-finger distance never moves.

**Primitive:** `Browser.rotate(selector, degrees)` resolves the honest hit point
(F061), refuses if occluded, places two points on opposite ends of a radius-60
diameter through the center, then turns both around the center by `degrees`
(positive sweeps the line clockwise in screen space) issuing two-point
`touchMove` events so the rotate handler runs each frame, and lifts both with
`touchEnd`. The separation is held constant throughout, so a pinch handler reads
`scale ≈ 1`. Returns `True` once the rotation completes, `False` if the element
is absent or occluded.

**Live (R58):** a two-finger `pinch` over a twist view leaves `rot` at `0` (the
handler reads only the angle, which a spread does not change) though it returns
`True`; `rotate(+90)` turns the line to exactly `90°`; the inter-finger distance
holds so `scale` stays `1` (`|scale-1| < 1e-6`); `rotate(-45)` turns it to
exactly `-45°`; under a transparent veil `rotate` → `False` and `rot` stays
`-45`; an absent selector → `False`. `343/343 checks passed`, deterministic ×3.

**Lesson (道法自然):** 反也者，道之動也 — a pair of fingers can spread or turn,
and the two motions are not the same motion seen twice; a twist holds the
distance and moves the angle. The honest rotate refuses through an overlay
rather than pretend a turn it cannot land.

---

## F095 — touch long-press to arm a dwell-gated handler (`touch_hold`) · R59

**Friction:** A mobile context menu, a "press and hold to react", a drag-handle
that only arms after a long touch — these listen on `touchstart`, arm a timer,
and commit only if neither `touchmove` nor `touchend` arrives before it elapses.
`press_hold` (F083) holds the *mouse* down for a dwell, but Chrome manufactures
no `touchstart` from a mouse press, so the touch long-press never even arms — its
`touchstart` count stays `0` and nothing fires, though `press_hold` returns
`True`. `tap` (F091) *does* fire `touchstart`, but lifts at once, so the dwell
timer is cancelled by `touchend` before it elapses — again nothing commits, yet
`tap` returns `True`. Two silent lies. The faithful gesture is a single touch
pressed and held *motionless* past the dwell, then lifted.

**Mechanism:** A page arms `setTimeout(fire, 350)` on `touchstart` and clears it
on `touchmove`/`touchend`. A single `touchStart` at the hit point (no `id` pair,
no move) leaves the timer running; Chrome's JS event loop runs it while the
gesture stays down. Holding `0.6s` past a `350ms` dwell lets the timer fire
exactly once; issuing *no* `touchMove` means a handler that cancels on movement
never cancels. The closing `touchEnd` lands after the commit, so the lift cannot
undo it. A mouse press touches none of this path (`touchstart` count unchanged);
an instant tap arms then immediately clears it.

**Primitive:** `Browser.touch_hold(selector, hold=0.6)` resolves the honest hit
point (F061), refuses if occluded, presses one stationary touch point there,
sleeps `hold` seconds while the page's dwell timer runs, then lifts with
`touchEnd`. No `touchMove` is ever issued, so a movement-cancel handler keeps its
timer armed. Returns `True` once the full press-hold-release completed, `False`
if the element is absent or occluded.

**Live (R59):** the page starts unfired (`lp=0`, `ts=0`); `press_hold` (mouse)
leaves `ts=0` and `lp=0` though it returns `True` (no touch ever reaches the
handler); `tap` raises `ts` to `1` but `lp` stays `0` (the lift cancels the
timer); `touch_hold(0.6)` holds past the `350ms` dwell and `lp` becomes exactly
`1`; it issues no move so `ts` is exactly `2`; under a transparent veil
`touch_hold` → `False` and `lp` stays `1`; an absent selector → `False`.
`351/351 checks passed`, deterministic ×3.

**Lesson (道法自然):** 弱也者，道之用也 — a touch that does nothing but stay,
held still and unhurried, is what arms the gate; the mouse that pushes harder and
the tap that strikes faster both miss it. The honest long-press neither forces
nor feigns: it waits the dwell, or it refuses.

---

## F096 — touch double-tap to trip a fast double-tap gesture (`double_tap`) · R60

**Friction:** A photo that zooms on a quick double-tap, a map that scales, a
"like" that fires on a fast double touch — these count two `touchend` events
landing within a short window (often ~250–300 ms) and ignore the mouse.
`double_click` (F040) sends a *mouse* double sequence and synthesizes
`dblclick`, but Chrome manufactures no `touchstart`/`touchend` from it, so the
touch double-tap counter never advances (`tc` stays `0`), yet `double_click`
returns `True`: a silent lie. A single `tap` (F091) fires exactly one
`touchend`, arming the window but never completing it; a second tap that arrives
*after* the window only re-arms (`dt` stays `0`). The faithful gesture is two
`touchStart`/`touchEnd` pairs separated by less than the page's window.

**Mechanism:** The page increments a counter on every `touchend` and, when the
gap from the previous `touchend` is under `250 ms`, increments `dt` and resets
the clock; otherwise it just records the new timestamp. A mouse double click
touches none of this path. Two touch pairs `0.12 s` apart land well inside the
`250 ms` window, so the second `touchend` sees a fresh prior timestamp and
commits exactly one double-tap; a `0.4 s` gap between two single taps exceeds
the window and only re-arms.

**Primitive:** `Browser.double_tap(selector, interval=0.12)` resolves the honest
hit point (F061), refuses if occluded, dispatches a `touchStart`/`touchEnd`
pair, sleeps `interval` (short, so both land inside a tight double-tap window),
then dispatches a second pair. Returns `True` once both taps fire, `False` if
the element is absent or occluded.

**Live (R60):** the page starts unfired (`dt=0`, `tc=0`); `double_click` (mouse)
leaves `tc=0` and `dt=0` though it returns `True`; a single `tap` raises `tc` to
`1` with `dt=0`, and a second tap `0.4 s` later reaches `tc=2` but `dt` stays
`0` (past the window); `double_tap()` commits exactly one double-tap (`dt=1`)
from `tc=2`; under a transparent veil `double_tap` → `False` and `dt` stays `1`;
an absent selector → `False`. `360/360 checks passed`, deterministic ×3.

**Lesson (道法自然):** 二生三 — one touch is only a tap, two touches near in time
become a new gesture the page recognises as a third thing. The mouse's louder
double-strike speaks a language the touch handler cannot hear; the honest gesture
is two quiet touches close enough to be read as one.

---

## F097 — two-finger tap that lands and lifts still (`two_finger_tap`) · R61

**Friction:** A map that recenters on a two-finger tap, a viewer that zooms *out*
one step, a trackpad-style "secondary tap" — these arm when `e.touches.length`
reaches `2` on `touchstart`, drop on any `touchmove`, and commit at the final
`touchend` only if no move arrived. `tap` (F091) lands a single finger, so the
`===2` arm never trips (`tf` stays `0`). `pinch` (F093) and `rotate` (F094) do
land two fingers, but they then *move* them, so a tap detector that drops on
`touchmove` refuses (`tf` stays `0`). A mouse makes no `touchstart` at all. The
faithful gesture is a finger *pair* that touches and lifts without moving.

**Mechanism:** Chrome always decomposes a multi-touch press/release into
per-finger events: a single `Input.dispatchTouchEvent` with two points fires two
`touchstart` events (`touches.length` `1` then `2`), and lifting with
`touchPoints:[]` fires two `touchend` events (`1` then `0`). So there is no way
to lift two fingers truly simultaneously at the DOM layer — a robust detector
must read the pair at the *final* lift (`touches.length===0`), not demand a
single combined release. An early probe page that reset its "saw two" flag on
*every* `touchend` never committed, because the first finger's lift cleared the
flag before the second arrived; a detector that only clears at `length===0` is
the honest, realistic model.

**Primitive:** `Browser.two_finger_tap(selector, gap=40.0)` resolves the honest
hit point (F061), refuses if occluded, places two touch points astride the
center `gap` px apart, and lifts both with one `touchEnd` — no `touchMove`
between. Returns `True` once both fingers touch and lift, `False` if the element
is absent or occluded.

**Live (R61):** the page starts unfired (`tf=0`); a one-finger `tap` leaves
`tf=0` (never armed); `pinch` and `rotate` each land two fingers but move them,
so `tf` stays `0`; `two_finger_tap()` commits exactly one tap (`tf=1`); under a
transparent veil `two_finger_tap` → `False` and `tf` stays `1`; an absent
selector → `False`. `368/368 checks passed`, deterministic ×3.

**Lesson (道法自然):** 弱也者，道之用也 — the gesture's power is its stillness. A
pinch and a rotate are louder (they move), and the page reads movement as "not a
tap"; only two fingers that arrive and depart *quietly* are heard. And because no
two fingers ever truly lift as one, the honest detector waits for the last finger
to leave rather than insisting they go together.

## F098 — long-press-to-arm touch drag (`touch_drag`) · R62

**Friction:** A sortable list that reorders rows only after a press dwells long
enough to "pick up", a drag-handle that ignores a quick flick as a scroll, a
kanban card that lifts on long-press then follows the finger — these arm a timer
on `touchstart` and **cancel it on any `touchmove` that arrives before it
elapses**, treating an early move as a scroll, not a drag; only a touch that
stays still past the dwell, *then* travels, is accepted and committed at
`touchend`. `swipe` (F092) starts moving immediately, so the arm timer is
cancelled and the drag never engages (`armed` stays `false`, `dropped` stays
`0`). `touch_hold` (F095) dwells and arms (`armed=true`) but never moves, so the
handle is picked up yet dropped in place — `dropped` stays `0`. A mouse
`drag_by` (F088) makes no `touchstart` at all.

**Mechanism:** The realistic pick-up handler is a state machine: `touchstart`
starts a `setTimeout(arm, 200ms)`; a `touchmove` while *not yet armed* clears the
timer (an early move is a scroll); once armed, `touchmove` records travel; and
`touchend` commits only if armed *and* travel ≠ 0. So the gesture has an
order-of-operations requirement — **be still first, move second** — that neither
a pure swipe (move-only) nor a pure long-press (still-only) satisfies. The honest
primitive must press, *wait out the arm window with no `touchMove`*, and only
then step the held point.

**Primitive:** `Browser.touch_drag(selector, dx, dy, arm=0.25)` resolves the
honest hit point (F061), refuses if occluded, presses one touch point, holds it
motionless for `arm` seconds so the page's pick-up timer fires, steps it along
`(dx, dy)` issuing `touchMove` events so the live drag handler runs each frame,
then lifts with `touchEnd`. Returns `True` once the drag completes, `False` if
the element is absent or occluded.

**Live (R62):** the page starts unfired (`armed=false, dragged=0, dropped=0`); a
`swipe` moves immediately so it never arms and `dropped` stays `0`; a
`touch_hold` arms (`armed=true`) but commits no drag (`dropped=0`); `touch_drag`
arms then commits exactly one drag (`dragged=80, dropped=1`); under a transparent
veil `touch_drag` → `False` and `dropped` stays `1`; an absent selector →
`False`. `376/376 checks passed`, deterministic ×3.

**Lesson (道法自然):** 知止所以不殆 — knowing when to stop keeps you from harm.
The drag is granted only to the finger that first holds *still*: the page reads
an immediate move as a scroll and refuses it. Power here is sequenced restraint —
be quiet long enough to be trusted, then act. 反也者，道之動也: the swipe and the
long-press are each one half of the gesture, and only their union, in order,
is the whole.

---

## F099 — two-finger pan / scroll (`two_finger_pan`) · R63

**Friction:** A map that scrolls under a two-finger drag, a touch pane that pans
its content, an embedded scroller that moves only when a finger *pair* slides as
one — these read two simultaneous touch points and accept the gesture only when
both translate in parallel: the separation between them barely changes (no
pinch) and the line through them does not turn (no rotate). `pinch` (F093)
changes the spread, so a pan handler that rejects scale-change marks it
`rejected`; `rotate` (F094) turns the line, so a pan handler that rejects
angle-change marks it `rejected`; a one-finger `swipe` (F092) never reaches
`touches.length===2` at all, so it neither pans nor is even rejected.

**Mechanism:** The realistic pan handler latches the start distance, angle, and
midpoint of a two-touch `touchstart`; on each two-touch `touchmove` it measures
how much the spread (`Δdist`) and angle (`Δang`) drift and how far the midpoint
has travelled. A spread drift past ~12px or an angle drift past ~0.15rad is read
as a pinch or a rotate and rejected; only a near-rigid pair whose midpoint
travels commits a pan. So the gesture has a *shape-preserving* requirement —
both points must move by the **same vector** — that neither a pinch
(antisymmetric motion) nor a rotate (arc motion) nor a single finger satisfies.

**Primitive:** `Browser.two_finger_pan(selector, dx, dy, gap=60)` resolves the
honest hit point (F061), refuses if occluded, places two touch points astride
the center separated by `gap`, then translates *both* by the same `(dx, dy)`
each step issuing two-point `touchMove` events — distance and angle held fixed
while the midpoint travels — and lifts both with `touchEnd`. Returns `True` once
the pan completes, `False` if the element is absent or occluded.

**Live (R63):** the page starts unfired (`panned=0, rejected=0`); a one-finger
`swipe` never pans (`0,0`); a `pinch` is rejected not panned (`panned=0,
rejected=1`); a `rotate` is rejected not panned (`panned=0, rejected=1`);
`two_finger_pan` slides the rigid pair and commits one pan (`panned=80,
rejected=0`); under a transparent veil `two_finger_pan` → `False` and nothing
pans; an absent selector → `False`. `384/384 checks passed`, deterministic ×3.

**Lesson (道法自然):** 知其雄，守其雌 — know the strong, keep to the soft. The
pan is the gesture that *changes nothing about the pair* — it neither spreads
(pinch) nor twists (rotate); its whole power is in holding its shape and moving
together. The view trusts only the hand that does not deform. 萬物負陰而抱陽，
中氣以為和: the two fingers are yin and yang held in balance, and the harmony
between them — constant spread, constant angle — is what carries the motion.

---

## F100 — three-finger swipe (`three_finger_swipe`) · R64

**Friction:** A system-style app switcher, a three-finger scroll, a gesture pad
that switches workspaces — these fire only when *three* simultaneous touch
points slide as one, reading `e.touches.length===3` and ignoring any smaller
count. A one-finger `swipe` (F092) never raises the count past one; a two-finger
`two_finger_pan` (F099) reaches two and stops — neither ever presents the third
finger the handler waits for, so neither moves the view.

**Mechanism:** The realistic handler latches the *midpoint of all three* touch
points on a three-touch `touchstart`, then on each three-touch `touchmove`
measures how far that midpoint has travelled, committing once it passes a small
threshold. The whole gate is the count: the body of both handlers short-circuits
unless `e.touches.length===3`. A page that watches the running maximum count
sees `1` under a one-finger swipe, `2` under a two-finger pan, and only `3` when
the trio lands — so the gesture is defined purely by *how many fingers* arrive
together, not by what they trace.

**Primitive:** `Browser.three_finger_swipe(selector, dx, dy, gap=50)` resolves
the honest hit point (F061), refuses if occluded, places three touch points
abreast across the center (spaced by `gap`), then translates *all three* by the
same `(dx, dy)` each step issuing three-point `touchMove` events — so a rigid
triad travels — and lifts all with `touchEnd`. Returns `True` once the swipe
completes, `False` if the element is absent or occluded.

**Live (R64):** the page starts unfired (`swiped3=0, maxn=0`); a one-finger
`swipe` never reaches three (`swiped3=0, maxn=1`); a `two_finger_pan` never
reaches three (`swiped3=0, maxn=2`); `three_finger_swipe` slides the rigid trio
and commits (`swiped3=80, maxn=3`); under a transparent veil
`three_finger_swipe` → `False` and nothing swipes; an absent selector → `False`.
`391/391 checks passed`, deterministic ×3.

**Lesson (道法自然):** 三生萬物 — three begets the ten-thousand things. One
finger taps, two fingers pinch and pan, but the third finger opens a whole new
class of gesture the view answers to. The primitive does not strain for novelty;
it simply lets the third point arrive, and the count itself is the meaning.
道生一，一生二，二生三：each finger added is a turn of the same wheel, and the
view reads only the number that has gathered.

## F101 — edge swipe (`edge_swipe`) · R65

**Friction:** A back-swipe, an edge drawer, a peek-from-the-side panel — these
arm only when the touch *starts* inside a thin band hugging one border and then
travels inward, reading `e.touches[0].clientX` at `touchstart` and ignoring any
gesture that begins out in the body. A normal `swipe` (F092) starts at the
*center* of the element, so the edge handler files it as a mid-start and never
opens — the same finger, the same motion, but the wrong *origin*.

**Mechanism:** The realistic handler latches the starting x at `touchstart`. On
each `touchmove` it short-circuits to a `midstart` flag if the stroke began more
than a small margin from the edge (`sx>24`); only a stroke born on the rim is
measured for inward travel, opening once it passes a threshold. A page that
watches both flags sees `midstart=1, opened=0` under a centered swipe and
`opened≈dx, midstart=0` only when the stroke starts on the border — so the
gesture is defined purely by *where the finger lands*, not by what it traces.

**Primitive:** `Browser.edge_swipe(selector, dx, dy, edge="left", margin=4)`
resolves the honest hit point (F061), refuses if occluded, reads the element
rectangle (F073), places the first touch `margin` pixels inside the chosen
`edge` (`"left"`/`"right"`/`"top"`/`"bottom"`) at the perpendicular center, then
translates by `(dx, dy)` in steps issuing `touchMove` events so the handler sees
the stroke leave the rim, and lifts with `touchEnd`. Returns `True` once the
swipe completes, `False` if the element is absent or occluded.

**Live (R65):** the page starts unfired (`opened=0, midstart=0`); a centered
`swipe` files as a mid-start and never opens (`opened=0, midstart=1`); an
`edge_swipe` born on the rim opens the gesture (`opened≥40, midstart=0`); under
a transparent veil `edge_swipe` → `False` and nothing opens; an absent selector
→ `False`. `397/397 checks passed`, deterministic ×3.

**Lesson (道法自然):** 大道甚夷 — the great way is very level, yet the gate is
narrow. Two strokes can be identical in finger, force, and path and still differ
in everything that matters, because one is born on the rim and one in the body.
知其所止 — to know *where* a thing begins is to know whether it begins at all.
The primitive does not push harder; it simply starts in the right place, and the
origin itself is the meaning.

---

## F102 — drag to a target zone (`touch_drag_to`) · R66

**Friction:** A swipe-to-dismiss that only fires past a snap line, a card you
drag onto a delete well, a tile that drops into a slot — these commit only when
the finger *lifts inside* the destination, reading the release coordinate at
`touchend` against the target's rectangle and **springing back** if it landed
short. A blind `touch_drag` (F098) by a *guessed* delta moves the same finger
the same way but stops wherever the number said, so a delta that falls short of
the well releases outside it and the page files it as a spring-back — the
gesture ran, yet nothing dropped, and `touch_drag` still returns `True`. The
friction is the **release coordinate** relative to a second element, not the act
of dragging: you cannot hit a target you have not measured.

**Mechanism:** The realistic surface latches the last touch point on every
`touchmove` and, at `touchend`, tests it against `getBoundingClientRect()` of
the zone: inside → `dropped=1`, outside → `shortfall=1`. A real drag surface
must also *claim* the gesture (`touch-action:none` + non-passive
`preventDefault`) or Chrome turns a long horizontal stroke into an overscroll
back-navigation and the page never sees the drop at all. So the page records a
shortfall under a blind delta that stops short, and a clean drop only when the
finger is carried all the way onto the zone before lifting.

**Primitive:** `Browser.touch_drag_to(selector, target, arm=0.25, ...)` resolves
the honest hit point of the *source* (F061), refuses if it is absent or
occluded, then resolves the honest hit point of the *target* (refusing if *it*
is absent or occluded — there is nowhere to drop), presses one touch at the
source, holds it motionless for `arm` seconds so any pick-up timer fires, steps
it to the target's point issuing `touchMove` events, and lifts with `touchEnd`
*over the zone*. Returns `True` once the drop completes, `False` if either
element is absent or occluded.

**Live (R66):** the page starts unfired (`dropped=0, shortfall=0`); a blind
`touch_drag(+30,0)` releases short of the well (`dropped=0, shortfall=1`) while
still returning `True`; `touch_drag_to("#card","#zone")` carries the finger onto
the resolved zone and drops (`dropped=1, shortfall=0`); under a transparent veil
the source is occluded and `touch_drag_to` → `False` with nothing dropped; an
absent source *or* an absent target → `False`. `404/404 checks passed`,
deterministic ×3.

**Lesson (道法自然):** 千里之行，始於足下 — but the journey is judged by where the
foot comes to rest, not by how far it was told to go. A blind delta is a number
spoken into the dark; it moves honestly and lands nowhere. To drop a thing you
must first *measure where it must land*, then carry the finger there and let go.
知止 — knowing the stopping place is the whole of the gesture; the destination,
not the distance, is the meaning.

---

## F103 — read a multi-glyph word off the canvas (`read_text` / `segment_run`) · R67

**Friction:** `read_glyph` (F058) reads *one* pre-isolated character: it reduces
a region to a single `edge_signature` and returns the closest atlas label. A
word the page draws straight onto a canvas — `"BOXCAB"` painted as one magenta
run with no per-letter DOM node — is still *one* ink region, so pointing
`read_glyph` at the whole run collapses six glyphs into one signature and returns
a single wrong letter (`'O'` for the run, not `"BOXCAB"`). You cannot read a
string you have not first *cut into letters*; the friction is segmentation, not
classification.

**Mechanism:** `segment_run` projects every column inside the run's bbox, marks
a column *inked* when any pixel there is within `tol` of the foreground colour,
and walks left-to-right opening a cell at the first inked column and closing it
once `gap` consecutive blank columns prove the inter-letter space. Each cell is
then tightened to its actual inked rows so the bbox hugs the glyph (what
`edge_signature` wants), and the cells are returned in reading order. The cut is
honest only where letters are parted by ≥ `gap` blank columns — glyphs that
*touch* (tight kerning, italic overhang) share a column and merge into one cell;
projection cannot part what the rendering joined, and that is its named boundary,
not a thing to fake.

**Primitive:** `read_text(rgb, size, bbox, atlas, fg, ...)` `segment_run`s the
run by the foreground colour into per-glyph cells, classifies each cell in the
scale-free frame (`read_glyph` against the reference `atlas`), and joins the
labels in reading order. Reads only glyphs the `atlas` carries and only runs
`segment_run` can part; returns `""` when nothing inked is found. The atlas is
rendered *small* (90px) while the scene word is drawn *large* (150px) — a
fixed-size match would read every cell as the same letter, so classification
stays in `edge_signature`'s scale-free frame.

**Live (R67):** the atlas canvas segments into six reference glyphs; the word run
is located by colour and is larger than the atlas glyphs; `read_glyph` over the
whole run returns a single letter (`'O'`), reproducing the friction; `segment_run`
cuts the run into exactly six cells in strict left-to-right order; `read_text`
reads `"BOXCAB"`, and a different word `"OK"` and a single glyph `"X"` with no
per-word special-casing; a blank region yields no cells and `read_text` returns
`""`. `415/415 checks passed`, deterministic ×3.

**Lesson (道法自然):** 道生一，一生二，二生三，三生萬物 — the run is the undivided one;
to read it you must let it become many. `read_glyph` knows a single thing whole;
a word is not a bigger glyph but a *sequence*, and the act that makes reading
possible is the cut, not the gaze. 知止 again: the segmenter stops at the blank
column the rendering itself left between letters — it parts only what was already
parted, and refuses to invent a boundary where the ink runs together.

---

## F104 — read a word whose letters TOUCH (`split_run`) · R68

**Friction:** `segment_run` (F103) parts letters only where ≥`gap` *fully blank*
columns separate them. Tight kerning, an italic overhang, or a script font joins
two glyphs in one shared column — there is no blank seam — so they merge into one
wide cell. Live: a `"CAB"` drawn with 40 px of negative kerning segments into
**one** cell, and `read_text` reduces the whole run to a single `edge_signature`
and returns `'A'`, not `"CAB"`. A blank-column cut cannot part what the rendering
joined; that is `segment_run`'s named boundary, reproduced.

**Mechanism:** the honest extra knowledge that *does* part touching letters is the
**glyph count** `n`. When two letters merely touch, the seam between them is a
local *minimum* in the per-column ink count — the pinch where only the thin
overlap inks the column, shallower than either letter's own body. `split_run`
counts the ink in every column of the run, finds the interior local minima, and
takes the `n - 1` *shallowest* of them (those at or below `frac`·peak — a real
pinch, not a letter's own waist) as the seams, cutting there and tightening each
piece to its inked rows with `segment_run`. It returns fewer than `n` cells when
it cannot find `n - 1` honest seams, and refuses (`[]`) on blank ink — it parts
what genuinely pinches and never invents a cut where the ink runs solid.

**Primitive:** `split_run(rgb, size, bbox, fg, n, tol, frac)` returns the `n`
per-glyph bboxes of a touching run in reading order. `read_text` gains an optional
`n`: when blank-column `segment_run` yields fewer than `n` cells it falls back to
`split_run`, so the *same* call reads both spaced and kerned runs. Without `n`
the F103 behaviour is unchanged.

**Live (R68):** the atlas segments into six reference glyphs; a kerned `"CAB"`
run is located by colour; `segment_run` merges it into one cell and `read_text`
*without* a count misreads it (`'A'`), reproducing the friction; `split_run` with
`n=3` parts it into three cells in strict left-to-right order; `read_text` *with*
`n` reads `"CAB"`, and a different touching pair `"AB"` reads correctly with no
per-word special-casing; `split_run` with `n=1` returns a single cell and on a
blank region returns `[]`. `425/425 checks passed`, deterministic ×3.

**Lesson (道法自然):** 反也者，道之動也 — where F103 read the word by the *blanks*
between letters (presence), F104 reads it by the *valleys* within the ink
(absence inside the joined form). The cut lives not in the strokes but in the
pinch between them; and only the count — knowing how many to expect — tells the
inter-letter seam from a letter's own waist. We part what touches and refuse to
saw through what is fused.

---

## F105 — read a multi-LINE text block (`segment_lines` / `read_block`) · R69

**Friction:** `read_text` (F103/F104) projects ink down *columns* across the whole
`bbox` — it assumes a single horizontal line. Point it at a block of stacked
lines and every column is inked by *more than one* line at once: the column
profile never falls blank between letters, the rows fuse vertically, and the run
reads as garbage. Live: an `"OK"` over `"CAB"` block (two lines, blank leading
between them) reads `'AXB'` — three merged columns, neither word. A column cut
cannot part rows the page stacked one above another; that is `read_text`'s named
boundary, reproduced.

**Mechanism:** the cut is *orthogonal* to F103/F104. Where those split the ink by
column blanks (the gaps *between letters*), lines are split by the blank leading
*between rows*. `segment_lines` counts ink per *row* of the block and groups the
inked rows into bands separated by ≥`row_gap` fully-blank rows — each band is the
tight vertical extent of one text line, in top-to-bottom order. It refuses (`[]`)
on blank ink and never invents a split inside a single line's x-height: it parts
only the leading the page actually left.

**Primitive:** `segment_lines(rgb, size, bbox, fg, tol, gap)` returns one bbox per
line; `read_block(rgb, size, bbox, atlas, fg, …, row_gap)` segments the block into
line bands and reads each as its own run with `read_text`, returning one string
per line top-to-bottom. A single-line block yields a one-element list; a blank
region yields `[]`. The horizontal machinery (`segment_run` → `split_run` →
`read_glyph`) is reused unchanged per band.

**Live (R69):** the atlas segments into six reference glyphs; a two-line `"OK"`/
`"CAB"` block is located by colour; `read_text` over the *whole* block reads
neither line (`'AXB'`, the friction); `segment_lines` parts it into two bands in
strict top-to-bottom order, each shorter than the whole block; `read_block` reads
`['OK','CAB']`; a three-line block reads `['OK','AB','OK']` and a single line
reads `['OK']` with no per-block special-casing; a blank region yields no bands
and `[]`. `436/436 checks passed`, deterministic ×3.

**Lesson (道法自然):** 反也者，道之動也 — F103/F104 read *along* the line by what
parts letters left-to-right; F105 reads *down* the page by what parts lines
top-to-bottom. The same projection, turned ninety degrees: presence of ink names
the line, absence of ink (the leading) names the seam between lines. We cut only
where the page already left a gap, and refuse to break a line that does not.

---

## F106 — read a line WITH its word spaces (`read_words`) · R70

**Friction:** `read_text` (F103/F104) `segment_run`-s a line into per-glyph cells
and joins their labels with *nothing* between them — it records only *where* the
inked cells sit, never the *width* of the blank between them. A blank column is a
blank column to it whether it parts two letters or two words. Draw a real word
gap (`"OK  CAB"`) and it reads `'OKCAB'`: the space the page left between words is
dropped. `read_text` cannot tell an inter-letter gap from an inter-word gap — that
is its named boundary, reproduced live.

**Mechanism:** the missing signal is in the gaps themselves — they are *bimodal*.
The gaps *inside* a word (between its letters) cluster small and roughly equal;
the gap *between* words is markedly wider. `read_words` reads each cell exactly as
`read_text` does, measures the horizontal blank between every adjacent pair, takes
the **median** gap as the typical inter-letter spacing, and inserts a single `' '`
wherever a gap is `>= space_k` times that median — a clear word seam, not a
letter's own spacing. Honest only where the spacing is bimodal: a single word, or
evenly-tracked type whose word gap barely exceeds its letter gap, clears no
threshold and reads as one space-less run rather than inventing a break. Empty ink
→ `""`; raise `space_k` to demand a wider seam, lower it to split more eagerly.

**Primitive:** `read_words(rgb, size, bbox, atlas, fg, …, space_k=1.8)` returns the
line as a single string with spaces only at the word seams. The cell machinery
(`segment_run` → `split_run` → `read_glyph`) is reused unchanged; the only new
work is the median-gap threshold over the inter-cell gaps.

**Live (R70):** the atlas segments into six reference glyphs; a two-word `"OK  CAB"`
line is located by colour and segments into five glyph cells with four gaps whose
maximum (the word gap) is `>= 1.8 ×` the median (bimodal, confirmed); `read_text`
over the line reads `'OKCAB'` (the friction); `read_words` reads `'OK CAB'` with
exactly one space restored; a single word `"CAB"` reads `'CAB'` with no invented
space; three words read `'OK AB OK'` with exactly two spaces in order; a demanding
`space_k=99` refuses to split the same line (`'OKCAB'`); a blank region yields
`''`. `448/448 checks passed`, deterministic ×3.

**Lesson (道法自然):** 信者信之，不信者亦信之 — F103/F104/F105 cut where the page
left a *gap*; F106 listens to *how wide* the gap is. The same blanks that part the
letters also part the words — the page already wrote the spacing, two scales of it
at once, and we only had to stop discarding the wider scale. We trust the gap the
page made, and refuse to trust one it did not.

---

## F107 — read a glyph only when it CLEARLY fits (`read_glyph_conf`) · R71

**Friction:** `read_glyph` (F058) returns `min(atlas, key=…)` — the *nearest* label,
always. It has no way to say "I do not know this." Point it at a glyph the atlas
never held (a `"Z"` against an atlas of `"ABCOKX"`) and it returns the closest
*wrong* letter with the same outward confidence as a true read. The closest of a
bad lot is still reported as a read. `read_glyph` cannot express ignorance — that
is its named boundary, reproduced live (unknown `Z`/`M`/`5` each named as some
atlas letter).

**Mechanism:** the distance to the best match carries the missing signal, on two
axes that separate cleanly. A glyph that *is* in the atlas matches its own
signature with a *small* Hamming distance relative to the live ink it sets
(measured `best/on ≈ 0.22–0.38`), and beats the runner-up by a wide *margin*
(`≈ 3.5–7×`); an *unknown* glyph's nearest match is both far in absolute terms
(`best/on ≈ 0.95–1.40`) and barely closer than the runner-up (`margin ≈ 1.0–1.3`)
— nothing stands out. `read_glyph_conf` admits the best label only if it passes
*both* gates: the nearest distance is `<= max_dist` (0.6) times the live ink's set
cells *and* the runner-up is `>= conf_k` (2.0) times farther. Fail either and it
returns `unknown` (`""` by default). Honest only where the atlas entries are
themselves distinguishable: hold two near-twins and a true match may not clear
`conf_k` — it refuses rather than guess, which is the honest answer when the
reference itself cannot tell them apart.

**Primitive:** `read_glyph_conf(rgb, size, bbox, atlas, …, max_dist=0.6,
conf_k=2.0, unknown="")` returns the label when one entry clearly fits, else the
chosen sentinel. The signature/Hamming machinery (`edge_signature`,
`edge_hamming`) is reused unchanged; the only new work is the two-gate decision
over the sorted distances.

**Live (R71):** the atlas segments into six reference glyphs; a known `"A"` drawn
at a *different* size is a tight fit (`best <= 0.6 × ink`) and a clear winner
(`runner-up >= 2×`), named `'A'` by both readers; an unknown `"Z"` is a poor fit
*and* has no clear winner, so `read_glyph` misreads it (the friction) while
`read_glyph_conf` returns `''`; two further unknowns (`M`, `5`) are refused while
`read_glyph` still misreads them; the refusal sentinel is caller-chosen (`'?'`); a
blank region returns `''`; and loosening both gates accepts the nearest match
again (it knows its own threshold). `466/466 checks passed`, deterministic ×3.

**Lesson (道法自然):** 知人者知也，自知者明也 — F058 always *knew* a glyph; F107
learns to know *whether* it knows one. The nearest label is not the same as a
read; the distance the page set already says whether anything truly fits. We add
the power to refuse — 知止不殆 — naming only what stands out, and staying silent
where the atlas cannot honestly answer.

---

## F108 — read a line, marking glyphs the atlas cannot name (`read_text_conf`) · R72

**Friction:** F107 cured the lie for *one* glyph, but `read_text` never propagated
the confidence up: it classifies every cell with `read_glyph`, which returns the
*nearest* label no matter how badly it fits. Draw a line holding a glyph the atlas
never carried — a `"Z"` inside `"CZB"` — and `read_text` reads `"CCB"`: the unknown
letter is silently rewritten as the closest known one, and the string lies about a
character it never recognised. Reproduced live: the middle cell parts cleanly as a
third glyph, yet the returned string names it a known letter. The friction
re-appears the moment a *line* is read because confidence stopped at the glyph.

**Mechanism:** there is no new pixel signal — the cure is *composition*.
`read_text_conf` segments exactly as `read_text` does (blank columns, or
`split_run` when `n` is given and the letters touch) but classifies each cell with
`read_glyph_conf` instead of `read_glyph`. Each cell is named only when one atlas
entry is both a good absolute fit (`best <= max_dist × ink`) and a clear winner
(`runner-up >= conf_k × farther`); otherwise that position is written as the
caller-chosen `unknown` mark (`"?"` by default). The string therefore *shows* its
gaps — every position the reader could not honestly resolve is a visible mark, not
a fabricated letter — so a caller can tell `"C?B"` (one glyph unreadable) from
`"CAB"` (read whole).

**Primitive:** `read_text_conf(rgb, size, bbox, atlas, fg, …, n=None,
max_dist=0.6, conf_k=2.0, unknown="?")` returns the line with unreadable glyphs
marked. `unknown=""` drops the unreadable cells instead of marking them. The
segmentation (`segment_run`/`split_run`) and per-glyph gates (`read_glyph_conf`)
are reused unchanged; the only new work is routing the cells through the honest
reader.

**Live (R72):** an all-known line `"CAB"` is read whole by both readers (no marks);
a mixed line `"CZB"` is misread `"CCB"` by `read_text` (the friction) while
`read_text_conf` returns `"C?B"`, keeping the known `C`/`B` and marking only the
unknown; the mark sentinel is caller-chosen (`"C#B"`); `unknown=""` drops the cell
(`"CB"`); an all-unknown line `"ZW"` becomes `"??"` while `read_text` still rewrites
both to known letters; and loosening both gates makes `read_text_conf` accept the
nearest match exactly like `read_text` (no marks). `480/480 checks passed`,
deterministic ×3.

**Lesson (道法自然):** 大成若缺，其用不敝 — a reading that *shows* where it is
incomplete is more useful than one that hides its gaps behind invented letters.
F107 gave one glyph the power to refuse; F108 carries that honesty up to the line,
adding nothing new — 為學者日益，聞道者日損 — only composing the honest part so the
whole inherits its silence.

---

## F109 — a reader needs the ink colour, but layout only gives bounds

**Friction.** Every reader in `osctl` — `segment_run`, `read_text`, `read_block`,
`read_text_conf` — demands the caller pass `fg`, the text colour, and segments the
region by proximity to it. But a control found by *layout* (a button's bounds, a
label's box from the DOM) arrives with no colour attached: you know *where* the
text is, not what colour the page drew it. Hand such a region to `read_text` with
the wrong `fg` and it finds no ink at all and reads `""` — the whole reading stack
is blind to text whose colour it was not told in advance. Location is not enough;
reading needs the ink colour, and nothing supplied it from the pixels themselves.

**Mechanism.** The region carries the answer. A label is a large flat field of
*background* pixels with a sparse scatter of *ink* on top. Quantise the region to
`q`-step buckets and histogram them: the background is simply the most frequent
bucket, and the ink is the most frequent bucket that lies *far* from it (L1
distance `> min_dist`). Anti-alias fringe colours sit *between* ink and background
and are rarer than either, so they never win. A *uniform* region (a blank panel,
a solid fill) has no bucket far from its background — so there is no ink, and
`fg` is honestly `None` rather than a promoted fringe or noise pixel.

**Primitive:** `detect_fg(rgb, size, bbox, q=16, min_dist=120)` returns `(bg, fg)`
where `fg` is `None` when the region holds no ink. The quantised `fg` still falls
within a reader's `tol` of the true colour, so it can be handed straight to
`read_text`/`read_block` to unblock reading a region found by layout alone.

**Live (R73):** a magenta atlas reads lines drawn in *other* colours once
`detect_fg` supplies the right `fg`. Yellow-on-navy, near-white-on-maroon and
black-on-green regions each have both colours recovered within tolerance; the same
`read_text` told the *wrong* `fg` (magenta) reads `""` (the friction) but reads
`"CAB"`/`"BACK"`/`"OK"` once given `detect_fg`'s colour; a uniform field returns
its colour as `bg` and refuses `fg=None`; and demanding an unreachable `min_dist`
refuses real ink too (`fg=None`) — the gate is the distance. `493/493 checks
passed`, deterministic ×3.

**Lesson (道法自然):** 知人者智，自知者明 — to know others is wisdom, to know
oneself is clarity. The readers asked the caller to *know* the colour; F109 lets
the region *know itself*, reading its own ink from its own pixels. And it keeps
the F107/F108 honesty: where there is no ink to name, it says `None` rather than
inventing one.

---

## F110 — one ink is not enough: a region holds a *palette*

**Friction.** `detect_fg` (F109) answers a single question — "what is the *one*
ink colour here?" — and returns the most frequent bucket far from the background.
But a region rarely holds just one ink: a status line draws a red word beside a
green one, syntax highlighting paints three or four colours into one box, a label
sits next to a coloured badge. Hand such a two-ink region to `detect_fg` and it
keeps only the *most frequent* ink and **silently drops the rest**. And since
every reader (`read_text`, `read_block`) segments by a *single* `fg`, the
other-coloured words become unreadable: you cannot read what you were never told
the colour of, and one `fg` can only ever name one colour.

**Mechanism.** The region still carries the whole answer. Quantise to `q`-step
buckets and walk them in *descending frequency*, admitting a bucket only when it
is at least `min_dist` (L1) from every colour already kept *and* holds at least
`min_pop` of the region's pixels. The `min_dist` guard fuses each true colour's
anti-alias fringe into the colour it edges (the fringe sits *between* two colours
and is rarer than either, so it is never admitted as its own); `min_pop` drops
stray noise. The result is the region's **palette**: the background first (most
pixels), then each ink in turn — each ready to hand to a reader.

**Primitive:** `palette(rgb, size, bbox, q=16, min_pop=0.002, min_dist=96)`
returns `list[tuple[int,int,int]]`, background-first, frequency-ordered. A colour
rarer than `min_pop` is honestly *not reported* — a one-pixel speck is noise, not
a colour the page meant to draw.

**Live (R74):** a magenta atlas (magenta is rare on screen, unlike black chrome)
reads runs drawn in *any* ink once the right `fg` is supplied. In a region with
`RED` (red) beside `GRN` (green) on white, `detect_fg` names exactly *one* of the
two inks and drops the other (the friction); its lone colour then reads the
other-coloured word as `""`. `palette` recovers all three colours — white
background first, then both inks, *and nothing else* (no fringe admitted) — and
each recovered colour reads its own word (`"RED"`, `"GRN"`). A three-colour region
yields all three inks; a uniform region yields a single colour (no inks); an
unreachable `min_pop` honestly keeps only the background. `507/507 checks
passed`, deterministic ×3.

**Lesson (道法自然):** 萬物負陰而抱陽 — the ten thousand things carry yin and
embrace yang. A region is not one colour against a ground; it is many, held
together. F109 named the one; F110 names them all, and — keeping the F107–F109
honesty — names *only* those the page truly drew, letting the fringe dissolve
into the colour it borders rather than promoting it to an ink of its own.

## F111 — naming the colours is not reading them: read the *whole* region

**Friction.** `read_text` segments by a *single* `fg`: `segment_run` marks a
column inked only where a pixel sits within `tol` of that one colour. Hand it a
region holding two differently-coloured words — a red `OK` beside a green `GO`, a
black label next to a coloured value — and it reads only the run of *its* colour;
every other-coloured glyph is **background** to it, and the line comes back
half-read. F110's `palette` could finally *name* every ink in the region, but
naming is not reading: there was still no primitive that turns the whole
multi-coloured region into the string a human actually sees.

**Mechanism.** Ask `palette` for the region's colours, drop the first (the
background — the field the text sits on holds the most pixels), and for *each*
remaining ink `segment_run` the region by that colour into per-glyph cells.
Gather every cell from every ink and **sort by its left edge**: the glyphs fall
back into the single left-to-right order the eye reads, regardless of which
colour drew them. Each is then classified scale-free (`read_glyph` against the
atlas) and the labels join into the region's full text — `"OKGO"` where one `fg`
read only `"OK"`.

**Primitive:** `read_region(rgb, size, bbox, atlas, ...)` returns the region's
full text across every colour, in reading order. Honest about its frame: it reads
each ink as a *run of glyphs*, so a solid coloured fill (a badge, a progress bar)
has no inter-glyph blanks and segments as one wide cell `read_glyph` will
mislabel — `read_region` reads the *text* colours of a region, not its
decorations, and the caller scopes `bbox` to a text area. An empty region (no ink
above `palette`'s floor) → `""`.

**Live (R75):** one magenta atlas reads runs of any ink. With `OK` (red) beside
`GO` (green) on white, `read_text` given the red ink reads only `"OK"` and given
the green only `"GO"` (the friction, both directions); `read_region` reads
`"OKGO"`. Order follows *geometry, not palette frequency* — swap the sides and it
reads `"GOOK"`. Three coloured words `RED`/`GRN`/`BLU` read back `"REDGRNBLU"`; a
single-ink region agrees with `read_text` (`"RED"`); a uniform region reads `""`.
`517/517 checks passed`, deterministic ×3.

**Lesson (道法自然):** 知其白，守其黑，為天下式 — know the white, keep the black,
be the world's pattern. F110 *knew* the colours; F111 *keeps* them all in the one
order they were drawn. The reader stops belonging to a single ink: the region
speaks once, in every colour at once, and the glyphs sort themselves back into
the line the eye already saw.

---

## F112 — a region reads as one line: read the *block*, line by line

**Friction.** F111's `read_region` gathers every ink's glyphs and sorts them by
their **left edge** — one flat left-to-right run. Hand it a region holding *two
stacked lines* (`OK GO` above `NO BY`) and the x-sort interleaves them: a
left-most word on line 2 (`NO`) sorts *before* a right-most word on line 1
(`GO`), so the block comes back x-scrambled (`"ONOKGBYO"`) — never the two lines
the eye reads. F105's `read_block` *does* band rows into lines, but it bands by a
**single** `fg`: give it lines drawn in *different* colours (a red line above a
green line) and every line that colour does not ink is dropped — `read_block(red)`
reads only `["RED"]`, the green line gone. Neither primitive reads a multi-line,
multi-colour block whole.

**Mechanism.** Ask `palette` for the region's inks (drop the background). Project
**rows**: a row is *inked* if any pixel in it sits within `tol` of *any* ink — so
a line drawn in any colour lights its rows. Group consecutive inked rows into
**bands** separated by `row_gap` blank rows; each band is one line's y-span. Then
hand each band's sub-bbox, **top-to-bottom**, to `read_region` — which already
reads every colour in left-to-right order within the band. The block returns as a
`list[str]`, one entry per line, in geometric reading order.

**Primitive:** `read_block_region(rgb, size, bbox, atlas, ...)` returns the
block's lines, each read across every colour, ordered top-to-bottom. Composition,
not new machinery: `palette` (which inks) + row-ink projection (where the lines
sit) + `read_region` per band (what each line says). A block with no ink above
`palette`'s floor → `[]`; a single-line block → a one-element list equal to
`[read_region(...)]`.

**Live (R76):** one magenta atlas reads runs of any ink (`OKGREDNBLUY`). A
two-line, two-colour block — `OK`(red) `GO`(green) over `NO`(blue) `BY`(red) —
makes `read_region` return the x-scramble `"ONOKGBYO"` (the friction), while
`read_block_region` reads `["OKGO", "NOBY"]`. Mono-coloured lines (`RED` red,
`GRN` green) make `read_block(red)` drop the green line (`["RED"]`, the friction);
`read_block_region` reads `["RED", "GRN"]`. Order follows geometry — swap the two
lines and it reads `["NOBY", "OKGO"]`; a single line equals `[read_region]`
(`["OKGO"]`); a uniform block reads `[]`. `527/527 checks passed`, deterministic
×3. (`capture_rgb` grabs the whole desktop, so the white field abuts the browser
chrome; the test crops `//8` off the field's top/bottom — as R75 — to keep the
bookmarks-bar fringe out of the top band.)

**Lesson (道法自然):** 知其白，守其黑 — but a page is not one line. F111 kept every
colour in one order; F112 keeps every *line* in its own order, then every colour
within it. The reader stops flattening height into width: rows say *where* the
lines are, columns say *what* each line is, and the block speaks line by line as
it was written.

---

## F113 — a coloured line reads as one word: read the *words* across colours

**Friction.** F111's `read_region` reads every colour of a line, but joins the
glyph labels with *nothing* between them — hand it `OK GO` painted as a red `OK`
beside a green `GO` and it reads `"OKGO"`, the word seam the page left between the
two words dropped exactly as `read_text` dropped it before F106. F106's
`read_words` *does* recover the seam — it measures the blank between cells and
splits where the spacing turns bimodal — but it `segment_run`-s by a **single**
`fg`: give it that two-colour line and it reads only one colour's word
(`read_words(red)` → `"OK"`, the green word gone; `read_words(grn)` → `"GO"`).
Neither primitive reads a multi-colour line *with* its spaces.

**Mechanism.** Word spacing and colour are orthogonal axes that the two readers
each collapsed: F111 kept every colour but flattened the spacing, F106 kept the
spacing but flattened to one colour. The seam lives in the *gaps between cells*,
which are bimodal (inter-letter gaps small and even, the word gap markedly
wider) — and that signal survives no matter which inks sit on either side of it.

**Primitive.** `read_region_words` composes the two. As `read_region`, it asks
`palette` for the region's inks, drops the background, and `segment_run`-s each
ink into per-glyph cells, gathering *every* cell from *every* colour and sorting
by left edge — the one left-to-right order the eye reads. Then, as `read_words`,
it takes the median cell-to-cell gap as the typical letter advance and inserts a
single `' '` wherever a gap is `>= space_k` (1.8) times that median — a word
seam, regardless of the colours flanking it. One line; use `read_block_region`
first to part stacked lines.

**Live (R77):** one magenta atlas reads runs of any ink. A two-colour line —
red `OK`, wide gap, green `GO` — makes `read_region` read `"OKGO"` (seam dropped)
and `read_words(red)`/`read_words(grn)` read only `"OK"`/`"GO"` (the frictions);
`read_region_words` reads `"OK GO"`. Three words in three colours (`RED` red,
`OK` green, `BY` blue) read `"RED OK BY"`; order follows geometry — green word
left, red word right reads `"GO OK"`; a single-colour line equals `read_words`
(`"OK GO"`); an evenly-tracked block invents no space (`"OKGO"`); a uniform
region reads `""`. `539/539 checks passed`, deterministic ×3.

**Lesson (道法自然):** 大音希聲 — the space between words says as much as the words.
F111 kept every colour, F106 kept every seam; each had let the other axis go.
F113 keeps both: colour says *what* each glyph is, the gap says *where* one word
ends and the next begins, and the line reads as the page spaced it.

---

## F114 — a coloured paragraph reads as run-on lines: read the *words* across rows

**Friction.** F112's `read_block_region` parts a coloured paragraph into its lines
and reads each across every colour — but each band is read through F111's
`read_region`, which joins a line's glyph cells with *nothing* between them. So a
block whose lines each carry a word seam, `OK GO` over `NO BY`, reads
`["OKGO", "NOBY"]`: rows kept, colours kept, every word gap *inside* a line
dropped — the F113 friction, now one level up at block scope. F113's
`read_region_words` *does* recover a line's seams, but it flattens the whole
`bbox` into one x-sorted run, so handed a two-line block its lines interleave by
column and every word shatters across the line break (`OK GO`/`NO BY` →
`"ONOKGBYO"`). One reader keeps the rows and loses the seams; the other keeps the
seams and loses the rows.

**Mechanism.** Three axes — colour, row, word seam — and each prior reader had let
one go. F111 dropped seams; F112 kept rows + colours but inherited F111's dropped
seam; F113 kept colours + seams but flattened the rows. Rows live in the *blank
leading* between bands; seams live in the *bimodal gaps* within a band. The two
signals are independent: band first by vertical blanks, then split each band's
horizontal gaps — neither erases the other.

**Primitive.** `read_block_region_words` composes F112's banding with F113's
reader. The row-banding both share is now `_band_rows` (a row inked by *any*
palette ink, lines parted by `>= row_gap` blank leading) — F112 and F114 read a
block by the *same* rows, differing only in how each band is then read: F112 hands
each band to `read_region`, F114 to `read_region_words`. Every line comes back
across all its colours *and* with the `' '` at each seam its spacing is bimodal
about: `["OK GO", "NO BY"]`.

**Live (R78):** one magenta atlas reads runs of any ink. A two-line block — red
`OK` / green `GO` over blue `NO` / red `BY` — makes `read_block_region` read
`["OKGO","NOBY"]` (rows kept, seams dropped) and `read_region_words` read
`"ONOKGBYO"` (seams kept, rows scrambled) — the two frictions; then
`read_block_region_words` reads `["OK GO","NO BY"]`. Order follows geometry
top-to-bottom (swap → `["NO BY","OK GO"]`); three words per line across three
colours read `["RED OK BY","GO NO RED"]`; a single line equals
`[read_region_words]`; an evenly-tracked block invents no space
(`["OKGO","NOBY"]`); a uniform block reads `[]`. `550/550 checks passed`,
deterministic ×3.

**Lesson (道法自然):** 三生萬物 — colour, row, and seam are three axes; a reader that
collapses any one of them run-ons the page. F112 found the rows, F113 found the
seams; F114 holds both at once, and the paragraph reads as the page laid it out —
each line whole, each word parted where the spacing parts it.

---

## F115 — reading a word is not reaching it: locate the word to *click* it

**Friction.** Every reader from F103 on answers *what* the pixels say and throws
the rest away. `segment_run` knows each glyph's bbox, but `read_region` /
`read_region_words` fold those cells into one joined string and the positions are
gone. So an agent that has just *read* `"GO"` off a `<canvas>` button still cannot
*press* it: there is no DOM node for `Browser.click`/`click_text` to find, and the
pixel finders (`find_color`, `template_match`) locate by *colour* or *bitmap* —
never by the *word* the eye read. Reading and acting were split halves: you could
name the text, or you could find a shape, but not click the text you named.

**Mechanism.** The position was never missing — it was *discarded*. Each glyph
cell `segment_run` returns is already a bbox in the same screen frame `capture_rgb`
and `click` share (R14 proved that frame is the click coordinate space). The
readers just collapsed the cells to labels. To click a read word you keep the
cells: group them into words exactly where `read_region_words` finds its seams
(the bimodal gap), read each group, and the matching group's *union bbox* is where
that word sits on screen.

**Primitive.** `locate_word(region, target)` gathers every ink's cells
(`palette` + `segment_run`), sorts left-to-right, groups at gaps `>= space_k` the
median (the F113 seam), reads each group (`read_glyph` against the atlas), and
returns the first group whose label equals `target` as its union bbox — or `None`
if the region does not hold that word (or the atlas cannot spell it). Its centre
fed to `osctl.click` presses the very word that was read. Repeated words return
the leftmost (reading order).

**Live (R79):** three coloured text "buttons" — red `OK`, green `GO`, blue `BY` —
painted on a `<canvas>` with no DOM nodes. `read_region_words` names them
(`"OK GO BY"`) but yields no place to click; `locate_word` returns a bbox for each
in reading order (`OK` left of `GO` left of `BY`) and `None` for an absent `"ZZ"`.
Then the loop closes: `click`-ing the centre of the located `"GO"` makes the canvas
report `HIT:GO`, and locating-and-clicking `"OK"` reports `HIT:OK` — the agent
presses the word it read, not a hard-wired spot. `558/558 checks passed`,
deterministic ×3.

**Lesson (道法自然):** 知行合一 — to read without being able to act is to know half a
thing. The whole tower F103→F114 learned to *see* text on raw pixels; F115 turns
seeing into reaching, and the agent at last presses the button it can only read.

---

## F116 — reaching a word in a paragraph: locate it across the block's lines

**Friction.** F115's `locate_word` reaches a word *in one line*: it sorts every
cell in the bbox by left edge and groups by the gaps between. Hand it a two-line
block and the lines interleave by column — exactly the scramble
`read_region_words` suffered before F114 — so a word's cells shuffle among the
other line's, no run forms, and *every* `locate_word` returns `None`. The reach
F115 opened was line-deep; a paragraph closed it again. Reading climbed line →
block at F112/F114; reaching had not yet made the same climb.

**Mechanism.** The same banding that let F114 read a block lets F116 reach into
one. Rows live in the blank leading between lines (`_band_rows`); within a band a
word's cells group only against its own line's neighbours. Band first, locate
within each band, and a word is found where it sits in the paragraph — its run
formed against its own line, its bbox in the screen frame `capture_rgb`/`click`
share.

**Primitive.** `locate_block_word(region, target)` asks `palette` for the inks,
bands the rows with `_band_rows` (a row inked by *any* ink, lines parted by
`>= row_gap` blank leading — the same partition F114 reads by), and runs
`locate_word` within each band top-to-bottom, returning the first band's match.
Reading order top-to-bottom then left-to-right; a word no line holds → `None`.

**Live (R80):** two lines of coloured text buttons on a `<canvas>` — red `OK` /
green `GO` over blue `NO` / red `BY`, no DOM nodes. `read_block_region_words`
names the lines (`["OK GO","NO BY"]`) but flat `locate_word` finds *none* of the
four words (`[None,None,None,None]` — the friction). `locate_block_word` returns a
bbox for each, line one above line two, left-to-right within a line, and `None`
for an absent `"ZZ"`. The loop closes across rows: clicking the located `"BY"` on
the *second* line reports `HIT:BY`, clicking `"OK"` on the first reports `HIT:OK`.
`568/568 checks passed`, deterministic ×3.

**Lesson (道法自然):** 為學者日益 — reach must climb wherever reading climbed. F114
taught the eye to read a paragraph line by line; F116 teaches the hand to reach
into it the same way, and the agent presses any word on any line it can read.

---

## F117 — a button is a phrase, not a word: locate the run of words it spans

**Friction.** `locate_word`/`locate_block_word` (F115/F116) reach a *single* word —
each matches one run between seams. But controls are labelled across spaces:
`Sign In`, `Add To Cart`, here `OK GO`. Ask `locate_block_word` for `"OK GO"` and
it never matches (no single run carries the space); ask for `"OK"` and you get
only that word's box, its centre landing on *half* the button. The locators could
say where one word sits but not where a labelled control — a *run of words* —
spans, nor where its true middle is.

**Mechanism.** A phrase is a *consecutive run of words on one line*. The cells were
already grouped into words at the bimodal seam (the F115 spine, now factored as
`_line_words`, returning each word's `(label, bbox)`); a phrase is just a window
over that per-line word list whose labels match `target.split(' ')`. Its extent is
the union of exactly those words' boxes, and that union's centre — unlike any one
word's — is the control's middle.

**Primitive.** `locate_phrase(region, target)` bands the rows (`_band_rows`, like
`locate_block_word`), reads each line's words in order (`_line_words`), and slides
a window of `len(words)` over each line's labels for the consecutive run equal to
the phrase, returning the union bbox of exactly those words. A one-word target is
`locate_block_word`; a phrase no line carries in order → `None`. (`locate_word`
was refactored onto the same `_line_words` spine — no behaviour change.)

**Live (R81):** a multi-word button `OK GO` (red `OK` beside green `GO`, one
clickable span) over a single `NO`. `read_block_region_words` reads the label as
one line (`["OK GO","NO"]`); `locate_block_word("OK GO")` is `None` (the friction)
while each word locates singly. `locate_phrase("OK GO")` spans `OK`'s left edge
through `GO`'s right (the whole label), its centre falling *between* the two word
centres (the control's middle), `None` for an absent `"NO BY"`, and equal to
`locate_block_word` for a single word. The loop closes on the control: clicking the
phrase's centre presses the multi-word button (`HIT:OKGO`). `579/579 checks
passed`, deterministic ×3.

**Lesson (道法自然):** 大制無割 — a button is one thing though many words paint it. F115
found a word, F116 found it on any line; F117 sees the whole label as the control
it is, and presses it where its middle truly lies.

---

## F118 — the screen is a process in time: wait for a word to appear

**Friction.** Every locator F115→F117 reads a *single frame* — one `capture_rgb`,
one search. But a GUI unfolds in time: a result paints after a click, a page
settles after a load. So the one capture an agent takes the instant it acts
catches the screen *before* the word it waits for, and `locate_phrase` honestly
returns `None` for text a heartbeat from existing. Acting and observing were one
tick apart — the agent that clicks and reads in the same breath reads the *old*
screen. Reading climbed glyph→word→line→block→phrase in *space*; it had not yet
moved in *time*.

**Mechanism.** Finding is a snapshot; appearing is a transition. To see a
transition you must look more than once. Re-capture on a fixed cadence and run the
spatial locator each time; the first frame that holds the target is the moment it
appeared, and its bbox is already in the click frame.

**Primitive.** `wait_for_phrase(bbox, atlas, target, timeout, interval)` loops:
`capture_rgb` → `locate_phrase` over `bbox`, returning the hit the moment the
target first appears, or `None` at the `timeout` deadline (never blocking forever,
never guessing a place). It takes a screen *region* and recaptures itself rather
than a fixed `rgb`, because the pixels it waits on do not yet exist when it is
called. So `click(button); box = wait_for_phrase(field, atlas, "OK"); click(box…)`
reads the screen as it *becomes*, not as it *was*.

**Live (R82):** a blue `GO` button that paints the red result `OK` ~700 ms after
it is pressed. Clicking `GO` then capturing at once misses the result
(`locate_phrase` → `None`, the friction); `wait_for_phrase("OK")` returns its bbox
the moment it appears, `None` for a word that never comes (short deadline). The
loop closes through time: clicking the awaited `OK` reports `HIT:OK`. `586/586
checks passed`, deterministic ×3.

**Lesson (道法自然):** 動其機，萬化安 — the eye that only blinks once sees a still world.
F118 lets the eye stay open, and the agent waits for what is coming instead of
acting on what has passed; sight at last moves in time as it moved in space.

---

## F119 — the window is not the world: roll the wheel to see past the fold

**Friction.** The agent could move and click anywhere it could *see* — but it
could only ever see one screenful. `capture_rgb` is the viewport, and every reader
and locator F103→F118 searches within it. Content past the fold — the rest of a
page, a list below the window, a result rendered lower than the screen is tall —
simply was not in the pixels, so `locate_phrase` returned `None` for text that
*exists* but is scrolled away, and nothing in the toolkit could bring it into
view. Sight had climbed in space (glyph→block) and in time (F118), but stayed
boxed inside the window frame; a button one line below the fold was as unreachable
as one on another planet.

**Mechanism.** The surface is larger than the window; to see the rest, move the
window over it. The OS already carries that motion as the mouse wheel — a
`WHEEL_DELTA` event per notch through `SendInput`, the same trusted channel
`click`/`type_unicode` use — and after it, a fresh `capture_rgb` simply holds
different pixels the unchanged readers can work on.

**Primitive.** `scroll(dy, dx, x, y)` rolls the wheel a notch at a time:
`dy < 0` toward the user (page moves up, revealing content *below*), `dy > 0` away
(revealing *above*), `dx` likewise horizontal, each notch one `MOUSEEVENTF_WHEEL`/
`HWHEEL` event sent over `(x, y)` when given so it lands on the pane under the
cursor. No reader changes — only which screenful they read.

**Live (R83):** a 3000 px page whose only button, a blue `GO` canvas, sits far
below the fold. At rest `scrollY == 0` and `locate_phrase("GO")` is `None` (the
friction — it exists but is off-screen). `scroll(dy=-40)` rolls the page down
(`scrollY` grows past 500), a fresh capture now holds `GO`, and clicking it reports
`HIT:GO` — reach past the fold. `scroll(dy=40)` rolls back to the top. `594/594
checks passed`, deterministic ×3.

**Lesson (道法自然):** 其出也彌遠 — what the window cannot hold, motion can reach. F119
unboxes sight from the viewport: the readers were never the limit, only the one
frame they were given; let the frame move and the whole surface comes within view.

---

## F120 — walk the surface to the text: scroll and search as one

**Friction.** F119 can reach past the fold, but only by a *guessed* amount: the
caller must know how many notches the target lies below, and a fixed roll over- or
under-shoots — too few and the word never enters the frame, too many and it flies
past the top and out again (the F119 probe lost `GO` at the first overshoot, found
it only when the page clamped at its bottom). And `locate_phrase` still reads only
the one screenful it is handed. To *find* text on a surface taller than the window,
scrolling and searching cannot be two separate acts.

**Mechanism.** Make them one loop: read the frame for the target; if absent, roll
one step and read again, walking the surface a screenful at a time. The bound is a
step count, *not* a "pixels stopped changing" bottom test — because a long blank
stretch scrolls past while the captured screen does not change a single byte (the
scrollbar thumb does not register in a GDI grab; measured: `scrollY` 0→600→1200→
1800 with zero sampled pixel diff). A pixel-only reader has no truthful bottom
signal, so stopping on a still frame would abandon a target lying just past the
blank. Honesty is to promise only a bounded walk.

**Primitive.** `scroll_to_phrase(bbox, atlas, target, step, max_steps)` loops
`locate_phrase` → `scroll(dy=-step)` up to `max_steps` rolls, returning the
target's bbox the step it comes into view, or `None` once the walk is exhausted.
So `box = scroll_to_phrase(field, atlas, "SUBMIT")` brings a button anywhere down
a long page into view and hands back where to press it — the window walking itself
to the text instead of the caller counting notches.

**Live (R84):** a 3000 px page whose blue `GO` sits at 2600. A single fixed
`scroll(dy=-6)` undershoots — `GO` still off-screen (the friction).
`scroll_to_phrase("GO")` walks down step by step until `GO` enters the frame
(`scrollY` 2355) and returns its bbox; clicking it reports `HIT:GO` — a control
found by *text alone*, anywhere down the page. An absent word walks to the end and
returns `None`. `602/602 checks passed`, deterministic ×3 (one earlier R18/F054
moving-target flake cleared on rerun).

**Lesson (道法自然):** 馳騁於天下 — the eye need not leap the whole gulf at once; step by
step the window crosses a surface larger than itself, and what cannot be reached
in one bound is reached by walking. F119 gave motion; F120 gives the motion a
purpose — go until the text is seen, and no further claim than that.

---

## F121 — `drag`: the held stroke (R85)

**Friction.** The OS-input channel — the one that works on bare pixels, with no
DOM and no CDP, the channel that lets agentctl operate *any* window — could press
a point (`click`) and roll the wheel (`scroll`), but it could not *hold and carry*.
A slider thumb, a canvas signature, a text selection, a list reorder: all of these
need the button held down while the cursor travels, and none of them yield to a
press-and-release at a single point. Every drag round in the suite so far (R44
reorder, R52 splitter, R54 pan, the touch rounds) drove **CDP's** `b.drag` —
synthetic events dispatched *into* the page. The pure OS channel, which is blind
to the DOM and answers only to what it sees, had no stroke at all. A handle painted
on a `<canvas>` could be *seen* and *pressed* but never *moved*.

**Mechanism.** Press at the start, then glide: button down, many small `move`s
interpolated along the line, button up at the end. The interpolation is the whole
point — a single jump from start to end reads to a `mousemove`-driven handler as a
teleport, and most drag listeners ignore it; the path must be continuous for the
page to follow. `steps` controls how finely the line is walked, `hold` gives the
press and release a beat to register.

**Primitive.** `drag(x0, y0, x1, y1, steps=24, hold=0.05, right=False)` —
button-down at `(x0,y0)`, interpolated travel to `(x1,y1)`, button-up; `right=True`
strokes with the secondary button. So `drag(*handle, *zone)` carries a canvas
handle across to a dropzone, and the page sees the whole journey, not just the ends.

**Live (R85):** a magenta handle and a cyan dropzone painted on a `<canvas>` —
no DOM node marks either, so only the pixel channel reaches them. A plain
`click` on the handle presses it but carries it nowhere (`window.__moves==0`,
title stays `DROP-MISS`) — the friction. `drag` from the handle to the zone is a
continuous stroke (`__moves` ≈ 20, not a teleport); the handle lands inside the
zone, the title flips to `DROP-OK`, and the change is confirmed *back through the
pixels* (the zone is now green). The handle, a solid 90×90 block, is located by
its exact centroid; the zone sits a known canvas delta away, so the endpoint is
anchored on the clean handle rather than a hollow colour's drifting centroid. A
right-button drag leaves the left-only handler untriggered. `614/614 checks
passed`, R85 deterministic ×3 (the suite's pre-existing R9 omnibox OS-paste round
flaked once on focus timing and cleared on rerun; unrelated to `drag`).

**Lesson (道法自然):** 天下之至柔，馳騁於天下之致堅 — the softest thing, a held
and gliding touch, runs through the hardest. `click` only taps; the world of
sliders, strokes, and selections opens only to a hand that presses and *stays*
while it moves. To carry, do not leap — hold, and travel.

---

## F122 — `double_click`: the paired press (R86)

**Friction.** `click` fires exactly one click. A control bound to `dblclick` —
a list row that opens only on double-click, double-click-to-select-a-word, a
handle that resets on a double-tap — never answers a single press, and one
`click()` call can never reach it. The OS-input channel could tap, hold-and-drag
(F121), and roll, but it could not pair two presses into the one gesture the page
is waiting for.

**Mechanism.** Two presses at the *same* point, close enough in time that the
window pairs them into a `dblclick`. Two requirements, both real: the presses
must land on the same pixel (so the second `click` does not move), and they must
fall inside the system double-click interval. `double_click` presses, waits a
`gap` well under that interval, presses again — so the page sees `click, click,
dblclick`, not two strangers.

**Primitive.** `double_click(x, y, right=False, gap=0.05)` — move once, then two
button cycles `gap` apart at that fixed point. Built on `click`, not beside it:
the pair *is* two clicks, only timed and co-located.

**Live (R86):** a blue pad that counts single clicks and opens (turns green,
title `OPENED`) only on `dblclick`. A single `click` leaves it shut
(`__dbl==0`) while still registering as one click — the friction. `double_click`
opens it: exactly one `dblclick` fires, the title flips to `OPENED`, and the
change is read *back through the pixels* (the pad is now green). A `double_click`
out on the empty page background opens nothing. `622/622 checks passed`,
deterministic ×3.

**Honest note.** The probe first assumed a *slow* pair of clicks would stay two
singles — that the timing alone draws the line. It does not, reliably: the
measured double-click window here is generous and jittery (a 0.8 s gap paired
in-suite though it did not in isolation), so "slow clicks never pair" is not a
deterministic truth and was cut from the round. The honest, repeatable line is
the one kept: *one `click()` call cannot open a `dblclick` control; `double_click`
can.* An early `double_click(20, 20)` also destabilised the shared Chrome — a
screen corner is the window frame, not the page — so the off-target check now
aims at empty page background inside the viewport.

**Lesson (道法自然):** 將欲拾之，必故張之 — some doors open only to the second
knock. To act once is to be heard once; the gesture the page waits for is not a
louder press but a *paired* one, two taps the window can bind into a single
intent.

---

## F123 — `middle_click`: the third button (R87)

**Friction.** `click` encoded only two flags — left and right. The wheel button
did not exist in the channel at all. Yet middle-click is its own verb on the web:
`button===1`, the `auxclick` event, open-link-in-a-new-background-tab,
paste-on-X11, autoscroll. A left or right click can never stand in for it, and
no composition of the two produces it — the down/up flags for the middle button
were simply absent.

**Mechanism.** Add the two missing SendInput flags (`MIDDLEDOWN`/`MIDDLEUP`) and
send one pair at the point, exactly as `click` does for its buttons. Nothing
clever — the gap was that a name had never been written down.

**Primitive.** `middle_click(x, y)` — move once, then one middle button cycle.

**Live (R87):** an amber pad counts left clicks and middle (`auxclick`,
`button===1`) separately, opening (green, title `MIDDLE`) only on a true middle
click. A left `click` leaves it shut (`__mid==0`) while counting as one left
click — the friction. `middle_click` opens it: exactly one middle click lands,
no phantom left click is added, the title flips to `MIDDLE`, and the change is
read back through the pixels (the pad is green). A `middle_click` on empty page
background opens nothing. `633/633 checks passed`, deterministic ×3.

**Lesson (道法自然):** 三生萬物 — two were named, the third was not, and a whole
family of gestures stayed shut. To complete a thing is sometimes only to write
down the name that was always missing; the world it opens was waiting all along.

---

## F124 — `mod_click`: the held modifier (R88)

**Friction.** A plain `click` *replaces* a selection — click item B and item A
lets go. To extend a selection you must hold a key *while* the mouse goes down:
Ctrl-click adds one, Shift-click takes a contiguous range. The channel had keys
(`key_down`/`key_up`) and had the click, but never one *inside* the other — and
order is the whole point. Pressing Ctrl, releasing it, then clicking is three
separate events; the page reads `e.ctrlKey === false` on a click whose modifier
was already let go. Multi-select and range-select were simply unreachable.

**Mechanism.** Hold each modifier VK down, click, then release them in reverse —
so the modifier is down across the entire button cycle and the click event
carries `ctrlKey`/`shiftKey`. The same nesting `chord` does for keys, now wrapped
around a mouse press.

**Primitive.** `mod_click(x, y, *mods, right=False)` — `mods` are VK codes
(`VK_CONTROL`, `VK_SHIFT`, …); built on `key_down`, `click`, `key_up`.

**Live (R88):** four items located by four distinct colours, each showing a green
inner block when selected (so the count is also pixels). A plain click selects
one; a second plain click *replaces* it (the friction). `mod_click(.., VK_CONTROL)`
extends to two without dropping; `mod_click(.., VK_SHIFT)` fills the contiguous
range to the anchor (all four) — confirmed by four green markers in the pixels.
A plain click afterward collapses back to one, proving the modifiers were
released, not left stuck down. `641/641 checks passed`, deterministic ×3.

**Lesson (道法自然):** 將欲翕之，必固張之 — to gather many you must first hold
open. The difference between replacing and extending is not a different click but
a held breath around the same one; what the press means depends on what is held
while it lands.

---

## F125 — `triple_click`: the third rung (R89)

**Friction.** The click-multiplicity ladder has three rungs: one click places
the caret, two (`double_click`, F122) select the *word* under it, three select
the whole *line or paragraph*. `double_click` reaches the second rung and stops
there — to grab a full line for replacement (a common edit), the third press was
unreachable. The channel could tap and pair, but never count to three.

**Mechanism.** Three presses at the same point, each `gap` apart, all inside the
OS double-click window, so the page counts up to `detail===3`. The same shape as
`double_click` with one more click — the ladder built one rung higher.

**Primitive.** `triple_click(x, y, gap=0.05)`.

**Live (R89):** a paragraph of words on a coloured band. A single click leaves the
selection empty (caret only); `double_click` on a word grabs exactly one token
(no internal space, a proper substring of the line); `triple_click` at the same
point takes the entire paragraph — strictly more than the word. `647/647 checks
passed`, deterministic ×3.

**Honest note.** The rungs only stay distinct if the gestures do not chain: a
`click` followed immediately by a `double_click` at the *same* point is itself
three presses in the window — a triple — and selected the whole line. So each
rung is tested on a fresh page load, which is also the honest reading of the
mechanism: multiplicity is counted from the *last reset*, not per call.

**Lesson (道法自然):** 一生二，二生三，三生萬物 — each rung is the one below it
plus a single further step, and only the third opens the whole. To reach a thing
you cannot leap to, climb the rung you already stand on once more.

---

## F126 — `press_hold`: the sustained press (R90)

**Friction.** Every press in the toolkit was either *instant* (`click` —
mouse-down and mouse-up in the same breath) or *moving* (`drag` — held, but
travelling). Nothing could press a point and simply *stay* there. A
hold-to-confirm button, an autorepeat stepper, a long-press that arms a timer on
`mousedown` — all answer only a still, sustained press, and a `click` releases
before any such timer can fire. Duration in one place was the one quantity the
channel could not express.

**Mechanism.** Button down at the point, `time.sleep(duration)` with no movement,
button up. Between the down and the up the cursor does not stir, so a timer armed
on `mousedown` is allowed to reach its threshold before `mouseup`/`mouseleave`
would cancel it.

**Primitive.** `press_hold(x, y, duration=0.8, right=False)`.

**Live (R90):** a button arms a 500 ms timer on `mousedown`; releasing earlier
cancels it. An instant `click` never confirms (`__conf==0`) — the friction.
`press_hold(.., 0.8)` holds past the threshold: it confirms exactly once, title →
`CONFIRMED`, and the change is read back through the pixels (button green). A
`press_hold(.., 0.15)` below the threshold still does not confirm — the duration
is doing the work, not the press alone. `654/654 checks passed`, deterministic ×3.

**Lesson (道法自然):** 致虛極，守靜篤 — some doors open not to force but to
stillness held. To act is not always to strike and withdraw; sometimes the whole
gesture is to press, and then to *remain*, until what waits on duration arrives.

---

## F127 — `key_hold`: the sustained key (R91)

**Friction.** `tap` presses and releases a key in the same breath — the key is
down for essentially zero time. But many controls integrate over *how long* a
key is held: a game that advances a character each frame while a direction key is
down, a hold-to-charge action, a modifier kept down across other events. The
keyboard channel could tap and chord, but could not *dwell* on a key. `press_hold`
(F126) gave the mouse a sustained press; the keyboard had no twin.

**Mechanism.** `key_down(vk)`, `time.sleep(duration)`, `key_up(vk)` — the exact
shape of `press_hold`, in the keyboard channel. The key stays logically down for
the whole `duration`, so any flag set on `keydown` remains set until release.

**Primitive.** `key_hold(vk, duration=0.8)`.

**Live (R91):** a page sets `held=true` on `keydown(ArrowRight)`, clears it on
`keyup`, and a 50 ms interval advances `__pos` while held. An instant `tap`
accrues nothing (`__pos==0`) — the friction. `key_hold(VK_RIGHT, 0.8)` accrues
many steps (≥5) while the key is down; once released the integrator stops, and
the title mirrors the accrued position. `660/660 checks passed`, deterministic ×3.

**Honest note.** SendInput sends *one* `keydown`, not an OS autorepeat stream — a
held synthetic key does not emit repeated `keydown` events. So `key_hold` is
honest only for controls that integrate over the *held state* (a flag set on
`keydown`), which is how game-style movement and hold-to-charge actually work; it
is not a substitute for OS keyboard autorepeat (that would need repeated taps).

**Lesson (道法自然):** 大音希聲 — the longest note is not struck harder but
sounded longer. What a quantity *is* (a key pressed) differs from how long it is
*held*; some answers come only to duration, on either hand.

---

## F128 — `mod_scroll`: the modifier on the wheel (R92)

**Friction.** A plain `scroll` always *scrolls* — the page or a pane moves. But
the same wheel under a held modifier means something else entirely: Ctrl+wheel
*zooms* a browser, a map, an image viewer, an editor's font; Shift+wheel scrolls
sideways. The page reads `e.ctrlKey` on each `wheel` event, so the modifier must
be down *while* the notch fires. The channel could scroll, and could hold keys,
but had no way to hold a key across the wheel — so zoom-by-wheel was unreachable.

**Mechanism.** Hold each `mods` VK down, scroll (the same wheel as `scroll`,
reusing its `x`/`y` placement so it lands on the element under the cursor),
release the modifiers in reverse — every notch carries the modifier. It is to
`scroll` what `mod_click` (F124) is to `click`.

**Primitive.** `mod_scroll(dy, dx, *mods, x, y, pause)`.

**Live (R92):** a page treats Ctrl+wheel as zoom (adjusts `__zoom`,
`preventDefault`) and a plain wheel as ordinary scroll. A plain `scroll` never
reaches the zoom path (`__zoom==0`) — the friction. `mod_scroll(3, 0,
VK_CONTROL)` drives `__zoom` to 3 with *no* notch leaking to the plain-scroll
path, the title reads `Z3`, and a plain scroll afterward leaves the zoom
untouched (the modifier was released). `667/667 checks passed`, deterministic ×3.

**Honest note.** Wheel notches coalesce when they fire too fast — a plain scroll
of three notches sometimes registered as two. So the test does not assert an
absolute plain-notch count; it asserts the *relative* invariant (mod_scroll adds
nothing to the plain path) and widens `pause` so the zoom notches stay distinct.

**Lesson (道法自然):** 同謂之玄 — the same motion, under a different holding,
becomes a different thing. The wheel did not change; what was held alongside it
did, and that was enough to turn scrolling into zooming.

---

## F129 — `mod_drag`: the modifier across the stroke (R93)

**Friction.** A plain `drag` moves a handle freely. But a held modifier changes
what the drag *means*: Shift constrains it to an axis (a straight horizontal or
vertical move), Ctrl/Alt turns a move into a copy, a modifier-drag extends a
selection. The handler reads `e.shiftKey` on every `mousemove` of the stroke, so
the modifier must be down across the *entire* drag — not merely tapped before it.
`mod_click` (F124) and `mod_scroll` (F128) held a modifier through a click and a
wheel; the drag had no such member, so a constrained or copy drag was unreachable.

**Mechanism.** Hold each `mods` VK down, run the same stroke as `drag`, release
the modifiers in reverse — every `mousemove` of the stroke carries the modifier.
The third member of the modifier-held family (`mod_click` / `mod_scroll` /
`mod_drag`).

**Primitive.** `mod_drag(x0, y0, x1, y1, *mods, steps, pause, hold, right)`.

**Live (R93):** a canvas drag where Shift constrains the handle to its starting Y.
The dropzone sits horizontally from the handle, but the endpoint passed to the
drag overshoots upward in Y — so a plain `drag` follows the diagonal and lands
above the zone (`DROP-MISS`, zero moves with the modifier): the friction. The
same endpoint under `mod_drag(.., VK_SHIFT)` locks Y and travels purely
horizontally into the zone (`DROP-OK`), with Shift held on *every* move of the
stroke (`shift == moves`), not merely tapped. `674/674 checks passed`,
deterministic ×3.

**Honest note.** The mousemove count drifts by one between runs (19 vs 20), so
the test does not assert an absolute count; it asserts the *relative* invariant
(`shift == moves`, every move carried the modifier) and the visible outcome
(`DROP-OK` only under Shift).

**Lesson (道法自然):** 直而不肆 — to go straight is not to force; the hand that
would draw a true line does not fight its own tremor but *binds* one axis and
lets the other run free. The constraint is what makes the straightness effortless.

---

## F130 — `glide`: the button-less path (R94)

**Friction.** `move` jumps the cursor straight to a point — one `mousemove` at
the destination, nothing in between — and `drag` glides but with a button
*down*. Neither can trace a button-less path. Yet much of a GUI answers only to
the cursor's *journey*, not its arrival: a hover trail, a parallax that tracks
the pointer, a slider that scrubs on bare `mousemove`, and above all a nested
menu that keeps its submenu open only while the cursor crosses from parent into
child — teleport onto the child and the parent's hover lapses, so the submenu
never opens.

**Mechanism.** `move` to the start, then many small `move`s along the line with
no button — every element under the path sees the cursor pass through. It is
`drag` without the press: the hover twin of the held stroke.

**Primitive.** `glide(x0, y0, x1, y1, steps=24, pause=0.01)`.

**Live (R94):** a path-dependent hover menu — the target opens (`REACHED`) only
if the cursor's path crossed the parent gate first. A teleport (`move`) jumps
straight onto the target, crossing no gate (`__gate==0`, only two moves), so the
menu stays shut (`SKIPPED`) — the friction. A `glide` from left of the gate to
the target traces a continuous stream (40 steps), crosses the gate exactly once
(`__gate==1`), and the menu opens (`REACHED`). `681/681 checks passed`,
deterministic ×3.

**Honest note.** The exact `mousemove` count drifts run to run, so the test does
not assert an absolute count; it asserts the *relative* shape (glide emits a
stream, the teleport ≤3) plus the path-crossing signal (`__gate`) and the visible
menu state. The fixture leaves a gap between gate and target, so it keys on
*whether the path entered the gate at all*, not on the cursor still being inside
it at arrival — the honest signal for "the journey passed through here."

**Lesson (道法自然):** 千里之行，始於足下 — the destination is not the road. A
leap arrives at the same point a walk does, but only the walk has *been* to every
place between; some doors are opened only by what the path touched on the way.

---

## F131 — `mod_taps`: one modifier across a sequence (R95)

**Friction.** `chord` presses a modifier with one key and releases both in the
same breath — perfect for a single combo. But some input is a *run* under one
sustained modifier: Shift held while several Arrow taps extend a selection one
cell at a time, Alt held across a digit sequence to compose a code, a modifier
held while several keys are struck and the result committed only on the
modifier's *keyup*. A loop of `chord` releases the modifier between every key, so
each keystroke looks like its own combo and the run never coheres. `mod_click` /
`mod_scroll` / `mod_drag` held a modifier through one pointer action; the
keyboard had no member that held one across a *sequence* of taps.

**Mechanism.** Hold each `mods` VK down, tap every key in `keys` in order with
the modifier still down, then release the modifiers in reverse — one continuous
hold across the sequence. To `chord` what a held stroke is to a single press.

**Primitive.** `mod_taps(*mods, keys=(), pause=0.03)`.

**Live (R95):** a page appends each letter typed while Shift is held to a buffer
and commits it (to the title) on Shift's keyup. A loop of `chord(Shift, k)` over
A,B,C releases Shift after each letter, so it commits three times (`__commits==3`)
and only the last letter survives (`WORD:C`) — the friction. `mod_taps(Shift,
keys=(A,B,C))` holds Shift across the whole run, so it commits once
(`__commits==1`) and the sequence coheres into one word (`WORD:ABC`).
`687/687 checks passed`, deterministic ×3.

**Honest note.** SendInput sets the real keyboard state, so the letter keydowns
genuinely report `shiftKey=true` while the VK is held — the grouping is a true
OS-level hold, not a synthesized flag. The fixture is keyup-committed precisely
so that the *number of modifier releases* is observable; that count (3 vs 1) is
the unforgeable evidence that the hold spanned the run.

**Lesson (道法自然):** 慎終如始，則無敗事 — to hold from first stroke to last
without loosening is what lets many acts become one; the grip that never lapses
mid-way is the whole of the deed.

---

## F132 — `wait_until_stable`: wait for motion to end (R96)

**Friction.** `wait_for_phrase` waits for *text* to appear, but much of a GUI
moves without ever spelling anything: a panel slides in, a spinner turns, a list
reflows, a fade settles. Act mid-transition and the target is still in flight —
the click lands where the thing *was*, not where it comes to rest. The read side
could wait for a *word* but had nothing that waited for *stillness*.

**Mechanism.** Re-capture the ``bbox`` region every ``interval`` and compare it
byte-for-byte to the previous capture; once ``settle`` consecutive captures are
identical, the region is at rest. Returns ``{stable, changes, captures,
elapsed}`` — ``changes`` proves the region really moved before it settled, so the
caller can both wait *and* confirm something happened. Reuses ``crop_rgb`` (the
existing region cutter), so no new capture machinery.

**Primitive.** `wait_until_stable(bbox, settle=3, interval=0.08, timeout=6.0)`.

**Live (R96):** a red block slides across a band for ~1.2s then rests. Two
captures a beat apart just after the trigger differ (a single snapshot would read
a position still in flight) and the title is not yet ``REST`` — the friction.
`wait_until_stable` keeps sampling until the band stops, reports ``stable=True``
with ``changes>=3`` (real motion observed), by which point ``REST`` is set; a
fresh re-capture of the settled region then matches. `694/694 checks passed`,
deterministic ×3.

**Honest note.** Stability is judged by exact byte-equality of consecutive
region captures — robust for a discrete settle (an element coming to a fixed
rest), but a region with perpetual micro-motion (a blinking caret, a looping
spinner) would never satisfy it, so `timeout` is a real bound and `stable=False`
is a legitimate outcome, not only an error. The visual twin of `wait_for_phrase`
honestly carries the same "bounded wait" contract.

**Lesson (道法自然):** 重為輕根，靜為躁君 — stillness is the ruler of motion; to
act well you first wait for the restless to come to rest, then move once, surely.

---

## F133 — `wait_for_change`: wait for the onset of change (R97)

**Friction.** `wait_until_stable` waits for motion to *end*; `wait_for_phrase`
waits for a *known word*. But the most common post-action wait is neither: after
a click you often need to know merely that *something happened* — a button lit
up, a badge appeared, a spinner began, a row got selected — without knowing the
eventual text or colour, and before any of it has settled. Reading immediately
races the change and sees the old frame, so the agent concludes nothing happened
and acts twice (double-submits, re-clicks).

**Mechanism.** Capture (or accept) a ``baseline`` snapshot of the region, then
re-capture every ``interval`` until a capture differs from it. Returns
``{changed, captures, elapsed}``. The idiom pairs with F132:
``baseline = crop; act(); wait_for_change(bbox, baseline)`` then
``wait_until_stable`` — catch the change beginning, then its coming to rest.

**Primitive.** `wait_for_change(bbox, baseline=None, interval=0.05, timeout=5.0)`.

**Live (R97):** a gray box turns green 600ms after the trigger. An immediate read
still equals the baseline and the title has not flipped — the friction, an eager
read would miss it. `wait_for_change` samples until the box first differs
(``changed=True``, ``elapsed>=0.3s`` so it genuinely waited for the delayed onset,
``captures>=2``); afterwards the region differs from the baseline and ``ON`` is
set. `702/702 checks passed`, deterministic ×3.

**Honest note.** Onset is exact byte-inequality against the baseline, so it fires
on the *first* differing pixel — sensitive by design (it must not miss a subtle
change), which means a region that also carries incidental motion (a caret in the
same bbox) would trip it early. Scope the bbox to the element you expect to
change. It is the deliberate mirror of `wait_until_stable`: one fires on the first
difference, the other only after many identities.

**Lesson (道法自然):** 其安易持，其未兆易謀 — what has not yet stirred is easy to
plan for; watch for the first sign of motion and you are never caught by acting
into a frame that has already moved on.

---

## F134 — `region_diff`: the measured form of equality (R98)

**Friction.** `wait_until_stable` and `wait_for_change` (F132/F133) both judge
sameness by exact byte-equality — and that is brittle. A real desktop jitters at
the bottom bit: subpixel text rendering, a one-level antialiasing wobble, a
gradient's dithering. A shift of ``+2`` per channel is invisible to the eye yet
makes an exact compare report *every* pixel as changed, so "did it change?" fires
on noise and "has it settled?" never settles. The two waits assumed an equality
they had no tolerant way to measure.

**Mechanism.** Compare two equal-size RGB patches pixel-by-pixel and count those
whose per-channel difference exceeds ``tol``, returning ``{pixels, total,
frac}``. ``tol=0`` *is* the exact compare; raising ``tol`` looks past
sensor/render noise and sees only real change. A pure function over two patches —
no capture, no timing — so it is deterministic and composes under the waits.

**Primitive.** `region_diff(a, b, tol=0)`.

**Live (R98):** a ``#808080`` box. An unchanged re-capture has zero exact
difference (the capture itself is clean). Then ``#808080 → #828282`` — a +2/channel
shift, invisible noise: exact compare flags >50% of the box (it over-fires,
``frac>0.5`` at ``tol=0``) while ``tol=8`` flags *zero* pixels. A real change
``→ #22cc44`` is still caught under the same ``tol=8`` (``frac>0.5``). `707/707
checks passed`, deterministic ×3.

**Honest note.** The measured truth here is stark: a humanly-invisible +2 shift
makes exact equality declare the *entire* region changed. That is the precise
reason F132/F133's exact compares are honest only in a noise-free fixture;
`region_diff(tol>0)` is the form they would take against a real, dithering
desktop. Kept standalone (not retrofitted into the merged waits) to avoid
changing their tested behaviour — but it is the foundation they now stand on.

**Lesson (道法自然):** 明道若昧 — the clear way looks dim. Exact sight that
counts every flicker as change sees less truly than a softened gaze that takes in
only what matters; precision past the point of meaning is its own blindness.

---

## F135 — `locate_change`: find *where* the screen changed (R99)

**Friction.** `find_color` needs the colour; `locate_phrase` needs the words —
both require knowing the target in advance. But after an action the thing that
appears is often unknown in both: a toast slides in at an unpredictable corner, a
badge lights up somewhere on a toolbar, a newly-selected row highlights. You know
*something* arrived, but not its colour, text, or position — so neither locator
can aim at it.

**Mechanism.** Diff ``before`` against ``after`` pixel-by-pixel (per-channel
``tol``, ignoring render noise the way `region_diff` does) and return the
centroid and bounding box of the changed pixels — ``{x, y, count, bbox}`` in
screen coordinates, exactly what `click` consumes — or ``None`` past
``min_count``. The geometry sibling of `region_diff`: one counts, the other
locates.

**Primitive.** `locate_change(before, after, size, tol=12, min_count=30)`.

**Live (R99):** a toast appears at a spot the test never names. Identical captures
localise to ``None`` (no false target). After the toast shows, `locate_change`
returns a region of ``count>5000`` with real bbox extent; cross-checked against
`find_color` of the toast's own colour, the diff centroid coincides within
``<=10px`` — proof it localised correctly *without being told* colour or
position. `713/713 checks passed`, deterministic ×3.

**Honest note.** It localises *all* change at once into a single bbox+centroid:
if two unrelated things change in different corners, the centroid lands in the
empty middle (the `find_color` → `find_color_blobs` lesson, F052, recurs here).
The honest scope is "one thing arrived"; segmenting multiple simultaneous changes
into separate targets would be its own round (a `locate_change_blobs`), built only
when a real two-change failure is reproduced.

**Lesson (道法自然):** 為之於未有，治之於未亂 — act on a thing while it is still
nameless. To answer where the world stirred you need not its name, only to have
watched the place before and after; the difference itself points the way.

---

## F136 — `locate_change_blobs`: separate simultaneous changes (R100)

**Friction.** `locate_change` (F135) collapses every changed pixel into one
centroid — and its own honest note named the trap: when two unrelated things
change at once (a toast in one corner, a badge in another), the mean lands in the
empty gap between them and clicks nothing. This is the exact F052 lesson
(`find_color` → `find_color_blobs`) recurring, now on change rather than on a
static colour.

**Mechanism.** Label the changed pixels (per-channel ``tol``, as `locate_change`)
into connected components by union-find — 4-connectivity over only the changed
pixels, so cost scales with the change's area, not the screen — and return one
``{x, y, count, bbox}`` per region in screen coordinates, sorted by pixel count.
Each centroid is a real, clickable target; regions under ``min_count`` are
dropped.

**Primitive.** `locate_change_blobs(before, after, size, tol=12, min_count=30)`.

**Live (R100):** two toasts appear in different corners at once. `locate_change`'s
single centroid is stranded >150px (Manhattan) from *both* toasts — on neither.
`locate_change_blobs` returns exactly two regions; matched order-independently,
one is centred on the red toast and one on the blue (each within ``<=20px`` of
that toast's own colour centroid), and the two are >150px apart. `720/720 checks
passed`, deterministic ×3.

**Honest note.** Connectivity is 4-neighbour over thresholded pixels: two changes
that visually touch (overlapping toasts, a single reflow spanning a gap of <1px)
merge into one blob, and a single change broken by an antialiased seam could split
into two. The fixture keeps the toasts well separated so the segmentation is
unambiguous; a real desktop with adjacent changes would need a dilation/merge
pass, which is its own round if that failure is ever reproduced. Counts are equal
(both 130×80), so the sort order between them is a tie — the test matches by
nearest rather than assuming order, which is why it is deterministic.

**Lesson (道法自然):** 大制不割 — the great tailoring makes no needless cut, yet
what is truly two must be kept two; to fold two answers into one mean is to lose
both. Divide only where there is a real seam, but there, divide.

---

## F137 — `sample_color`: read the colour at a place (R101)

**Friction.** `find_color` maps *colour → place*: it forces you to name the
colour up front and only confirms presence. But the colour is often the very
unknown — a status surface is green or red, a toggle's fill tells its state — and
you cannot search for the answer you are trying to read. To guess a colour and
`find_color` each candidate is backwards: blind iteration to learn one fact.

**Mechanism.** Crop ``bbox`` and average it, returning ``{r, g, b, count}`` — the
colour that is actually *there*, which the caller classifies or compares. The
exact dual of `find_color`: one maps colour→place, this maps place→colour.

**Primitive.** `sample_color(bbox, rgb=None, size=None)`.

**Live (R101):** the whole page is the status surface (so the screen centre is
solid fill regardless of DPI/scroll). `sample_color` reads the green state
(g dominant by >80), then after a flip reads the red state (r dominant by >80),
and the two reads are >150 apart in colour. The friction made concrete: a stale
guess of "green" run through `find_color` on the same patch finds *nothing* after
the flip — `find_color` is blind to the state, while `sample_color` just told it.
`725/725 checks passed`, deterministic ×3.

**Honest note.** It returns the *mean*, which blurs a multicolour region into mud
(text on a button averages toward grey); the honest use is a tight bbox on solid
fill, or as a building block under a future dominant-colour/`palette` read. Mean
is also vulnerable to a single bright outlier — but for the solid indicators it is
meant for, it is exact (it read ``#1faa3c`` and ``#cc2222`` to the digit).

**Lesson (道法自然):** 不窺於牖，以知天道 — you need not search the whole sky to
know its colour; look once at the patch before you. To ask *where is green* when
the question is *what is here* is to walk far to learn what lay underfoot.

---

## F138 — `cursor_pos`: read where the pointer is (R102)

**Friction.** The whole pointer family *writes* position — `move`, `drag`,
`glide`, every click that takes ``(x, y)`` — but nothing ever *read* it back. That
asymmetry bites three ways: (1) `move` sends *absolute* coordinates rescaled to
the 0–65535 virtual-desktop range, so on a DPI-scaled or multi-monitor desktop the
landing pixel can differ from what was asked, with no way to confirm; (2) a
relative nudge ("5px right of wherever I am" for a slider/resize handle) is
impossible without first knowing the current point; (3) polite flows that move the
cursor aside then restore it had nothing to restore *to*.

**Mechanism.** Call ``GetCursorPos`` and return ``(x, y)`` in screen pixels — the
read-side dual of `move`.

**Primitive.** `cursor_pos()`.

**Live (R102):** a commanded `move` to screen centre is confirmed landed within
``<=2px``; a nudge computed *from* the read (``base.x + 40``) moves exactly 40px
right (impossible without reading first); and a third move to a distinct point is
tracked (not a stale constant). `728/728 checks passed`, deterministic ×3.

**Honest note.** It returns the *system* cursor in *physical* screen pixels, which
on a DPI-scaled desktop may not equal the logical coordinates `move` was given —
that is exactly the gap it exists to expose, not hide. On this VM the rescale is
1:1 so the read is exact; the ``<=2px`` tolerance is there only for the
65535-range rounding, and is honest about that rounding rather than asserting a
false zero.

**Lesson (道法自然):** 知人者智，自知者明 — to know others is wit; to know
oneself is clarity. A hand that can only act and never feel where it is moves
blind; the loop closes when the mover can also know its own place.

---

## F139 — `wait_for_color`: wait for a specific colour, not any motion (R103)

**Friction.** `wait_for_change` waits for *any* difference — and that is exactly
its weakness as a done-signal. A click usually starts a spinner, a skeleton
shimmer, a progress bar first: motion that is *not* the outcome. So the first
change fires on the busy state and the agent proceeds as if finished. The real
signal is often a particular colour arriving — a status dot going green, a field
turning red, a toggle filling. You cannot wait for that with `wait_for_change`
(the spinner trips it) nor with a bare `find_color` (it races the change and sees
the old frame).

**Mechanism.** Poll `find_color` every `interval` until at least `min_count`
pixels within `tol` of `target` exist, then return its `{x, y, count, bbox}`
(already a click target) plus `elapsed`; `None` if it never arrives by `timeout`.
It is to `find_color` what `wait_for_phrase` is to the text readers: the same
locate, made patient.

**Primitive.** `wait_for_color(target, tol=24, min_count=30, interval=0.05, timeout=5.0)`.

**Live (R103):** a trigger flips the surface gray (spinner) for 1000ms, then
green. On one trigger, the two waiters run in sequence: `wait_for_change` fires in
``<0.6s`` on the spinner while the green has *not* yet arrived (green pixels below
the 400 threshold); then `wait_for_color(green)` keeps waiting through the spinner
and returns only once green truly fills (754k px), with a centroid that lands a
real click target on the surface, and a strictly larger `elapsed` than the
any-change wait — meaning over motion. `734/734 checks passed`, deterministic ×3.

**Honest note.** It is whole-screen `find_color` under a clock, so it inherits
that cost and that blind spot: ~91 stray green pixels live in the browser chrome,
so a naive `min_count=1` would false-fire instantly. The `min_count` floor is what
makes it honest — it waits for a *meaningful amount* of the colour, not a single
matching pixel; the test sets 400 precisely because the stray count is ~91. For a
known region, pass a tighter search via the colour's expected `bbox` upstream.

**Lesson (道法自然):** 致虛極，守靜篤 — the spinner is the ten-thousand things
stirring; do not mistake their motion for the end. Hold to the stillness and wait
for the one true colour to return, then act. 躁勝寒，靜勝熱 — patience reads what
haste misreads.

---

## F140 — `wait_for_color_gone`: wait until a colour leaves (R104)

**Friction.** The disappearance twin of `wait_for_color`. The blocker is often a
coloured surface that must *go away* before you proceed: a loading veil tinted a
brand colour, an error banner red until the input is fixed, a modal backdrop.
`wait_until_stable` is the wrong tool — a *static* overlay is perfectly stable, so
it reports "ready" while the veil still covers everything; `wait_for_change` trips
on any unrelated motion underneath. What you mean is "wait until *this colour* is
essentially absent".

**Mechanism.** Poll `find_color` every `interval` until at most `max_count` pixels
within `tol` of `target` remain; return `{gone, count, elapsed}`. The same patient
polling as `wait_for_color`, watching the colour thin out rather than arrive.

**Primitive.** `wait_for_color_gone(target, tol=24, max_count=30, interval=0.05, timeout=5.0)`.

**Live (R104):** a full green veil covers the page (754k px), then clears to white
after 1000ms. On one trigger the two waiters run in sequence: `wait_until_stable`
falsely reports ready in ~0.1s *while the veil is still fully present* (green still
754k); then `wait_for_color_gone(green)` keeps waiting until green truly leaves
(drops to ~91 stray px, below the 400 floor) and reports `gone`, with a strictly
larger `elapsed` than the stability wait. `738/738 checks passed`, deterministic ×3.

**Honest note.** Symmetric to F139: it is whole-screen `find_color` under a clock,
and the `max_count` floor (not zero) is the honest part — ~91 green pixels live in
the browser chrome that never leave, so demanding *exactly* zero would hang
forever. It waits for the colour to become *negligible*, not absent; the test uses
400 because the irreducible stray count is ~91.

**Lesson (道法自然):** 萬物並作，吾以觀復 — the ten thousand things rise, and I
watch them return. A still veil is not absence; ready is not the cessation of
motion but the going-out of the thing itself. 知止所以不殆 — know what to wait for,
and you do not stumble.

---

## F141 — the OS floor becomes cross-platform (pluggable backends)

**Friction (the most fundamental yet).** Every primitive from F001 to F140 was
verified on Windows, because `osctl` *was* Windows: it opened with
`ctypes.WinDLL("user32")` and spoke `SendInput` + GDI `BitBlt` directly. On a
Linux desktop — the GUI this agent actually has to operate here — `osctl` could
not even be imported (`WinDLL` does not exist), so the whole 738-check suite, and
any future F-round, was unrunnable on this machine. The toolkit that exists to
let an AI operate *its* screen could not operate *this* screen. That is not a
missing feature; it is the ground being only half-laid.

**Why this is structural, not a port.** The platform-specific surface is tiny and
lives entirely at the bottom: grab the screen, move/press the mouse, press a key,
read/own the clipboard, read the cursor. Everything above it — locating colours,
segmenting glyphs, reading text, matching templates, the wait/settle family, the
gesture vocabulary (`click`/`drag`/`scroll`/`chord`/…) — is pure arithmetic over a
`(w, h, rgb)` buffer and a handful of leaf calls. It never cared which OS drew the
pixels. So the fix is not to fork the toolkit per OS; it is to name the floor as
an interface and let the platform supply it. 大制無割 — the great cut makes no cut.

**Mechanism.** `osctl` now selects a backend at import by `sys.platform`:
`_osbackend_win` (Win32 `SendInput`/GDI, extracted verbatim from the old osctl)
or `_osbackend_x11` (pure-ctypes X11 + the XTEST extension). Both export the exact
same leaf API — `screen_size`, `move`, `cursor_pos`, `mouse_button`, `mouse_wheel`,
`key_down`, `key_up`, `type_unicode`, `set_clipboard`, `get_clipboard`,
`capture_rgb` — and `(w, h, rgb)` is the identical byte layout on both. The rest of
`osctl.py` is rewritten once against those names and never touches a raw OS call.
No third-party deps on either ground (no python-xlib, no PIL): the X11 backend is
hand-bound ctypes, the PNG encoder stays `zlib`.

The three X11 corners that took real care (each a leaf the perception side relies
on being faithful):
- **Unicode typing without a layout.** Bind the target keysym to a spare keycode
  (`XChangeKeyboardMapping`), strike it via XTEST, then clear it — with `XSync` +
  small sleeps between chars so a stale binding can never autorepeat into
  `"hll333…"`. The Win side injects the same text via `KEYEVENTF_UNICODE`; both
  bypass the active layout, so CJK/emoji go in verbatim.
- **Clipboard as a selection owner.** X has no global buffer — the owner serves the
  text to each paster on demand. A daemon thread on its own display connection
  answers `SelectionRequest` for `CLIPBOARD`/`PRIMARY`, so Chrome's Ctrl+V receives
  it. (Bug paid down: the reply event is `XSelectionEvent` — 9 fields, *no* `owner`
  — not the 10-field request struct; reusing the wrong struct corrupted memory and
  hung CDP. Match the spec exactly.)
- **Capture.** `XGetImage` of the root, BGRA→RGB into the same tight `w*h*3` buffer
  the GDI grab produced, freeing the image each time so repeated grabs don't leak.

**Live (Linux, X11):** at the **maximised 1600-wide** window, `703–710/738`,
deterministic across runs. Every input/gesture/capture primitive and every
*single-ink* perception primitive (find_color, blobs, edges, templates,
read_glyph/read_text/read_words, detect_fg, the whole wait/settle/diff family,
cursor_pos) passes live against real Chrome. The X11 leaves were independently
proven first in `_x11proto.py` / `_x11e2e.py` (magenta-pixel click, Unicode type,
clipboard paste) before being folded in.

**Honest note (the ~28 deltas — harness geometry & cadence, none in the floor).**
The remaining failures are not OS-backend defects, and — this round corrects an
earlier guess that blamed FreeType anti-aliasing — they are overwhelmingly a
single, *demonstrated* cause: **the fixtures' `field_bbox` helper crops a fixed
fraction of the located white field, and on a window wider than the canvas that
fraction bites into the leftmost word.** The multi-colour OCR fixtures draw a
1100–1300 px canvas, but maximised the viewport is ~1600 wide, so the white field
that `find_color_blobs(white)` returns is the whole viewport — ~280 px wider than
the canvas. A symmetric `width/16` (or `/8`) inset then lands *inside* the
left-aligned first word. Proven with `_probe_region_clip.py` on scene B
(`RED`/`GRN`/`BLU`): maximised, the leading `R` is captured **30 px** wide (vs
35–42 px for full glyphs), its left stem clipped, and `read_glyph` returns `L`
→ `LEDGRNBLU`. Resize the window so the viewport ≈ the canvas (≈1320 wide) and the
same leading `R` is captured **42 px** wide and matches `R` at Hamming distance 5
→ `REDGRNBLU`. With that one geometry change **27 of the 28 deltas vanish and the
suite reaches `737/738`** — no primitive or test touched. On Windows the suite ran
at a viewport where the field ≈ the canvas, so the inset never clipped; this is
why the deltas are Linux-only without being a Linux defect.

The two residuals are likewise harness-geometry/timing, not floor defects:
- **R18 `wait_stable`** — *capture-rate aliasing*: a full-screen `capture_rgb` +
  `find_color` scan is slow enough that consecutive samples can fall an even number
  of the fixture's 180 ms teleports apart and read the *same* spot, so the motion is
  undersampled (Nyquist) and it can "settle" early. It is cadence-dependent (it
  passes or fails with the exact per-iteration timing), not an input/capture error.
  **(Resolved structurally in F143 by foveated pursuit — see below.)**
- **R103 green centroid** — the check builds its target box from a *screen* fraction
  `(w//2, 0.6·h)` and expects the full-page green's centroid to land inside it, so it
  depends on where the window sits on the captured screen. `find_color` returns the
  correct centroid of the green; the assumption is about window placement.

The lesson recorded for the next rounds: these are **environment/harness** surfaces,
to be met by running the suite at a viewport that matches the fixtures (field ≈
canvas) rather than by a Linux-only threshold tweak that would risk the Windows
reading the same primitives were tuned for. A first hardening was attempted for R18
(a wall-clock hold + non-resonant poll); it did **not** fix the aliasing, because a
slow *full-screen* capture undersamples the motion outright — jitter cannot add
samples that were never taken. That dead end pointed at the real cause (sampling
*rate*, not sampling *phase*) and is resolved properly in F143 below: do not poll
the whole wall faster — foveate. The discipline held throughout: grow a primitive
only from a reproduced failure, and only with a fix proven correct on *both* grounds.

**Lesson (道法自然):** 上善若水，水善利萬物而不爭 — the highest good is like water,
which benefits all things by taking the shape of whatever holds it. The toolkit
does not argue with the OS; it lets the OS be the vessel and flows the same way on
each. 無為而無不為 — name the floor, do nothing above it that knows the floor's
name, and it runs everywhere.

---

## F142 — the fovea: ROI capture (`capture_rgb(x,y,w,h)`, `foveate`)

**Friction (reproduced, from F141's R18 residual).** Every read until now grabbed
the *whole* screen. That is how a human would operate a GUI if the only way to see
were to photograph the entire wall and scan every pixel — and it is exactly why
`wait_stable` undersampled: a full-screen `find_color` is millions of pixels in
Python, slow enough that the sampler runs slower than a 180 ms animation step, so it
Nyquist-aliases the motion (F141, R18). Polling "the whole wall" faster is not the
answer; the eye never did that.

**Why this is structural (referencing the visual system).** A human retina is not
uniform: a tiny central **fovea** carries nearly all the acuity over ~1–2° of arc,
and the eye *aims* it where the signal is, re-reading that small patch many times a
second while the periphery stays coarse. The cost of "looking" is thereby decoupled
from the size of the scene. The OS floor already had the one call needed to give the
toolkit a fovea — both `XGetImage` and GDI `BitBlt` take a *source rectangle* — it
was simply never exposed. So F142 widens the leaf, on **both** backends identically,
to `capture_rgb(x, y, w, h)`: grab only a sub-rectangle (clamped to the screen).

`osctl.foveate(target, center, radius)` is the fovea built on it: grab a `2·radius`
window around an expected point, locate inside it, and map the hit back to *screen*
coordinates so it drops straight into `click`. And — 大音希聲 — its `None` is a
signal, not a non-answer: target-not-in-window *means* the thing has left the fovea
(it moved, or the aim was wrong), the cue to saccade.

**Live (Linux, X11):** a 160×160 foveal grab is **~0.2 ms vs ~6.4 ms** for the
full screen (**~41× faster**), and `foveate` returns the identical screen centroid
as the full-screen `find_color` (`dx=dy=0`). Proven in `_probe_fovea.py`.

## F143 — smooth pursuit + saccade: `wait_stable` rebuilt on the fovea

**Friction.** The same R18 — a synthesised click on a moving target lands where the
target *used to be*, and the F054 fixed-rate full-screen poll could falsely "settle"
mid-flight (it failed live: `settled click hits … :: MISS`).

**Why this is structural (referencing oculomotor control).** The eye tracks a moving
thing with two complementary motions: **smooth pursuit** keeps the fovea on a target
that stays roughly in view, and a fast **saccade** re-points it when the target jumps
out of the foveal window. Loss of the target *from the fovea* is itself the cue to
saccade. `wait_stable` is rebuilt exactly so: acquire once with a full grab, then
*pursue* inside a fovea via `foveate` at a fast poll (foveal grabs are cheap, so the
sampler finally out-paces the motion). While the fovea keeps the target within
`move_tol` it is at rest — hold that for a wall-clock `settle_frames·interval` and it
is settled. The instant the target leaves the fovea, that absence triggers one
full-screen **saccade** to re-acquire and the hold restarts. Dense sampling is foveal
(no undersampling); leaving the fovea resets the hold (cannot false-settle mid-motion).
No cadence is tuned to any display — correct on **both** grounds by construction.

**Live, A/B at the same geometry (1320):** committed F141 floor → `736/738`, failing
`settled click hits the now-stationary target :: MISS` (R18 aliases). With F143 →
`737/738`, R18 fully passes, the only residual the pre-existing R103 green-centroid
(window-placement, untouched). At **maximised 1600**, R18 also passes (`samples=33`,
`settled click … HIT`); the remaining failures there are purely the F141 OCR
viewport-crop deltas. A focused 5× repro (`_probe_settle.py`) settles in ~2.0 s every
time with `saccades≈5` (it re-acquires after each teleport and settles only at the
true rest). So R18 is fixed at **both** viewports — a sampling-rate cure, not a phase
hack: 反也者道之動 — the dead end (jitter) pointed straight at the way through (foveate).

**Lesson (道法自然):** 為學者日益，聞道者日損 — the earlier instinct was to *add*
timing machinery to a full-screen poll; the Tao was to *subtract* the scanned area
until sampling was cheap enough to simply see faster. 無為而無不為.

---

## F144 — low-acuity periphery + predictive reach: click a *still-moving* target (R105)

**Friction (reproduced live, on this VM's real Chrome).** F143 (`wait_stable`) waits for
motion to *stop*. But a target need not stop — a menu, a handle, a card still easing into
place is a legitimate click target *mid-glide*. Driving live Chrome with a magenta square
sliding continuously, the classic snapshot+click **missed essentially every time**: at
200 px/s 1/20, at 450 px/s 0/20, at 900 px/s 0/20, at 1500 px/s 1/20, with mean error
growing 58→300 px. Timing the loop named the culprit exactly: a whole-screen `find_color`
**scan is ~232 ms** (≈1.9 M pixels in pure Python) — by the time the click lands the
element has slid 200+ px. The perceive→act gap was not a constant to tune around; it was a
*slow perception* to fix.

**Why this is structural (referencing the visuomotor system).** Two corrections, each the
way the eye/hand actually works, neither a threshold hack:

1. **Acquire with the periphery, refine with the fovea.** The retina's periphery is
   *low-resolution* — it does not read every receptor. So `find_color` grew a `step`
   (acuity) knob: sample every n-th pixel on every n-th row, ~1/n² the work. Measured on
   the live screen: step=1 → 202 ms; **step=4 → 13 ms (16×), centroid only ~2 px off**;
   step=8 → 3 ms (67×), ~4 px. A coarse scan finds *where* the target is in a few ms, then
   `foveate` re-reads that small window at full acuity. (`wait_stable`'s saccade now scans
   coarsely too — re-acquisition that used to cost 232 ms is ~13 ms.)
2. **Predict, don't chase.** Smooth pursuit does not aim where the target *is* — that image
   is already one neural delay old; it estimates the target's **velocity** and aims where it
   *will be*. `osctl.reach` samples the fovea twice (~12 ms apart) for a velocity, then
   clicks the position extrapolated `lead` seconds ahead — `lead` being the measured
   perceive→click-lands latency. A live `lead` sweep at 900 px/s found the optimum at
   **~0.03 s** (mean error 30 px at lead=0 → **6 px** at 0.03), so that is the default.

**Live A/B (same scenes, this VM), snapshot+click vs `reach`:**

| speed | snapshot+click | reach0 (foveal, no predict) | **reach (predictive)** |
|------:|:--------------:|:---------------------------:|:----------------------:|
| 200 px/s | 1/20 (58 px) | 20/20 (8.9 px) | **20/20 (4.2 px)** |
| 450 px/s | 0/20 (119 px) | 20/20 (14 px) | **20/20 (3.7 px)** |
| 900 px/s | 0/20 (232 px) | 19/20 (30 px) | **18/20 (8.4 px)** |
| 1500 px/s | 1/20 (300 px) | 1/20 (47 px) | **20/20 (11 px)** |

The middle column shows the fovea alone fixes low/mid speed but **breaks at 1500 px/s**
(the residual latency exceeds the target half-width); prediction is what conquers high
speed (1/20 → 20/20). In total, snapshot+click landed ~3/80 across speeds; predictive reach
~78/80. R105 (`round_reach`) bakes this in as a permanent check: stale 0/6 vs reach 6/6 on a
600 px/s glide. Full suite **740/741** at the content viewport (only the pre-existing R103
window-placement delta remains); R18 and all OCR unaffected — `step` defaults to 1 (identical),
`reach` is additive, and the coarse saccade left `wait_stable` 5/5 on `_probe_settle.py`.

**Lesson (道法自然).** 大音希聲 — the fix was not a faster whole-screen stare but *less*
looking: low-acuity where acuity is wasted, and aiming at the not-yet (the target's future)
rather than the already-gone (its last snapshot). 為學者日益，聞道者日損: we did not add a
chase loop, we subtracted scanned pixels and subtracted the latency by prediction. 無為而無不為.

---

## F145 — the keyboard is a servo, not a typewriter (closed-loop keyboard control)

**Reframing (反者道之動).** The goal was never to beat the official screenshot+click
at its own game; it is to do what that primitive *cannot*. So this round asked: what
on a screen cannot be placed by a click at all? Answer: a control that moves only while
a **key is held** and *coasts* after release — a momentum scrubber, a key-repeat slider,
a game character. A click has nothing to grab; you must *drive* it with the keyboard.

**Reproduced friction (live, this VM's real keyboard).** A canvas knob that accelerates
while ArrowRight/Left is held and decays after release, with a goal band. The honest
open-loop attempt — read once, hold the key for the distance-estimated time `t=√(2d/a)`,
release — **landed 0/12 in band, mean error ~244–272 px**: acceleration and the
post-release coast are unmodelled, so it always overshoots. No click can help; the
control is keyboard-only.

**Why this is structural (referencing motor control).** The hand does not place a
momentum control open-loop either. It uses a **ballistic** phase (move fast toward the
goal while *watching*) released *before* arrival to leave room for the coast, then a
**corrective** phase of small impulses until inside the target — saccade-and-correct,
with proprioception telling it the limb has come to rest. `osctl.steer` is exactly that,
fused with vision:

1. **Perceive by pixels, move by the real keyboard.** Both the controlled element and
   the goal are located with `find_color`/`foveate` (the goal band is just another
   colour on screen); motion is genuine OS key events (XTEST), not a DOM write.
2. **Ballistic + predictive release.** Hold the key toward the goal, sampling position
   every ~12 ms; estimate velocity and release once the predicted stop (`pos + |v|·coast`)
   reaches the goal, so the coast carries it the rest of the way.
3. **Rest, then correct.** The decisive fix: do **not** re-measure on a fixed sleep — the
   element is still coasting, and correcting mid-coast oscillates (first cut: 4/12). Wait
   until perception shows it has actually *stopped* (two consecutive sub-pixel deltas),
   then nudge with 20 ms impulses until the centre is inside the band. 知止所以不殆 —
   know when it has stopped before acting again.

**Live A/B (same scenes, this VM), open-loop hold vs `steer`:**

| method | in-band | mean \|err\| |
|---|:---:|:---:|
| open-loop (one reading, timed hold) | 0/12 | ~244–272 px |
| inline servo (page-readout corrective) | 11–12/12 | ~25 px |
| **`osctl.steer` (pure-pixel perception)** | **12/12** | **~12 px** |

The shipped primitive, perceiving *both* knob and goal purely by pixels, beats even the
inline version that peeked at the page state — because rest-by-perception removes the
mid-coast mis-correction. R106 (`round_steer`) bakes it in: open-loop 0/4 vs steer 4/4.

**Generality beyond the browser (不局限於一瀏覽器).** The same `osctl` floor drove a
*native* app end-to-end this session — KDE Konsole: an OS click to focus (mouse), then
`type_unicode` of a shell command and Return (keyboard), verified by the marker file it
wrote. The floor is application-agnostic: it acts on the X11 screen, not on a DOM. (It
still has **no window-enumeration/activation primitive** — a real gap for addressing the
*right* window among many; logged here as the next honest surface.)

**Lesson (道法自然).** A click is one impulse; many controls integrate over *held* time and
*coast* after. The keyboard is therefore not a typewriter but a **servo** — and the same
perceive→predict→correct loop that hit a moving target (F144) drives a moving control,
just with keys instead of a click. 大音希聲: the signal that it is *safe to correct* is the
*absence* of motion (rest), perceived, not assumed. 無為而無不為.

---

## F146 — address the *right* window among many (`list_windows` / `activate_window` / `focus_window`, R107)

**The gap F145 logged.** Every keyboard and clipboard gesture in this floor acts on
*whatever window holds focus*. In a single browser that is invisible; on a real desktop —
the user's actual machine, many apps open at once — it is a silent, dangerous bug: a typed
command or a paste lands in the **wrong window**. And this is precisely a place the official
screenshot+click *cannot* help: it can click a visible pixel, but it cannot **address a
window by identity**, nor raise one that is occluded or behind another. There was no
primitive to enumerate windows or bring a chosen one forward.

**Reproduced friction (live, this VM).** Two KDE Konsole windows, `DAOWIN-A` and `DAOWIN-B`,
each launched with a distinct `WTAG` env var so the *same* typed command —
`echo $WTAG > marker` — records which window actually received the keystrokes. With B
focused (it opened last) but A *intended*, typing with no addressing wrote **`B`** to the
marker — input went to the wrong window. There is no click that fixes this; the target is
identity, not a pixel.

**The primitive (referencing how a person does it).** A person does not type blindly into
whatever is on top — they *find* the window they mean (by its title in the taskbar) and
*click it to the front* first. Two leaves on the OS floor, one gesture above them:

1. **`list_windows()`** — the eye that finds the right window. X11: read the window
   manager's `_NET_CLIENT_LIST` (EWMH) off the root and each window's `_NET_WM_NAME`
   (UTF-8, falling back to `WM_NAME`). Windows: `EnumWindows` + `GetWindowTextW`. Returns
   `[{"id", "title"}, …]`.
2. **`activate_window(id)`** — raise + focus by identity. X11: send the EWMH
   `_NET_ACTIVE_WINDOW` client message to the root (the request a pager/taskbar makes) then
   `XMapRaised`/`XRaiseWindow`. Windows: `SetForegroundWindow` with the documented
   attach-thread-input dance to defeat the foreground lock, restoring if minimised.
3. **`focus_window(match)`** (platform-agnostic, above the leaves) — find the window whose
   title contains `match` and activate it, so the *next* `type`/`tap`/paste reaches the
   intended app.

**The 64-bit gotcha (worth recording).** EWMH list/window properties are `format 32`, but
libX11 returns format-32 data as an array of C **`long`** — 8 bytes each on a 64-bit box,
not 4. Reading them as `uint32` silently doubles the count and yields garbage ids. The
backend reads them as `c_long`/`ctypes.sizeof(c_long)`.

**Live A/B (same two windows, this VM):**

| step | marker | outcome |
|---|:---:|---|
| no addressing (B focused, A intended) | `B` | input went to the **wrong** window |
| `focus_window("DAOWIN-A")` then type | `A` | input went to the **intended** window |

R107 (`round_window`) bakes it in (4 checks: enumerate both, wrong-window without
addressing, right-window with `focus_window`, and the strict A/B). `activate_window` was
independently confirmed live — after the call `xdotool getactivewindow` and the root's
`_NET_ACTIVE_WINDOW` both reported our target window.

**A second friction found in passing (honest).** While building the probe, `type_unicode`
with a trailing `'\n'` did **not** submit the command in a terminal — both commands
concatenated on one prompt line. A literal newline codepoint is not the Return key; the
fix is an explicit `tap(VK_RETURN)`. Documented so the next round does not relearn it.

**Lesson (道法自然).** 知人者知也，自知者明也 — to act on the right thing you must first
*know which thing it is*. The floor could already move and type with a person's precision,
but it was blind to *which* window it was speaking to; giving it the eye to enumerate and
the hand to raise-by-name closes that. 始制有名 — once things have names, address them by
name. 無為而無不為.

---

## F147 — the clipboard relay: copy here, paste *there* by name (R108)

**Reframing toward fusion (各方面東西要高效的搭配).** F146 gave the floor a window's *name*;
typed input now reaches the intended app. But the act a person performs across apps all day
is richer: **copy something here, paste it into that other window**. It is the moment all
four faculties must move as one — the eye (find the window), the hand (raise it), the
clipboard (hold the content), the keyboard (the paste chord). And it is a place official
screenshot+click is doubly blind: it has neither window identity *nor* clipboard addressing;
it can only click a guessed pixel and hope the right app has focus.

**Reproduced friction (live, this VM).** Two terminals `DAOREL-A`/`DAOREL-B`; the clipboard
holds `DAOPAY-7c3f`; we *intend* to deliver it into A. With B holding focus and **no
addressing**, the relay (`echo $WTAG <paste> > marker`) wrote **`B DAOPAY-7c3f`** — the
payload crossed into the *wrong* window. After `focus_window("DAOREL-A")` it wrote
**`A DAOPAY-7c3f`** — delivered, intact, into the intended window.

**No new primitive — the composition was already there (無為).** This needed nothing new on
the floor: `set_clipboard` + `focus_window` (F146) + `chord`. The honest contribution is to
*prove and lock* the fusion, not to invent a leaf for it. 為學者日益，聞道者日損 — we add by
subtracting frictions, and here the friction was already dissolved by F146; what remained was
to confirm the whole gesture composes.

**One real app-detail learned (worth recording).** A terminal does **not** paste on
`Ctrl+V` — that is the wrong chord there (a literal / interrupt). X11 terminals paste on
`Ctrl+Shift+V`; Windows consoles accept `Ctrl+V`. So the existing `paste_text` (which uses
`Ctrl+V`, correct for web inputs) is *not* universal; R108 selects the terminal chord per
platform. The lesson is small but exact: the paste **chord is app-class-specific**, even
though the clipboard underneath is one.

**Live A/B (same two terminals):**

| step | marker | outcome |
|---|:---:|---|
| no addressing (B focused, A intended) | `B DAOPAY-7c3f` | payload crossed into the **wrong** app |
| `focus_window("DAOREL-A")` then paste | `A DAOPAY-7c3f` | payload delivered into the **intended** app |

R108 (`round_clip_relay`) bakes it in (3 checks): wrong-window without addressing, payload
delivered to the intended window, and the strict A/B. Portable — X11 terminals use
`Ctrl+Shift+V`, Windows consoles `Ctrl+V`; skips gracefully without a terminal.

**Lesson (道法自然).** 三生萬物 — once the floor had moving (F144), keyboard-servoing (F145),
and *naming* windows (F146), the cross-app clipboard relay was not a new thing to build but a
*combination* that already existed in latent form. The system rises not only by adding
faculties but by letting the ones it has **move together**. 無為而無不為.

---

## F148 — raising an occluded window so the *mouse* reaches it (R109)

**The other half of addressing.** F146/F147 routed the **keyboard** by input-focus — and on
X11 input-focus is independent of stacking, so even a *covered* window receives keystrokes
once activated. The **mouse** is a different animal: a click lands on whichever window owns
that pixel in the **Z-order**. When two windows overlap, clicking the shared pixel hits the
*top* one. So to operate an occluded window *with the mouse* you must first **raise** it —
exactly what screenshot+click cannot do (it can only click the visible top pixel; it has no
way to bring a covered window forward).

**Reproduced friction (live, this VM).** Two konsoles at overlapping geometry —
`ZWIN-A` at `+120+120`, `ZWIN-B` at `+170+170` (B on top). Clicking the shared body pixel
`(420,360)` and typing wrote **`CLICK-B`** — the click hit the occluding window. After
`focus_window("ZWIN-A")` (which `activate_window` raises via `_NET_ACTIVE_WINDOW` +
`XMapRaised`/`XRaiseWindow`), clicking the **same** pixel wrote **`CLICK-A`** — the mouse now
reached the intended, formerly-covered window.

**This is a distinct mechanism, not a re-dress of R107/R108.** Those proved *focus* routing
(keyboard); this proves *stacking* (mouse). The same `activate_window` serves both, which is
the honest economy: one act of raising-by-name satisfies the keyboard (focus) and the mouse
(Z-order) at once. 大制無割 — the right cut leaves nothing to re-cut.

**Live A/B (same two overlapping terminals, identical click point):**

| step | marker | outcome |
|---|:---:|---|
| click shared pixel, B occluding A | `CLICK-B` | mouse hit the **top** window |
| `focus_window("ZWIN-A")` then click | `CLICK-A` | mouse reached the **raised** window |

R109 (`round_zorder`) bakes it in (3 checks): top-window-hit without raising, raised-window
reached after `activate_window`, strict redirection. Linux/konsole only for now — forcing a
deterministic window *overlap* on Windows needs a move primitive the floor has not grown yet
(no friction reproduced there), so it skips gracefully on Windows. `_probe_relay.py` covers
F147; F148's reproduction lives in the round itself.

**Lesson (道法自然).** 見小曰明 — the small, easily-missed distinction (focus ≠ stacking) is
exactly where the real defect hides. A system that only ever drove the keyboard would have
*claimed* to "address windows" while silently failing every mouse click on a covered one. We
only earn the claim by living the mouse case too. 無為而無不為.

**Side-friction caught while validating F148: a transient CDP drop cascaded.** Two of four
full-suite runs lost the Chrome debug websocket *mid-run* (once deep in the perception rounds,
once right after a window round) — a transient socket close under heavy off-CDP activity, not
a code defect (every affected round passes standalone). But the harness had no recovery: once
`CDP._alive` went False, **every** later round threw `CDP not connected`, turning one hiccup
into ~50 false failures. Fixed structurally, not by re-running until lucky: `Browser.reconnect()`
re-attaches to the live page (the tab survives a socket drop; only the connection died) and the
harness self-heals between rounds — the round the drop landed in still counts, but the suite
stays honest after it. 弱也者道之用也 — the connection's weakness (it can drop) is answered not
by force but by yielding-and-reattaching.

## F149 — moving a window back into reach (R110)

**The third pathway of addressing.** F146/F147 routed the **keyboard** by focus; F148 raised a
covered window so the **mouse** reaches it by Z-order. But raising only reorders the *stack* —
it does nothing for a window placed **off the visible screen**: there is then no on-screen
pixel that belongs to it, so no click can land on it, raised or not. The only remedy is to
**move it back into view**. Screenshot+click cannot reposition a window at all.

**Reproduced friction (live, this VM).** A konsole `MVWIN` on-screen at `+200+200` is driven
fine. `move_window(id, screen_w+100, 300)` pushes it fully off the right edge (`window_geometry`
confirms `x=1700` on a 1600-wide screen). Now even `activate_window(id)` (raise) cannot help —
clicking the body-centre it used to occupy hits empty desktop and the typed marker never
arrives (`SENTINEL` unchanged). After `move_window(id, 200, 200)` the **same** click lands and
writes `MV-M`.

**Live A/B (one konsole, pushed off then moved back):**

| step | marker | outcome |
|---|:---:|---|
| off-screen, then `activate_window` (raise) + click old spot | `SENTINEL` | unreachable — raising can't rescue it |
| `move_window` back into view + click | `MV-M` | the click reaches it |

Two new primitives on both backends: `window_geometry(id)` (X11 `XGetGeometry` +
`XTranslateCoordinates`; Windows `GetWindowRect`) tells the floor *where a window actually is*;
`move_window(id, x, y, w=0, h=0)` relocates it (X11 EWMH `_NET_MOVERESIZE_WINDOW` + core
`XMoveResizeWindow` fallback; Windows `SetWindowPos`). Note KWin *clamps initial placement*
on-screen but honours an explicit `_NET_MOVERESIZE_WINDOW` off-screen — which is exactly what
makes the friction reproducible. The move-back needs a follow-up `activate_window` for the WM
to re-grant focus to a window that had left the screen. R110 (`round_move`) bakes it in
(4 checks); `_probe_move.py` is the standalone reproduction. Linux/konsole only for the round.

**Lesson (道法自然).** 樸散則為器 — one act of *addressing a window* splinters, under honest
pressure, into three distinct tools: focus (keyboard), stacking (mouse), and **position**.
Each was invisible until the case that needs it was lived. A system that stopped at "raise"
would silently fail every off-screen window. 大制無割 — the whole is served only by not
papering over the seams between these three.

## F150 — reaching a window on another virtual desktop (R111)

**The fourth addressing axis: workspace.** Focus (R107), Z-order (R109), and position (R110)
all silently assume the window shares the **current** workspace. A window on another virtual
desktop has *no on-screen pixels whatsoever* — no click can reach it, no matter its focus,
stacking, or coordinates. First the floor must even be able to **see** this: `list_windows`
now reports each window's `"desktop"`, so a window whose desktop ≠ `current_desktop()` is
known to be off-screen-by-workspace. Then two genuinely distinct remedies exist — and they are
*not* the same gesture:

- **GO THERE** — `set_desktop(n)` switches the shown workspace (what clicking a pager cell
  does); `activate_window` likewise *follows* a window to its desktop. You leave where you were.
- **BRING HERE** — `move_window_to_desktop(win, current_desktop())` pulls the window onto the
  workspace you are already on, **without leaving it**. `activate_window`'s "follow" cannot
  express this — sometimes you want the window to come to your work, not your work to scatter.

**Live A/B (one konsole, sent to workspace 1 while we stay on 0):**

| step | marker | outcome |
|---|:---:|---|
| `move_window_to_desktop(w,1)`, then click its coords from desktop 0 | `SENTINEL` | unreachable — no pixels on this workspace |
| `set_desktop(1)` (go there) + click | `VD-D` | reachable |
| back to 0, `move_window_to_desktop(w,0)` (bring here) + click | `VD-D` | reachable **without leaving desktop 0** |

X11 via EWMH: read `_NET_CURRENT_DESKTOP` / `_NET_NUMBER_OF_DESKTOPS` / `_NET_WM_DESKTOP`
(`num_desktops`/`current_desktop`/`window_desktop` + the new `desktop` field on `list_windows`);
act via `_NET_CURRENT_DESKTOP` / `_NET_WM_DESKTOP` client messages (`set_desktop` /
`move_window_to_desktop`). KWin honours a runtime `_NET_NUMBER_OF_DESKTOPS` bump, which makes
the friction reproducible on this single-desktop VM (the round uses `wmctrl -n 2` as *setup*;
the floor only reads/switches/moves, it does not create workspaces). A subtle correctness trap
caught in review: `list_windows` and `window_desktop` hold the backend `_lock`, and
`threading.Lock` is **not** reentrant — calling `current_desktop()` (which re-locks) from
inside them would deadlock; both read `_NET_CURRENT_DESKTOP` inline instead. R111 (`round_desktop`,
5 checks) bakes it in; `_probe_desktop.py` is the standalone reproduction. Linux-only — Windows
virtual-desktop COM (`IVirtualDesktopManager`) has a GUID that shifts every OS build, so the
floor offers graceful no-op fallbacks there rather than ship something unstable; the round
skips on Windows.

**Lesson (道法自然).** 知人者智，自知者明 — before the hand can act, the eye must *know* the
window is elsewhere; perception (`list_windows` carrying `desktop`) had to grow before the act
was even meaningful. And 反者道之動 — "bring it here" is the reverse of "go there"; the same
need (operate that window) is met by moving either the self or the window, and a complete floor
holds both directions rather than forcing one.

---

## F151 — see which window owns a pixel before clicking it (`window_under`, R112)

**Ground: Windows Server 2022.** The cross-platform floor (F141) had only ever
been exercised live on the X11 ground; this round was discovered, built and
verified on the **Win32** backend, then mirrored back to X11 for parity.

**Friction.** F148 established that the mouse follows the *stack*: a click lands
on whoever owns that pixel in the Z-order, so reaching an occluded window means
first *raising* it (`activate_window`). But raising was a **blind write** — the
floor could reorder the stack yet had no way to *read* it back. So before a
click it could not answer the most basic question: *which window is actually
under this point right now — the one I intend, or an occluder?* Official
screenshot+click is doubly blind here: a screenshot carries colour, never window
identity; two windows of the same colour are indistinguishable, and nothing in
the pixel says where one window ends and the next begins.

**Primitive.** `osctl.window_under(x, y)` → the top-level window id that owns the
screen pixel, or `None` for bare desktop/root. It is the **read-side dual of
`activate_window`**: the latter *writes* the stack, this *reads* it, and the id
it returns keys directly against `list_windows`.

- **Win32**: `WindowFromPoint(POINT)` resolves the deepest window at the point;
  `GetAncestor(hwnd, GA_ROOT)` lifts that to its top-level root so the result is
  the same id `list_windows`/`activate_window` speak.
- **X11**: `XTranslateCoordinates(root, root, x, y)` gives the toplevel under the
  point, but a reparenting WM wraps the client in frame/decoration windows, so
  that is usually a *frame*, not the `_NET_CLIENT_LIST` id. We descend the
  subtree (`XQueryTree`, topmost child first) to the window bearing `WM_STATE`
  (the ICCCM client window), and only return it if it is actually managed
  (present in `_NET_CLIENT_LIST`).

**Live A/B (two consoles overlapping at one pixel, Windows):**

| step | `window_under(450,380)` | meaning |
|---|:---:|---|
| B launched last, on top | `B` | the pixel a click would hit is B's, not A's |
| `activate_window(A)` (raise A) | `A` | the read tracks the write — ownership flipped |
| a pixel outside both frames | not A, not B | no misattribution to our windows |

R112 (`round_window_under`, 5 checks) bakes it in; `_probe_under.py` is the
standalone reproduction. Cross-platform: runs natively on Windows (cmd consoles)
and on a konsole-equipped X11 host.

**Lesson (道法自然).** 知人者智，自知者明 — *knowing others is wisdom; knowing
oneself is clarity.* The hand learned to reorder the stack (F148) long before the
eye could see it; a faculty that can only *act* and never *perceive its own act*
is half-blind. 反者道之動 — the Way moves by opposites: every write the floor
grows eventually demands its reading dual (`move`→`cursor_pos`, `set_clipboard`→
`get_clipboard`, `activate_window`→`window_under`), and the floor is only whole
when both directions are present.

---

## F152 — a window has a life: wait for it to be born, close it by identity (`wait_window` / `close_window`, R113)

**Ground: Windows Server 2022.**

**Friction.** Every window primitive so far (F146 address, F148 raise, F149 move,
F150 desktop, F151 read) assumed the window *already exists and will keep
existing*. But a window has a lifetime. Two ends of it had no primitive:

- **Birth is delayed.** Launching an app, opening a dialog, spawning a document —
  the window appears *after* a delay. Code that lists/activates the instant after
  spawning races the window's birth and addresses nothing. F118's `wait_for`
  waits for *pixels* to appear, but pixels carry no identity: two same-looking
  windows are indistinguishable, and a window can already exist while fully
  occluded with zero visible pixels. The floor could wait on appearance but not
  on *identity*.
- **Death had no gesture.** The floor could raise, move, read a window — but
  never *dismiss* one. Screenshot+click would have to hunt the ✕-button pixel;
  killing the process is a sledgehammer that skips the app's own close path.

**Primitives.**
- `osctl.wait_window(match, timeout)` → blocks until a top-level whose title
  contains `match` exists, returns it (or `None` on timeout). Polls
  `list_windows` — waiting on window *identity*, the dual of waiting on pixels.
- `osctl.close_window(win)` → asks a window to close *by identity*, the graceful
  path a human's ✕ click takes: Win32 `PostMessage(WM_CLOSE)`, X11 EWMH
  `_NET_CLOSE_WINDOW` client message. It runs the app's own close handlers, not a
  process kill.
- `osctl.window_exists(win)` / `wait_window_closed(win, timeout)` → the read that
  confirms a close actually took; the closing dual of `wait_window`.

**Live (Windows, cmd consoles):**

| step | call | outcome |
|---|---|---|
| no such window | `wait_window("DAO-NOEXIST", 1.0)` | `None` after ~1s — no false positive |
| launch console, then wait | `wait_window("ULIFE-X", 10)` | returns `{id, title}` once born |
| while alive | `window_exists(id)` | `True` |
| close by identity | `close_window(id)` → `wait_window_closed(id)` | gone; dropped from `list_windows`; `window_exists` → `False` |

R113 (`round_window_lifecycle`, 5 checks); `_probe_life.py` is the standalone
reproduction (7/7). Full suite **761/761** clean.

**Lesson (道法自然).** 出生入死 — *coming into life, going into death.* The floor
had learned to operate windows but treated them as eternal fixtures; a complete
hand must meet a window at both ends of its existence — wait for it to arrive,
and let it go — addressing each *by name*, never by groping at pixels. 反者道之動
again: birth (`wait_window`) and death (`close_window`/`wait_window_closed`) are
duals, and the floor grows whole by holding both.

---

## F153 — how a window is *shown*: minimize, maximize, restore (`window_state` / `set_window_state`, R114)

**Ground: Windows Server 2022.**

**Friction.** The floor could now address (F146), raise (F148), move (F149), read
ownership of (F151), and end (F152) a window — but every one of those concerns
*where* the window is or *whether* it is. None touched *how it is shown*. A window
also lives along a show-state axis: **minimized** (no on-screen pixels at all),
**maximized** (filling the work area), **normal**. Geometry cannot express it: a
maximized window and a window merely sized to the screen have identical rects, and
a minimized window and a closed one both have no pixels — a screenshot cannot tell
them apart. The floor had no way to read this axis, nor to perform the most
ordinary title-bar gestures a human does dozens of times an hour.

**Primitives.**
- `osctl.window_state(win)` → `"minimized"` / `"maximized"` / `"normal"` (or None
  if gone). Win32 `IsIconic`/`IsZoomed`; X11 ICCCM `WM_STATE`==IconicState for
  minimized, `_NET_WM_STATE` carrying both MAXIMIZED_VERT and _HORZ for maximized.
- `osctl.set_window_state(win, state)` → the gesture by identity. Win32
  `ShowWindow` (SW_MINIMIZE / SW_MAXIMIZE / **SW_SHOWNORMAL**); X11
  `XIconifyWindow` + EWMH `_NET_WM_STATE` add/remove of the two MAXIMIZED atoms.

**Live (Windows, cmd console):**

| step | `window_state` | corroboration |
|---|:---:|---|
| fresh | `normal` | — |
| `set_window_state(maximized)` | `maximized` | `window_geometry().w` = 1296 ≈ screen 1280 |
| `set_window_state(minimized)` | `minimized` | `window_exists` still True (≠ closed) |
| `set_window_state(normal)` | `normal` | returns to normal *even from minimized* |
| `set_window_state("bogus")` | — | returns False, nothing applied |

**Defect found & fixed in practice.** First run: restoring from *minimized* with
`SW_RESTORE` (9) bounced the window back to **maximized**, because SW_RESTORE
restores the *prior* show-state, not the normal one. Probe caught it
(`_probe_state.py`); fixed by mapping `"normal"` to `SW_SHOWNORMAL` (1), which
forces normal size/position regardless of prior state. The maximize check is
cross-validated against pixels (`window_geometry`), so the *read* cannot drift
from the *reality* — perception and actuation pinned to each other.

R114 (`round_window_state`, 5 checks); `_probe_state.py` standalone (5/5). Full
suite **766/766** clean.

**Lesson (道法自然).** 大成若缺 — *the greatest completion seems incomplete.* Each
new window primitive revealed one more axis the floor had silently assumed away:
position, then stack, then existence, now show-state. Completeness is not a
destination but the steady exposure and filling of these unspoken assumptions —
and only a *read* pinned to a *pixel* (maximized ↔ geometry) keeps the filling
honest rather than self-certifying.

---

## F154 — which window has the keyboard: read focus, and fix repeated activation (`active_window`, R115)

**Ground: Windows Server 2022.**

**Friction.** F151 gave one of the two read-duals of `activate_window`:
`window_under` — which window owns a *pixel*, i.e. where a *click* lands (the
mouse follows the stack). Its twin was still missing: which window owns *focus*,
i.e. where a *keystroke* lands (the keyboard follows focus). The floor could
*write* focus (`activate_window`, `focus_window`) but never *read* it, so it typed
blind — no way to confirm a `type`/key would reach the intended app rather than
whatever silently held focus.

**Primitive.** `osctl.active_window()` → the id of the window holding keyboard
focus now, or None. Win32 `GetForegroundWindow`; X11 reads EWMH
`_NET_ACTIVE_WINDOW` off the root. The focus-read dual of `activate_window`, as
`window_under` is its stack-read dual.

**Defect surfaced & fixed in practice (the real prize).** Building the read
exposed a writer defect that had been invisible without it. The probe activated A
(read: A ✓), then activated B — and `active_window` still reported **A**. The
third check ("focus_window agrees") only *looked* green because A was already
focused, a no-op agreement masking the failure. Root cause: **Windows'
foreground lock**. `SetForegroundWindow` grants only the *first* foreground change
a process makes after user input and silently denies the rest
(`ForegroundLockTimeout`) — so `activate_window` worked once and failed on every
switch after, quietly leaving the keyboard pointed at the wrong window. The
`AttachThreadInput` workaround already in `activate_window` was not enough. Fix:
zero `SPI_SETFOREGROUNDLOCKTIMEOUT` once at backend import, after which every
subsequent `activate_window` takes reliably. After the fix: activate A → A,
activate B → **B**, focus_window(A) → A. This hardens not just F154 but every
window-addressing round that switches focus more than once.

R115 (`round_active_window`, 5 checks, incl. the explicit *second-switch* assert);
`_probe_active.py` standalone (3/3 after fix; it was 2/3 that *found* the bug).
Full suite **771/771** clean.

**Lesson (道法自然).** 反者道之動 — *the Way moves by opposites.* The read
(`active_window`) was not merely the missing half of a pair; building it is what
made the writer's silent failure *visible at all*. A faculty that can only act
and never perceive its own act cannot even know it has failed. The dual is not
decoration — it is the floor's only honest mirror. 知人者智，自知者明: knowing the
window is wisdom; the floor knowing *its own* focus is clarity.

---

## F155 — always-on-top: where the stack and focus deliberately diverge (`set_window_topmost` / `is_window_topmost`, R116)

**Ground: Windows Server 2022.**

**Friction.** F151 reads the *stack* (`window_under` — which window owns a pixel,
where a click lands); F154 reads *focus* (`active_window` — which window owns the
keyboard). On a normal desktop the two move together: raising a window both
stacks it and focuses it, so nothing had yet *proved* they are independent axes
rather than two names for one thing. And the floor had no way to express the one
case where a human deliberately splits them: pinning a reference window
*always-on-top* so it stays visible while typing into another.

**Primitives.**
- `osctl.set_window_topmost(win, on=True)` → pin/unpin always-on-top by identity.
  Win32 `SetWindowPos(HWND_TOPMOST/HWND_NOTOPMOST)`; X11 EWMH `_NET_WM_STATE`
  add/remove of `_NET_WM_STATE_ABOVE`.
- `osctl.is_window_topmost(win)` → read the pin. Win32 `WS_EX_TOPMOST` ext-style;
  X11 `_NET_WM_STATE_ABOVE` membership. The read dual of the write.

**Live (Windows, two overlapping consoles sharing one pixel):**

| step | `active_window` (focus) | `window_under(px)` (stack) |
|---|:---:|:---:|
| pin A, then activate B | **B** | **A** — topmost wins the pixel |
| unpin A, activate B | **B** | **B** — axes re-converge |

That single row where focus = B but the pixel = A is the whole point: it proves
`active_window` and `window_under` measure genuinely different things. A
screenshot+click floor cannot pin anything, and cannot even perceive the split.

R116 (`round_topmost`, 5 checks); `_probe_topmost.py` standalone (6/6). Full suite
**776/776** clean.

**Lesson (道法自然).** 萬物負陰而抱陽 — *all things carry yin and embrace yang.*
Stack and focus had ridden together so faithfully they looked like one; only by
*forcing* them apart (the topmost pin) does the floor confirm it holds two
independent truths, each with its own read. Wholeness is not sameness — it is
holding distinct opposites at once and knowing which is which.

---

## F156 — a window's process identity, and the forceful death (`window_pid` / `terminate_window`, R117)

**Ground: Windows Server 2022.**

**Friction.** Every window read so far keyed off the *title* or the *handle*. But
a title can **collide** — two consoles, two editors, two browser windows can carry
the exact same caption — so a title is not an identity; addressing "the window
titled X" is ambiguous when two exist. And F152 gave only the *graceful* death
(`close_window` → WM_CLOSE / _NET_CLOSE_WINDOW, the app's own close path); a hung
window or a stubborn modal can simply ignore it, leaving the floor no recourse. A
human in that spot opens Task Manager and kills the process — an escalation the
floor could not make.

**Primitives.**
- `osctl.window_pid(win)` → the owning OS process id (Win32
  `GetWindowThreadProcessId`; X11 `_NET_WM_PID`). Identity *beyond the title*: it
  tells two same-titled windows apart and groups one app's windows.
- `osctl.terminate_window(win)` → force the owning process to end (Win32
  `OpenProcess(PROCESS_TERMINATE)`+`TerminateProcess`; X11 `SIGKILL` the pid). The
  *forceful* death dual of the graceful `close_window`.

**Live (Windows, two consoles with the SAME title):**

| check | result |
|---|---|
| two windows share the identical title "UPID-SAME" | n = 2 |
| `window_pid` of each | **3804 ≠ 2488** — distinct identity the title can't give |
| `terminate_window(A)` then `wait_window_closed(A)` | gone |
| the other same-titled window (pid 2488) | unharmed |

R117 (`round_window_pid`, 4 checks); `_probe_pid.py` standalone (6/6). Full suite
**780/780** clean.

**Lesson (道法自然).** 名可名也，非恒名也 — *a name that can be named is not the
constant name.* The title is a name, and names collide and change; the process is
the window's constant identity beneath the name. And death has two faces: the
graceful asking (`close_window`) and, when that is refused, the forceful ending
(`terminate_window`). A floor that could only ask politely was at the mercy of any
app that would not answer; holding both the gentle and the absolute completes its
authority over a window's end.

---

## F157 — reading the floor's own keyboard (`key_state`, R118)

**Ground: Windows Server 2022.**

**Friction.** For 156 rounds the floor could *press* and *release* keys
(`key_down`/`key_up`) but had no way to *read* them back. It typed entirely blind
to its own keyboard. Two silent corruptions live in that blindness: a modifier
left held (a `key_down(Shift)` whose `key_up` never fires turns every later letter
upper-case) and a toggled lock (`CapsLock`/`NumLock` flipped on by a stray tap
silently inverts case / digit-vs-arrow) — neither detectable, because the write
side cannot see the latch it set. This is the keyboard's missing read dual, the
twin of F154's `active_window` (which read *where* keys land; this reads *what*
the keyboard itself holds).

**Primitive.**
- `osctl.key_state(vk)` → `{"down": bool, "toggled": bool}`. `down` = the physical
  press (Win32 `GetAsyncKeyState` high bit; X11 `XQueryKeymap` keymap bit);
  `toggled` = the lock latch (Win32 `GetKeyState` low bit; X11 Xkb `locked_mods`).

**Live (Windows, no window/app needed — raw input floor):**

| check | result |
|---|---|
| Shift: up → held → released | `down` False → **True** → False |
| CapsLock: read, toggle, toggle back | `toggled` False → **True** → False |

R118 (`round_key_state`, 2 checks); `_probe_keystate.py` standalone (5/5). Full
suite **782/782** clean.

**Lesson (道法自然).** 自知者明 — *to know oneself is clarity.* F154 was 知人
(knowing *which* window holds focus, outward); this is 自知 (the floor knowing
*its own* hand). A power that cannot perceive itself acts blind and cannot tell a
clean act from a corrupted one; only with a read of its own state can the floor
trust what it writes. Every write this session has now grown its read — the
keyboard was the last actuator still typing into the dark.

---

## F158 — reading the floor's own mouse buttons; the input floor closes (`mouse_state`, R119)

**Ground: Windows Server 2022.**

**Friction.** F157 gave the keyboard its read; the mouse *button* was the last
input **write** with no read. `mouse_button` could press and release, but nothing
could ask "is a button down right now?" A drag is press → move → release; if the
release event is ever lost (an exception between the down and the up, a gesture
abandoned mid-way), the button stays logically held and **every later move
becomes an unwanted drag** — selecting text, dragging icons, smearing the desktop
— invisible to the floor until something breaks far downstream. The button had no
mirror.

**Primitive.**
- `osctl.mouse_state()` → `{"left","right","middle": bool, "pos": (x,y)}`. Win32
  reads each button via `GetAsyncKeyState(VK_LBUTTON/…)`; X11 reads the live button
  bits from `XQueryPointer`'s mask. The button-read dual of `mouse_button`, and it
  folds in the cursor position so one call answers "where is the pointer and what
  is it holding?"

**Live (Windows, pressed at a neutral corner, always released):**

| check | result |
|---|---|
| at rest | left **up**, pos reported |
| while left held | left **down**, right/middle up |
| after release | left **up** (a stuck drag would show here) |

R119 (`round_mouse_state`, 3 checks); `_probe_mousestate.py` standalone (5/5). Full
suite **785/785** clean.

**Lesson (道法自然).** 知人者智，自知者明 — and now the self-knowing is complete.
Across F151–F158 every actuator finally grew its mirror: the stack (`window_under`),
focus (`active_window`), window state/identity/end, the keyboard (`key_state`), and
now the mouse (`mouse_state`). 反者道之動 — the Way moves by opposites: a power that
only acts is half a power; only when each write can be read does the floor act with
open eyes instead of in the dark. The input floor is whole.

---

## F159 — the atom of perception, and waiting for visual state (`pixel` / `wait_pixel`, R120)

**Ground: Windows Server 2022.**

**Friction.** Perception was all-or-nothing. `capture_rgb` grabs the whole desktop
and `find_color` scans it; but the most frequent question is tiny — *what colour is
**this** spot right now?* (is the indicator green, has the cell filled, did the
light come on) — and there was no atomic way to ask it. Worse, there was no way to
**wait** on a visual state. `wait_window` could block until a window is *born*, but
nothing could block until something *looks* a certain way — a button enabling, a
spinner stopping, a progress bar finishing, a render settling — which is exactly
what a human does: watch the screen until it changes.

**Primitives (platform-agnostic, built on `capture_rgb` — no backend duplication).**
- `osctl.pixel(x, y)` → `(r, g, b)` for one spot, a 1×1 foveal read: the cheapest
  perception the floor can make.
- `osctl.wait_pixel(x, y, rgb, tol, timeout, interval)` → block until that spot
  comes within `tol` of `rgb`, or time out. The visual-state dual of `wait_window`.

**Live (Windows, deterministic — reads the live screen, changes nothing):**

| check | result |
|---|---|
| `pixel(cx,cy)` vs same coord in full `capture_rgb` | identical `(255,255,255)` |
| `wait_pixel` for the colour already there | True in **0.016 s** |
| `wait_pixel` for a colour that never appears (1 s deadline) | False in **1.016 s** |

R120 (`round_pixel`, 3 checks); `_probe_pixel.py` standalone (3/3). Full suite
**788/788** clean.

**Lesson (道法自然).** 見小曰明 — *to see the small is clarity.* The whole-screen
grab is the grand gesture; real attention is a single point, watched over time.
And waiting is not idleness — `wait_pixel` is 無為 that is not inaction: the floor
stops *doing* and simply *watches*, letting the world arrive at the state it needs
before it acts. After F158 closed the input floor (every write its read), F159
begins giving perception the same temporal depth the actuators already trust:
not just *read now*, but *wait until*.

---

## F160 — perception beyond pixels: reading a control's actual text (`window_text` / `child_windows`, R121)

**Ground: Windows Server 2022.**

**Friction.** Every perception primitive to here returned *pixels* — `capture_rgb`,
`find_color`, template match, even OCR (which *guesses* glyphs from pixels and can
be wrong: `rn`→`m`, `0`→`O`). Yet the OS already holds the **exact** text inside its
controls — an edit box's content, a label's words, a button's caption — as strings,
not images. The floor could read a window's outer *title* but never look *inside* a
window at the semantic content of its controls. So to know what was typed in a
field, it screenshotted and OCR'd a picture of text the OS could have handed over
verbatim. A human must read pixels with their eyes; the floor need not.

**Primitives.**
- `osctl.window_text(win)` → the text a window/control carries. Win32 `WM_GETTEXT`
  (cross-process safe — unlike `GetWindowText`, which only fetches titles across
  process boundaries): a title for a top-level, the live content for a child
  control. X11 reads `_NET_WM_NAME`/`WM_NAME` (window-level names; toolkits paint
  their own widgets, so that is the honest OS-visible analogue).
- `osctl.child_windows(win)` → `[{"id","class","text"}, …]`, descending into a
  window's controls (Win32 `EnumChildWindows`; X11 `XQueryTree`).

**Live (Windows, against classic `notepad.exe`, cleaned up after):**

| check | result |
|---|---|
| `window_text` on the top-level | `'Untitled - Notepad'` |
| `child_windows` finds the `Edit` control | classes `['Edit','msctls_statusbar32']` |
| type a marker, `window_text(edit)` reads it back | exact `'DAO-F160-5684'` |

R121 (`round_window_text`, 4 checks); `_probe_text.py` standalone (all pass). Full
suite **792/792** clean.

**Lesson (道法自然).** 不窺於牖，以知天道 — *without peering through the window one
knows the Way.* OCR peers through the glass (pixels) and squints to guess the text;
`window_text` asks the OS for the thing itself. 為學者日益，聞道者日損 — the pixel
path keeps *adding* machinery (capture, threshold, segment, recognise, correct) to
approximate what the semantic path gets by *subtracting* all of it and reading the
string directly. This is the first perception that is not an eye — the floor reads
meaning the OS already knows, exactly, where a human could only look and guess.
Here begins 超越人類: not a better eye, but a sense humans do not have.

---

## F161 — writing a control directly by identity (`set_window_text`, R122)

**Ground: Windows Server 2022.**

**Friction.** F160 let the floor *read* a control's text; this is its write dual.
To *fill* a field the floor otherwise had to: activate the window, ensure focus
landed on the right control, then emit keystroke after keystroke. That path is
slow (one message per character), focus-fragile (a popup or notification stealing
focus mid-type drops the rest into the void or the wrong control), and corruptible
(a stuck modifier or CapsLock — the very thing F157 exposed — silently mangles it).
The hand could only type into whatever happened to hold focus *right now*.

**Primitive.**
- `osctl.set_window_text(win, text)` → hand the exact string to a control in a
  single `WM_SETTEXT` (Win32): no focus change, no keystrokes, instant, verbatim,
  and it works even when the window is occluded or unfocused. X11 writes the
  window name (`_NET_WM_NAME`/`WM_NAME`) — toolkits own their widget text, so the
  OS-level write reaches the window's name, the honest analogue of the read side.

**Live (Windows, against `notepad.exe`, never activated or typed into):**

| check | result |
|---|---|
| `set_window_text(edit, mark)` then read back | exact `'DAO-F161-4176'` |
| a second write | replaces, not appends → `'REPLACED'` |

R122 (`round_set_window_text`, 4 checks); `_probe_settext.py` standalone (all pass).
Full suite **796/796** clean.

**Lesson (道法自然).** 為而弗恃 — *acts, yet does not rely on force.* The keystroke
path *forces* text through the narrow gate of focus, one character at a time, at
the mercy of whatever else grabs the keyboard. `WM_SETTEXT` does not push against
that gate at all — it sets the thing it means directly, 無為 in the sense of
effortless: no struggle for focus, no race with a popup, no per-key labor. F160
and F161 now form a complete semantic pair — read the meaning the OS holds, write
the meaning the OS will hold — beside the pixel/keystroke floor, not replacing it
but transcending it where the OS offers a truer door.

---

## F162 — the bridge: resolving a pixel to the control behind it (`control_at`, R123)

**Ground: Windows Server 2022.**

**Friction.** Two perception worlds had grown side by side and never touched. The
**pixel floor** (`capture_rgb`, `find_color`, template match, `window_under`) knew
*where* things are but not what they mean — a found pixel is just a colour at a
coordinate. The **semantic floor** (F160 `window_text`, `child_windows`, F161
`set_window_text`) knew *what* controls mean but had no place for them on screen —
a control handle is identity without location. So the floor could see a coloured
region and could read a control's text, but could not say *"the thing at this
pixel is that control."* Every visual find had to be re-grounded by guesswork to
act on it semantically.

**Primitive.**
- `osctl.control_at(x, y)` → `{"id","class","text","top"}`: descends to the **leaf
  control** under a screen point (Win32 `WindowFromPoint`; X11 tree descent via
  repeated `XTranslateCoordinates`), reports its class, its text (via
  `window_text`), and its owning top-level. Where `window_under` returns *which
  window* a click lands in, this returns *which control* and *what it says*. This
  is exactly what an accessibility inspector does on hover.

**Live (Windows, Notepad placed at a known rect, pointed at its centre):**

| check | result |
|---|---|
| pixel → leaf control | class `Edit` |
| control's top-level | the Notepad window (ids match) |
| control's text under the pixel | exact `'DAO-F162-5432'` |

R123 (`round_control_at`, 4 checks); `_probe_controlat.py` standalone (all pass).
Full suite **800/800** clean — the suite crosses 800.

**Lesson (道法自然).** 二生三，三生萬物 — *two beget three, and three the ten thousand
things.* The pixel world (一) and the semantic world (二) each, alone, were half-
blind; `control_at` is the 三 that joins them, and from that joining the real
repertoire becomes possible — see a thing, know what it is, read what it holds,
act on it by identity. 知人者智，自知者明: the floor already knew itself (its own
keyboard, mouse, windows) and knew the world (pixels, controls); here those two
knowings meet in a single act. Seeing becomes understanding. This is the seam
where 超越人類 stops being a slogan: a human hovering a control sees pixels and
*infers* meaning; the floor reads the meaning and the location at once, exactly.

---

## F163 — addressing a control by meaning (`find_control`, R124)

**Ground: Windows Server 2022.**

**Friction.** F162's `control_at` answered *what is at this pixel?* — location →
identity. But the far commoner question runs the other way: *where is the control
that means X?* — the OK button, the address bar, the password field. The floor had
no inverse: to act on a known control it either scanned pixels for a visual
pattern (fragile, theme-dependent) or already had to know the coordinate. A name
without a place cannot be clicked.

**Primitive.**
- `osctl.find_control(top, cls=None, text=None)` → the first control inside
  ``top`` matching class and/or text (case-insensitive substring), as
  ``{"id","class","text","rect":(x,y,w,h)}`` in **screen coordinates** — or None.
  Win32 walks `EnumChildWindows` + `GetWindowRect`; X11 recurses `XQueryTree` and
  maps each hit to absolute coords. Returning the *rect* closes the loop back to
  the actuator floor: a semantic search hands the mouse a pixel target, no visual
  scanning at all.

**Live (Windows, against `notepad.exe`):**

| check | result |
|---|---|
| find Edit by class → screen rect | `(148, 191, 704, 438)` |
| **round-trip** `find_control`→`control_at(centre)` | same control id |
| find same control by text substring | same id |
| non-existent class | `None` (no false positive) |

R124 (`round_find_control`, 5 checks); `_probe_findctl.py` standalone (all pass).
Full suite **805/805** clean.

**Lesson (道法自然).** 名與實 — *name and substance.* `control_at` reads the name
off the substance at a place; `find_control` finds the place from the name. The
round-trip — name → place → name returning the *same* control — is the proof they
are 反 (inverse), 反者道之動: the floor can now move freely between *what a thing
is* and *where it is*, in either direction, and neither is primary. And because
`find_control` ends in a pixel rect, the semantic layer does not float free of the
hand — it 復歸 (returns) to the actuator floor: understand a thing, then click
exactly where it lives. The two worlds the bridge (F162) joined are now fully
two-way, and the loop perceive → understand → locate → act is closed without one
pixel of guesswork.

---

## F164 — the verbs of an app: reading and invoking its menu (`window_menu` / `invoke_menu`, R125)

**Ground: Windows Server 2022.**

**Friction.** The floor could now read controls, locate them by meaning, write
and click them — but all of that is the *nouns* of an application (its fields, its
labels, its buttons). An app's *verbs* — Save, Copy, Find, Insert-Date — live in
its **menus**, and a menu is invisible to every screenshot until a click opens it,
then vanishes again. To run a command the floor had to *perform the choreography*:
move to the menu bar, click to open, find the item among those that appeared,
click it — every step a pixel gamble, and the whole transient structure unreadable
in between. The actions an app offers had no names the floor could see or speak.

**Primitives (Windows-native — OS menus).**
- `osctl.window_menu(win)` → the menu bar as a tree: `[{label, id, sep, items}]`,
  every leaf carrying its **command id** (`GetMenu` + `GetMenuString`/`GetSubMenu`/
  `GetMenuItemID`). The whole command vocabulary, read without opening a thing.
- `osctl.invoke_menu(win, id)` → executes a command **by its id**, posting the
  `WM_COMMAND` the menu itself would have sent — no menu opened, no mouse moved,
  no focus held, works even occluded. The verb performed by name.
- X11 returns `[]`/`False`: toolkits draw their own menus, so there is no OS menu
  to read — honest asymmetry, like the rest of the semantic layer.

**Live (Windows, against `notepad.exe`):**

| check | result |
|---|---|
| `window_menu` top-level | `['&File','&Edit','F&ormat','&View','&Help']` |
| Time/Date command located in tree | `{label:'Time/&Date\\tF5', id:26}` |
| `invoke_menu(win, 26)` then read the Edit | `'5:16 PM 6/27/2026'` (timestamp inserted) |

R125 (`round_menu`, 4 checks); `_probe_menu.py` standalone (all pass). Full suite
**809/809** clean.

**Lesson (道法自然).** 道隱無名，始制有名 — *the Way hides, nameless; once shaped, it
has names.* A menu, unopened, is the app's repertoire held latent and unnamed; the
human must *enact* it (open, hunt, click) each time to touch one verb. `window_menu`
brings the whole latent repertoire into the named and the visible at once, and
`invoke_menu` performs the chosen verb 弗為而成 — accomplished without the doing,
no choreography, no mouse, the command run straight by its name. The floor now has
both halves of agency: the *nouns* (F160–F163: read, write, locate, click a
control) and the *verbs* (F164: read and invoke an app's commands). Seeing,
understanding, and acting are all semantic now — the pixel/keystroke floor remains
underneath as the universal fallback, but where the OS offers a true name, the
floor speaks it. 超越人類: a human can hold only the menu they have opened; the
floor holds the entire command tree and fires any verb in it, instantly, by name.

---

## F165 — seeing inside modern apps: UI Automation read (`uia_name` / `uia_children`, R126)

**Ground: Windows Server 2022. Pure-ctypes raw COM — zero new dependencies.**

**Friction (surfaced by the very browser the floor runs on).** The whole semantic
layer F160–F164 reads *native* controls — real child HWNDs (`child_windows`,
`window_text`, `find_control`) and OS menus (`window_menu`). Pointed at the
**modern** app it lives beside — Chrome — it goes nearly blind: `child_windows`
returns a single generic `Chrome Legacy Window` and the menu is empty, because
Chrome (like Electron and UWP) paints its entire UI inside one HWND with no child
controls and no OS menu. The semantic floor worked on Notepad and could not see a
tab, an address bar, a button in the browser running the tests. A floor that means
to operate *everything* cannot be blind to most of today's software.

**Primitives (Windows-native; raw `IUIAutomation` COM via ctypes vtable calls).**
- `osctl.uia_name(win)` → a window's accessible **name** from the OS accessibility
  tree (the same tree a screen reader uses).
- `osctl.uia_children(win)` → its child UIA elements as `[{"name","type"}]`, where
  `type` is the control-type name (Button, Edit, Tab, Document, Pane, …) — seeing
  *inside* modern apps where `child_windows` cannot.
- Implemented in `_uia_win.py`: `CoCreateInstance(CUIAutomation)` →
  `ElementFromHandle` → `GetCurrentPropertyValue`(Name/ControlType) and
  `FindAll`(children, TrueCondition). Best-effort: any failure degrades to
  `""`/`[]`, so the backend always imports and callers fall back to the
  Win32 / pixel floor. Non-Windows returns the same empty defaults.

**Live:**

| target | `child_windows` (Win32) | `uia_children` (UIA) |
|---|---|---|
| Notepad (native) | Edit, status bar | `Edit "Text Editor"`, `StatusBar`, `TitleBar`, `MenuBar` |
| **Chrome (modern)** | **1 generic** `Chrome Legacy Window` | `"x"`, `TitleBar`, `Pane` — **sees inside** |

`uia_name`: Notepad → `'Untitled - Notepad'`, Chrome → `'x - Google Chrome for
Testing'`. R126 (`round_uia`, 5 checks); `_probe_uia.py` standalone (all pass).
Full suite **814/814** clean.

**Lesson (道法自然).** 無有入於無間 — *the formless enters where there is no gap.*
The Win32 reader needs a seam — a real child window, an OS menu — to grip; a modern
app offers none, presenting one smooth opaque HWND. UIA does not pry at the surface
but enters through the accessibility tree the app already publishes about itself,
and there the interior — tabs, panes, documents — is plainly there. This is 反者道
之動 again at the level of *which floor reads*: the native reader and the UIA reader
are opposites (one grips native seams, one reads the published tree), and the floor
needs both to perceive *all* software, not a subset. With F165 the semantic
perception is no longer a Notepad trick — it is uniform across native and modern,
and the floor can finally see the inside of the browser it has been driving blind.

---

## F166 — semantic locate inside modern apps: UIA find (`uia_find`, R127)

**Ground: Windows Server 2022. Pure-ctypes raw COM.**

**Friction.** F165 let the floor *see* inside modern apps, and F163's `find_control`
could turn a meaning into a clickable rect — but only for *native* child HWNDs.
Pointed at Chrome, `find_control` finds nothing: there are no native children to
match. So the floor could now *see* a tab or a button in Chrome (F165) yet still
had no way to turn "the element that means X" into a pixel the mouse can hit —
the modern-app half of addressing-by-meaning was missing.

**Primitive.**
- `osctl.uia_find(win, name=None, ctype=None)` → the first descendant in the
  window's **accessibility tree** matching accessible name (case-insensitive
  substring) and/or control type, as `{"name","type","rect":(x,y,w,h)}` in screen
  coordinates — or None. The UIA analogue of `find_control`, but it reaches
  *inside* Chrome/Electron/UWP. `FindAll(Descendants, TrueCondition)` then filter;
  the rect comes from the `BoundingRectangle` property (a SAFEARRAY of 4 R8 parsed
  in ctypes). Returning the rect closes the loop back to the pixel actuator for
  modern apps too.

**Live:**

| check | result |
|---|---|
| `uia_find(notepad, type=Edit)` → rect | `(168, 211, 704, 438)` |
| **cross-floor:** that rect's centre → `control_at` | native `Edit` (same place) |
| `uia_find(chrome, type=Pane)` → rect | `(8, 0, 1284, 732)`, inside the window |

R127 (`round_uia_find`, 4 checks); `_probe_uiafind.py` standalone (all pass). Full
suite **818/818** clean.

**Lesson (道法自然).** The deep proof here is the **cross-floor agreement**: a thing
located through the accessibility tree (UIA, *meaning*) and the same thing read
through the pixel/native floor (`control_at`, *substance*) return the **same place**.
天得一以清，地得一以寧 — *the one obtained, and all is settled.* Two utterly different
descriptions of reality — the published semantic tree and the raw window-from-point
— converge on one coordinate; that convergence is what makes acting on understanding
*trustworthy*. And it is the modern-app completion of 反者道之動: F163 (native
locate) and F166 (UIA locate) are the two opposites whose union lets the floor turn
*any* meaning, in *any* app, into a pixel the hand can strike — perceive →
understand → locate → act, now universal.

---

## F167 — acting inside modern apps: UIA value write & invoke (`uia_set_value` / `uia_get_value` / `uia_invoke`, R128)

**Ground: Windows Server 2022. Pure-ctypes raw COM.**

**Friction.** F165–F166 gave the floor *sight* and *locate* inside modern apps,
but its semantic *actions* were still native-only: `set_window_text` writes a
control by its HWND, `invoke_menu` posts a WM_COMMAND to an OS menu — and a modern
app has neither. So the floor could see a Chrome address bar and find its rect, yet
to *fill* it still had to fall back to clicking the pixel and typing. The
semantic-action half of the modern-app loop was missing.

**Primitives (UIA control patterns via raw COM).**
- `osctl.uia_set_value(win, value, name=None, ctype=None)` → writes a field's value
  through the **ValuePattern** of an element found by meaning — the modern-app dual
  of `set_window_text`, reaching inside Chrome/Electron/UWP.
- `osctl.uia_get_value(win, …)` → its read dual (ValuePattern get_CurrentValue).
- `osctl.uia_invoke(win, name=None, ctype=None)` → presses a button/link via the
  **InvokePattern** — the UIA analogue of `invoke_menu`, no mouse, no pixels.
- Implemented via `IUIAutomationElement::GetCurrentPattern` (vtable 16) → the
  pattern interface, then its method (SetValue/Invoke at vtable 3). BSTR args via
  `SysAllocString`.

**Live (Notepad, cross-floor):**

| check | result |
|---|---|
| `uia_set_value(note, mark, type=Edit)` | `True` (through ValuePattern) |
| native `window_text` reads it back | `'DAO-F167-…'` — **exactly the UIA-written value** |
| `uia_get_value` callable → str | `str` (multiline Document returns "" on read — a real UIA quirk) |

R128 (`round_uia_value`, 4 checks); `_probe_uiaval.py` standalone. Full suite
**822/822** clean (the harness even self-recovered its CDP link after the round —
the live floor proving its own resilience).

**Lesson (道法自然).** 為而弗恃 — *act, yet do not lean on it.* The UIA write does not
seize the field by force (focus, keystrokes, pixels); it asks the accessibility
contract the app already honours, and the value is simply *there* — confirmed by an
entirely independent floor (native `window_text`) reading back precisely what was
written. That two unrelated mechanisms — the accessibility write and the native
read — agree to the character is the same 得一 (obtaining-the-one) convergence as
F166, now on the *action* side. The modern-app loop is whole: **see** (F165) →
**locate** (F166) → **write/press** (F167), each a true semantic verb, each falling
back to the universal pixel/keystroke floor only when no contract is offered. The
floor now operates native and modern software alike, by meaning, end to end.

---

## F168 — driving a modern UWP app by pure meaning + exact-preferred match (R129)

**Ground: Windows Server 2022. Windows Calculator (UWP).**

**Friction (surfaced only by actually driving an app, not by probing one call).**
F165–F167 each verified a *single* UIA call. The real test is a *sequence*: take
the Calculator — a UWP app with one HWND, no native controls, no OS menu — and
compute `5 + 3 = 8` entirely by meaning. Doing so immediately exposed a defect in
the matcher: `uia_invoke(name="Add")` pressed **"Memory add"**, because name
matching was *substring* and "Memory add" appears earlier in the tree than "Add".
A semantic floor that picks the wrong verb because another verb happens to contain
its name as a substring is not trustworthy — the friction only appeared because a
real multi-step task was run, exactly as 道法自然 predicts.

**Fix.** `_find_ptr` (shared by `uia_find` and all UIA action helpers) now prefers
an **exact** case-insensitive name match anywhere in scope, keeping the first
substring hit only as a fallback. `uia_find(name="Add")` → "Add", never "Memory
add"; `find_control`-style "by meaning" is preserved for partial names.

**Live (no pixels, no coordinates, no keystrokes):**

| step | call | result |
|---|---|---|
| press 5, +, 3, = | `uia_invoke(calc, name=…, ctype="Button")` ×4 | all True |
| read the answer | `uia_find(calc, name="8", ctype="Text")` | `Text "8"` — **5 + 3 = 8** |
| exact match | `uia_find(calc, name="Add", ctype="Button")` | `"Add"` (not "Memory add") |

R129 (`round_uia_drive`, 3 checks); `_probe_uiadrive.py` standalone. Full suite
**825/825** clean.

**Lesson (道法自然).** 大成若缺，其用不敝 — *great completion seems flawed, yet its use
never fails.* The whole UIA arc (F165–F167) looked complete after single-call
proofs, but only an actual end-to-end task revealed the substring flaw; the
completion was *seeming*, the use would have failed in practice. This is the method
itself, demonstrated: 為學者日益，聞道者日損 — do not add speculative features; run the
real thing until a real contradiction surfaces, then resolve exactly that. The
payoff is concrete and beyond a human's reach: the floor computed an arithmetic
result by reaching into a modern app's accessibility tree and pressing its verbs by
name — no screen reading, no aiming, no typing — the see→locate→act loop closed on
software a screenshot-and-click operator can only fumble at.

---

## F169 — bridging semantic locate to the keyboard floor: UIA focus (`uia_focus`, R130)

**Ground: Windows Server 2022.**

**Friction.** `uia_set_value` (F167) writes through the ValuePattern — but not every
modern input offers one. Rich-text editors, `contenteditable` regions, custom
canvas widgets expose no ValuePattern at all; the floor could *find* them (F166) and
*see* them (F165) yet had no semantic way to put text in them. The only fallback was
to compute a pixel and click — back to aiming.

**Primitive.**
- `osctl.uia_focus(win, name=None, ctype=None)` → moves keyboard focus to an element
  found by meaning, via UIA `SetFocus` (IUIAutomationElement vtable 3). Once focused,
  the *universal keyboard floor* (`osctl.tap`/`key_down`/`key_up`) types into it.

**Live:** `uia_focus(notepad, type=Edit)` → True; then tapping `d`,`a`,`o` on the
keyboard floor yields `window_text == "dao"` — the keystrokes landed in the element
that was focused purely by meaning. R130 (`round_uia_focus`, 3 checks);
`_probe_uiafocus.py` standalone. Full suite **828/828** clean.

**Lesson (道法自然).** 天下之至柔，馳騁於天下之至堅 — *the softest in the world overruns the
hardest.* The accessibility tree (soft, abstract, just names) and the raw keyboard
(hard, physical, just scancodes) are the two extremes of the stack; `uia_focus` is
the hinge where the soft meaning steers the hard keystroke. The two floors that
looked independent — semantic UIA and the universal keyboard — turn out to
*cooperate*: UIA does the one thing the keyboard cannot (aim by meaning), the
keyboard does the one thing UIA cannot here (deliver text where no ValuePattern
exists). 弱也者，道之用也 — the floor doesn't force a single mechanism to do everything;
it lets each be weak where another is strong, and the whole becomes able to put text
into *any* field, ValuePattern or not.

---

## F170 — reading text OUT of a modern app: UIA TextPattern (`uia_text`, R131)

**Ground: Windows Server 2022. Chrome.**

**Friction (surfaced by probing the read side across both worlds).** The floor had
three text reads, each blind outside its world: `window_text` (native HWND only —
Chrome has no native text to `WM_GETTEXT`), `uia_get_value` (single-line
ValuePattern — returns "" for a document body, confirmed live: Chrome's Document
ValuePattern read is empty), and `uia_name` (the element's label, not its content).
There was no way to read the *rendered body text* of a modern document.

**Primitive.**
- `osctl.uia_text(win, name=None, ctype=None, max_len=20000)` → the element's full
  text via the UIA **TextPattern** (`get_DocumentRange` → `GetText`), the
  accessibility tree's own text spine. Reaches into Chrome/Electron pages and rich
  editors. "" if no TextPattern.

**Live:** Chrome navigated to `data:text/html,<h1>DAOFLOW-MARKER-7</h1>…`;
`uia_text(chrome, ctype="Document")` → `"DAOFLOW-MARKER-7 the floor reads me"`, while
`uia_get_value` on the same Document returns `""` — proving TextPattern is the
*necessary* deep read, not a duplicate of the value spine. (Chrome enables its a11y
tree lazily when a UIA client first asks, so the read retries briefly.) Vtable
indices confirmed by probe before integration: TextPattern `get_DocumentRange` = 7,
TextRange `GetText` = 12. R131 (`round_uia_text`, 2 checks); `_probe_uiatext.py`
standalone. Full suite **830/830** clean.

**Lesson (道法自然).** 知其白，守其黑 — *know the white, keep to the black.* Three reads
each shone in their own light and were dark elsewhere; completeness was not one read
that does everything but knowing exactly where each is dark and growing the one that
illuminates it. The perception floor now reads text from native controls
(`window_text`), value fields (`uia_get_value`), labels (`uia_name`), and now the
rendered body of modern documents (`uia_text`) — each kept to its own province, the
set of them leaving no dark corner. 大方無隅 — the great square has no corners; the
whole has no blind edge precisely because each piece admits its limit.

---

## F171 — the toggle verb + an async-race lesson: UIA TogglePattern (`uia_toggle`/`uia_toggle_state`, R132)

**Ground: Windows Server 2022. Chrome checkbox.**

**Friction.** The modern-app action set had press (`uia_invoke`), write
(`uia_set_value`), aim (`uia_focus`) — but a checkbox is none of those; it is a
*state to flip*. There was no semantic way to toggle it short of computing a pixel
and clicking.

**Defect surfaced by driving it (the real lesson).** The first `uia_toggle` issued
the flip *and* read back the new ToggleState to return it. Live, that returned
`"off"` — yet the DOM `.checked` was already `True` and a read a moment later said
`"on"`. Chrome updates its UIA ToggleState **asynchronously** across the
accessibility bridge; reading it in the same breath as the flip is stale. So the
primitive was redesigned: `uia_toggle` returns only **whether it acted** (True), like
`uia_invoke`, and the settled state is read by `uia_toggle_state` afterward.

**Primitives.**
- `osctl.uia_toggle(win, name, ctype)` → True if the flip was issued (TogglePattern
  `Toggle`, vtable 3).
- `osctl.uia_toggle_state(win, name, ctype)` → `"on"`/`"off"`/`"indeterminate"`/`""`
  (TogglePattern `get_CurrentToggleState`, vtable 4) — the read dual.

**Live:** Chrome `<input type=checkbox>`; initial state `"off"`; `uia_toggle` → True,
DOM `.checked` → True; settled `uia_toggle_state` → `"on"`. R132 (`round_uia_toggle`,
3 checks); `_probe_uiatoggle.py` standalone. Full suite **833/833** clean.

**Lesson (道法自然).** 為而弗恃 — *act, but do not presume.* The flawed design presumed
the action's result was instantly knowable by the actor; the bridge proved it is not.
Separating *acting* from *knowing* is not a workaround but the correct shape: the
verb reports that it acted, the read reports what now *is*, after the world has
settled. 生而弗有，為而弗恃，長而弗宰 — the floor does the deed and lets the truth be read
from the world, rather than asserting the outcome from its own act. Every write still
demands its read dual (反者道之動), and here the dual is not decoration but the *only*
honest source of the post-state.

---

## F172 — the selection verb: UIA SelectionItemPattern (`uia_select`/`uia_is_selected`, R133)

**Ground: Windows Server 2022. Chrome radio buttons.**

**Friction.** Toggle (F171) flips a two-state checkbox; but choosing *one of many* —
a radio button, a list option, a tab — is a different verb the floor lacked. There
was no semantic way to pick one short of computing its pixel and clicking.

**Primitives (the same act/read split the toggle race taught).**
- `osctl.uia_select(win, name, ctype)` → True if `Select` was issued
  (SelectionItemPattern `Select`, vtable 3).
- `osctl.uia_is_selected(win, name, ctype)` → True / False / None (no pattern)
  (SelectionItemPattern `get_CurrentIsSelected`, vtable 6) — the settled read dual.

The action returns only that it acted; selection (like toggle) settles
asynchronously across the a11y bridge, so the post-state is read separately.

**Live:** Chrome `<input type=radio>` Alpha/Beta; `uia_is_selected("Beta")` → False;
`uia_select("Beta")` → True, DOM `r2.checked` → True; settled
`uia_is_selected("Beta")` → True. R133 (`round_uia_select`, 3 checks);
`_probe_uiaselect.py` standalone. Full suite **836/836** clean.

**Lesson (道法自然).** 多藏必厚亡 — *the more hoarded, the greater the loss.* A checkbox
and a radio look alike, and a naive floor would force one verb (Toggle) onto both;
but a radio is not a toggle — it is a *choice within a set*, and pressing it does not
"flip" it, it *elects* it (and de-elects its siblings). Honoring the distinct pattern
the platform already publishes (SelectionItem, not Toggle) is 因而制之 — model after
what is, do not impose. The verb set grows by the world's own joints, not the floor's
convenience: press / write / aim / flip / **choose**.

---

## F173 — the reveal verb: UIA ExpandCollapsePattern (`uia_expand`/`uia_collapse`/`uia_expand_state`, R134)

**Ground: Windows Server 2022. Chrome `<details>` disclosure.**

**Friction.** Some structure does not exist on screen until *revealed* — a dropdown's
options, a tree node's children, a `<details>` disclosure's body. Every read and
action verb the floor had operated on what was already present; none could *make
hidden structure appear*. Without a reveal verb, half a modern UI's content is
unreachable except by hunting a pixel and clicking.

**Primitives (the act/read split, now habitual).**
- `osctl.uia_expand(win, name, ctype)` → True if `Expand` was issued (vtable 3).
- `osctl.uia_collapse(win, name, ctype)` → True if `Collapse` was issued (vtable 4).
- `osctl.uia_expand_state(win, name, ctype)` →
  `"collapsed"`/`"expanded"`/`"partial"`/`"leaf"`/`""` (vtable 5) — the settled read.

**Live:** Chrome `<details><summary>MORE</summary>`; initial `"collapsed"`,
DOM `.open`=False; `uia_expand` → True, DOM `.open`=True, settled `"expanded"`;
`uia_collapse` → True, DOM `.open`=False. R134 (`round_uia_expand`, 3 checks);
`_probe_uiaexpand.py` standalone. Full suite **839/839** clean.

**Lesson (道法自然).** 天下萬物生於有，有生於無 — *all things are born of the manifest, and the
manifest of the hidden.* A UI's full content is not all manifest at once; much waits,
latent, behind a disclosure. The reveal verb is how the floor calls the hidden into
the manifest so the rest of perception can act on it — expand, then read the children
that did not exist a moment before. 啟其悶，濟其事 — open what is shut, and the work can
proceed. With this the modern-app verb set is whole across the common joints:
press / write / aim / flip / choose / **reveal**, each with its settled read dual.

---

## F174 — bringing an element into reach: UIA ScrollItemPattern (`uia_scroll_into_view`, R135)

**Ground: Windows Server 2022. Chrome, a button 3000px below the fold.**

**Friction.** An element below the fold has *no on-screen pixels* — the pixel
executor cannot click what is not painted, and `uia_find` returns a rect outside the
window. The floor could locate the element by meaning but could not *reach* it.

**Primitive.**
- `osctl.uia_scroll_into_view(win, name, ctype)` → True if `ScrollIntoView` was
  issued (ScrollItemPattern, vtable 3) — asks the element's own scroll container to
  bring it into the viewport.

**Live (cross-floor proof):** Chrome page with a button at `rect.top=3029`
(`innerHeight=645`, below the fold); `uia_scroll_into_view("BOTTOMBTN")` → True,
`scrollY` 0→2413, button `rect.top`→616 (in view); and crucially `uia_find` then
returns rect `(16, 703, 100, 21)` *inside* the window `0..740` — the pixel executor
can now reach what had no pixels a moment before. R135 (`round_uia_scroll`, 3 checks);
`_probe_uiascroll.py` standalone. Full suite **842/842** clean.

**Lesson (道法自然).** This is the element-level twin of F149 (moving an off-screen
*window* back on screen): there the unit of reach was a window, here it is an element
within a scroll container, but the principle is one — 將欲取之，必固張之 — to act on a
thing you must first bring it within reach. Locating by meaning is not enough;
*reaching* completes it. And the completion is cross-floor: the semantic verb
(ScrollIntoView) hands the pixel floor a now-valid rect — 天得一以清，地得一以寧 — the two
worlds agree on one place, the seen and the meant made to coincide so the deed can
land.

---

## F175 — the magnitude verb: UIA RangeValuePattern (`uia_range_value`/`uia_set_range_value`, R136)

**Ground: Windows Server 2022. Chrome `<input type=range>`.**

**Friction.** A slider, a progress bar, a scrollbar is neither a field of text
(ValuePattern), nor a state to flip (Toggle), nor a choice among items (Selection) —
it is a *number within bounds*. To set it the floor would otherwise have to compute
the pixel offset along the track and drag — brittle arithmetic over a moving target.

**Primitives.**
- `osctl.uia_range_value(win, name, ctype)` → `{"value", "min", "max"}` (floats) or
  None (RangeValuePattern `get_CurrentValue`/`Maximum`/`Minimum`, vtable 4/6/7).
- `osctl.uia_set_range_value(win, value, name, ctype)` → True if `SetValue` succeeded
  (vtable 3, the value passed as a C `double` through the COM call) — set a slider to
  a number directly, no mouse drag. The provider clamps to its own min/max.

**Live:** Chrome slider min=0/max=100/value=20; `uia_range_value` → that triple;
`uia_set_range_value(75)` → True, DOM `.value`→"75"; read-back → 75. (Unlike
toggle/select this read settles synchronously.) R136 (`round_uia_range`, 3 checks);
`_probe_uiarange.py` standalone. Full suite **845/845** clean.

**Lesson (道法自然).** 圖難於其易 — *plan the hard through the easy.* Setting a slider by
dragging its handle along a pixel track is the hard way — fragile to skin, scale, and
sub-pixel rounding; the platform already publishes the easy way, a number with known
bounds, and the floor merely speaks it. The C `double` crossing the raw COM vtable is
the one new mechanical wrinkle (every prior pattern took ints or void) — proven by
probe before integration, in keeping with 千里之行，始於足下. The semantic verb set now
matches the kinds of controls the world actually has: text / state / choice / reveal /
reach / **magnitude**.

---

## F177 — the keyboard floor crosses to its own ground: X11 truncation + the unmapped key (R137)

**Ground: Ubuntu 22.04, X11 (KDE Plasma), 64-bit. The agent's *own* VM — not the
Windows host reached over the bridge, but the machine it actually runs on.**

**Friction.** F157–F159 grew the keyboard/mouse read floor and proved it on
Windows Server 2022. Run end-to-end on *this* ground for the first time, the live
suite did not fail a check — it **died**: a bare `Segmentation fault`, exit 139,
the whole process gone, taking every later round with it. Re-run, it died at a
*different* round (R115 once, R118 the next) — the signature of memory corruption,
not a logic bug. And once that was past, a second, different death: `X Error …
BadValue … XTEST … keycode 0x0`, exit 1 — a fatal protocol error on a key *press*.
Two crashes hiding in primitives that were "green" on the other ground.

**Mechanism (two, both pointer-deep).**
1. `key_state` calls `XQueryKeymap` and `XkbGetState`. Every *other* X call in the
   backend declares its `argtypes`, so the 64-bit `Display*` (held as a Python int
   since `XOpenDisplay.restype = c_void_p`) is widened correctly. These two had no
   `argtypes` — so `ctypes` defaulted the first argument to a 32-bit `c_int` and
   **truncated the pointer**; libX11 then dereferenced a garbage half-address →
   SIGSEGV. Non-deterministic in *where* it killed the suite because the corruption
   landed wherever the heap happened to put things that run.
2. The VK→keysym table (`_VK_KEYSYM`) carried no entry for CapsLock (`0x14`) or
   NumLock (`0x90`). `key_state` could *read* their locked-mod latch, but
   `_vk_keysym` fell through to `return vk`, `XKeysymToKeycode` could not resolve
   the bogus keysym and returned **keycode 0**, and `XTestFakeKeyEvent(_, 0, …)` is
   a fatal `BadValue` — the default Xlib error handler calls `exit()`. So the
   keyboard could read the lock but never actuate it, and *trying* to killed the
   process. 知人者智，自知者明 — the self-knowing (read) had outrun the self-acting
   (write); the two had to be made whole on this ground too.

**Fix (no new verb — the existing ones made true here).**
- Declare `XQueryKeymap`/`XkbGetState` `argtypes` (`Display*` as `c_void_p`) so the
  pointer crosses intact. The read no longer corrupts memory.
- Add `0x14→XK_Caps_Lock`, `0x90→XK_Num_Lock` to `_VK_KEYSYM` — the write side can
  now actuate the very latches the read side already saw.
- Guard `key_down`/`key_up`: an unmapped keysym yields keycode 0, and the honest
  floor **does nothing** with it rather than handing XTEST a fatal value. A press
  that cannot be expressed is a no-op, never a crash.

**Live (this VM):** `_probe_keystate.py` — Shift up→held→released reads
`down` False→True→False; CapsLock read→toggle→toggle-back reads `toggled`
False→True→False (5/5). `_probe_mousestate.py` 5/5, `_probe_pixel.py` 3/3. And the
whole suite, which before could not *reach* its own end on Linux, now runs to
completion end-to-end.

**Lesson (道法自然).** 上士聞道，堇而行之 — a floor is only known when it is *walked*,
and walked on its own ground. Every primitive here was "proven" — on Windows. The
Way moved the moment the same code touched the earth it actually stands on: 反也者，
道之動也. The deepest faults were not in the grand verbs but in the smallest
crossing — a pointer's width, a key with no name on this keymap — invisible until
the ground itself pushed back. 圖難於其易，為大於其細：the segfault that looked like
chaos was one missing line of intent (`argtypes`), and the fatal error one missing
pair of names. To operate *its own machine* the agent first had to stop killing
itself on it.

---

## F178 — the semantic floor opens its eyes on Linux: AT-SPI, the dual of UIA

**Ground: Ubuntu 22.04, X11 (KDE Plasma). The agent's own VM.**

**Friction.** F165 grew `uia_name`/`uia_children`/`uia_find`/`uia_invoke`/
`uia_get_value`/`uia_set_value` — the semantic layer that reaches *inside* a
modern app where Win32 child-window enumeration is blind. It was proven on
Windows through UIA. On *this* ground the X11 backend supplied **none** of those
verbs, so `osctl` bound every one to its no-op fallback (`uia_name → ""`,
`uia_children → []`, `uia_invoke → False`). `window_text`/`child_windows` say so
in their own docstrings: on X11 a toolkit paints its **own** widgets, so the X
server sees only a window title and opaque sub-windows — the buttons, menu items
and edit fields *inside* a real app are invisible to it. The floor could move a
mouse and read pixels, but it could not name a single control of the very
applications it was meant to operate. 瞽者善聽 — it heard (pixels) but did not
see (meaning). The whole point — to surpass screenshot-and-click — was missing
its other half on Linux.

**Mechanism.** The Linux dual of Windows UIA is **AT-SPI** (the at-spi2
accessibility bus): a session-bus service through which a toolkit exposes its
accessible tree — role, name, geometry, and the Action/Text/EditableText/Value
interfaces. The capability was *present but dark*: `libatspi.so.0` ships the
whole client API, but the registry daemon (`at-spi2-core`) was not installed,
and no process had asked the toolkits to expose themselves. Nothing was broken —
the floor simply had no organ for this sense yet.

**Fix (grow the organ, same discipline as libX11/libXtst — pure ctypes, no gi).**
- Bind `libatspi.so.0` directly by `ctypes`, lazily and once (`_atspi()`), every
  call declaring `argtypes`/`restype` (the F177 lesson: a 64-bit handle silently
  truncated is a segfault waiting — and it bit again here, see below). If the
  a11y bus is absent, init fails *quietly* and every verb returns its empty
  default. An unseen floor, never a broken one.
- Map an X window → its AT-SPI frame by **process id** (`_NET_WM_PID` ==
  `atspi_accessible_get_process_id`), the title disambiguating multiple frames —
  identity crossing two worlds that share no handle.
- Implement the **same `uia_*` verbs** on this ground so the floor is *one* and
  only the earth differs: `uia_name` (frame's accessible name), `uia_children`
  (every real control inside, with role + screen rect — what `child_windows`
  could never see), `uia_find` (locate by name/role → screen rect: the bridge
  that turns *meaning* into geometry the pixel/input floor can click),
  `uia_invoke` (fire a control's default Action), `uia_get_value`/`uia_set_value`
  (read/write a field's text via Text/EditableText), `uia_focus`.

**Friction inside the fix (反也者，道之動也, twice over).** First live call:
`Segmentation fault` again — `atspi_rect_free` had no `argtypes`, so the
`AtspiRect*` returned by `get_extents` was truncated to 32 bits and freed as
garbage. The *identical* pointer-width fault as F177, in a new library: declare
its `argtypes` and it is gone. Second: the depth-first search that returns a live
accessible was unref'ing the very node it found — a tree-walk that frees its own
answer — because the "don't double-free" guard (`r is not c`) fired on the match
itself. Each accessible holds an independent ref (`get_child_at_index` is
transfer-full), so the rule is exact: unref every child *except* the one the
match came through. 圖難於其易 — the deep fault was again in the smallest
crossing (a pointer's width; one identity comparison).

**Live (this VM).** Two grounds, two toolkits, no pixels and no keystrokes:
- **Qt / KWrite** (`_probe_atspi.py`, 5/5): `uia_name` → `'atspi_demo.txt '`;
  `uia_children` sees **314** real controls incl `File`/`Edit`/`Save`/`Open...`;
  `uia_find('Save', button)` → screen rect `(648,376,72,29)`; `uia_invoke('New')`
  presses it by meaning and a fresh **`Untitled — KWrite`** window appears,
  observed independently through the window manager.
- **GTK / zenity** (`_probe_atspi_gtk.py`, 4/4): `uia_set_value` types
  `'operated purely by meaning'` into the entry, `uia_get_value` reads it back,
  `uia_invoke('OK')` submits — and zenity's **own stdout** prints exactly that
  string: independent proof the dialog was driven entirely by meaning.

Capability is honestly toolkit-dependent (KWrite's editor exposes `Text` but not
`EditableText`; a disabled button's Action no-ops) — and the floor degrades to a
truthful `False`/`""` rather than pretending or crashing. Where a toolkit's
Action is incomplete, `uia_find`'s rect is the universal fallback: meaning →
geometry → the existing gesture floor.

**Runtime note.** Needs `at-spi2-core` installed and the process to carry
`DBUS_SESSION_BUS_ADDRESS` of the live desktop session (the a11y bus is then
auto-discovered). Both belong in the environment blueprint so future sessions
inherit the sense.

**Lesson (道法自然).** 知人者智，自知者明 — to know others is wit; to know
oneself is light. The agent already saw the *outside* of its machine (pixels) and
the *inside* of the browser (CDP); AT-SPI is how it finally sees the inside of
every other app — by meaning, not by reading rendered light. 視之不足見，聽之不足
聞，用之不可既：the accessible tree was always there, emitting nothing to the eye;
the floor grew the organ to receive it. 無有入於無間 — the formless (meaning)
enters where there is no gap, reaching inside a window the X server held as one
opaque rectangle. The floor is now whole on its own ground: it perceives, it
finds, it acts — 無為而無不為.

---

## F179 — the two floors become one: invoke falls through to a real click (`uia_click`)

**Ground: Ubuntu 22.04, X11 (KDE Plasma). The agent's own VM.**

**Friction.** F178 ended on a promise: *where a toolkit's Action is incomplete,
`uia_find`'s rect is the universal fallback — meaning → geometry → the gesture
floor*. The promise was not yet kept in code. Walk KWrite's accessible tree and
**347** controls carry a screen rect; exactly **one** of them — the editor text
region itself (`role=text`, rect `(81,98,998,743)`) — exposes **no Action
interface at all**. It is the most important surface in the whole window, and
`uia_invoke` found it and then had nothing to fire: `get_action_iface → NULL →
return False`. A toolkit wires *some* controls for accessibility (buttons, menu
items) and leaves the content surfaces (a text canvas, a drawing area, a custom
widget) to be *clicked* like a human would. The semantic floor could **name**
that region but could not **act** on it — a second, narrower blindness exactly
where the work matters most.

**Mechanism.** There was never a missing capability here — only a missing
*join*. The pixel/gesture floor (move + XTEST click) already lands a click
anywhere on screen; the semantic floor already turns a name/role into a screen
rect (`uia_find`). The two were strangers. The bridge is one function:
`_click_rect(win, rect)` — raise the owning window so the click reaches it, aim
at the rect's centre, press/release through the *same* XTEST path every other
click uses. Semantics choose *what*; pixels deliver the *where*.

**Fix (grow the smallest joining primitive).**
- `uia_click(win, name, ctype)` — the join made explicit: locate a control purely
  by meaning, then land a real click on its rect. Answers for **any** visible
  control regardless of whether the toolkit made it actionable.
- `uia_invoke` now **falls through** to that same path: try `Action.do_action(0)`
  first (the clean, no-pixel route when a control offers it); only if there is no
  Action, or it refuses, locate the rect and click it. So invoke-by-meaning is
  total — a button fires through its Action, a text region answers through a
  click, and the caller need not know which.

**Live (this VM, `_probe_atspi_click.py`, 2/2).**
- **Invoke-fallback on the no-Action region**: cursor parked outside at
  `(76,93)`; `uia_invoke(ctype="text")` now returns `True` and the cursor lands
  at `(580,469)` — *inside* the rect meaning located. The verb that had nothing
  to fire now acts.
- **Click + type round-trip**: `uia_click(ctype="text")` places the caret by
  meaning; the universal keyboard floor types `F179 union-of-floors 道法自然`
  (CJK and all); the toolkit's *own* text reads straight back through the
  semantic floor (`uia_get_value → 'F179 union-of-floors 道法自然'`). Located by
  meaning, acted by gesture, confirmed by meaning — the loop closes on itself.

**Lesson (道法自然).** 天下之至柔，馳騁於天下之致堅；無有入於無間 — the softest
(meaning) rides through the hardest (an opaque content surface the toolkit never
wired); the formless enters where there is no gap. The floor stops being two
separate organs — an eye that sees meaning, a hand that strikes pixels — and
becomes one body where the eye guides the hand without a seam. 大成若缺，其用不敝:
the whole is complete precisely by keeping the humble fallback. 無為而無不為 — by
not forcing every control into one mechanism, every control is operable.

---

## F180 — the semantic floor survives a *living* tree: walk in an ephemeral body

**Ground: Ubuntu 22.04, X11 (KDE Plasma). The agent's own VM.**

**Friction (a real app, found by using it).** Installed `gnome-calculator` (GTK)
and drove arithmetic purely by meaning: `uia_invoke('7'), ('+'), ('5'), ('=')` —
every press returned `True`. Then read the answer back by walking the tree
again — and the **whole floor process segfaulted** (exit 139), each time after a
flurry of GLib screams: `invalid unclassed pointer in cast to 'AtspiObject'`,
`g_object_unref: assertion 'old_ref > 0' failed`. The arithmetic worked; *seeing
its result* killed the floor. KWrite (F178/F179, 314–347 controls) never did
this — the difference is that a calculator **rebuilds its accessible tree on
every `=`**, and its tree is large and volatile (407→422 nodes, 325 of them menu
items that pop in and out).

**Mechanism (the deepest pointer fault yet — not ours alone).** Every
synchronous AT-SPI call pumps libatspi's own GLib event loop while it waits for
the D-Bus reply. During that pump, libatspi processes the app's
*children-changed / defunct* events and **force-finalizes** any node whose remote
peer just died — *regardless of the ref we hold*. So a long-lived walker that
collects child refs and unrefs them as it recurses will, on a mutating tree,
eventually call `g_object_unref` on an object libatspi already freed → the
`old_ref > 0` double-free → SIGSEGV. Three escalating fixes proved the diagnosis:
a `STATE_DEFUNCT` guard before touching a node *reduced* the crash but lost the
TOCTOU race; fetching children **one at a time** (never holding a fistful of
sibling refs) reduced it further but still lost; making `_unref` a **no-op
(leak)** ran 15/15 hard cycles spotless — proving the fatal call is precisely our
unref of a node the toolkit's own event loop already reclaimed.

**Fix (grow the smallest robust primitive — give the volatile work its own
ephemeral body).** Not unref'ing is crash-proof but leaks in a long-lived floor.
Both horns dissolve at once if the walk runs in a **short-lived worker process**:
- `_atspi_call(verb, win, **kw)` spawns `python3 _osbackend_x11.py
  __atspi_worker__ <req>`; the child sets `_LEAK_REFS = True`, runs the one verb,
  prints a tagged JSON result, and `os._exit(0)`.
- In that ephemeral body **leaking is free** — the OS reclaims every byte the
  instant it exits — so the walk *never unrefs a dead node and never crashes*.
- The long-lived parent floor never touches the fragile tree, so it can **neither
  crash nor leak**. A worker that dies anyway on a truly pathological tree just
  yields the verb's honest empty (`""`, `[]`, `None`, `False`) — degradation, not
  death. The eight `uia_*` verbs are unchanged; only *where* they run moved
  (`uia_X` → thin wrapper → `_atspi_call` → `_impl_uia_X` in the child).

**Live (this VM, `_probe_atspi_calc.py`, 2/2).**
- **Arithmetic by meaning, checked against the app's own readout**: `123 × 8`
  driven entirely through `uia_invoke`, and `uia_children` reads `984` straight
  off the calculator's own display — an oracle the floor cannot fake.
- **The mutation race is gone**: 12 interleaved `press(7,+,9,=)` + full re-walk
  cycles on the live, rebuilding tree — **no segfault**, every walk returns. The
  exact sequence that killed the floor now runs to completion.
- **No regression**: KWrite `uia_name/children/find` and the F179 invoke→click→
  type→`get_value` round-trip (CJK and all) still pass through the new isolation;
  `find`'s rect survives the JSON crossing as a tuple.

**Lesson (道法自然).** 出生入死 — what lives also dies; the accessible tree is
not a fixture but a *living* thing that is born and torn down under your hand. To
read a living thing safely, do not grip it in a body that must outlive it; lend
it a body that dies with the reading. 夫唯不爭，故天下莫能與之爭 — by *not*
contending to free what the toolkit already freed, the floor cannot be made to
crash. 無有入於無間: the formless worker enters the volatile tree, takes what it
needs, and dissolves, leaving the long-lived floor untouched — 生而弗有，為而弗恃.
(Known, deliberately un-pre-solved: the per-call spawn costs latency; a persistent
recycling worker is the next optimization, to be grown only when a real workload
makes that friction bite.)

---

## F181 — operate a native OpenGL canvas app by meaning (`locate_labels`) · Blender

**Friction (反者道之動 — push into the hardest GUI, let the floor's blindness show).**
Installed Blender (3D modelling, a self-drawn OpenGL viewport — no toolkit widgets)
and tried to operate it with the floor. Two senses failed in succession:
- **Semantic floor is blind here, and says so.** `uia_name(blender)` → `''`,
  `uia_children(blender)` → `[]`. Blender paints its whole UI on one GL canvas; it
  exposes no AT-SPI tree. Honest empty, not a crash — but no control has a name.
- **The OCR path cannot help either.** Every reader since F103 (`read_text`,
  `locate_word`) needs an *atlas* of the target font's glyphs, and the only atlas
  the floor can build is rendered by **itself on a browser scratch canvas** — a
  font Blender does not use. Harvesting an atlas from Blender's *own* rendering
  founders one rung lower, on **glyph segmentation**: its ~9px proportional
  anti-aliased labels fuse and split unreliably (`"File"` happens to cut into 4,
  but `"Render"` shatters into 12). Per-glyph reading is simply lost on small
  native type. So the floor could not act on Blender at all.

**Mechanism (the seam that was missing).** You do not need to *read* a menu to
*act* on it. A menu bar / dropdown / toolbar is an **ordered sequence of *known*
labels parted by wide blank space**, and the item-level gaps are far larger and
far more reliable than the inter-letter gaps that defeat glyph OCR. If you already
know *which* labels are there and *in what order* (you do — you wrote "Add → Mesh →
Cube"), you never have to recognise a glyph; you only have to *count runs* and pair
them to your list in reading order. 瞽者善聽，聾者善視 — blind to glyphs, the floor
sees by the one source it can trust: the rhythm of blank space between items.

**Primitive grown — `locate_labels(rgb,size,bbox,labels,fg,axis)` → {label: rect}.**
Maps an ordered known-label list to click-rects with **no atlas**. Two segmenters,
fast then count-driven:
- *Fast path* — one fixed-`gap` blank-run cut (`segment_run` on `x`, the new
  `_segment_rows` on `y`). Nails *uniform* strips (the menu bar, a plain dropdown)
  in a single pass.
- *Count-driven path* (`_segment_rows_n` / `_segment_cols_n` / `_ink_runs_cut`) —
  a real menu is rarely uniform: Blender's File menu interleaves shortcut text,
  submenu arrows and several separator rules, so **no single `gap` yields the right
  band count** (too small splits a separator, too large fuses two items). This
  borrows the exact discipline of `split_run` (which parts *touching glyphs* once
  told the glyph count `n`): given the *label* count, cut the ink profile at its
  `n-1` **widest** blank valleys — ranking gaps *relatively* instead of by an
  absolute threshold, so it parts items whose spacing is uneven.
- *Honest degradation, two ways.* It commits only when it can form exactly
  `len(labels)` bands (a hidden/extra item → `{}`, never a mispairing). And because
  a spurious valley (shortcut/icon ink) can make the count *match* while a cut is
  *displaced* — leaving a band hugging a 2–3px sliver — `_reject_thin` rejects any
  segmentation whose thinnest band collapses on its cross-axis (`{}` rather than a
  confident-but-wrong map). The File menu honestly returns `{}`; the clean Add/Mesh
  menus map exactly.

**Live (this VM, recorded + headless oracle).**
- **Add a Cube to Blender entirely by meaning**: top header `Add` (horizontal,
  `axis=x`) → `Add` dropdown `Mesh` (`axis=y`, 17 items) → `Mesh` submenu `Cube`
  (`axis=y`, 10 items). No pixel target was hard-coded; every click was a label
  located by run-segmentation. Repeated for `Add → Mesh → Monkey`.
- **Independent oracle the floor cannot fake**: saved the scene through the floor
  (Ctrl+S — `'S'` is VK `0x53`, A–Z map by formula — then the file browser's name
  field typed and confirmed by the floor) and re-opened it in a **headless**
  Blender that never saw the GUI: `ORACLE_MESH_OBJECTS=3 ['Cube','Cube.001',
  'Suzanne']` — the default cube plus the two the floor added by meaning.
- **Count-driven correctness, positively**: with the fast path deliberately broken
  (`gap=1`) on the clean Add menu, the count-driven path recovered the *identical*
  17-way mapping (`Mesh` at the same rect) — it produces correct maps, not just
  honest refusals. And the messy File menu → `{}` (honest).
- **No regression**: `test_live.py` 799/800 — the one fail is the F139 pixel-
  centroid jitter present since F177, outside this change (which only *adds*
  `locate_labels` and helpers; no existing path is touched).

**Lesson (道法自然).** 大音希聲，大象無形 — the loudest control needs no sound, the
plainest form no outline: the floor stopped trying to *read* the canvas and instead
*counted the silence between things it already knew*. 絕利一源，用師十倍 — cut off
to the one source you can trust (the rhythm of blank space) and you gain tenfold.
And 知止不殆: the primitive grows only as far as the count guarantees it, and where
the menu's own clutter breaks that guarantee it stops and says `{}` — knowing where
to halt is what keeps it from ever lying. (Known, deliberately un-pre-solved: a
menu *whose label set you do not know* still needs the atlas path — `locate_labels`
acts on the known, it does not read the unknown.)

---

## F182 — one app, two frames: name the *right* accessible by geometry · KiCad

**Friction (反者道之動 — a new domain reveals a gap the old apps hid).** Installed
KiCad/eeschema (PCB/EDA — wxWidgets on GTK) and drove it by meaning. Its chrome is
richly accessible (the floor read and dismissed three first-run dialogs purely by
`uia_invoke('OK')` / `uia_invoke('Yes')`), but the create-file prompt stopped the
floor cold: `uia_find('Yes')` → `None`, `uia_invoke('Yes')` → `False`, and
`uia_name(win)` for that window returned `'[no schematic loaded] — Schematic
Editor'` with **129 children** — the *main window's* menu tree. The floor was
reading the wrong window.

**Mechanism (why title alone misses).** `_atspi_frame_for` crosses the X world to
the AT-SPI world by process id, then disambiguates *which* of an app's top-level
accessibles a window is by an **exact title match**. That held for every earlier
app because each owned a single frame (KWrite, gnome-calculator) or its dialogs'
titles matched their frame names. KiCad breaks it: one pid (`eeschema`) exposes
**two** accessibles at once — a `frame` named `[no schematic…]` at `(0,0,1600,1156)`
and an `alert` named **`"Question"`** at `(474,536,652,141)` — while the modal's
*X window title* is **`"Confirmation"`**. WM title ≠ accessible frame name, so the
title compare missed and the code fell back to the first same-pid frame (the main
window). Every `uia_*` verb then operated on the wrong frame.

**Primitive grown — disambiguate by *screen geometry* (`_iou` + a `>=0.25` gate).**
A frame's accessible extents and the X window's rect are two reports of *the same
pixels*; when the title can't decide, the frame whose extents best overlap the
window is unambiguously the one those pixels belong to. `_atspi_frame_for` now: (1)
keeps the exact-title fast path (cheapest, surest when names align — single-frame
apps are unchanged); (2) otherwise picks the same-pid frame of maximum
intersection-over-union with the window rect, but **only if IoU ≥ 0.25**; (3) else
falls back to the first same-pid frame, exactly as before. Geometry never lies
about whose pixels are whose, so it resolves what a name mismatch cannot.

**Live (this VM) + independent oracle.**
- **The fix unblocks the live dialog**: after the change, `uia_name` of the X
  window "Confirmation" reads `'Question'` (4 kids), `uia_find('Yes')` →
  `{push button, rect (800,643,326,34)}`, and `uia_invoke('Yes')` creates the
  schematic. Measured IoU(window, alert)=**0.794** vs IoU(window, main)=**0.039** —
  not a close call (probe `_probe_kicad_frames.py` pins both numbers, PASS).
- **A resistor placed by meaning**: opened the symbol chooser (`A`), typed the
  filter `Device:R` into its one `text` field located by meaning, confirmed with
  `uia_invoke('OK')`, dropped the part on the canvas with a real click (the gesture
  floor — a schematic canvas has no per-part accessible), and **saved by meaning**
  via `uia_invoke('Save', 'menu item')` (the menu action fired with no pixels; the
  title lost its `*`). The saved `f182.kicad_sch` — KiCad's own text, the floor
  cannot fake — carries `(symbol (lib_id "Device:R") (at 128.27 74.93 0) …)`.
- **No regression**: single-frame apps resolve exactly as before — KWrite 314
  controls + `Save` found, calculator 434 kids (F180 isolation intact), Blender
  still honest `''`/`[]`. `test_live.py` 799/800 (the lone fail is the F139 centroid
  jitter present since F177; this change only touches frame *selection*).

**Lesson (道法自然).** 知人者智，自知者明 — a thing's *name* is what others call it,
but its *place* is what it is; when the two disagree, trust the place. The floor
already held both reports (an accessible's extents, a window's rect) and only
needed to believe geometry over a label. 反者道之動: a fourth app did not need a new
sense — it exposed that an old correlation (pid + title) was too weak, and the
remedy was to lean on a measure (overlap) the floor had carried since the pixel
days. Single-frame apps never felt it; it took an app that shows two faces at once.

---

## F183 — the second ground walks: prove the whole semantic floor on Windows, and reach a *virtualized* item · WPF/UWP

**Friction.** F177–F182 grew and proved the semantic floor on **Linux/AT-SPI**.
The Windows dual (`_uia_win.py`, the UIA COM tree in raw `ctypes`) had been
*written* — every verb, every vtable index — but **never run on Windows**, so the
README honestly hedged that the richer Windows verbs "degrade to truthful no-ops
on a ground that has not yet been forced to grow them." A floor you have not stood
on is a claim, not a capability. This round stood on it: a fresh Windows VM, a
deterministic WPF fixture exposing one of every UIA-bearing control, and every
`uia_*` verb driven through its read-dual.

**What the standing exposed.**
- **The vtable indices are correct.** All nineteen verbs act on a first-class UIA
  provider (WPF): `set_value`/`get_value` (Unicode round-trip `'héllo 道 42'`),
  `toggle`/`toggle_state`, `expand`/`collapse`/`expand_state` (ComboBox + TreeItem),
  `select`/`is_selected`, `range_value`/`set_range_value` (Slider 10→75),
  `invoke` (Button → `'PONG'`), `text` (multiline + CJK). The "no-ops" narrative
  was **stale**, not true — the floor was live; only the proof was missing.
- **Provider depth is the real variable, not the verb.** The *same* verbs on a
  **WinForms** fixture pass only for the patterns its legacy-MSAA→UIA bridge
  surfaces (Toggle, SelectionItem, ExpandCollapse-on-TreeItem, Value) and return
  *honest empties* for the rest (no RangeValue/ScrollItem/Text/ComboBox-expand).
  The floor reports what the control *is*, never crashes on what it lacks — F177's
  "degrade to truthful empties" holds across the Win32/UWP gap exactly as designed.
- **The one true gap: virtualization.** A long modern list (WPF/UWP/WinUI) only
  materializes the rows near the viewport into the UIA tree. `row-38` of a 41-row
  `ListBox` has **no element at all**: `uia_find` (a Descendants walk) returns None,
  and `uia_scroll_into_view` — which needs the element first — has nothing to scroll.
  Meaning is present (the item exists, by name) but unreachable through the existing
  verbs.

**Primitive grown — `uia_find_item` (ask the *container* to realize it).** UIA has
one mechanism built for exactly this: `ItemContainerPattern.FindItemByProperty`,
which a virtualizing container implements to *materialize and return* an item by
property without the caller scrolling blind. The new verb finds the container by
meaning, asks it for the item by `Name`, then `ScrollIntoView`s the realized element
and returns its now-visible screen `rect` — the same *meaning → geometry → pixel*
bridge `uia_find` already is, extended to items that did not exist a moment ago.
After it, the element is in the tree and every other `uia_*` verb sees it. It needed
a `VT_BSTR` VARIANT passed **by value** through the COM vtable (the `_variant_bstr`
helper); ctypes carries the MS-x64 struct-by-value ABI correctly — no crash, the
returned pointer is live.

**Live (this VM).** `_probe_winverbs.py` launches its own WPF fixture and runs
**15/15 green**: the virtualized `row-38` is invisible to `uia_find`, `uia_find_item`
realizes it at `rect (62,290,479,20)`, `uia_select` then reports `is_selected=True`,
and a missing `row-999` returns `None` (honest). A parity gap closed alongside:
`list_windows` on Windows now carries `pid` (via `GetWindowThreadProcessId`), as the
X11 sibling always has — addressing a window by its process, not only its title.

**No regression.** The X11 ground is untouched (`uia_find_item` is additive, exposed
through the same `getattr` fallback that returns `None` where a backend has not grown
it — so AT-SPI degrades truthfully until an equivalent realize-verb is forced there).
Pure stdlib, no new deps; the Win backend still imports with UIA absent.

**Lesson (道法自然).** 上士聞道，堇而行之 — the upper student, hearing the way,
*walks* it. The Windows floor was already whole in code; it became real only by being
trodden. And 反者道之動: the one true gap was not a missing verb but a thing that
**isn't there until asked** — the remedy was not to scan harder but to ask the
container to bring the item into being. 為而弗恃: the floor acts and does not presume
— where a control has no pattern it says so, and only a *real* absence (the unrealized
row) grew a new primitive.

---

## F184 — walk into the real apps: address by AutomationId, read a collection by meaning · paint.net / 7-Zip

**Friction.** F183 stood the floor on a *fixture* — a WPF dialog built to expose one
of every control. A fixture is honest but obliging: every control there has a clean
accessible `Name`. The user asked for the harder ground — *large third-party apps,
across domains, driven entirely by meaning, let the friction surface itself*
(無為而無不為). So the floor walked into **paint.net** (a graphics editor), **7-Zip**
(a file manager), **VLC**, **SumatraPDF**. Two real frictions surfaced almost at once.

**What the standing exposed.**
- **Meaning is not always in the Name.** paint.net's tool and color strip are
  *icon* buttons — owner-drawn, captioned by a glyph, not a word. UIA reports their
  `Name` as `''`, so `uia_find(name=…)` could never reach them. But the meaning had
  not vanished; it sat one property over: the **AutomationId** — `foreColorRectangle`,
  `backColorRectangle`, `documentListButton`, `moreLessButton` — stable, developer-
  assigned, *semantic* handles. (Some apps put the human word in **HelpText**, the
  tooltip, instead.) The floor was matching on a single property when meaning lives
  across several.
- **A collection lives below the window, where `uia_children` is blind.**
  `uia_children` sees only the *direct* children of the top window — for 7-Zip that
  is `[ToolBar, Pane, TitleBar, MenuBar]`, not a single file. The file list — the
  whole point of a file manager — is `ListItem`s many levels down. `uia_find` could
  surface *one*; there was no way to read the *set* by meaning.
- **Provider depth, honestly.** paint.net's *pure* tool icons (and its Layers rows)
  carry **no** Name, **no** AutomationId, **no** HelpText — they are drawn, not
  modeled, and remain unreachable through the a11y tree. That is paint.net's gap, not
  the floor's: where a provider models nothing, the floor truthfully finds nothing.

**Primitives grown.**
- **`uia_find` now matches Name *and* AutomationId *and* HelpText.** Exact equality on
  Name or AutomationId wins outright; otherwise a substring of Name/AutomationId/
  HelpText is the fallback — the same precedence that already kept `'Add'` from
  matching `'Memory add'`, widened across the three properties. `uia_find`/`uia_children`
  now also *return* `aid` and `help`, so a caller can see the handle it just used.
  This is still operating by **meaning**: an AutomationId is a name a developer chose,
  not a pixel.
- **`uia_find_all` — the plural of `uia_find`.** One Descendants walk, every match
  collected as `[{name,type,aid,help,rect}, …]`. This is how you read a *collection*
  by meaning: the rows of a list, the items of a result set — the subtree
  `uia_children` cannot see.

**Live (this VM), driven by meaning, no pixel hunting.** `_probe_appfloor.py` runs
**8/8 green** against the *real installed apps*:
- paint.net — `uia_find` resolves three icon buttons whose `Name` is empty purely by
  their **AutomationId** (and returns their rect for the pixel actuator); a bogus id
  returns `None`; the resolved control's `Name` is confirmed genuinely empty, proving
  the AutomationId path was *required*, not decorative.
- 7-Zip — `uia_find_all` reads the file-list rows `['Computer','Documents','Network',
  '\\.']` that `uia_children` cannot see; `uia_find` addresses the `Computer` row by
  meaning; a double-click on its returned rect navigates *into* it; and `uia_find_all`
  read **back** the new contents `['C:','D:']` — the change is the oracle. A whole
  file-manager step performed and verified through the a11y tree.
- (VLC's first-run privacy modal was dismissed the same way — `uia_invoke(name=
  'Continue')` found the button by meaning though it was nested below the dialog's
  direct children — incidental proof the descendant find reaches where `uia_children`
  stops. Its transport `Play` is addressable by meaning too.)

**No regression.** Both growths are additive and exposed through the same `getattr`
fallback (X11 returns `[]`/`None` until an equivalent is forced there); the WPF
fixture still runs 15/15 (`_probe_winverbs.py`). Pure stdlib, no new deps.

**Lesson (道法自然).** 道隱無名 — the way hides in the nameless. paint.net's buttons
had no Name and the floor was briefly blind to them; the remedy was not to look harder
at pixels but to notice the meaning had only *moved* — to the AutomationId, to the
tooltip — and to widen what "by meaning" reads. 大方無隅: the larger the surface, the
fewer its clean edges; a fixture has corners, a real app does not, and the floor grew
to hold the formless. 為而弗恃: where paint.net models nothing, the floor claims
nothing — only a *real* reach (the file list below the window) grew a real verb.

---

## F185 — the menu lives in another window: `uia_menu` walks a menu path by meaning · FreeCAD / KiCad / Shotcut

**Friction.** The user pushed the floor into the *heavy* domains — **Blender** (3D),
**FreeCAD** (CAD/Qt), **KiCad** (EDA/wxWidgets), **Shotcut** (video/Qt). These are not
toy apps; they are driven almost entirely by their **menus**. So the first thing the
floor reached for was `Edit → Preferences`, and the first thing it hit was a wall:

```
uia_invoke(freecad, name="Edit", ctype="menuitem")     # -> True
uia_find_all(freecad, ctype="menuitem")
#   -> ['File','Edit','View','Tools','Macro','Sketch','PartDesign','Help']   (just the BAR)
#      'Preferences','Undo','Cut'…  are NOWHERE in the window's tree
```

The dropdown items simply were not in the window. Watching `list_windows()` while the
menu opened told the truth: **a dropdown menu is a separate top-level *popup window*.**

```
before = {w['id'] for w in list_windows()}
# open Edit (Alt+E, or a click on the bar item's rect)
new = [w for w in list_windows() if w['id'] not in before]
#   -> [(1508184, 'FreeCAD')]                      a NEW top window
uia_find_all(1508184, ctype='menuitem')
#   -> ['Undo','Redo','Cut','Copy','Paste',…,'Preferences']   the items live HERE
```

Qt, wx and Win32 all do this — the menu "tears off" into its own HWND/UIA tree the
moment it opens. Every `uia_find` the floor had was scoped to *one* window, so it could
see the menubar item but never a single thing beneath it. A whole, universal modality —
the menu, the primary way these apps are driven — was unreachable by meaning.

**Primitive grown — `uia_menu(win, *path)`.** Invoke a menu path by meaning across the
popup windows menus open into:

```python
uia_menu(freecad, "Edit", "Preferences")          # -> True; the Preferences dialog opens
uia_menu(kicad,   "Help", "About KiCad")           # -> True; the About box opens
uia_menu(shotcut, "Help", "About Shotcut")         # -> True
uia_menu(shotcut, "File", "No Such Item ZZZ")      # -> False (clean miss, ESC closes the menu)
```

It walks the path the way a human does: open the menubar item (click its `uia_find`
rect), then for each further name find it as a `menuitem` in **whatever** top-level
window it popped into and click it — opening the next submenu, or, on the last name,
firing the action. It is **composed purely of floor verbs already present**
(`uia_find` + `list_windows` + `click`), so it is *one* implementation that holds for
every backend, and it lives in `osctl` (the composition layer) rather than in a
platform binding. The read side (F184's `uia_find` across Name/AutomationId/HelpText)
is what lets each popup item be named; this is its natural action-side complement.

**Live (this VM), by meaning, no pixel hunting.** `_probe_menuapps.py` runs **8/8 green**
against the real installed apps, each using the *dialog the menu opens* as its oracle:
- **FreeCAD** (Qt) — `uia_menu("Edit","Preferences")` opened the **Preferences** window.
- **KiCad** (wxWidgets) — `uia_menu("Help","About KiCad")` opened the **About KiCad** box.
- **Shotcut** (Qt) — `uia_menu("Help","About Shotcut")` opened the **About** box.
- a bogus path returned **False** without hanging or leaving a menu half-open.

**Honest environment finding (not a floor bug).** This VM has **no GPU** — it exposes
only **OpenGL 1.1** (software). FreeCAD warned (needs 2.0) but ran its Qt shell fine, so
the floor drove it; **Blender refuses to start its UI at all** (it requires OpenGL 4.3).
The floor *reached and read* Blender's "OpenGL 4.3 … required" dialog by meaning — but
there is no Blender UI behind it to drive. That is the environment's gap, not the
floor's; on a GPU host the same `uia_menu` would drive Blender's menus too. Recorded as
proof of the boundary, honestly: 為而弗恃 — the floor claims only what is really there.

**No regression.** `_probe_appfloor.py` 8/8 (F184) and `_probe_winverbs.py` 15/15
(F183) both still green. `uia_menu` is additive, pure stdlib, no new deps.

**Lesson (道法自然).** 大方無隅 — the great square has no corners. A fixture has a single
tidy tree; a real app's most-used surface, its menus, is not even in the same window you
were looking at. The floor did not learn this by design — it tried the obvious thing,
the obvious thing failed, and *watching what actually happened* (`list_windows` growing
by one) showed where the meaning had gone. 反也者道之動 — the way moves by turning back:
the answer was not a deeper API but to widen the *scope of the search* from one window to
all of them, which the floor could already do. The verb only names a path the floor was
always able to walk.

---

## F186 — the other menu: a right-click `#32768` popup has no title, so the floor was blind to it · `menu_windows` + `uia_context`

**Friction.** "继续推进到底 …所有领域所有软件全方位推进实践." So the floor went at the *other*
menu — the **right-click context menu**, the densest single surface in a file manager,
an editor, a browser. In 7-Zip it right-clicked a row and reached for `Open`:

```
click(row_rect, right=True)                      # the menu IS on screen (visible)
[w for w in list_windows() if w['id'] not in before]   # -> []   NOTHING new
uia_find_all(any_window, ctype='menuitem')             # -> []   the items are nowhere
```

The menu was plainly drawn on screen, yet **every floor verb was blind to it.** F185's
trick — scan `list_windows()` for the popup — found nothing this time. The reason is one
property: a native Windows context menu opens in a window of class **`#32768`** that has
**no title**, and `list_windows` keeps only *titled* top-levels (it filters on
`GetWindowTextLength > 0`, by design — an untitled top-level is usually noise). F185's
Qt/wx dropdowns were *titled* child windows, so they slipped through; the native popup
does not. The most common menu on the system was the one the floor could not see.

**Primitives grown — `menu_windows()` + `uia_context(win, target, *path)`.**

```python
menu_windows()
#  -> [{'id': 525216, 'title': '', 'class': '#32768'}]      the popup, found by CLASS not title
uia_find_all(525216, ctype='menuitem')
#  -> ['Open','Open Inside','Rename','Delete','Properties', …]   its items, by meaning

uia_context(sevenzip, "Computer", "Open")   # right-click target, pick from its menu
#  -> True; the file list changes  ['Computer','Documents',…] -> ['C:','D:']   the change is the oracle
uia_context(sevenzip, "Computer", "No Such Item ZZZ")   # -> False (clean miss, ESC closes the menu)
```

`menu_windows()` is the missing *eye*: it enumerates open native popups by their window
**class** (`#32768`) instead of a title, so a menu is addressable the instant it pops.
`uia_context` is the *hand*: find the target by meaning, right-click its centre, then walk
the path through the popup exactly as `uia_menu` walks a menubar. The two menu verbs were
then **unified** — a shared `_walk_menu_path` searches `list_windows() + menu_windows()`,
so `uia_menu` now also drives *classic Win32* menubars (titleless dropdowns) it previously
could not, and `uia_context` handles Qt/wx context menus (titled) for free. One code path,
every toolkit, both gestures.

**Live (this VM), by meaning, no pixel hunting.** `_probe_ctxmenu.py` runs **7/7 green**
on real 7-Zip: the right-click opens *no* titled window (proving `list_windows` is blind);
`menu_windows()` sees the `#32768` popup; its items read by meaning; `uia_context("Computer",
"Open")` navigates and the file list flips to the drives (oracle), reversibly; a bogus item
returns False without hanging. **No regression** — `_probe_menuapps.py` 8/8 (F185),
`_probe_appfloor.py` 8/8 (F184), `_probe_winverbs.py` 15/15 (F183) all still green. Pure
stdlib, additive.

**Lesson (道法自然).** 道隱無名 — the way hides in the nameless. The menu was not missing;
it was *nameless* — a window with no title, and the floor had been looking for things by
title. The fix was not to reach harder but to recognise the thing by *what it is* (its
class) rather than by a name it never had. 天下萬物生於有，有生於無 — and once seen, the
nameless popup is just another window the existing verbs read straight through. The verb
did not add power; it removed a blindness.

---

## F187 — "choose me" without a SelectionItemPattern: a Qt tab is *invoked*, not *selected* · `uia_select` falls back to Invoke

**Friction.** New domains this round — office, audio, **database**, vector. DB Browser
for SQLite (Qt) holds a real grid of rows behind a tab strip, so the floor reached for
the obvious semantic verb to switch tabs:

```
uia_select(dbbrowser, name="Browse Data", ctype="tabitem")   # -> False   (won't switch)
uia_is_selected(dbbrowser, name="Browse Data", ctype="tabitem")  # -> None  (no read either)
```

A tab that plainly *means* "choose this page" could not be chosen. The cause is a
toolkit truth: a Qt `QTabBar` tab models **only InvokePattern** — switching the page is
an *invoke*, not a *select* — so it exposes no `SelectionItemPattern` at all (hence the
`None` read). `uia_select` spoke exactly one pattern (`SelectionItemPattern.Select`) and
gave up when it was absent, blind to a whole class of real controls (Qt tabs, some custom
lists) where the same human gesture lives under a different UIA name.

**Primitive widened — `uia_select` now falls back to Invoke.** Try `SelectionItemPattern.
Select` first (unchanged for WPF radios/list items); if the pattern is absent or its
Select fails, **invoke** the element instead — clicking the tab is what a human does, and
InvokePattern *is* that gesture. One element pointer, two patterns tried in meaning-order,
no new verb surface:

```python
uia_select(dbbrowser, "Execute SQL",  ctype="tabitem")   # -> True; the grid disappears
uia_select(dbbrowser, "Browse Data",  ctype="tabitem")   # -> True; the grid returns
uia_select(dbbrowser, "No Such Tab",  ctype="tabitem")   # -> False (clean miss)
```

**An honest non-gap, noted.** The same DB grid's *cells* were already reachable —
`uia_find_all(ctype="dataitem")` returns `['1','Laozi','无为而无不为','2','Zhuangzi',…]`
and `uia_find(name="Laozi")` lands a `DataItem` with a rect. Reading a data grid by
meaning needed **no** new primitive; only the *select* verb was too narrow. The floor
should grow only where practice actually broke it — and here only one verb did.

**Live (this VM), by meaning.** `_probe_qttabs.py` runs **7/7 green** on real DB Browser:
the tab is confirmed to expose no SelectionItemPattern (`uia_is_selected` → None);
`uia_select("Execute SQL")` then `("Browse Data")` switch pages, with the `sages` grid's
cell `Laozi` appearing/disappearing as the oracle; the grid is read by meaning; a bogus
tab returns False. **No regression** — `_probe_winverbs.py` 15/15 (the WPF fixture still
drives *real* SelectionItemPattern tabs and radios through the unchanged primary path),
`_probe_appfloor.py` 8/8, `_probe_menuapps.py` 8/8, `_probe_ctxmenu.py` 7/7. Pure stdlib.

**Lesson (道法自然).** 大音希聲 — the great note is faint. The verb's name said *select*,
but the meaning the user holds is "choose this" — and a Qt tab honours that meaning
through *invoke*. Binding the verb to one UIA pattern mistook the **name** of the action
for the **action**. 弱也者道之用 — the way works by yielding: the verb stopped insisting on
its one pattern and bent to whatever pattern the control actually offers, and so reaches
more by demanding less. The intent — choose one — is the constant; the pattern is just
how a given toolkit happens to spell it.

---

## F188 — a popup menu is a *shape*, not a class · `menu_windows` sees any toolkit's menu; an honest GTK boundary

**Friction.** Pushing into the **office** domain, LibreOffice Calc. F186 had taught the
floor to see a titleless context-menu window — but only by the native Win32 class
`#32768`. Right-clicking a Calc cell, the menu was on screen yet invisible again:

```
right-click cell → menu_windows() → []        # F186's eye is blind here
```

The popup was real — its class is **`SALTMPSUBFRAME`** (LibreOffice/VCL draws its own menu
window), titleless like `#32768` but a *different class*, so `list_windows` (titled only)
and the F186 `menu_windows` (`#32768` only) both missed it. Every GUI toolkit pops its menu
in its *own* class — VCL one, Qt another, wx another — so a class allow-list is endless and
forever one toolkit behind.

**Primitive generalised — recognise the menu by its *shape*.** What every popup menu shares
is not a class but a **shape**: a titleless **`WS_POPUP`** window (a popup with no caption).
`menu_windows` now admits any window of that shape, plus `#32768` unconditionally. One
catch: a bare `WS_POPUP` also describes persistent shell furniture (the taskbar
`Shell_TrayWnd`, the IME bar) — which first leaked in. The clean discriminator is
**ownership**: a context/dropdown menu is *spawned by* an app window and is **owned** by it
(`GetWindow(GW_OWNER) != 0`), whereas shell windows stand alone. So the rule is: titleless,
`WS_POPUP`, non-zero area, **owned** — or `#32768`. The menu *walk* still keeps only windows
that actually contain a `menuitem`, so anything spurious contributes nothing. One eye, every
toolkit.

```python
# right-click the (named) sheet tab, walk the VCL context menu by meaning:
uia_context(calc, "Sheet1", "Insert Sheet...", ctype="tabitem")  # -> True; dialog opens
uia_menu(calc, "Help", "About LibreOffice")                      # -> True; About opens
```

**Live (this VM), by meaning.** `_probe_vcl.py` runs **9/9 green** on real LibreOffice:
`menu_windows` sees the open `SALTMPSUBFRAME` popup (titleless, not `#32768`), its items read
by meaning (Insert/Rename/Duplicate Sheet…), and it is **empty the moment the menu closes**
(no taskbar leakage); `uia_context("Sheet1","Insert Sheet…")` opens the Insert Sheet dialog
(a new window is the oracle); `uia_menu("Help","About LibreOffice")` opens About — proving
the menu story now covers a **4th** GUI toolkit (Qt/wx/Win32 → **VCL**). **No regression** —
`_probe_ctxmenu.py` 7/7 (the `#32768` path), `_probe_winverbs.py` 15/15, `_probe_appfloor.py`
8/8, `_probe_qttabs.py` 7/7. Pure stdlib.

**An honest boundary, recorded (not papered over).** Inkscape (GTK) is found as a window
with a real name, yet its accessibility tree has **0 descendants** — GTK on Windows ships no
UIA/MSAA bridge, so there is genuinely *nothing modelled* to reach by meaning. The floor
reports the truth: where an app draws its UI without an a11y tree (GTK here, as GL-only
Blender before it, F185), the semantic floor reaches nothing, and only a pixel/OCR floor
could. The probe asserts this boundary explicitly so it stays honest.

**Lesson (道法自然).** 大方無隅 — the great square has no corners. F186 drew a corner around the
menu — the `#32768` class — and the next toolkit's menu fell outside it. The way was not to
draw more corners (one per toolkit) but to stop drawing them: name the menu by the *shape*
all menus share (a titleless owned popup), and the boundary dissolves. 同於道者，道亦得之 —
recognise a thing by what it *is* and every instance of it comes to you; recognise it by one
of its names and you spend forever collecting names.

---

## F189 — write by meaning even where ValuePattern reads but won't write (wxWidgets) · `uia_set_value` falls back to the keyboard floor

**Friction.** Into the **audio** domain, Audacity (wxWidgets). `uia_menu("Generate","Tone…")`
opened the Tone dialog (wx menus — F185 toolkit already covered). The dialog's Frequency
field reads back fine — `uia_get_value(...) == "440"` — but filling it fails:

```
uia_set_value(tone, "432", name="Frequency (Hz):", ctype="edit")  -> False   # value stays 440
uia_get_value(tone,          name="Frequency (Hz):", ctype="edit")  -> "440"   # read still works
```

The control exposes **ValuePattern for *reading*** yet its **`SetValue` is a silent no-op** —
a wxWidgets number field (and some validated/custom inputs) model the read but not the
write. So the floor could *read* a field it could not *fill*: a half verb. Binding "set this
field" to ValuePattern.SetValue alone mistook one mechanism for the intent.

**Primitive widened — yield to the keyboard floor when the pattern won't write.**
`uia_set_value` now tries ValuePattern.SetValue first (the clean, focus-free path — WPF and
Win32 edits take it unchanged), and when that fails it falls back to the **keyboard floor**:
`uia_focus` the field → Ctrl+A select-all → Delete → `type` the value — exactly what a human
does. It is **composed of existing leaves** (`uia_focus` + the key floor already proven in
F169), so one implementation serves every backend; it returns False only if the field can be
neither written nor focused. This is the same shape of fix as F187 (`uia_select` → Invoke):
the verb stops insisting on one mechanism and bends to whatever the control offers.

```python
uia_set_value(tone, "432", name="Frequency (Hz):", ctype="edit")  # -> True
uia_get_value(tone,          name="Frequency (Hz):", ctype="edit")  # -> "432"  (write landed)
```

**Live (this VM), by meaning.** `_probe_wxset.py` runs **7/7 green** on real Audacity: the wx
field reads via ValuePattern, its raw SetValue is proven to fail (value unchanged), then
`uia_set_value("432")` lands and **reads back "432"** (the read-back is the oracle); OK
generates a tone and a track appears, read by meaning as `1 Audio 1`. **No regression** —
`_probe_winverbs.py` 15/15 (WPF ValuePattern write still succeeds on the *first* try, never
reaching the fallback), `_probe_appfloor.py` 8/8, `_probe_ctxmenu.py` 7/7, `_probe_qttabs.py`
7/7, `_probe_vcl.py` 9/9. Pure stdlib.

**Lesson (道法自然).** 弱也者道之用 — the way works by yielding. A field's *meaning* is "this is
where the value goes"; ValuePattern.SetValue is merely one road in, and some toolkits pave
only the read direction. The verb that demands that one road reaches half the fields; the
verb that yields — pattern if it writes, else focus-and-type — reaches them all by demanding
less. 上德無為而無以為 — the higher way acts without forcing one mechanism, and so nothing is
left undone.

---

## F190 — a pattern can *lie*: trust ValuePattern only when a read-back confirms it · `uia_set_value` reaches the keyboard floor through a real click

**Friction.** Into the **database** domain, DB Browser for SQLite (Qt). The Execute-SQL
editor is a **Scintilla** widget; F189's fallback fired on `SetValue` returning *False*, so
I expected the same path. Instead `uia_set_value` returned **True** and ran *stale* SQL —
the new text never reached the editor. Two probes told the real story:

```
_uia_set_value_pattern("SELECT 1;", editEditor)  -> True    # SetValue *claims* success
uia_get_value(editEditor)                          -> ""      # …yet nothing was written
uia_focus(editEditor)                              -> True    # SetFocus *claims* focus
# (keystrokes then land nowhere)
```

The Scintilla control's **ValuePattern.SetValue returns success while writing nothing**, and
its **UIA SetFocus returns success without taking the caret**. Both lie. F189 trusted the
`SetValue` return code; a lying *True* slipped straight past the fallback and the verb
reported a write that never happened — worse than an honest failure.

**Primitive hardened — believe the read-back, not the return code; reach focus by a click.**
`uia_set_value` now trusts the pattern **only when `uia_get_value` reads the value back**.
Absent that proof — pattern refused (wx, F189), or faked it (Scintilla) — it reaches for the
**keyboard floor**, and takes focus the one way that cannot lie: a **real click on the
field's centre** (the widget under the pixels gets the caret), select-all, type. UIA
`SetFocus` is kept only as a last resort for a field with no on-screen rect; if neither
click nor focus is possible the pattern's own claim stands. One read-back gate, one click,
every toolkit:

```python
pattern_ok = SetValue(value)
if pattern_ok and uia_get_value(...) == value:   # proof, not a promise
    return True
click(centre_of(field)); select_all(); type(value)   # the floor that cannot lie
```

**Live (this VM), by meaning.** `_probe_dbexec.py` runs **7/7 green** on real DB Browser: the
raw pattern is shown to *claim* success yet leave the editor empty; `uia_set_value` then
writes three different `SELECT`s by meaning, and each runs — `alpha`, `42`, `DAO`, and
`dao 2026 | FLOOR` appear in the results grid (the **computed cell is the oracle** that the
text truly reached Scintilla). **No regression** — `_probe_wxset.py` 7/7 (wx still falls back
on an honest False), `_probe_winverbs.py` 15/15 (WPF SetValue succeeds *and* its read-back
confirms, so it never enters the fallback), `_probe_appfloor.py` 8/8, `_probe_ctxmenu.py`
7/7, `_probe_qttabs.py` 7/7, `_probe_vcl.py` 9/9. Pure stdlib.

**Lesson (道法自然).** 信言不美，美言不信 — a control's `True` is a *美言*, a smooth word; the
read-back is the plain truth. A verb that believes return codes is deceived by the toolkits
that flatter; a verb that asks the field to *show* what it holds cannot be. 為而弗恃 — act,
but do not lean on the actor's own report of acting; lean on what is. The keyboard floor
reached through a real click is the bedrock under every lying pattern: pixels do not lie
about where the caret went.

---

## F190b — `uia_drag`: drag one control onto another *by meaning* · the grip is the handle, not the centre

**Friction.** Into the **drag-and-drop** modality. The floor had `drag(x0,y0,x1,y1)` — a real
press-glide-release over *pixels* — but no way to say "drag *this* control onto *that* one".
To reorder Audacity's tracks I had to pull both rects out of `uia_find` by hand and compute
points. That is exactly the gap `uia_click` already closed for the tap (locate-by-meaning →
real click); the held stroke had no such dual.

The first naive shape — drag from the **centre** of the source element to the centre of the
target — failed, and taught the real lesson. A track's UIA element spans the whole row; its
centre is the **waveform**, and a press there means *select a time region*, not *move the
track*. The reorder handle lives at the item's **leading edge** (the control-panel header).
A column header taught the mirror lesson: dragging DB Browser's "name" column collapsed into
a **click that only sorted** — the grid never enabled section-move, so the drag had nowhere
to go.

**Primitive grown — `uia_drag(win, name, ctype, to_name, to_ctype)`.** Find both ends by
meaning, then grip a point just inside each element's **top-left** (where titlebars, drag-dots
and track headers sit) and run the existing `drag` stroke between them:

```python
src, dst = uia_find(name), uia_find(to_name)
grip = lambda r: (r.x + min(40, r.w//2), r.y + min(12, r.h//2))   # the handle, not the body
drag(*grip(src), *grip(dst))      # a genuine press → glide → release
```

Like every floor verb it does not *assert* the app honoured the gesture — the caller reads
the new order back (the change is the oracle), the same discipline F190 forced for writes.

**Live (this VM), by meaning.** `_probe_drag.py` runs **7/7 green** on real Audacity: three
mono tracks `Audio 1/2/3`; `uia_drag` drags the **bottom** track onto the **top** one purely
by name; the order read back shows it moved up into the top region with **no track lost**;
Audacity's own status line confirms *"Drag up or down to change track order."* A bogus source
returns False cleanly. **No regression** — `_probe_wxset.py` 7/7, `_probe_dbexec.py` 7/7,
`_probe_winverbs.py` 15/15, `_probe_appfloor.py` 8/8, `_probe_ctxmenu.py` 7/7,
`_probe_qttabs.py` 7/7, `_probe_vcl.py` 9/9. Pure stdlib.

**Two honest boundaries (recorded, not hidden).** A target that turns a drag into a click (a
header that only sorts) does nothing visible — truthful inaction, not a floor bug. And an
**OLE** drop target — a file dragged from Explorer into an app — ignores synthetic mouse
motion entirely; that is the platform's drag-drop *protocol*, reachable only by speaking it,
not by moving a pointer. The pointer path reaches every *in-process* drag; the OLE wall is
named, not papered over.

**Lesson (道法自然).** 大方無隅 — the great square has no corners; the thing you grab has no
single canonical point. A verb that insisted on the centre reached the waveform and missed the
handle; yielding to *where the handle actually is* (the leading edge) reached the move. 弱也者
道之用 — the way works by yielding: demand less about *where*, and the one stroke serves track,
row and header alike.

---

## F191 — `uia_text` falls back to the accessible **Name** · reading a custom editor (Notepad++/Scintilla) that models no TextPattern

**Friction.** Operating a *real* installed app — Notepad++ — on a fresh Windows VM.
Type a buffer into it, then read it back *by meaning*: `uia_text(win, ctype="document")`
returns `""`, and so does `ctype="edit"`/`"pane"`. The text is plainly there — the
title shows the modified star, the glyphs are on screen — yet the deep-read verb sees
nothing. The native `window_text` is no help either: Scintilla is a custom-drawn control,
not a Win32 Edit, so there is no `WM_GETTEXT` text to fetch cross-process.

Walking the tree told the truth: Notepad++'s editor surface is a **`Pane`** whose
**Name** *is* the whole buffer (`'F191 floor 道法自然 …'`), and it carries **no
TextPattern at all**. `uia_text` only ever asked the TextPattern (`DocumentRange.GetText`)
and, finding none, returned the empty default — honest, but blind to where this toolkit
actually keeps its text.

**Primitive grown — a second channel, not a new verb.** `uia_text` now reads the
element's accessible **Name** (`_prop_bstr(el, NameProperty)`) whenever the TextPattern
is absent *or* yields empty:

```python
s = text_pattern_read(el)          # the proper channel for documents (Chrome, rich edit)
if not s:                          # a custom editor publishes its buffer as the Name
    s = name_of(el)                # Scintilla/Notepad++ — truth, not a guess
```

The Name *is* what the accessibility tree reports as that element's text, so the fallback
reads what is, never a fabricated value. No new symbol — the existing verb now reaches one
more honest surface.

**Live (this VM), by meaning.** `_probe_textname.py` runs **2/2 green** on real
Notepad++: a fresh Unicode buffer is typed in, `uia_text(ctype="pane")` reads it back
verbatim, and the title's modified star is the independent oracle that the bytes truly
landed. **No regression** — `_probe_winverbs.py` **15/15** (WPF's read-only TextBox has a
real TextPattern, so the multiline+Unicode read still goes through `DocumentRange.GetText`,
never the fallback; Chrome's document likewise reads through TextPattern). Pure stdlib.

**Lesson (道法自然).** 大音希聲 — the great sound is almost soundless; a control that
models no TextPattern was not *silent*, it was speaking on the channel the verb wasn't
listening on. 弱也者，道之用 — the way works by yielding: stop insisting on the one
"proper" pattern and accept the text wherever the toolkit puts it. The verb did not grow
larger; it grew *quieter and wider* — one more way to hear the same truth.

---

## F192 — drive a **fully minimized** (zero on-screen pixels) window by meaning · the backend-GUI floor

**Friction.** The frontier the user named: the *backend* GUI — a window with no pixels at
all. The official screenshot→reason→click loop is defined by pixels; a **minimized** window
has none (its `BoundingRectangle` collapses to an off-screen sentinel, here `(-32000,
-32000)`), so that loop simply cannot act on it. Can *this* floor still operate such a
window — not by un-minimizing it (that would defeat the test), but by addressing its
controls through the accessibility provider, which answers by *identity*, not geometry?

The first naïve modality taught the boundary. Driving a *collapsed* `ComboBox`'s item
failed — but it failed **whether minimized or restored**, so it is not a backend limit at
all: a WPF ComboBox realizes its item only when the dropdown *popup* renders, and a popup
needs a surface to draw on. That is a rendering boundary, recorded and then *kept out of*
the minimized claim, not papered over it.

**Mechanism (no new primitive).** F190's pattern-first design already does this — the
proof is to *demonstrate and lock* it, not to invent a leaf. Every pixel-free pattern verb
addresses a control by its provider while the window sits minimized:

```python
set_window_state(win, "minimized")        # geometry -> (-32000,-32000); zero pixels
uia_set_value(win, "…", name="field")      # ValuePattern      — write
uia_toggle(win, name="agree")              # TogglePattern     — flip
uia_select(win, name="row-5")              # SelectionItem     — pick (ListBox: no popup)
uia_set_range_value(win, 73, name="level") # RangeValuePattern — set
uia_expand(win, name="Root")               # ExpandCollapse    — open a tree node
uia_invoke(win, name="ping")               # InvokePattern     — fires; field := PONG
uia_text(win, name="doc")                  # TextPattern       — read multiline+unicode
assert window_state(win) == "minimized"    # never raised; every act used zero pixels
```

**Live (this VM), by meaning.** `_probe_backend.py` runs **9/9 green** against a WPF
fixture driven start-to-finish while **minimized**: value write+read-back, toggle (asserted
by *change*, fixture-state-independent), ListBox row select, range set to 73, tree expand,
Invoke → `PONG`, multiline Unicode text read — and the window is confirmed still minimized
*after* every action, proving no verb silently restored it. **No regression** —
`_probe_winverbs.py` **15/15** on the same provider, visible. Pure stdlib.

**Two honest boundaries (recorded, not hidden).** (1) A *collapsed ComboBox* item needs
its dropdown popup rendered, so it is out of reach with zero pixels — and even visible it
needs the popup handled as a separate window. (2) Any verb that *falls through to a real
click* (a control exposing no pattern; `uia_set_value`'s keyboard-floor fallback for a
lying ValuePattern) cannot reach a minimized window — the pattern channel can, the pixel
channel cannot, and the floor degrades to the truthful boundary rather than faking it.

**Lesson (道法自然).** 視之不足見，聽之不足聞，用之不可既 — what cannot be *seen* can
still be *used*. The screenshot loop binds action to the visible; meaning unbinds it. 為而
弗恃 — act, but do not lean on the pixels as proof of acting; the read-back, taken while the
window has no pixels at all, is the proof. The backend GUI is not a different floor — it is
the same semantic floor, with the eyes closed.

---

## F193 — a button that opens a **modal** must not *freeze* the agent · `uia_invoke` dispatches on a timed daemon thread

**Friction.** Operating a real app (DB Browser for SQLite) by meaning, `uia_invoke(win,
name="New Database")` **never returned**. The button is honest and the Invoke *succeeds* —
it opens a Save-file dialog — but `IUIAutomationInvokePattern::Invoke` is **synchronous**,
and the control's handler runs a **modal** message loop that does not return until the
dialog is dismissed. The floor initialises COM as a single-threaded apartment (STA), so the
blocked call sits on the **only** thread the agent has: the agent is frozen, holding a modal
open, with no way to even *see* the dialog it just summoned. A floor that can be hung by a
button that *worked* is not a floor.

**Mechanism.** Move the one blocking call off the agent's thread. `uia_invoke` now runs the
find-and-Invoke on a **daemon thread that builds its own STA + its own UIA instance** (COM
objects can't cross apartments, so the worker re-resolves the element itself — kin to F165's
per-process cache, now per-thread), and `join`s it with a `timeout`:

```python
def uia_invoke(win, name=None, ctype=None, timeout: float = 6.0) -> bool:
    ...
    th = threading.Thread(target=_invoke_worker, args=(...), daemon=True); th.start()
    if done.wait(timeout):
        return bool(res[0])          # returned in time: the real True/False
    return True                      # still blocked in a modal handler — dispatched, do not hang
```

A genuinely missing element/pattern returns `False` *fast* (the find is cheap), so the
timeout fires **only** on a real block — and then returns `True`, because the action *was*
dispatched and the modal is now up, ready to be driven. The orphaned worker ends harmlessly
the moment the dialog closes.

**Live (this VM), by meaning.** `_probe_modal.py` runs **4/4 green** against real DB Browser:
`uia_invoke("New Database")` **returns in 6.03 s instead of hanging**; the *"Choose a filename
to save under"* modal is confirmed up; the flow is completed and **`daoprobe.db` actually
appears on disk**. **No regression** — `_probe_winverbs.py` **15/15** (the `ping` button, which
opens no modal, still returns its real result through the worker, fast).

**The honest seam (why the dialog is finished by keys).** The native file dialog is *driven*
through the floor's **keyboard** channel, not by meaning — because reaching into it by meaning
hits a *second*, distinct wall (recorded as a frontier below): UIA's `FindAll` traverses the
**whole** subtree, and the dialog's virtualised shell list view stalls that walk. The two
findings are kept separate: F193 is "Invoke must not block the agent" (fixed, proven); the
FindAll-walk stall is "a read must not block the agent either" — **now fixed in F194**, by
generalising this very worker-thread mechanism to every read verb.
The floor completes the task today by using the channel that *does* work — meaning to summon
the modal, keys to fill it — and degrades to the truthful boundary rather than faking a reach.

**Lesson (道法自然).** 動其機，萬化安 — move the one moving part (the blocking call) off the
agent's single thread and the whole stays at rest, free to act. 為而弗恃 — invoke, but do not
lean on the call *returning* as proof; the modal that appears, and the file that lands on
disk, are the proof. A synchronous door, opened on a thread you can abandon, no longer locks
you in the room.

---

## F194 — a *read* must not hang the agent either: every locate/read verb runs on an abandonable worker · UIA

**Friction.** F193 stopped *Invoke* from freezing the agent on a modal. The same
single-thread trap swallows **reads**. Driving the modal F193 summons — DB Browser's native
*"Choose a filename to save under"* dialog — `uia_get_value(dlg, ctype="edit")`, `uia_find`,
`uia_text` **never return**. The dialog embeds a *virtualised shell list view* (the file
browser), and a descendant search across it **wedges inside a single COM call**.

**Why the obvious fixes don't work (measured on this VM, not assumed).**
- *Scope the search by a ControlType condition.* No — a condition filters the *results*, not
  the *traversal*; `FindAll(TreeScope_Descendants)` still realises the whole subtree. Tried,
  still hangs.
- *Replace FindAll with a hand-rolled bounded TreeWalker* (`RawViewWalker` GetFirstChild /
  GetNextSibling, capped by a node budget **and** a wall-clock deadline). Also no — it hung
  too. The block is **inside one `GetFirstChildElement`/`GetNextSiblingElement` call**, so a
  deadline checked *between* steps never fires. This refutes the lighter fix outright: the
  pathology is a single wedging COM call, not an expensive aggregate that a budget could trim.

**The fix — generalise F193 from invoke to all reads.** `_get_uia` is now **thread-local**
(each thread builds its own STA apartment + UIA instance, since UIA objects cannot cross
apartments). A `_hangproof(default)` decorator runs an element-resolving verb on a **daemon
worker** with that per-thread UIA, joined with `_FIND_TIMEOUT`: a wedged worker is
**abandoned** and the verb returns its empty default; a worker that completes tears its own
UIA down so nothing leaks. The verb bodies are **untouched** — the decorator wraps them — so
the common path is unchanged in behaviour, only made un-freezable. Applied to every locate /
read / act verb (`uia_find`, `uia_find_all`, `uia_get_value`, `uia_text`, `uia_set_value`,
`uia_focus`, `uia_toggle`/`_state`, `uia_select`/`uia_is_selected`, `uia_expand`/`collapse`/
`_state`, `uia_scroll_into_view`, `uia_range_value`/`set`, `uia_find_item`). `uia_invoke`
keeps its own bespoke worker — it must return *True* on a modal-block, not the empty default.

**Live (this VM).** `_probe_hangproof.py` **6/6 green** against real DB Browser: a normal
`uia_find("New Database")` still resolves in **0.05 s**; on the wedging dialog
`uia_get_value`/`uia_find`/`uia_text` each **return empty in ~8.0 s** (the timeout) instead of
never; and the agent is **still alive afterward** — a re-read of the main window comes back in
**0.02 s**. **No regression** — `_probe_winverbs.py` **15/15** (every verb now runs through a
worker and still returns its real result, fast).

**Lesson (道法自然).** 知止不殆 — knowing where to stop is safety: a read that cannot stop is
a read that can trap you, so bound it. 為學者日益，聞道者日損 — I added two clever fixes (a
scoped condition, a bounded walk) and the Tao took both away; what remained after the
subtraction was the one mechanism already proven on Invoke — run it on a thread you may walk
away from. The proof is not that the call returns, but that the agent **keeps moving** whether
it returns or not.

---

## F195 — read what is *drawn*, not in the tree: the universal copy channel · cross-platform

**Friction.** Operating LibreOffice Calc by meaning, the *write* works — focus the grid by
meaning, type, and `道法自然` lands in A1 — but the *read* finds nothing. Calc renders its
whole cell grid as **one painted custom control**: there is no per-cell UIA element, so
`uia_text`/`uia_get_value` over the sheet return only the table's own name (`"Sheet Sheet1"`),
never a cell's contents. Scanning every control type for the written value by Name or
ValuePattern finds **zero** hits (measured on this VM). This is the F188/canvas family: the
content exists on screen but not in the accessibility tree.

**The fix — don't fight the tree, use the channel the content already travels on.** Drawn
content that a human can read is content a human can **select and copy**. `read_selection`
performs the copy on the *caller's* current selection and returns the text: it clears the
clipboard to a sentinel first (so a no-op copy returns `""`, never a stale value) and restores
the prior clipboard afterward (the read leaves no trace). It is the deliberate complement of
`uia_text` — *meaning* for what is in the tree, the *copy channel* for what is only drawn —
and it is cross-platform (Ctrl+C + clipboard, no UIA). The caller still positions the
selection by meaning + keyboard (click a cell, `Ctrl+A` a field, shift-arrow a range); the
verb only turns a positioned selection into text.

**Live (this VM).** `_probe_readsel.py` **5/5** against real Calc: `uia_text` over the drawn
grid is empty of cell content (the gap); a CJK cell (`道法自然`) and a numeric cell (`31415`)
written by meaning each **read back exactly** through `read_selection`; the prior clipboard is
**restored** (`SENTINEL-PRIOR-VALUE` survives the read); and a shift-selected `A1:A2` range
returns **both** cells (`"道法自然\r\n31415\r\n"`). The same channel reads a terminal, a
canvas-drawn code view, any custom-painted surface.

**Lesson (道法自然).** 夫唯不爭，故天下莫能與之爭 — do not wrestle a provider into exposing a tree
it never built; take the content where it already flows freely. 上善若水 — the copy channel is
water: it fills whatever surface holds text (tree or pixels) without forcing any of them. The
floor now reads by meaning where the tree speaks, and by the copy channel where it is silent.

---

## F196 — read a *row* the tree scattered into cells · `uia_rows` rebuilds a flattened details view by geometry

**Friction.** Operating 7-Zip's File Manager by meaning, every cell is *readable* — `uia_find_all`
hands back the file names (in `edit` elements) and, separately, the sizes and dates (in `text`
elements) — yet you cannot read **the row for `desktop.ini`**: the one fact that pairs that name
with its `402` bytes and its dates. The provider exposes the grid as a *flattened* list: each
column cell is a separate sibling with no per-row parent (measured on this VM — the name lives in
an `edit` at x∈[118,200], its size in a `text` at x≈274, its dates at x≈374/474; a single
full-width `listitem` at x∈[114,874] wraps them but only repeats the name). So reading a record as
a unit by meaning was impossible — the cells were all there, just un-associated.

**The fix — rebuild the row the way the eye does: by geometry.** `uia_rows` keeps only the cells
inside the list container's rect (dropping toolbar/header/status text), clusters them into rows by
**vertical band** (rect top within `y_tol` px), and orders each row **left-to-right by x**. The
row-wrapper `listitem` that duplicates the name is removed by a containment test — a cell that
spatially *encloses two or more others* is a wrapper, not a column — chosen over collapsing equal
text precisely so a folder's **equal Modified/Created dates are both preserved**. It relies only on
rects (which UIA reports reliably even as it scatters the elements) and Names, so it is
provider-agnostic; and it *composes* the already hang-proof `uia_find`/`uia_find_all` then does
pure-Python geometry, so it inherits F194's safety and **cannot itself hang** — no decorator needed.

**Live (this VM).** `_probe_rows.py` **5/5** against the real 7-Zip File Manager in
`C:\Users\Administrator\Documents`: `uia_rows` returns one row per visible entry (all five known
names present); the flattening is shown real (name in an `edit`, size in a separate `text`); the
`desktop.ini` row pairs the name **with its `402` size** in one reconstructed row; every row is in
left-to-right column order (name leftmost); and rows come back top-to-bottom in visual order.

**日損 (same change, subtracted).** F193's `uia_invoke` worker hand-rolled its own
`CoInitializeEx`/`CoCreateInstance` — duplicating the per-thread UIA lifecycle that F194's
thread-local `_get_uia`/`_teardown_uia` now own. The worker now uses them, deleting ~10 lines of
bootstrap and giving invoke the *same* teardown (no leak) as every other verb. Proven unchanged:
`_probe_modal.py` **4/4** (invoke still returns in ~6s on a real modal, file lands on disk),
regression `_probe_winverbs.py` **15/15**.

**Lesson (道法自然).** 萬物並作，吾以觀復 — the parts were all present; seeing the whole was a matter of
watching how they return to their rows. We did not force the provider to build a tree it never
built (F195's restraint); we read the geometry it *does* report and let the record reassemble
itself. And 為學者日益，聞道者日損 in one stroke: a new verb added (`uia_rows`), a duplicated apartment
bootstrap removed — the floor grew a capability while shrinking its code.

---

## F197 — navigate to an arbitrary spreadsheet cell *by reference*, verified · `goto_cell` defeats a VCL "SetFocus lie"

**Friction.** The longest-standing entry on the frontier: *reaching* an arbitrary cell like `B2` in
LibreOffice Calc purely by meaning. The grid is one drawn canvas with no per-cell element, so
`uia_find("B2")` finds nothing; the natural anchor is the **Name Box** (the cell-reference box
top-left), but it is a VCL ComboBox whose `uia_focus` returns True while keyboard focus stays on the
sheet — a "SetFocus lies" of the F190 family — so a typed reference lands in a cell, not the box.
Reading a cell was solved (F195) and writing works by typing into the focused grid; only *go to X*
remained.

**The fix — click the meaning-found box where SetFocus lied, then let the box be its own oracle.**
`goto_cell(win, "B2")` finds the Name Box, clicks its centre (a *real* click focuses it where the
API lied — the same meaning-anchored-geometry pattern as `uia_menu`/`uia_context`), `Ctrl+A`s,
types the reference and presses Enter. The Name Box then *displays the new active cell*, so the same
control is the verification oracle: read its Name back, accept only an exact match, else `Esc` the
stray edit and retry. Two robustness lessons came straight from real failures on this VM, not from
imagination:
- **Identify the box by meaning, recover by geometry.** The Name Box is normally found *by meaning*
  — it is the one ComboBox whose displayed Name *is* a cell reference. But a rejected or half-typed
  reference **stays in the box**, so its Name stops looking like a cell reference and the meaning
  match goes blind — wedging every later call. So when the meaning match fails, fall back to the
  geometry the provider always reports (leftmost ComboBox of the formula-bar row); finding it that
  way lets the click+`Ctrl+A` *overwrite* the bad text and self-heal.
- **Reject a non-reference up front.** Asking for `not-a-ref` made the box echo `not-a-ref`, which
  naïvely "matched" the request — a fooled oracle. A target that is not a single-cell reference is
  meaningless, so it is refused before the box is ever touched (and so never poisoned).
A leading `Esc` cancels any ambient in-cell edit so the walk starts clean. Composed of hang-proof
finds + click + keys — no new COM, cannot itself hang.

**Live (this VM).** `_probe_gotocell.py` **5/5**, stable across repeated runs, on the real Calc
window: near cell `B2` (active cell becomes `B2`); far cell `AA30` (many columns/rows away, no
per-cell element — the canvas defeats every approach but this one); recovery from a half-typed
in-cell edit to reach `D4`; a non-reference returns False in ~0.0s without hanging or poisoning;
and the landed cell is real and editable — typing `F197道` into `C7` and reading it back through
F195's `read_selection` round-trips exactly. Regression `_probe_winverbs.py` **15/15** unchanged.

**Lesson (道法自然).** 知其雄，守其雌 — hold the elegant meaning-anchor, but keep the humble geometric
fallback beneath it; the system that knows its own failure mode (a self-poisoning identity) and
keeps a lower, stabler footing is the one that does not wedge. 知止不殆: validate the request before
acting, so an impossible ask costs nothing and harms nothing. The frontier's caution — "grow the
verb only once one approach proves robust against VCL" — is now met.

---

## F198 — learn the font from a *known* rendering, then read the unknown · `learn_glyphs` closes the atlas frontier

**Friction (the longest-open frontier, R-next).** The perception ladder — `read_glyph` → `read_text`
→ `read_block` → `read_region` — reads text a page *drew* (no DOM node, no tree element) by matching
each glyph against an `atlas` of `{char: edge_signature}`. But nothing in the floor ever *built* an
atlas: every probe hand-rolled one from a fixture the test itself rendered (spaced magenta swatches
located by `find_color_blobs`, zipped with the known string) — the same idiom copy-pasted ~25 times
across `test_live.py`. So the readers could only read a font the test had first drawn itself. Reading
a *real* canvas control was out of reach: there was no way to turn an actual on-screen rendering into
the atlas the readers need.

**The fix — a teacher: known truth begets read truth.** `learn_glyphs(rgb, size, bbox, label, fg=None)`
takes a patch of real on-screen text whose string you *do* know — a label whose caption the UIA tree
reports, a cell you just typed, any run you can name another way — `segment_run`s it into one cell per
non-space character (falling back to `split_run` with the known glyph count when letters touch), and
returns `{char: edge_signature(cell)}`: exactly the atlas the readers consume, captured from the live
rendering instead of a fixture. The ink colour may be omitted and is recovered from the pixels by
`detect_fg` (F109). It refuses to mislead: if the run cannot be aligned to its label one-cell-per-char
(too few cells even after `split_run`, an over-long label), it returns `{}` rather than zip a shifted
alignment that would poison every later read. With this rung the loop closes — *learn* a font from
known live text, then *read* unknown drawn text rendered in that same font, all from pixels.

**Live (this VM).** `_probe_learnglyphs.py` **5/5**, stable across runs, against a real Chrome
`<canvas>` (text the browser draws with **no DOM node** — the exact "drawn, not in the tree" target):
the atlas is learned *only* from the teacher run `DAOFLOOR2197` (10 unique glyphs); `read_text` then
reads the *different*, never-taught student run `ROOF1729` **exactly** from pixels; omitting `fg`
(auto `detect_fg`) gives the identical read; `read_text_conf` on `ZONE17` *marks* the untaught
`Z`/`N` as `?` rather than fabricate them; and an over-long label is refused (`{}`, no mislabeled
atlas). Regression `_probe_winverbs.py` **15/15** unchanged.

**日損 (same stroke, subtracted).** `learn_glyphs` is the canonical form of the
`{chars[i]: edge_signature(…, blob[i].bbox)}` idiom hand-rolled ~25× across the probes — and it also
accepts pre-cut `cells`, so a caller that already isolated each glyph (the old colour-blob fixture)
folds onto the same verb. A primitive added (日益) that subsumes a duplicated idiom (日損): the floor
grows a capability while giving the scattered copies one home.

**Lesson (道法自然).** 不言之教 — the teaching without words: a rendering the system already understands
*is* the lesson that lets it read the renderings it does not. We did not build a universal font
database or bolt on an OCR engine (聞道者日損 — we add the smallest rung, not the largest machine); we
let known truth on the screen teach the reader the rest, and we made the teacher decline to teach what
it cannot align with certainty. 知止不殆: a teacher that refuses a doubtful alignment never poisons the
student.

---

## F199 — drive a window on **another virtual desktop** (zero pixels by *workspace*) · the floor learns to *see* the workspace axis on Windows

**Friction.** F192 proved the floor drives a *minimized* window — no pixels by show-state — by
meaning. The user's frontier has a twin: a window on a **non-current virtual desktop** has no
on-screen pixels either, by *workspace*. Operating a WPF fixture parked on a second Windows
desktop, the semantic verbs reached it fine — but the floor was **blind to the workspace axis
itself**. On X11 it reads it via EWMH (`_NET_WM_DESKTOP`), but on Windows
`window_desktop`/`current_desktop`/`num_desktops` were the no-op defaults
(`0`/`0`/`1`): the floor could not even *tell* a window had no pixels *because it lives on
another workspace*, so it could not decide between the meaning channel and the (useless) pixel
channel. A floor that cannot see why a window is dark cannot reason about it.

**Mechanism — answer exactly what the *documented* API answers, and no more.** Windows exposes
virtual desktops through two COM interfaces. The **documented** `IVirtualDesktopManager`
(`CLSID_VirtualDesktopManager`) is stable across builds and answers two questions for *any*
window, including foreign-process ones: `IsWindowOnCurrentVirtualDesktop(hwnd)` and
`GetWindowDesktopId(hwnd)→GUID`. Everything else — enumerate the desktops, switch the shown one,
move a *foreign* window between them — lives only in the **undocumented**
`IVirtualDesktopManagerInternal`, whose vtable shifts build to build (the classic source of
breakage in this space). So the Windows backend binds the documented interface by pure `ctypes`
(a fresh instance per call, since COM pointers are apartment-bound — kin to F194's per-thread
UIA) and grows the **read** verbs truthfully:

```python
window_on_current_desktop(win) -> bool   # IsWindowOnCurrentVirtualDesktop — has pixels right now?
window_desktop(win)            -> str    # GetWindowDesktopId — the workspace's GUID identity
current_desktop()              -> str    # GUID of the shown workspace (read off any on-current window)
```

`window_on_current_desktop` is the one cross-platform question that decides *meaning vs pixels*,
so it is added to **both** grounds (X11 derives it: `window_desktop == current_desktop` or sticky).
The workspace identity differs by ground — an **integer index** on X11 (EWMH), a **GUID string** on
Windows (no stable integer index exists in the documented API) — but the *contract* is identical:
an opaque handle compared for **equality** (same handle ⟺ same workspace; equal to
`current_desktop()` ⟺ on screen), never arithmetic. 知其雄，守其雌 — hold the elegant integer where
the ground offers one, keep the humbler GUID where it does not.

**Two honest boundaries (recorded, not faked).** (1) The documented `MoveWindowToDesktop` returns
**`E_ACCESSDENIED` (0x80070005)** for a *foreign-process* window (measured on this VM) — so the
floor does **not** fake "bring it here" on Windows; `move_window_to_desktop`/`set_desktop`/
`num_desktops` stay the truthful no-op defaults there, and the floor instead drives the
off-workspace window *in place* by meaning. (2) `current_desktop()` returns `""` when only the
bare shell occupies the current desktop (a freshly created empty one), because every
non-shell window reports the null GUID — recorded, not papered.

**Live (this VM).** `_probe_vdesk.py` **8/8 green**: baseline the floor sees the fixture on the
current desktop (`on=True`, `window_desktop == current_desktop`); after `Win+Ctrl+D` parks it on
the prior desktop the floor **now sees it dark** (`window_on_current_desktop → False`) and reports
its workspace identity (a stable GUID, unchanged, differing from the new current); the semantic
floor still **drives the pixel-less window** — `uia_set_value`(`ACROSS-DESKTOP-道法自然`, read
back exact), `uia_invoke`(ping → `PONG`), `uia_text`(multiline+CJK); and the documented
`MoveWindowToDesktop` is shown to **deny** the foreign window (`0x80070005`), with
`osctl.move_window_to_desktop` correctly a no-op. **No regression** — `_probe_winverbs.py`
**15/15** unchanged (the new `ole32` binding at import disturbs nothing). Pure stdlib.

**Lesson (道法自然).** 視之不足見，聽之不足聞，用之不可既 — what cannot be *seen* (a window on another
workspace) can still be *used*. F192 closed the eyes by show-state; F199 closes them by workspace,
and the same semantic floor reaches through. 知止不殆: the deeper discipline here is knowing where the
*platform* stops — to bind the **documented**, stable interface and report only what it can answer,
declining the undocumented one that would read further but break on the next build. 為而弗恃 — give
the floor eyes for the workspace axis, but do not lean on a move the OS forbids; operate where the
window already is.

---

## F200 — operate an app that lives **entirely in the system tray** (no top-level window at all) · the deepest zero-pixel surface

**Friction.** F192 drove a *minimized* window; F199 a window on another *virtual desktop*. Both
still appeared in `list_windows`. An app **minimised to the notification area (system tray)** has
**no top-level window at all** — its sole presence is a `NotifyIcon` button living inside
`Shell_TrayWnd`, the untitled shell window the floor never enumerates (titled top-levels only). So
the meaning-floor's window list gives *no hint the app is even alive*: it is more invisible than a
minimized or off-workspace window, which at least still have a window object. UIA *can* reach the
icon — it is a `Button` whose Name is the tooltip — but only if you already know to look inside the
magic class `Shell_TrayWnd`, knowledge an agent operating *by meaning* does not possess. The tray
was a blind spot the floor could not even name.

**Mechanism — give the floor the tray as a first-class surface, then reuse what already works.**
A single new leaf (`tray_icons()`, Windows via the same pure-ctypes UIA as F165) enumerates the
notification area *by meaning*: it walks the two `"…Notification Area"` toolbars of `Shell_TrayWnd`
(promoted icons) plus the overflow flyout (`NotifyIconOverflowWindow` / the WinUI island; hidden
icons), returning each icon as `{"name","help","aid","rect"}` in screen coordinates. Scoping to the
notification-area toolbars is what makes it *honest*: the taskbar's own buttons (Start, Search, Task
View, running apps) are siblings in the same `Shell_TrayWnd` tree but are **not** tray icons, and
they fall outside those toolbars, so they are correctly excluded. The *operating* half needs no new
machinery at all — a `NotifyIcon`'s context menu opens as the same untitled native `#32768` popup
that F186's `uia_context` already walks via `menu_windows()`. So two thin compositions finish it:

```python
tray_icons()                       -> [{"name","help","aid","rect"}, …]   # discover by meaning
tray_invoke(name, right=False)     -> bool   # click the icon (right=True for its menu)
tray_context(name, *path)          -> bool   # right-click + walk the context menu by meaning
```

The mouse is the *honest* actuator for the click: a tray icon exposes only a legacy IAccessible
default action, not a real UIA Invoke pattern, so a real click on the reported rect is exactly what
a human (or a screen reader's "do default") does — the semantic search hands the pixel floor a
target, the loop closes. `tray_context` is the tray's exact twin of `uia_context`.

**Honest boundary.** `tray_icons()` returns `[]` on a backend with no Windows tray (the X11 status
area / StatusNotifier is a different, fragmented protocol and is left a truthful no-op until a real
Linux tray app demands it — 知止不殆, do not build a primitive ahead of a reproduced failure).

**Live (this VM).** `_probe_tray.py` **8/8 green** against a WinForms `NotifyIcon` fixture whose
only Form is hidden (`ShowInTaskbar=$false`, never shown) so the process owns **no** top-level
window: (1) the app is absent from `list_windows` (pure tray residency); (2) `tray_icons()`
discovers it by meaning (the tooltip) with a screen rect; (3) `tray_context(TITLE, "Ping Sentinel")`
and `…("Mark Done")` right-click it and pick menu items by meaning, and the effects **land** — the
hidden app writes the sentinel file — with no visible window ever touched; (4) `tray_icons()`
excludes the Start/Search/Task-View taskbar buttons. The fixture is finally quit through its *own*
tray menu (`tray_context(TITLE, "Quit")`). **No regression** — `_probe_winverbs.py` **15/15** and
`_probe_vdesk.py` **8/8** unchanged. Pure stdlib.

**Lesson (道法自然).** 為學者日益，聞道者日損 — the tray looked like it needed a whole new operating
stack, yet the round *subtracted*: discovery was the only true gap, and once the floor could *name*
the tray, F186's context-menu walk already operated it. 大音希聲 — the deepest hiding place (an app
with no window) yields to the smallest addition (one enumerator), because the meaning-floor's
existing verbs were already general. 萬物並作而不相害: minimized (F192), off-workspace (F199), and
tray-resident (F200) are three faces of one truth — *pixels are not where meaning lives* — and the
same floor reaches all three.

---

## F201 — a window with **pixels but no meaning**: perceive semantic opacity, then operate by pixels+keys (Inkscape / GTK-on-Windows)

**Friction (forward practice, a real app).** F192/F199/F200 found windows with *meaning but no
pixels*. Driving **Inkscape** (GTK3) cold surfaced the exact **inverse**, and a sharper one: a window
with *pixels but no meaning*. Inkscape's canvas window exposes a UIA tree of **only 7 elements — all
window-frame chrome**: one `Pane` for the *entire* client area, the `TitleBar`, the `System` menu, and
the OS caption buttons (Minimize/Restore/Close). Every **application** control — the File/Edit menubar,
the toolbox, the colour palette, the Fill&Stroke panel — is **invisible** to the meaning floor:
`uia_find(ink, "File")` → `None`, `window_menu` → `[]` (the menubar is GTK-drawn, not a Win32 menu),
`child_windows` → `0`. GTK on Windows bridges *nothing* below the toplevel into UIA. The friction is
not "Inkscape is hard" — it is that **`uia_find → None` is ambiguous**: it means *either* "wrong name,
try another" *or* "this whole window has no semantic surface — stop searching by meaning". An agent
that cannot tell these apart burns its turns guessing control names at a wall.

**Mechanism — give the floor a way to *know* it has hit a meaning-wall, so it switches channels.**
A small, cross-platform read composed from `uia_find_all`:

```python
window_opaque(win) -> bool   # True ⟺ the a11y tree holds NO operable app control, only OS frame chrome
```

It scans the tree and returns True iff every element is window-frame scaffolding — discounting the
caption buttons / `System` menu by name (`close`/`minimize`/`maximize`/`restore`/`system`/…) and keying
on *operable* control types (Button, MenuItem, Edit, ComboBox, Tab, …). The point is the **discipline
it encodes**: opacity is about *operable controls*, not raw element count (an opaque window still has
its 6–7 chrome elements — UIA is not broken, the *toolkit* is mute). When `window_opaque` is True the
floor stops asking for meaning and drives by the **pixel+keyboard** channel it already owns
(`screenshot`/`find_color`/`pixel` + `tap`/`drag`/`click`) — no new operating verb is owed, only the
*perception* that selects the right channel. 知止不殆: knowing where the meaning-floor stops is itself
part of operating it.

**Honest boundary.** `window_opaque` is a heuristic over the a11y tree, not an oracle. It discounts
controls whose names match the OS frame, so a real app whose *only* actionable control were named
exactly "Close" could misread as opaque (vanishingly rare for a genuinely operable window). The frame
names are English on this VM; a localized Windows would need its own set. Recorded, not papered.

**Live (this VM).** Two halves, both green. (a) **Real Inkscape, by hand:** focus the canvas (a click —
`activate_window` raises but GTK tool shortcuts need *keyboard* focus on the canvas, itself a noted
friction), press `r` (rectangle tool), drag → a rectangle appears (page centre white→black), then click
the meaning-blind palette's red swatch (a pixel located by colour) → fill `#FF0000`, page centre
verified `(255,0,0)` — an app whose every control is UIA-invisible, driven end-to-end by pixels+keys;
`window_opaque(ink)` correctly **True**. (b) **Deterministic proof** — `_probe_opaque.py` **7/7**: a
rich WPF window reads **not** opaque and `uia_find('field')` works; a synthetic opaque fixture (one
`Border` that repaints red on click, no controls) reads **opaque**, `uia_find` for any app control is
`None`, *yet* a pixel click drives it white→red; and the opaque window is shown to still carry its frame
chrome (so the signal is *operable-control absence*, not UIA failure). **No regression** —
`_probe_winverbs.py` **15/15**, `_probe_tray.py` **8/8**, `_probe_vdesk.py` **8/8**. Pure stdlib.

**Lesson (道法自然).** 明道如費，夷道如類 — the floor's brightest verbs (the whole `uia_*` vocabulary) go
*dark* against a mute toolkit, and pretending otherwise (guessing names forever) is the failure. 知人者
智，自知者明: the deeper capability is not another way to *act* but the floor *knowing its own blind
spot* and choosing pixels over meaning without being told. F192/F199/F200 taught it to act where there
are no pixels; F201 teaches it to recognise where there is no meaning — 一陰一陽之謂道, the two are one
discipline: match the channel to what the window actually offers, neither more nor less.

---

## F202 — the **file clipboard** (CF_HDROP): see and originate the way a human moves data between apps

**Friction (forward practice).** The floor's clipboard was text-only (`CF_UNICODETEXT`). But the
commonest cross-application transfer on a desktop is *not* text: when a user does Ctrl+C in Explorer
(or "Copy" in any shell view, a file manager, an email attachment list), the payload is a **file
list** (`CF_HDROP`), and `get_clipboard()` returns `""`. So the floor was blind two ways at once — it
could neither *see* what a user had copied (it looked empty) nor *originate* a file copy to paste
somewhere. For an agent meant to "operate all software", moving files between apps is table-stakes,
and it had no hands for it.

**Mechanism — the non-text twin of the clipboard, by hand in pure ctypes.**

```python
get_clipboard_files() -> [path, …]          # read CF_HDROP (DragQueryFileW)
set_clipboard_files(paths, move=False) -> bool   # write CF_HDROP + "Preferred DropEffect"
```

`get_clipboard_files` reads the dropped-file list via `DragQueryFileW`. `set_clipboard_files` builds
the `DROPFILES` structure by hand — the 20-byte header (`pFiles=20`, point, `fNC=0`, `fWide=1`) followed
by the wide, double-NUL-terminated path list — and *also* registers the **`"Preferred DropEffect"`**
format (DROPEFFECT_COPY/MOVE), because without it Explorer cannot tell a paste-copy from a paste-move
and the Ctrl+V silently does nothing. That second format is the non-obvious detail that makes the
paste actually land.

**Honest boundary.** Windows-only for now: the X11 ground's file clipboard is the fragmented
`text/uri-list` selection target, left a truthful `[]`/`False` no-op (the `getattr` fallback) until a
real Linux failure is reproduced — 知止不殆.

**Live (this VM).** `_probe_clipfiles.py` **7/7**: with a file copied by an *external* app (PowerShell
`Set-Clipboard`), the text channel reads `""` (the friction) while `get_clipboard_files()` reads the
path — so the floor now *sees* a real app's copy; `set_clipboard_files` round-trips; and end-to-end the
floor sets a file list, opens a **real Explorer window** at a destination folder, sends Ctrl+V, and the
file **lands** there — a genuine OS file-copy driven by the clipboard, verified a *copy* (the source
survives) with matching content. **No regression** — `_probe_winverbs.py` **15/15**, `_probe_opaque.py`
**7/7**, `_probe_tray.py` **8/8**. Pure stdlib.

**Lesson (道法自然).** 大道甚夷 — the data path humans use most (drag a file, copy a file) looked beneath
notice next to the semantic floor's cleverness, yet its absence was a plain hole in "operate all
software". 為而不爭: the fix adds no new gesture, only teaches the existing clipboard a second native
tongue (files, not just text), and the honest detail — the Preferred-DropEffect format Explorer
silently requires — is the kind of small truth that decides whether the paste is real or theatre.

---

## F203 — the **image clipboard** (CF_DIB): the third clipboard tongue

**Friction (forward practice).** F202 gave the *file* clipboard; the clipboard's third native format
is a **bitmap**. When an app does "Copy" of a picture — a chart from a spreadsheet, a region from a
screenshot tool, a selection in an image editor, "Copy as image" anywhere — the payload is `CF_DIB`,
and it is invisible to *both* the text clipboard (`get_clipboard()`→`""`) and the file clipboard
(`get_clipboard_files()`→`[]`). So the floor could neither *see* an image a user/app had copied nor
*originate* one to paste into Paint or a document. With text (F003) and files (F202) covered, the
bitmap was the last blind spot in the one surface every app shares.

**Mechanism — read/write `CF_DIB`, reusing the floor's own PNG codec.**

```python
get_clipboard_image(path) -> path | None   # CF_DIB -> (w,h,rgb) -> PNG the floor can perceive
set_clipboard_image(path) -> bool          # PNG -> (w,h,rgb) -> CF_DIB on the clipboard
```

The backend parses a `CF_DIB` (a headerless `BITMAPINFOHEADER` + bottom-up, 4-byte-padded rows;
handles 24/32-bit and the `BI_BITFIELDS` mask block) into the **same `(w,h,rgb)` top-down layout
`capture_rgb` produces**, so a clipboard image flows straight into the floor's existing perception
(`find_color`, template match, `ocr`) — a screenshot by another name. Origination is the inverse:
build a 24-bit bottom-up DIB. The serialisation to/from disk reuses the hand-rolled `zlib` PNG
encoder `_png` and its new inverse `_decode_png_rgb` (full None/Sub/Up/Average/Paeth filter support),
so no new image dependency enters — the floor already speaks PNG for screenshots.

**Honest boundary.** Reads 24/32-bit DIBs; palettised/16-bit/exotic DIBs return `None` (not a wrong
guess) until a real case appears. `_decode_png_rgb` is baseline truecolour 8-bit, non-interlaced —
which is exactly what `_png` writes — and raises (not silently mangles) on anything else. Windows-only;
X11's image selection is a separate target, a truthful no-op for now.

**Live (this VM).** `_probe_clipimage.py` **6/6**: `set_clipboard_image` originates a bitmap; with it
present the text and file clipboards both read empty (the friction); `get_clipboard_image` materialises
it and the round-trip is **pixel-exact** (every pixel of a 5×4 pattern). Then an **external** app
(Windows PowerShell `Clipboard.SetImage` on a solid 40×24 bitmap) copies an image and the floor reads
it back at the right dimensions and centre colour `(18,52,86)` — so the floor now *sees* what another
program copied as a picture. **No regression** — `_probe_winverbs.py` **15/15**, `_probe_opaque.py`
**7/7**, `_probe_clipfiles.py` **7/7**. Pure stdlib.

**Lesson (道法自然).** 大制無割 — text, files, and images are not three problems but one surface seen
three ways; the floor already had the parts (a DIB is a screenshot, a PNG it already writes), so the
"new" capability was mostly *recognising the unity* and wiring the existing pieces, adding only the
small honest format work. 萬物負陰而抱陽: every read primitive (`get_clipboard_image`) implies its write
(`set_clipboard_image`); completing the pair is what makes the clipboard a true two-way channel rather
than a one-way peek.

---

## F204 — read the **keyboard focus** desktop-wide: where will my keystrokes land?

**Friction (forward practice).** Every locate verb answers "where is control X in window W"
(`uia_find`). But a keypress is *not* aimed at a control by name — it goes to whatever currently holds
**focus**, and that target was invisible to the floor. After clicking a field, pressing Tab, or when a
dialog pops up, the floor had no way to *verify* where its next `type_unicode`/`tap` would land; it
typed blind and trusted that the prior click/focus had taken. The mouse has a visible cursor and the
floor always knows the click point; the keyboard's aim point had no such read.

**Mechanism.** `IUIAutomation::GetFocusedElement` (vtable 8), wrapped exactly like the other UIA reads
(`@_hangproof`, per-thread STA):

```python
uia_focused() -> {"name","type","aid","help","rect":(x,y,w,h),"pid"} | None
```

The one element that owns the keyboard *right now*, across every app at once — the keyboard's twin of
the mouse cursor. `pid` names the owning process, so the floor can distinguish "focus is in my target
app" from "a modal/another app grabbed it". `rect` makes the focus target also a clickable point,
closing the same locate→actuate loop `_prop_rect` gives `uia_find`. It is a pure read; it neither
moves focus nor types.

**Honest boundary.** Returns `None` on a backend without UIA, and on a focus owner that exposes no UIA
element (a fully opaque/GTK surface — F201 — reports its top-level or nothing). For those, focus
verification falls back to the pixel channel (caret/highlight), as F201 already prescribes.

**Live (this VM).** `_probe_focus.py` **5/5**: focusing the WPF fixture's text field by meaning makes
`uia_focused()` report *that* `Edit`; moving focus to the button reports the `Button` instead (focus
tracked live); `pid` equals the fixture's own process id (so the floor knows *which* app holds focus);
the focused element carries a screen rect; and the payoff — typing after reading focus lands exactly
where `uia_focused` pointed (the field's value becomes the typed text). **No regression** —
`_probe_winverbs.py` **15/15**, `_probe_tray.py` **8/8**, `_probe_clipimage.py` **6/6**. Pure stdlib.

**Lesson (道法自然).** 知人者智，自知者明 — F201 taught the floor to know a window's blind spot; F204 teaches
it to know *its own aim*. Acting without first reading where the act will land is the root of blind
flailing; a single cheap read before each commit (where is focus? is it in my app?) turns hopeful
typing into verified typing. 為而不爭: the verb does nothing — it only *sees* — yet it is what lets every
later keystroke be deliberate.

---

## F205 — `screen_observe()`: the one per-step observation a GUI agent reasons over (reverse-logic)

**Friction (reverse-logic round).** Reading the public AI-GUI frameworks from their *outcomes* back to
their essence — UFO's per-app **control inventory**, OmniParser / Agent-S's **set-of-marks** of
labelled, clickable regions — the one loop they all share is: *each step, take a single structured
snapshot of the screen* (the foreground app, its actionable controls with boxes, where focus is), then
decide. Our floor already had every ingredient (`list_windows`, `active_window`, `window_geometry`,
`window_opaque`, `uia_find_all`, `uia_focused`) but **no single call that assembles them** — an agent
had to hand-stitch six reads every step and re-derive which channel each window needs. The friction is
the *absence of the observation primitive itself*: the floor had the verbs of action and of perception,
but not the one read that turns a screen into a decision-ready state.

**Mechanism — compose, don't invent.**

```python
screen_observe(deep=False) -> {
    "active":  hwnd | None,                       # foreground window
    "focus":   {name,type,aid,rect,pid} | None,   # where keystrokes land (F204)
    "windows": [ {"id","title","rect","active","opaque","actions":[{name,type,aid,rect}…]} … ],
}
```

Each window carries its frame `rect` and an `opaque` flag (F201), and — for the **foreground** window
by default — its list of *actionable* controls only (the F201 control types minus OS frame chrome), so
the snapshot is decision-ready rather than a raw tree dump. Scanning every window's full a11y tree each
step is costly and rarely needed (an agent acts in the foreground window), so background windows are
listed (id/title/rect) without an action scan unless `deep=True`. It is **pure composition** of existing
floor reads: it speaks *meaning* where a window offers it and flags `opaque` where the agent must drop
to pixels — the floor's own F201/F204 discipline, surfaced as one call. No new OS binding.

**Honest boundary.** On a backend without UIA, `actions` is `[]` and `opaque` `False` (the pixel floor
still applies); the window list, geometry and focus remain truthful. `max_actions` caps total controls
returned so a pathological tree cannot bloat the observation.

**Live (this VM).** `_probe_observe.py` **6/6**: returns the structured shape (5 windows); marks the
foreground fixture active + not opaque and inventories its actionable controls by meaning (the `field`
Edit + the `ping`/echo Buttons, 29 controls, each with a rect); folds in live focus consistent with
`uia_focused`; leaves the 4 background windows action-empty by default (efficiency); and `deep=True`
keeps the active inventory while scanning all 5 windows (1→5 scanned). **No regression** —
`_probe_winverbs.py` **15/15**, `_probe_opaque.py` **7/7**, `_probe_focus.py` **5/5**. Pure stdlib.

**Lesson (道法自然).** 大制無割 — studying others' finished systems backward, the deep lesson was not a
missing capability but a missing *cut*: the floor's many small reads were the whole observation already,
waiting to be seen as one. 樸散則為器：the uncarved primitives become a usable instrument only when
assembled, yet the assembly *adds nothing new* — `為而弗恃`, it composes what is there and claims no new
power. The frameworks' "perception model" is, at root, this one disciplined read; building it from the
floor's own verbs is the reverse-logic payoff — understanding another's essence well enough to find it
already present in one's own ground.

---

## F206 — `wait_control` / `wait_control_gone`: semantic synchronization in time

**Friction (forward practice).** A GUI is a process in time *within* a window, not only at window birth.
Clicking a menu item opens a dialog whose **OK** appears a beat later; a panel expands; a tab's content
loads; a "Loading…" spinner clears. The floor could wait for a whole new *window* (`wait_window`, F152)
or for *pixels* (`wait_pixel`), but had **no wait for a control to become operable by meaning inside an
existing window**. So every multi-step interaction either *raced the control's birth* — acted the
instant after the trigger, found nothing, failed — or slept a fixed guess (too short → flaky; too long →
slow). Pixel waits don't help: they confirm something was *drawn*, not that it is an *operable control*
the floor can address by name.

**Mechanism — poll `uia_find`, both polarities.**

```python
wait_control(win, name=, ctype=, timeout=8) -> uia_find dict | None   # appears
wait_control_gone(win, name=, ctype=, timeout=8) -> bool              # disappears
```

`wait_control` is the semantic dual of `wait_window`/`wait_pixel`: it returns the control's
`{name,type,aid,rect}` the moment it is present, so the very next step can invoke/type against a target
the floor has just *confirmed* exists. `wait_control_gone` is the disappearance dual — the readiness gate
that is something *leaving* (a spinner clearing, a progress dialog's controls vanishing, a validation
error dismissing). Both are **pure composition** of `uia_find`; `None`/`False` (never raise) on a backend
without UIA, so a caller can fall back to a pixel wait.

**Honest boundary.** Polls (default 0.25s) rather than subscribing to UIA events — simpler, backend-
agnostic, and bounded by `timeout`; a control flickering in and out faster than the poll could be missed
(no real case yet). On an opaque window (F201) it returns `None`/`True` (nothing to find by meaning) and
the caller uses the pixel wait, exactly as F201/F205 prescribe.

**Live (this VM).** `_probe_waitctl.py` **5/5** against a window that *changes after it is already up*
(two `DispatcherTimer`s add a `ready` button at ~1.4s and remove a `spinner` at ~2.6s): a control present
from the start returns in 0.08s; the late `ready` button is waited for and returned (absent at start,
1.43s wait); a control that never appears returns `None` exactly at the 1.2s deadline; `wait_control_gone`
on a *permanent* control honestly blocks then times out `False` (1.43s); and the removed spinner is
reported gone. **No regression** — `_probe_winverbs.py` **15/15**, `_probe_observe.py` **6/6**. Pure stdlib.

**Lesson (道法自然).** 動其機，萬化安 (《陰符經》) — acting in phase with the screen's own unfolding, rather
than against it, is what makes a sequence of operations hold together; the floor's earlier verbs were all
*spatial* (where), this is the missing *temporal* one (when). 反也者，道之動也: appearance and
disappearance are one motion seen from two sides, so the wait had to come as a pair — to wait only for
things to arrive is to be stuck whenever the gate is something departing.

---

## F207 — `uia_set_value` must hit the editable field, not its same-named caption — and never lie

**Friction (forward practice, real Notepad++).** Driving NPP end-to-end through the floor —
`wait_window` → `screen_observe` → open Replace (Ctrl+H) → `wait_control("Replace All")` → set the two
fields by meaning → invoke — the result was *wrong*: every `alpha` was **deleted** instead of replaced by
`omega`. Inspecting the live dialog showed why: its label, ComboBox and Edit are **all three named
`"Replace with:"`** (and the two Edits even share `AutomationId 1001`). Two floor bugs compounded:
1. `_find_ptr` returned the **static Text caption** (first in tree order), so the write aimed at an
   uneditable label;
2. when the write was then attempted, `uia_set_value` **reported success having changed nothing** — its
   keyboard-floor fallback clicks the rect and types, then returned `True` unconditionally; typing into a
   read-only/label control is a no-op. So `Replace with` stayed empty and *Replace All* ran with an empty
   replacement.

**Mechanism — prefer the actionable twin, and prove the write.**
- `_find_ptr` (the shared matcher): when the caller did **not** pin a `ctype`, an exact-name match on a
  `Text` control is now held only as a *fallback* — an actionable (non-`Text`) control with the same exact
  name wins. A field's caption almost always shares the field's accessible name (it `LabeledBy`s it), and
  one virtually never wants to *act on the caption*. Explicit `ctype` still returns that type immediately.
- `uia_set_value` (osctl) now holds the **keyboard-floor path to the same read-back proof** the pattern
  path already used: trust the typed write only if the value became `value` or at least *changed* from
  before; stay optimistic **only** when the field's value cannot be read back at all (a Scintilla editor
  exposes none), so a genuinely-unobservable-but-working field is not wrongly failed. The UIA
  ValuePattern leaf also now refuses a `CurrentIsReadOnly` target rather than returning `SetValue`'s
  hollow `S_OK`.

**Honest boundary.** The read-back oracle can only *contradict* success when the value is observable and
unchanged; for write-only/unreadable fields the verb stays optimistic (unchanged behaviour). A field that
legitimately normalises input (`5`→`5.00`) still counts as success because it *changed*.

**Live (this VM).** Real **Notepad++** Replace now yields `'omega beta omega gamma omega'` (was the
data-destroying `' beta  gamma '`). `_probe_setvalue.py` **5/5** on a fixture reproducing the collision (a
`TextBlock` + `TextBox` both named `email`, a read-only `TextBox` named `locked`, a unique `solo`): writes
into the *field* not the label; find-by-name returns the actionable control; a read-only target returns
`False` and is left unchanged; unambiguous fields still settable; explicit `ctype` still works.
**No regression** — `_probe_winverbs.py` **15/15**, `_probe_opaque.py` **7/7**, `_probe_focus.py` **5/5**,
`_probe_observe.py` **6/6**, `_probe_waitctl.py` **5/5**. Pure stdlib.

**Lesson (道法自然).** 信言不美 — a verb that *says* it set a field but did not is worse than one that admits
it cannot: the lie propagated into deleted text. The cure is the floor's oldest law, applied once more —
*the change is the oracle*: don't believe the return code, read the result back. And 名可名也，非恒名也:
a name is not a unique handle on a thing — three controls wore `"Replace with:"`; meaning had to be
refined by *role* (act on the field, not its caption) to pick the one that can actually receive.

---

## F208 — `uia_text(win)` must read the window's *primary* text, not its first descendant

**Friction (forward practice, real Windows console).** Driving a `conhost` window through the floor to
read a command's output: `uia_text(win, ctype="Document")` correctly returned the **whole 20 000-char
scrollback** (the console exposes its buffer as a real `Document` TextPattern provider), and so did
`read_selection` (Ctrl+A + copy, F195) — but `uia_text(win)` with **no target** returned only **8
characters**: the *accessible Name of a scrollbar*. A type-less, name-less descendant scan returns the
first element it reaches (here a `ScrollBar` named `"Vertical"`), so "read this window's text" silently
answered with chrome instead of content — the F207 class of bug (a plausible-looking but wrong result),
now in a *read* verb.

**Mechanism — resolve to the primary text container when no target is pinned.** When `uia_text` is given
neither `name` nor `ctype`, it now resolves the window's main readable surface in priority order
(`Document` → `Edit`) and returns the first that actually carries text; only if none does does it fall
back to the prior first-element read. The per-element extraction (TextPattern `DocumentRange.GetText`,
else the accessible Name where a custom editor publishes its buffer — Scintilla/Notepad++, F191) is
factored into `_element_text` so the no-target path and the targeted path read by **identical** rules.
A targeted `uia_text(win, ctype=…)`/`uia_text(win, name=…)` is unchanged.

**Honest boundary.** A console's grid, like LibreOffice Calc's (F195) and GTK's canvas (F201), is *drawn*,
not modelled per-glyph — but conhost still publishes the buffer on a `Document` TextPattern, so meaning
*does* reach it; where it would not, `read_selection` (the universal copy channel) remains the floor's
already-owned fallback, proven here too.

**Live (this VM).** `_probe_console.py` **4/4** on a real `cmd` console printing a marker: the `Document`
read carries it; `uia_text(win)` with no target now carries it (was a scrollbar name); `read_selection`
carries it; and fresh `echo` output appears in the next `uia_text(win)`. **No regression** —
`_probe_uiatext.py` (F170) still green (its negative ValuePattern assertion hardened: Chrome's `Document`
ValuePattern returns the *URL*, which percent-encodes the body, so the decoded phrase `"floor reads me"`
proves the body is reachable only through TextPattern), `_probe_winverbs.py` **15/15**,
`_probe_setvalue.py` **5/5**. Pure stdlib.

**Lesson (道法自然).** 大方無隅 — the obvious reading of "the text of this window" has no single corner to
grab; a window is many elements, and the *first* one is rarely the one that matters. The verb must carry
a notion of *primacy* (the content surface), not merely *firstness* (tree order) — the same refinement
F207 made for writing (act on the field, not its caption) now made for reading (read the document, not the
scrollbar). 知人者智，自知者明: the floor grew not a new power but a clearer sense of *what it was being
asked for*.

---

## Frontier (next honest rounds)

These are *not yet built* — they are the next real surfaces to push into. Each
will only grow a primitive once a real failure is reproduced.

- **A window with *pixels but no meaning* — a semantically-opaque toolkit (GTK-on-Windows). — SOLVED, F201.**
  The inverse of the zero-pixel frontier: Inkscape's canvas window exposes only 7 UIA elements, all
  window-frame chrome — File/Edit/toolbox/palette are invisible. `window_opaque(win)` lets the floor
  *recognise* this (no operable control in the a11y tree) and switch to the pixel+keyboard channel it
  already owns. Proven `_probe_opaque.py` 7/7 + live on real Inkscape (rectangle drawn & filled #FF0000
  by keys+pixels). Kept here as a pointer.

- **An app with *no top-level window at all* — resident entirely in the system tray. — SOLVED, F200.**
  The deepest zero-pixel surface: a window minimized to the notification area is absent from
  `list_windows` (its only presence is a `NotifyIcon` inside the untitled `Shell_TrayWnd`). `tray_icons()`
  enumerates the tray *by meaning* (scoped to the notification-area toolbars + overflow flyout, excluding
  taskbar buttons), and `tray_context()` reuses F186's `#32768` menu walk to operate it. Proven
  `_probe_tray.py` 8/8: a hidden-Form NotifyIcon fixture, absent from `list_windows`, is discovered by its
  tooltip and driven through its context menu (effects verified via a sentinel file). Kept here as a pointer.

- **A window with zero on-screen pixels *by workspace*, not just show-state. — SOLVED, F199.**
  F192 drove a *minimized* window by meaning; F199 does the twin — a window on another **virtual
  desktop** — and teaches the floor to *see* the workspace axis on Windows (it was X11-only)
  through the documented `IVirtualDesktopManager` (`window_on_current_desktop`/`window_desktop`),
  declining the build-fragile internal interface that would switch/move-foreign/count. Proven
  `_probe_vdesk.py` 8/8: a fixture parked on a second desktop is driven by `uia_set_value`/
  `uia_invoke`/`uia_text` while the floor correctly reports it dark. Kept here only as a pointer.

- **R-next: an atlas built from the live page, not a fixture. — SOLVED, F198.**
  `learn_glyphs` turns a patch of real on-screen text whose string is *known* (a tree-reported
  caption, a cell just typed, a canvas run named another way) into the `{char: edge_signature}`
  atlas the readers consume — captured from the live rendering, no fixture — so `read_text` can then
  name *unknown* runs drawn in that same font. Proven on a real Chrome `<canvas>`: learn `DAOFLOOR2197`,
  read the never-taught `ROOF1729` exactly from pixels. Kept here only as a pointer to the entry above.
- **Addressing an *arbitrary* spreadsheet cell by its reference (LibreOffice Calc / VCL). — SOLVED, F197.**
  *Reading* a cell by meaning is solved (F195: position the selection, read the copy channel),
  writing works by focusing the grid by meaning + typing, and now *navigating to a named cell* like
  `B2` is solved by `goto_cell` (F197): click the meaning-found Name Box where `uia_focus` lied,
  type the reference, and verify via the box's own readback — with a geometry fallback that
  self-heals a box poisoned by a rejected reference. Kept here only as a pointer to the entry above.
- **Drawn document text is the F188/canvas family across *every* office toolkit — and F195 is the
  general answer.** This round confirmed it on three more surfaces (this VM): SumatraPDF renders a
  PDF page as pixels (`uia_text(document)` empty; only the toolbar's `Page:`/`Next Page` are in the
  tree, so navigation is by meaning but the page body is not); LibreOffice **Writer** renders the
  document body the same way Calc renders its grid — `uia_text(document)` returns only the doc's
  *name* (`"Untitled 3 - LibreOffice Document"`), never the typed text, yet `read_selection`
  (Ctrl+A + copy) reads back `道法自然 floor F197 probe` exactly. No new verb is owed here: F195 already
  is the cross-toolkit read for drawn text; the frontier is only *positioning* a selection by
  meaning where the toolkit also hides the cursor model (the Calc cell-reference item above).
- **A dialog field with no Name, no AutomationId, and no in-tree label has no semantic anchor —
  and that is provider opacity, not a missing verb.** paint.net's Adjustments dialogs
  (.NET, e.g. *Brightness / Contrast*) expose the two numeric edits with `name=''` *and* `aid=''`,
  and the "Brightness"/"Contrast" captions are *drawn*, absent from the tree (`text(0)` inside the
  dialog) — so nothing in the accessibility tree distinguishes the two fields; only geometry does
  (top edit = Brightness, set to `60` by position, read back `60`). A label-pairing verb (pair a
  nameless field to its nearest in-tree caption, like `uia_rows` but label→field) was considered and
  **deliberately not built**: it cannot help paint.net (the captions are not in the tree at all),
  and it is unnecessary for the dialogs that *do* expose captions — 7-Zip's *Add to archive* dialog,
  the obvious classic-Win32 candidate, already gives every control the caption as its **Name** (the
  password `edit` is `name="Enter password:"`, the `Dictionary size:` combobox is named in full), so
  it is wholly meaning-operable as-is. With no surface where pairing both *applies* and *helps*, the
  honest floor for unlabeled drawn-caption fields is geometry/pixel. 知止不殆.

---

## F213 — `uia_find_all` absent on the Linux/AT-SPI backend: the semantic floor is blind

**Friction (reproduced).**  On the Linux X11 backend `uia_find_all(win)` always
returned `[]` — not because the AT-SPI tree was empty (it wasn't; `uia_find` and
`uia_children` both worked fine on kwrite/gedit/Inkscape/LibreOffice), but because
the verb was **never implemented** in `_osbackend_x11.py`.  `osctl.py` fell back to
`lambda …: []`.  Every caller that depended on the plural walk — `window_opaque`,
`_actionable`, `screen_observe`, `goto_cell` — was dead on Linux.

**Root cause.**  The Windows backend had `uia_find_all` (a `FindAll(Descendants,
TrueCondition)` walk bounded by `max_scan`); the X11 backend never got a dual.

**Fix.**  `_impl_uia_find_all` walks the AT-SPI tree (same `_walk` DFS, same crash
isolation via ephemeral worker) collecting every matching descendant up to
`max_scan`, with `name`/`ctype` filtering matching `uia_find`'s semantics.
Registered in `_WORKER_IMPL`/`_WORKER_DEFAULT`; public `uia_find_all` shim added.

**Proof.** `_probe_find_all_x11.py` — 11/11 live checks on kwrite:
`uia_find_all` returns 376 elements, element schema correct, filters work.

---

## F214 — AT-SPI role names ≠ UIA type names: `window_opaque` / `screen_observe` blind on Linux

**Friction (reproduced).**  `window_opaque(kwrite)` returned `True` (opaque — no
meaning) even though the AT-SPI tree had 376 controls.  `screen_observe` reported
0 actions for the active window.  Why: AT-SPI role names are lowercase with spaces
(`"push button"`, `"menu item"`, `"combo box"`), but `_OPAQUE_ACTIONABLE` expected
Windows UIA PascalCase names (`"Button"`, `"MenuItem"`, `"ComboBox"`).

**Root cause.**  Two naming vocabularies, no translation layer.

**Fix.**  `_ROLE_TO_UIA` map (60+ entries) translates every known AT-SPI role to
its UIA ControlType equivalent at the `uia_find_all` output boundary.  Callers
see a single cross-platform vocabulary; no per-backend branching needed.

**Proof.** After fix: `window_opaque(kwrite)` → `False`; `screen_observe` →
308 actions for kwrite.  `_probe_find_all_x11.py` check 3 verifies no raw AT-SPI
role names leak into the `"type"` field.

---

## F215 — AT-SPI reports `INT32_MIN` screen rects for off-screen / hidden-tab controls

**Friction (reproduced).**  Inkscape's Welcome dialog has controls on non-active
tabs whose `atspi_component_get_extents` returns `(-2147483648, -2147483648, w, h)`
— i.e. `x = y = INT32_MIN`.  `uia_click` aimed the cursor at this nonsense
coordinate; the click went nowhere useful.

**Root cause.**  GTK widgets on a hidden notebook page report their extents at
`INT32_MIN` rather than `(0,0,0,0)` or refusing the query.

**Fix.**  `_acc_rect` now rejects any rect with `x < -30000` or `y < -30000`,
returning `None` — same as for zero-sized rects.  Callers (uia_click, uia_find_all,
screen_observe) already handle `None` gracefully.

**Proof.** Inkscape `uia_find_all` no longer reports nonsense rects;
`uia_click(wid, name='New Document')` on the hidden-tab button correctly returns
`False` (no rect → no click) instead of spraying the cursor at `INT_MIN`.

---

## Frontier (next honest rounds)

These are *not yet built* — they are the next real surfaces to push into. Each
will only grow a primitive once a real failure is reproduced.

- **A window with *pixels but no meaning* — a semantically-opaque toolkit (GTK-on-Windows). — SOLVED, F201.**
  The inverse of the zero-pixel frontier: Inkscape's canvas window exposes only 7 UIA elements, all
  window-frame chrome — File/Edit/toolbox/palette are invisible. `window_opaque(win)` lets the floor
  *recognise* this (no operable control in the a11y tree) and switch to the pixel+keyboard channel it
  already owns. Proven `_probe_opaque.py` 7/7 + live on real Inkscape (rectangle drawn & filled #FF0000
  by keys+pixels). Kept here as a pointer.

- **An app with *no top-level window at all* — resident entirely in the system tray. — SOLVED, F200.**
  The deepest zero-pixel surface: a window minimized to the notification area is absent from
  `list_windows` (its only presence is a `NotifyIcon` inside the untitled `Shell_TrayWnd`). `tray_icons()`
  enumerates the tray *by meaning* (scoped to the notification-area toolbars + overflow flyout, excluding
  taskbar buttons), and `tray_context()` reuses F186's `#32768` menu walk to operate it. Proven
  `_probe_tray.py` 8/8: a hidden-Form NotifyIcon fixture, absent from `list_windows`, is discovered by its
  tooltip and driven through its context menu (effects verified via a sentinel file). Kept here as a pointer.

---

### F217 — Seven missing semantic verbs ported from Windows to Linux X11/AT-SPI

| date | 2026-06-29 |
|---|---|
| surface | all Linux apps with AT-SPI |
| root cause | Windows UIA backend had 22 semantic verbs; X11 AT-SPI backend had only 11 |

**Friction.** After F213–F216 gave the X11 backend `uia_find_all`, cross-platform
type normalization, INT_MIN rect filtering, and label-shadow fixes, the floor could
see and click any AT-SPI element — but `uia_select`, `uia_toggle`, `uia_toggle_state`,
`uia_expand`, `uia_collapse`, `uia_expand_state`, and `uia_is_selected` were absent.
An agent trying to check a checkbox, switch a tab, read a toggle state, or expand a
tree node on Linux would get a silent False / empty string.

**Root cause.** The X11 backend was built bottom-up from the pixel floor and never
ported the Windows UIA pattern verbs.  AT-SPI models these differently:

- **Selection** is on the *parent* container (`atspi_selection_select_child`),
  not on the item (UIA puts `SelectionItemPattern` on the item).
- **Toggle** has no dedicated pattern; AT-SPI checkboxes expose Action "click"
  and the checked state is `ATSPI_STATE_CHECKED` (4) in the state set.
- **Expand/Collapse** has no dedicated pattern; tree nodes expose Action
  "expand or activate" / "open" / "collapse" / "close", and the state is
  `ATSPI_STATE_EXPANDED` (10) / `ATSPI_STATE_COLLAPSED` (5).

**Fix.** Seven new `_impl_uia_*` functions, each with three-tier fallback:

| Verb | Tier 1 | Tier 2 | Tier 3 |
|------|--------|--------|--------|
| `uia_select` | parent Selection + child index | Action.doAction | rect click |
| `uia_is_selected` | parent Selection.isChildSelected | ATSPI_STATE_SELECTED | — |
| `uia_toggle` | Action.doAction | rect click | — |
| `uia_toggle_state` | STATE_CHECKED / INDETERMINATE / PRESSED | — | — |
| `uia_expand` | Action named "expand"/"open"/"activate" | action-0 | — |
| `uia_collapse` | Action named "collapse"/"close" | action-0 if expanded | — |
| `uia_expand_state` | STATE_EXPANDED / COLLAPSED / EXPANDABLE | "leaf" | — |

Also added AT-SPI Selection interface bindings (`atspi_accessible_get_parent`,
`atspi_accessible_get_index_in_parent`, `atspi_accessible_get_selection_iface`,
`atspi_selection_select_child`, `atspi_selection_is_child_selected`).

**Proof.** Live on 12 Linux apps:
- `uia_select(nautilus, name='Documents')` → True; title changed to "Documents"
- `uia_select(calc, name='7')` → True (action fallback); 7+3=10 correct
- `uia_toggle(freecad, ctype='checkbox')` → True; `toggle_state` flipped off→on
- `uia_toggle_state(freecad, ctype='checkbox')` → "on" (was "off")
- `uia_expand_state(kicad, name='File', ctype='menu')` → "leaf"
- 11/12 apps semantically visible (only Blender opaque — OpenGL UI)

**Coverage after F217.** X11 backend: 22 verbs (was 11). Verb parity with Windows
backend for all core semantic operations.

---

### F218 — ComboBox commit boundary: `uia_select` highlights, `uia_click` commits

| date | 2026-06-28 |
|---|---|
| surface | Calculator combo box "Programmer" item selected via `uia_select` but mode unchanged |
| root cause | AT-SPI `Selection` only *highlights* (pre-selects); the combo collapses on click |

**Boundary.** `uia_select` moves the highlight in a combo's dropdown, but the
combo commits only when the user presses Enter or clicks the item — "highlight ≠
commit".  The floor does not auto-commit because some workflows deliberately
browse without committing (keyboard → arrow → ESC to cancel).

**Pattern.**  `uia_expand(combo)` → `uia_click(item)` to commit; `uia_select` for
preview-without-commit.  Documented as known boundary, not a bug.

---

### F219 — Label-shadow rect preference + GTK menubar type fallback

| date | 2026-06-28 |
|---|---|
| surface | `uia_click(name='Filters')` on GIMP returns False; `uia_menu('Help','About')` fails |
| root cause 1 | DFS finds a label node (rect=None) before the operable menu node |
| root cause 2 | GIMP menubar entries are type "Menu", not "MenuItem" (Qt/KDE convention) |

**Friction 1.** `_impl_uia_find` / `_find_acc` returned the first DFS match
unconditionally.  Label/text nodes share names with operable controls but carry
`rect=None`.  All rect-clicking callers (uia_click, uia_invoke, uia_menu) failed.

**Fix 1.** DFS now tracks `first_any` but prefers the first match whose
`_acc_rect` is not None.  Falls back to `first_any` only if no rect-valid match
exists → labels are still findable for read-only queries.

**Friction 2.** `uia_menu` hard-coded `ctype="menuitem"` for the top-level
menubar entry.  GIMP (GTK) exposes those as `"menu"`, not `"menuitem"`.

**Fix 2.** Try `"menuitem"` first; if not found or rect=None, try `"menu"`.

**Proof.** GIMP `uia_click(name='Filters')` → True.
GIMP `uia_menu('Help','About GIMP')` → True.

---

### F220 — Ellipsis mismatch: `_match` rejects "Preferences..." vs "Preferences"

| date | 2026-06-29 |
|---|---|
| surface | Inkscape `uia_menu('Edit', 'Preferences...')` fails — item named "Preferences" |
| root cause | `_match` substring check: "preferences..." ∉ "preferences" |

**Friction.** The user (or AI) naturally writes `"Preferences..."` because the
menu label shows an ellipsis.  But the AT-SPI accessible name is `"Preferences"`
(no dots).  Since `"preferences..."` is *not* a substring of `"preferences"`,
`_match` rejects it.  The reverse works (`"Preferences"` ∈ `"Preferences..."`)
but is fragile and unintuitive.

**Fix.** `_strip_ellipsis(s)` strips trailing `...` / `…` (U+2026) and whitespace;
`_match` tries the exact/substring test first, then falls back to
stripped-vs-stripped.  Bidirectional: `"Preferences..."` ↔ `"Preferences"`.

**Also:** `uia_menu` now retries with `uia_invoke` when the rect-click on a
menubar entry fails to produce visible submenu items — wxWidgets menus (Audacity)
need the AT-SPI Action interface to open.

**Proof.** After fix: Inkscape `uia_menu('Edit','Preferences...')` → True (was
False). VLC `uia_menu('Media','Open File')` → True (matches "Open File...").
KWrite `uia_menu('File','Open')` → True (matches "Open..."). 8/8 tests pass.

---

### F221 — `ctype='edit'` matches text *labels*, not editable fields

| date | 2026-06-29 |
|---|---|
| surface | KDE file dialog `uia_find(name='File name:', ctype='edit')` returns the static label |
| root cause | `_ROLE_ALIAS` maps `"edit"→"text"`, AT-SPI uses role `"text"` for BOTH labels AND input fields |

**Friction.** In the KDE Open dialog, "File name:" appears twice in the AT-SPI
tree: once as a label (not editable, rect 491,693) and once as the actual input
field (editable, rect 574,693).  Both have role="text".  `uia_find(ctype='edit')`
hit the label first in DFS → click/paste went to a non-editable widget.

**Fix.** When the caller asked for `ctype` ∈ `{edit, textbox, entry}` and the
element's AT-SPI role is "text", additionally check `STATE_EDITABLE` (state
constant 8).  Non-editable "text" nodes are rejected → the actual input field
is returned.

**Also proven.** Full file-dialog chain: `uia_menu('File','Open')` → dialog
opens → `uia_set_value(dlg, '/tmp/test_open_file.txt', name='File name:', ctype='edit')`
→ Enter → KWrite loads file with correct content.  9/9 regression pass.

---

### F222 — Context menus: exact-match priority + rect=None invoke fallback

| date | 2026-06-29 |
|---|---|
| surface | `_find_menuitem("Copy")` returns "Save Copy As..." from another window's menubar |
| root cause 1 | `_match` uses substring matching; "Copy" ∈ "Save Copy As..." |
| root cause 2 | `menu_windows()` is unimplemented on X11 → `lambda: []`; GTK context menu items have `rect=None` |

**Friction.** After right-click on LibreOffice Calc, `_find_menuitem("Copy")`
scanned all windows and returned the first substring hit — KWrite's menubar
"Save Copy As..." — instead of the context menu's "Copy".  Two interacting
issues: (1) substring matching gave false positives on partial name overlap,
(2) GTK context menu items existed in the AT-SPI tree but with `rect=None`,
so they were invisible to the rect-requiring search.

**Fix 1.** `_find_menuitem` now uses `uia_find_all` per window and prefers
**exact** name matches (case-insensitive) over substring hits.  Priority:
exact+rect > exact+no-rect > substring+rect.

**Fix 2.** `_walk_menu_path` falls back to `uia_invoke(wid, name=..., ctype='menuitem')`
when the found item has `rect=None`.  GTK/LibreOffice context menu items
respond correctly to AT-SPI Action invocation even without screen coordinates.

**Proven.** LO Calc right-click > Copy via invoke: clipboard = "道法自然 Context Copy" ✓.
KWrite right-click > Copy via rect-click: clipboard = "KWrite context test" ✓.
Menu chain regression 4/4: GIMP, VLC, KWrite, Inkscape all pass.

---

### F223 — VK_OEM punctuation + function keys unmapped on X11; GTK file dialog inaccessible

| date | 2026-06-29 |
|---|---|
| surface | `tap(0xBF)` does nothing — GTK file chooser location bar never activates |
| root cause | `_VK_KEYSYM` lacked VK_OEM_* (0xBA-0xDE) and VK_F1-F24 (0x70-0x87) mappings; fallback `return vk` gave wrong keysyms (191 ≠ slash keysym 0x2F) |

**Friction.** GIMP's File > Open produces a GTK file chooser dialog.  The file list
data items expose **no names** via AT-SPI (GtkTreeView cell renderers are
inaccessible).  The only way to type a path is to press `/` to activate the
location entry bar — but `tap(0xBF)` (VK_OEM_2 = `/?`) was silently producing
keysym 191 instead of `/` (keysym 0x2F), so the location bar never opened.

**Fix.** Added 11 VK_OEM punctuation mappings (`;=,-./ \`[]\\'`) and VK_F1..VK_F24
→ XK_F1..XK_F24 range to `_VK_KEYSYM` / `_vk_keysym()`.

**Proven.** GIMP File > Open > `tap(0xBF)` activates location bar > `uia_set_value`
sets path > Enter > image opened.  Full chain: 8/8 regression (4 menu chains +
clipboard + GIMP file open + LO context menu + Nautilus sidebar).

**Boundary (documented, not fixed).**
- GTK file chooser data items have no accessible names → cannot select files
  by meaning; must use location bar path entry.
- `goto_cell` on LO Calc: Name Box not exposed via AT-SPI; pixel-click workaround
  exists but not semantic.

---

### F224 — Left/right modifier VK codes unmapped; chord(0xA2, 0x41) sends `¢a` not Ctrl+A

| date | 2026-06-29 |
|---|---|
| surface | `chord(0xA2, 0x41)` types "¢a" in LO VCL dialog instead of selecting all |
| root cause | `VK_LCONTROL` (0xA2), `VK_RCONTROL` (0xA3), `VK_LSHIFT` (0xA0), `VK_RSHIFT` (0xA1), `VK_LMENU` (0xA4), `VK_RMENU` (0xA5), `VK_LWIN` (0x5B), `VK_RWIN` (0x5C) all fell through to raw `return vk` giving wrong X keysyms |

**Friction.**  Windows agents commonly use `VK_LCONTROL` (0xA2) in `chord()` calls
rather than the generic `VK_CONTROL` (0x11).  On the X11 backend, `_vk_keysym(0xA2)`
returned 0xA2 = keysym for `¢` (cent sign), so `chord(0xA2, 0x41)` pressed `¢` then
`a` instead of `Ctrl+A`.  Every `chord` with left/right-specific modifiers was broken.

**Fix.**  Added 8 left/right-specific modifier mappings to `_VK_KEYSYM`:
VK_L/RSHIFT → Shift_L/R, VK_L/RCONTROL → Control_L/R, VK_L/RMENU → Alt_L/R,
VK_L/RWIN → Super_L/R.

**Also.**  Added `uia_file_dialog_set_path(dialog_wid, path)` in `osctl.py` — a
unified helper that auto-detects KDE (edit field "File name:") vs GTK (press `/` to
activate location bar) file dialogs.

**Proven.**  gedit Ctrl+A/C with `chord(0xA2, ...)` now works (clipboard verified).
5/6 regression: VLC menu + KWrite menu + Inkscape menu + gedit chord + clipboard.
KDE Save As (KWrite) → file created ✓.  GIMP Open (GTK) → image loaded ✓.

**Boundary (documented, not fixed).**
- LO Calc VCL internal file dialog: `uia_find_all` returns 297 elements but all are
  Menu/MenuItem/Separator — no Edit or Button with name/rect.  The VCL Name field is
  visible but not AT-SPI-accessible; pixel-click + paste_text workaround partially
  works but the dialog's error handling is fragile.
- LO should be switched to use native GTK file dialogs (env `SAL_USE_VCLPLUGIN=gtk3`)
  for proper AT-SPI integration — a deployment-level fix, not a code fix.

---

### F226 — `get_clipboard()` reads only local cache, blind to text copied by other X apps

| date | 2026-06-29 |
|---|---|
| surface | `chord(0x11, 0x41); chord(0x11, 0x43); get_clipboard()` returns empty — text IS in X CLIPBOARD |
| root cause | `get_clipboard()` returned `_clip_text` (only what `set_clipboard()` stored); never queried the real X CLIPBOARD selection from other owners |

**Friction.** After the user types text in KWrite, `chord(Ctrl+A)` / `chord(Ctrl+C)` copies text to the X clipboard — verified by `xclip -o -selection clipboard`. But `get_clipboard()` returned the empty `_clip_text`, because it never asked the X server who currently owns CLIPBOARD and what they're serving.

**Root cause.** X11 has no global clipboard buffer. Each application *owns* the CLIPBOARD selection and hands data to each requester via `SelectionRequest` events. `get_clipboard()` was reading a Python variable, not the X selection.

**Fix.** `get_clipboard()` now shells out to `xclip -o -selection clipboard` (already installed as a dependency) with a 2-second timeout. If the owner responds, the real clipboard text is returned. Falls back to `_clip_text` only if xclip fails.

```python
def get_clipboard() -> str:
    try:
        r = subprocess.run(
            ["xclip", "-o", "-selection", "clipboard"],
            capture_output=True, timeout=2,
        )
        if r.returncode == 0:
            return r.stdout.decode("utf-8", errors="replace")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return _clip_text
```

**Proof.** 4/4:
- Read clipboard after KWrite `Ctrl+A`/`Ctrl+C` → `"CHORD_TEST_DATAHello chord test"` ✓
- `set_clipboard("test_道法自然"); get_clipboard()` → `"test_道法自然"` ✓
- gedit `Ctrl+A`/`Ctrl+C` → full text readable ✓
- Round-trip: set_clipboard → Ctrl+V in app → Ctrl+A/C → get_clipboard ✓

---

### F227 — GTK3/Xfce file dialogs: `uia_file_dialog_set_path` fails — location bar needs Ctrl+L, not `/`

| date | 2026-06-29 |
|---|---|
| surface | Mousepad/gedit/Inkscape Save As: `uia_file_dialog_set_path` fails to set filename |
| root cause | GTK3 GNOME / Xfce file dialogs activate location bar via Ctrl+L; the `/` key only works in older GTK2 dialogs |

**Friction.** F223 added the `/` key to activate GTK file dialog location bars. But GNOME GTK3 (gedit) and Xfce (Mousepad) file dialogs don't respond to `/` — they need `Ctrl+L` to switch to the path-entry mode.  Additionally, Inkscape's GTK file dialog reports 299 AT-SPI elements but ALL have `rect=None`, making semantic clicking impossible.

**Fix.** `uia_file_dialog_set_path` now has three tiers:
1. KDE: `uia_set_value(name="File name:", ctype="edit")`
2. Ctrl+L (GNOME GTK3 / Xfce / Inkscape): `chord(0x11, 0x4C)` → `uia_set_value(ctype="edit")`
3. `/` key (GTK2): `tap(0xBF)` → `uia_set_value(ctype="edit")`
4. Last resort: `Ctrl+A` + `paste_text`

**Proof.** Full save chains tested on 5 apps:
- KWrite Save As (KDE): file created ✓ (tier 1)
- gedit Save As (GTK3): file created via Ctrl+Shift+S → Ctrl+L → type path → Enter ✓
- Mousepad Save As (Xfce): file created via Ctrl+Shift+S → Ctrl+L → type path → Enter ✓
- Inkscape Save As (GTK): file created via Ctrl+Shift+S → Ctrl+L → type path → Enter ✓
- GIMP Export As (GTK): PNG exported via Ctrl+Shift+E → dialog → Export ✓

**Boundary.**
- Inkscape's GTK file dialog AT-SPI elements all have `rect=None` — semantic clicking is impossible; must use keyboard (Ctrl+L + type path) or coordinate-based fallback.
- LO Calc still has 0 AT-SPI elements — VCL toolkit boundary remains.

---

## F228 — `uia_file_dialog_set_path` types into document area on Xfce/GTK dialogs

**Friction.**  Mousepad (Xfce) and gedit (GTK3) Save As dialogs expose the
**parent window's** AT-SPI tree, not the dialog's own elements.  After Ctrl+L
opens the location bar, `uia_set_value(dialog, path, ctype='edit')` finds the
document text area (height > 300px) and types the file path into the document
content instead of the filename field.  For gedit, `paste_text` (Ctrl+V)
landed in the Name field rather than the focused location bar.

**Root cause.**  Xfce GTK file dialogs don't register their own elements in
AT-SPI; the tree-walk returns the parent window's tree.  The only Edit element
with a rect is the main document editor (h=449 for Mousepad, h=673 for gedit),
not the location-bar entry.

**Fix** (`osctl.py`).  Added `_has_small_edit()` height check (h < 200 = real
filename entry vs h > 300 = document area).  When no small edit exists after
Ctrl+L, use `type_unicode(path)` (key events to focused widget) instead of
`uia_set_value` or `paste_text`:

```python
def _has_small_edit(wid):
    els = uia_find_all(wid, max_scan=400)
    return any(e.get("type") == "Edit" and e.get("rect")
               and e["rect"][3] < 200 for e in els)

# After Ctrl+L:
if _has_small_edit(dialog_wid):
    uia_set_value(dialog_wid, path, ctype="edit")
else:
    chord(0x11, 0x41)    # Ctrl+A to clear
    type_unicode(path)    # key events to focused location bar
```

**Proof.**  5/5 dialogs pass after fix:
- KWrite (KDE `File name:` entry): ✓ `/tmp/f228v2_kwrite.txt` (90 bytes)
- gedit (GTK3 location bar): ✓ `/tmp/f228v2_gedit.txt` (90 bytes)
- Mousepad (Xfce location bar): ✓ `/tmp/f228v2_mousepad.txt` (58 bytes)
- GIMP Export As: ✓ `/tmp/f228v2_gimp.png` (9050 bytes)
- Inkscape Save As: ✓ `/tmp/f228v2_inkscape.svg` (1400 bytes)

---

## F229 — `_find_menuitem` fails on GIMP 3-level menus (type=Menu + scan depth)

**Friction.**  `uia_menu(gi, 'Filters', 'Blur', 'Gaussian Blur...')` returns
False.  GIMP's 3-level filter menus (Filters → Blur → Gaussian Blur...) are
unreachable.

**Root cause (dual).**

1. GIMP submenus ("Blur" under Filters) are AT-SPI type `Menu`, not
   `MenuItem`.  `_find_menuitem` only searched `ctype="menuitem"`, so the
   "Blur" submenu entry (with `rect=(570,250,293,25)`) was invisible.
2. GIMP has 469+ AT-SPI elements.  The old `max_scan=600` reached "Blur /
   Sharpen" (MenuItem, rect=None) but not the deeper "Blur" (Menu, with rect).
   At `max_scan=800` the correct element first appears.

**Fix** (`osctl.py`).  In `_find_menuitem`:
- Search both `ctype="menuitem"` AND `ctype="menu"` (two `uia_find_all` calls)
- Increase `max_scan` from 600 → 1000
- Add `best_sub_norect` fallback for compound names (e.g. "Blur / Sharpen")
  that have no rect

**Proof.**  4/4 pass:
- Filters > Blur > Gaussian Blur... (3-level): ✓ dialog opens
- Filters > Distorts > Lens Distortion... (3-level): ✓ dialog opens
- Edit > Preferences (2-level regression): ✓
- KWrite File > New (cross-app regression): ✓

---

## F230 — GTK3 autocomplete corrupts filenames in Save As dialogs

**Friction.**  Inkscape Save As with path `/tmp/regr_inkscape_edge.svg` produces
file `/tmp/rer__inkscape_edge.svg` — the `g` is eaten, the `_` doubled.
Mousepad also fails with longer filenames.

**Root cause.**  GTK3's file-chooser location bar has aggressive inline
autocomplete.  `type_unicode` types at ~32 ms/char; each keystroke triggers
autocomplete which overwrites the next character, corrupting the filename.

**Fix** (`osctl.py`).  Split the path in `uia_file_dialog_set_path`'s F228
fallback branch:
1. Ctrl+L → type **directory** + `/` → Enter (navigates; short directory names
   are autocomplete-safe)
2. After navigation, the Name field regains focus
3. Ctrl+A → type **just the basename** (no directory = no autocomplete on
   path separators)

**Proof.**  5/5 pass:
- KWrite (KDE): ✓ `/tmp/f230_kwrite_final.txt` (28 bytes)
- gedit (GTK3): ✓ `/tmp/f230_gedit_final.txt` (6 bytes)
- Mousepad (Xfce): ✓ `/tmp/f230_mousepad_final.txt` (18 bytes)
- Inkscape (GTK3): ✓ `/tmp/f230_inkscape_final.svg` (1826 bytes)
- GIMP Export As: ✓ `/tmp/f230_gimp_final.png` (5703 bytes)

---

## F231 — self-drawn surfaces have geometry but no value; the atlas cold-start

**Friction.**  gnome-mines exposes 64 anonymous AT-SPI `Button`s — exact cell
geometry (`rect`) but **no name, no value, no state**.  Whether a cell is
unrevealed, empty, a 1–8, or flagged is *pixels only*.  This is every
self-drawing surface: OpenGL/SDL games, `<canvas>`, custom toolkits — the
semantic channel goes blind exactly where the board lives.

**What the floor already had (不為而成).**  The pixel channel was *not* blind:
the F058/F103–F108 ladder — `edge_signature` → `read_glyph`/`read_glyph_conf`
→ `segment_run`/`split_run` → `read_text`/`read_words`/`read_block` — already
reads canvas text **dependency-free**, by matching each glyph's scale-free edge
signature against a reference *atlas*.  Verified live: a 3-entry atlas built from
three labelled cells reads the rest of the gnome-mines board exactly
(`read_glyph` → 3,2,1,2 ✓).  So for the *warm* path the floor was already
capable, and that path stays the runtime reader (no third-party dep, scale-free,
honest about unknowns — 大器免成).

**The real gap — cold start.**  `read_glyph` needs an atlas, and the atlas is
built from *labelled* reference glyphs.  An agent dropped into a game it has
never seen cannot label a glyph without first reading it — a chicken-and-egg the
atlas readers cannot break on their own.  That, precisely, is the uncovered
friction: **bootstrapping the first labels for an unknown font.**

**Fix** (`osctl.py`).  New *optional* engine-backed reader `ocr_text(region,
whitelist, psm, scale, invert, rgb, size)` — the cold-start complement to the
atlas ladder:
- grabs `region` (or whole screen), greyscales, optional invert (light-on-dark),
  nearest-neighbour upscale (small glyphs OCR poorly at native size), pipes a
  hand-rolled PNG to `tesseract` and returns the recognised text, stripped.
- `whitelist` constrains the alphabet (biggest accuracy win on short
  fixed-charset readouts); `psm` picks segmentation (7=line, 10=char, 6=block);
  `rgb`/`size` reuse one capture across many regions.
- tesseract is resolved once via `_ocr_engine` and is **optional**: the floor
  imports and runs without it, and the dependency-free atlas ladder remains the
  default reader.  `ocr_text` reads glyphs with *zero* prior atlas — so it can
  label reference cells, from which a fast `read_glyph` atlas is built for the
  rest of the session.  Engine for the cold start, structure for the warm path.

**The hybrid (道生二).**  AT-SPI gives *where* (cell rects), the pixel reader
gives *what* (the digit) — neither alone drives the board, together they do.
Driver `_game_mines.py` reads the full 8×8 state, then a constraint solver
(single-cell rule + subset elimination + global mine-count endgame + lowest-risk
guess) plays via XTEST left/right clicks.

**Proof.**
- `ocr_text` reads the self-drawn "4/10" flag counter (no AT-SPI value) and
  individual cell digits (verified against screenshot: 2,3,2 ✓).
- dependency-free `read_glyph` reads the same digits from a 3-glyph atlas
  (3,2,1,2 ✓) — the warm path the floor already owned.
- Full-board read in 3.5 s: digits **and** flags ('F', detected by corner colour
  staying on the unrevealed tile) all match the rendered board.
- Solver flagged 5/10 mines correctly and opened safe cells purely from pixel
  perception; refused to guess when no deterministic move existed (knows what it
  doesn't know).

## F232 — a zero-hold key tap is invisible to a frame-polled game

**Friction.**  With SuperTux v0.6.3 (SDL2/OpenGL, **0 AT-SPI elements**) up and
correctly holding X input focus (`xdotool getwindowfocus` → "SuperTux v0.6.3"),
`osctl.tap(VK_RETURN)` on the main menu did **nothing** — "Start Game" never
activated.  Four taps of `VK_DOWN` (and the same via `xdotool key Down`, also
XTEST) moved the highlight **zero** rows.  The floor's keyboard path was not
broken — the identical primitives type into KWrite/gedit and walk Qt/GTK menus
every regression run — yet the game ignored them completely.

**Root cause — event-latched widgets vs. state-polled surfaces.**  `tap` is
`key_down`+`key_up` *in the same breath*: the key is down for ~0 ms.  A toolkit
widget latches on the X `KeyPress` **event** itself, so a zero-duration press is
always seen.  A self-drawing game does not act on the event — it samples key
*state* once per frame and acts on the rising edge it sees **at a tick**.  A
press whose down and up both land between two ticks is never sampled → silently
dropped.  Measured on SuperTux (held `key_down`→sleep→`key_up`, one screenshot
per step):

| hold (ms) | menu highlight moved |
|----------:|----------------------|
| 0 (`tap`) | no (×4, incl. xdotool) |
| 25        | no |
| 100       | **yes — exactly one row** |
| 120       | yes — one row |
| 400       | yes — **still one** (repeat debounce caps it) |

So the press must span ≥ ~1 input tick to be observed, and one observed press is
one discrete action (the menu's own repeat-delay debounce prevents a long hold
from running away).  This is *every* SDL/OpenGL game, emulator and custom canvas
— the exact surfaces where AT-SPI is already blind (F231), so input and
perception go dark **together**.

**Fix** (`osctl.py`).  `tap(vk, hold=0.0)` gains an optional `hold` (seconds).
Default `0.0` is byte-for-byte the old behaviour (zero regression — toolkit apps
keep their instant tap), but on a polled surface you pass `tap(vk, hold=0.12)` so
the press crosses a tick and is observed.  The knob lives exactly where the trap
is, and the docstring states the rule: event-driven widget → `hold=0`; game/
emulator discrete press → `hold≈0.1`; sustained movement (walk, charge) →
`key_hold` (F127), whose longer default integrates *time-in-state*.  No new
top-level name — the floor already owned `key_hold` for the sustained case; this
just makes the *discrete* case expressible on the primitive callers already use.

**Proof.**  With the fix, held presses drove SuperTux end-to-end through the
zero-AT-SPI UI purely via the floor: main menu → "Start Game" → "Story Mode" →
worldmap, and on the worldmap a held `VK_DOWN` walked Tux one node along the path
(confirmed by capturing the penguin sprite's new position — the real-time
perceive→act loop on an OpenGL surface).  `tap(hold=0)` reproduces the original
dead input on the same menu; `tap(hold=0.12)` activates it every time.

## F233 — appearance localisation was correct but too slow to track a sprite

**Friction.**  On the same SuperTux worldmap (0 AT-SPI), once Tux *moves* the
floor must answer "where is he now?".  Colour keying fails — his anti-aliased
sprite has no single dominant hue against snow/water, and the warm pixels are
swamped by red level nodes and the brown path (`find_color_blobs((25,25,28))`
returned only a strip of UI text).  Frame differencing fails too — pressing a
direction makes the **camera follow**, so the whole background scrolls and
`locate_change` lights up the entire viewport (269 001 px changed on one step),
localising the scrolling world rather than the screen-centred avatar.  The right
channel is the one the floor already owns for *appearance* — `match_template`
(F053) — and it did find Tux exactly (score 0 at his true position).  But it was
**unusably slow**: a full-frame search took ~3 min, and even a tightly scoped
240×240 window around his last-known position took **33.3 s**.  A localiser that
takes half a minute cannot track a thing that moves.

**Root cause — source luma recomputed once per overlap.**  SAD template matching
slides the patch over every offset and sums |Δluma|.  The first cut converted
each *source* pixel to luma **inside the innermost loop**, so a pixel covered by
N overlapping windows had its luma (3 multiplies + a divide) recomputed N times —
the cost was `area × patch_area` luma conversions, almost all redundant.

| search          | before | after | result |
|-----------------|-------:|------:|--------|
| scoped 240×240  | 33.3 s | **5.1 s** | identical (score 0 @ same px) |
| full frame      | ~180 s | **41 s**  | identical |
| full, `step=2`  |  ~50 s | **19 s**  | identical |

**Fix** (`osctl.py`, `match_template`).  Two surgical changes, no signature or
result change (the returned arg-min is bit-identical — verified above):
1. **Precompute the search-area luma once** (`aw*ah` conversions) into a flat
   buffer; the inner loop becomes a bare integer subtract + abs.
2. **Early-abandon** (branch-and-bound): SAD only accumulates, so the instant a
   partial score reaches the best full score so far, that offset can never win —
   stop scoring it.  Once a good match is in hand almost every other offset
   aborts after a row or two.  Exact, because only provably-worse offsets are
   skipped.

The win is "少則得": no new primitive, no approximation — the same appearance
channel, with its wasted work removed at the root, is now fast enough to relocate
a moving sprite between frames (and faster still with a smaller patch or a coarse
`step` pre-pass, both already expressible).

**Proof.**  Tux cropped to a 47×58 template; after the fix `match_template`
relocates him at score 0 in 5.1 s scoped / 41 s full-frame — the same pixel the
33 s version found, 6.5× faster — so the floor's vision channel localises a
self-drawn avatar that neither colour nor frame-diff could pin down.  Full
`test_live.py --offline` regression after the change: 703/719, no new failures
(the 16 are the standing no-window-manager focus tests and glyph-atlas misreads).

---

## F234 — appearance matching is swamped by the *background* baked into a crop

**Friction.**  With F233 making `match_template` fast, the next practice step was
to actually *track* Tux as he walks the SuperTux worldmap.  A tight crop of him
on the snow scored 0 at rest — perfect — but the instant he stepped to the
adjacent node the same template's best score jumped to **34 483** and the
arg-min wandered off him (and, with several snowball/penguin look-alikes and a
dark brown path on the map, sometimes locked onto the wrong thing entirely).
The localiser that was exact one frame ago became unreliable the next.

**Root cause — the crop is mostly *not the sprite*.**  A 40×48 bounding box of a
penguin is ~1 400 background pixels (snow) and only ~500 sprite pixels.  SAD
weights every pixel equally, so the score is dominated by whether the *snow*
under the template still matches — which it does at the original node and does
*not* one node over (different snow/path/water mix).  The matcher was, in
effect, tracking the scenery inside Tux's bounding box, not Tux.  This is the
mirror of F233: F233 made the channel *fast*, F234 is about making it *see the
right thing*.

**Fix** (`osctl.py`, `match_template`).  One optional argument, no change to the
default path:

```python
match_template(patch, pw, ph, ..., mask=None)   # mask: pw*ph bytes, !=0 = foreground
```

A non-zero mask byte marks a sprite pixel to score; a zero byte is skipped.
Implemented by precomputing, per row, the tuple of foreground columns — when
`mask is None` that tuple is the full row, so the slide stays **bit-identical**
to the F233 path (verified: rest score still 0, the `template matched every
candidate` regression still passes).  With a silhouette mask only the sprite's
own pixels enter the SAD, so a changing background no longer swamps it.  This is
the human channel — track the *shape*, ignore the scenery (少則得: score less,
match better).

**Proof (deterministic, isolates background from animation noise).**  A
synthetic search image: the real Tux foreground pasted on a brown path field at
x≈60, and a plain snow block (matching the template's own snow background) at
x≈270.

| matcher | picks | score | verdict |
|---------|-------|------:|---------|
| unmasked | x≈284 (the snow decoy) | 41 588 | **wrong** — background dominates |
| masked   | x≈60 (the real Tux)    | **0**  | **right** — silhouette only |

**Honest limit (not over-claimed).**  Masking removes *background domination*,
not every ambiguity: on the live worldmap Tux also *idle-animates* (the static
template drifts as he bobs/blinks) and a coarse dark-luma silhouette still has
some affinity for dark path/tree clutter.  Robust closed-loop tracking of an
animated sprite among look-alikes is a further problem (a multi-frame template
or a tighter alpha mask would help) and is deliberately left open rather than
forced.  What F234 fixes at the root is the *background-in-the-crop* error,
proven above; the primitive now scores what you tell it is the sprite.

Regression after the change: `test_live.py --offline` 699/719 — no new failures
(the ~20 are the standing no-window-manager focus/clipboard/Z-order tests and
OCR glyph-atlas misreads, e.g. `RED`→`LED`; count fluctuates run-to-run as those
are nondeterministic; the `template matched every candidate` check passes).

---

## F235 — `ocr_text` silently drops round digits at the single-glyph page modes

**Practice that exposed it.**  Driving **gnome-sudoku** end-to-end (read the 9×9
board → solve → type the answers back).  AT-SPI exposes the toolbar but *not* the
81 cells or their digits, so the board is read purely by vision — the exact
cold-start the F231 `ocr_text` reader exists for.  First pass on an Easy puzzle
read **66/81** cells: every blank was right, but the *givens* `4 6 8 9` came back
empty or wrong while `1 2 3 7` read fine.  A reader that drops a third of the
non-blanks cannot close a constraint loop.

**Two false trails, then the root.**  My first driver hard-binarised each cell to
1-bit before OCR and called tesseract with `--psm 10` ("one character" — the
obvious mode for a lone digit).  Both were wrong:

* **Binarising throws away tesseract's signal.**  `ocr_text` already greyscales;
  feeding a hard 0/255 threshold on top destroys the anti-aliased edges the
  recogniser keys on.  The round glyphs, whose identity lives in their curves,
  were the first to go.
* **`psm=10`/`psm=7` segmentation silently discards a tight isolated glyph.**
  Measured on the ten hardest live cells (greyscale, correct geometry):

  | psm | reads of `6 9 5 5 6 8 8 4 4 9` | drops |
  |-----|------------------------------|------:|
  | 10 (one char)  | `6 _ 5 5 6 8 8 _ _ _` | 4 |
  | 7 (one line, **default**) | `6 _ 5 5 6 8 8 _ _ _` | 3 |
  | **6 (block)**  | `6 9 5 5 6 8 8 4 4 9` | **0** |

  Block mode (6) reads every digit; the "single character" modes treat a tight,
  isolated round glyph as stray ink and emit *nothing*.  With greyscale + `psm=6`
  the same board read **81/81** through the unchanged primitive — there was no
  bug in the floor's recognition, only in how the mode was chosen.

**Fix** (`osctl.py`, `ocr_text`).  Keep `psm` as the caller's choice, but when a
**whitelisted** read returns empty *and the crop actually holds ink*, retry once
in `fallback_psm` (block, 6) before giving up:

```python
res = _run(psm)
if not res and whitelist and fallback_psm and fallback_psm != psm:
    bg = max(g); ink = sum(1 for v in g if v < bg - 40)   # g = greyscale crop
    if ink >= max(8, (rw*rh)*3//200):                     # something is there
        res = _run(fallback_psm)
```

It only fires on an *empty* result, so it never overrides a hit; it is gated on
*ink present*, so a genuinely blank region still returns `''` and a
`' '`-means-empty caller (the F231 minesweeper driver) is untouched.  The
docstring's old hint ("10 = one character") is corrected — it steered toward the
mode that drops digits — and the greyscale-not-binarised rule is written down.

**Proof (deterministic, on an unseen Medium puzzle).**  Read every given cell at
the *default* `psm=7`, fallback off vs on:

| reader | givens read | recovered |
|--------|------------:|-----------|
| psm=7, no fallback | 24 | — |
| psm=7, ink-gated psm=6 fallback | **30** | `(0,3)=4 (1,4)=9 (3,1)=4 (4,2)=9 (5,7)=4 (6,1)=9` |

Every recovered cell is a `4` or a `9` — exactly the round glyphs the line mode
dropped — and the recovered board is solvable.  Full closed loop recorded:
`detect_board` recovers grid geometry from the heavy 3×3 box-border lines (no
hard-coded pixels), `ocr_text` reads the givens, backtracking solves, and
`click`+`type_unicode` fill all 54 empties → gnome-sudoku shows *"Well done, you
completed the puzzle"*.  Driver: `_game_sudoku.py`.

**Honest limit.**  The fallback rescues glyphs a single page-mode drops; it is
not a font-independent OCR.  Very low-contrast or overlapping glyphs can still
defeat both modes, in which case the warm path (label a few cells, build a
`read_glyph` atlas, F058) is the deterministic answer.  What F235 fixes at the
root is the *silent single-glyph drop* — a whitelisted cell that holds ink now
gets a second, reliable reading instead of an empty string.

Regression after the change: `test_live.py --offline` 701/719 — no new failures
(the standing ~18 are the no-window-manager focus/Z-order tests, the
`read_region` atlas misreads `RED`→`LED` which use the edge-signature ladder not
`ocr_text`, and the `locate_change` timing flake; count fluctuates run-to-run).

---

> 為學者日益，聞道者日損。 We add primitives only by subtracting frictions.

## F237 — `gnome-mines` board OCR used a fixed crop that went negative on 48×48 cells

**Symptom.**  On a fresh `gnome-mines` board, `_game_mines.py read` crashed before it
could print the grid:

```text
ValueError: negative count
```

The driver was calling `ocr_text((cx + 25, cy + 20, cw - 50, ch - 40), ...)`.
On this VM the GTK mine cells are `48×48`, so `cw - 50` and `ch - 40` underflow
the crop.  The issue appeared only after tesseract was installed; before that the
reader stopped earlier with the missing-binary error.

**Fix** (`_game_mines.py`).  Use a crop that scales with the actual cell size:

```python
pad_x = max(4, cw // 6)
pad_y = max(4, ch // 6)
digit = osctl.ocr_text((cx + pad_x, cy + pad_y,
                        max(1, cw - 2 * pad_x), max(1, ch - 2 * pad_y)),
                       whitelist='12345678', psm=10, scale=2,
                       rgb=rgb, size=(W, _CUR_H))
```

That keeps the OCR window safely inside the tile for both `48×48` and larger
board geometries, and the same `read` command now prints the 8×8 grid instead of
crashing.

**Proof.**  Before the patch:

```text
ValueError: negative count
```

After the patch:

```text
. . . . . . . .
. . .   . . . .
. . . . . . . .
. . . . . . . .
. . . . . . . .
. . . . . . . .
. . . . . . . .
. . . . . . . .
read in 0.15s
```

> 复杂 GUI 实操继续向前：先让可测、可读、可解，再谈更深的自动化。

## F238 — `ocr_text` re-spawned tesseract for every identical Mines crop

**Symptom.**  After F237, `gnome-mines` became readable again, but a full board
read still took about 3 seconds because `read_board()` re-OCR'd every revealed
cell on every pass.  On this VM a single `ocr_text()` call costs roughly
`0.058s`; a board with 59 revealed cells therefore spent most of its time
spawning identical tesseract jobs for pixels that never changed.

**Fix** (`osctl.py`).  Add a content-addressed OCR cache keyed on the exact
upsampled OCR crop plus the OCR parameters.  Identical pixels and flags now
return the cached string instead of spawning tesseract again.

**Proof.**

Before the cache:

```text
read_board 3.13s, revealed(non-dot) cells=59, grid=8x8
```

After the cache:

```text
0 read_board 0.815 revealed 59
1 read_board 0.142 revealed 59
```

The first call still pays the cold-start OCR cost, but the second pass reuses
the exact same crops and returns from cache, which is the steady-state path the
solver wants when the board geometry is unchanged.

## F239 — `_game_sudoku.py` assumed the puzzle board was already open

**Symptom.**  `python3 _game_sudoku.py` failed on a freshly launched
`gnome-sudoku` session because the app starts on a “Select Difficulty” dialog,
not on the board itself.  The script jumped straight into `detect_board()`, so
the first read saw no grid and crashed:

```text
RuntimeError: board borders not found: vx=[498, 1103] hy=[834]
```

When the dialog was present, AT-SPI exposed the `Easy` / `Medium` / `Hard`
choices, and clicking `Easy` started a normal puzzle.

**Fix** (`_game_sudoku.py`).  Detect the start dialog and click `Easy` before
constructing `Board`:

```python
def _ensure_started():
    for w in osctl.list_windows():
        if (w.get('title') or '') != 'Select Difficulty':
            continue
        for e in osctl.uia_find_all(w['id'], max_scan=2000):
            if e.get('name') == 'Easy':
                x, y, w0, h0 = e['rect']
                osctl.click(x + w0 // 2, y + h0 // 2)
                time.sleep(1.5)
                return
```

`play()` now calls `_ensure_started()` first, so the same command works from a
fresh launch without a manual click.

**Proof.**

Before the patch:

```text
RuntimeError: board borders not found: vx=[498, 1103] hy=[834]
```

After the patch:

```text
READ:
3.274...5
...5.28..
.6..1...3
.2.....96
9.6...3.8
84.....2.
5...2..8.
..19.8...
2...671.9
SOLUTION:
382746915
719532864
465819273
127384596
956271348
843695721
594123687
671958432
238467159
filled 49 cells
```

## F240 — colour segmentation needed an ROI window to stay cheap and local

While pushing Mahjongg deeper, I used the intended `colour -> template` flow to
find tile faces. `match_template()` already takes `search=...`, but
`find_color()` / `find_color_blobs()` scanned the whole desktop and could pull
in same-coloured blobs from other windows. I added the same ROI window to both
primitives and clamped the scan to that region. On the same Mahjongg frame,
the white-blob query dropped from 275 full-screen blobs to 93 ROI blobs.

---

> 道生一，一生二。 The single best match is `match_template`; all of them is its
> natural complement — one primitive begets the many.

## F241 — repeated-element GUIs need *all* matches, not the one best

Pushing Mahjongg to a real closed loop (perceive → pair → click → verify, until
the board clears) exposed a **structural** gap, not a per-game quirk. The whole
class of repeated-element GUIs — a Mahjongg layout with many copies of each tile
face, a card game repeating ranks, a match-3 / inventory grid tiling one icon
dozens of times — asks "where is *every* copy of this appearance?". The floor
could only answer "where is the *one* closest copy" (`match_template`, whose
arg-min early-abandon is built to crown a single winner). The only way to get
the rest was to blank each hit and rescan: O(hits) full slides plus a
caller-managed mask. That is the friction: the foundational verb was missing.

**Fix** (`osctl.py`, new `match_template_all`).  Same SAD-on-luma scorer as
`match_template` (honours `mask`/`step`/`search`), but it keeps every offset at
or below a ceiling, then runs non-maximum suppression (`min_sep`, default the
patch size) so each real instance yields one hit, not a cluster. Returns
`[{x, y, score, bbox}, ...]` sorted by ascending score. When `max_score` is
omitted the ceiling is **relative** — `best + 0.04*255*scored_px` — so a board
with no second copy still gets a sane bound and genuine anti-aliased/shadowed
copies survive while different faces are rejected.

**少則得 — and it must stay cheap.**  The first cut scored every pixel of every
offset (no early-abandon, since "keep all below ceiling" has no running best to
prune against) — a full-board `step=1` scan cost ~14 s, and a whole solver round
ran ~16 min. The fix is to abandon any offset whose partial SAD exceeds
`best_so_far + margin`: the bound only ever *tightens* as a better best is found,
so a true hit (`s ≤ best_final + margin ≤ best_seen + margin`) is never wrongly
abandoned, while doomed offsets bail after a row or two. Stale candidates kept
while `best` was still high are dropped by the final ceiling. Verified
**byte-identical** results to a brute-force fixed ceiling across several live
seeds (a lone face → 1 hit, a true pair → 2, a low-detail face → 16), at ~11 s
instead of ~14 s — the same arg-min discipline that makes `match_template` fast.

**Closed-loop discipline this surfaced (caller-side, not floor bugs).**  Driving
the loop end to end forced three corrections that are worth writing down because
they are the difference between "looks like it worked" and "verifiably worked":

1. **Free-ness is *change*, not colour.**  A tile is removable only if clicking
   it raises the selection highlight. The highlight is blue — but bamboo/dot
   tile *faces* are blue too, so an absolute-hue oracle marks blocked blue tiles
   as free. The honest oracle clicks and reads the **before/after diff** in the
   tile's bbox; content can never fake a change that isn't there.
2. **Alignment must come from the slide, not the guess.**  Classifying free
   tiles by directly comparing crops at *guessed* centres fails — a few px of
   drift between two identical faces is enough SAD to miss. `match_template_all`
   self-aligns (it slides), so seeding it with a rough centre still finds the
   exact copies.
3. **Verify on the invariant, not the chatty signal.**  `Moves Left` shares its
   title with a running clock, so a string compare always looks changed; the
   count itself is *available moves*, not tiles. A true removal is confirmed by
   **both faces vanishing** (both bboxes change vs the resting board) — a
   non-matching click only bounces the selection to the second tile.

**Proof (live gnome-mahjongg).**  `match_template_all` found the 中 pair at
score 0 and a dots triple at score 0; the closed loop then removed real pairs
with the diff-oracle + both-vanish check (e.g. a 發 pair, Moves Left 19→17,
revealing the 三萬 beneath; and a second pair at a later board). Reusable driver
committed as `_game_mahjongg.py` (`auto_clear` runs the full loop). Honest limit:
full-board `step=1` classification is still ~11 s/seed; the intended cheap path
is the F240 idiom — `find_color_blobs(search=ROI)` to a small band, then match
within it — which this primitive composes with directly.

---

> 知止所以不殆。 The change is everywhere the frame answered; knowing *where to
> stop looking* is what makes the one move you care about legible.

## F242 — the change channel needed the same ROI window colour got in F240

Pushing into a turn-based, modal GUI (gnome-chess) to read moves **purely from
pixels**: act, then ask `locate_change_blobs(before, after)` *where* the board
answered — the from-square empties, the to-square fills, two blobs, done. But a
live app answers an action in more places than the board. Playing Black's `exd4`
and diffing the whole frame returned **seven** changed regions: the real `e5`
and `d4`, tangled with the status line ("White to Move"), the move-history list,
and the window title — the extra four mis-bin as phantom rank-1/rank-8 squares.
`locate_change` folds them all into one centroid that lands in dead space;
`locate_change_blobs` emits spurious clickable targets. The reader could not
tell the move from the chrome.

The fix already existed one channel over. F240 gave `find_color`/`find_color_blobs`
a `search=(minx,miny,maxx,maxy)` ROI so colour segmentation stays cheap and
local; the **change** primitives never got it, so callers had to diff the whole
screen and post-filter by geometry — exactly the error-prone step that mis-binned
status text as board squares. This is the same friction (F052→F240) met a third
time, now on change itself.

**Fix** (`osctl.py`). Added the identical `search=` ROI to `locate_change` and
`locate_change_blobs`: same `(minx,miny,maxx,maxy)` screen window, same clamp
(`max(0,·)` / `min(w-1,·)`, `min(h-1,·)`), scan loops bounded to it. For the
blob variant the union-find now runs over **only the ROI's** changed pixels — the
4-connectivity neighbour checks (`(key-1) in parent`, `(up_base+x) in parent`)
already gate on membership, so pixels outside the ROI are simply never enrolled
and the component labelling stays correct at the ROI edge with no extra code.

**Proof (live gnome-chess + synthetic).**  Same `exd4`, same two captures:
whole-frame `locate_change_blobs` → `['c1','d1','d4','e1','e5','e8','f8']` in
0.42 s; `search=BOARD` → exactly `['d4','e5']` (the move, read from pixels alone)
in **0.04 s** — ~10× faster, because the union-find no longer walks the whole
screen's change. A synthetic two-region case (one inside the ROI, one outside)
confirms the default whole-frame path is byte-for-byte unchanged (both regions,
count 50 / 2 blobs) while `search=` returns only the inside region (count 25 /
1 blob @ the right centroid). `narrow the field first` now holds on all three
channels — colour, template, and change.

---

> 名與身孰親。 A window's *name* is the cheapest way to know it, but when the
> name is empty and the coordinates lie, only its *size* still tells the truth.

## F243 — a modal dialog was unreachable because its accessible extents lied

Stress-testing a turn-based, **modal** GUI (gnome-chess): play a move, then hit
Ctrl+N — gnome-chess raises a *"Save this game before starting a new one?"*
dialog with `Cancel / Abandon game / Save game for later`. A closed-loop agent
must read that dialog and press a button to proceed. `list_windows` showed the
dialog as a new top-level (id `…043`, empty title), but every semantic verb on
it lied: `uia_children(dialog)` returned the **main board's** tree (`ChessView`,
`White to Move`, the move-history combobox), `uia_find(dialog, name='Abandon
game')` returned `None`, and a scan of *every* window's accessible tree for the
button names found **nothing**. The blocking modal was invisible to the entire
semantic layer — an agent could only fall back to blind pixels.

The cause is in `_atspi_frame_for` (the X-window→AT-SPI-frame bridge). One app
(gnome-chess, one pid) owns two frames — the `frame "White to Move"` and the
`dialog ""` — and the resolver disambiguates same-pid frames by *screen-geometry
IoU* between the X window's rect and each frame's accessible extents. But
gnome-chess reports **both** frames' extents at window-local origin `(0,0)`
(main `(0,0,700,550)`, dialog `(0,0,489,60)`) even though `_acc_rect` asks for
`ATSPI_COORD_SCREEN` — a real CSD/compositor quirk. So IoU is `0` for every
frame, the geometry signal collapses, and the resolver fell through to its blind
fallback: `cands[0]` — the *first* same-pid frame, i.e. the main board. The
dialog query silently read the wrong window.

**Fix** (`_osbackend_x11._atspi_frame_for`). When IoU can't decide (best `< 0.25`),
disambiguate by **size** before the blind fallback: the X window's `(w,h)` still
matches its accessible frame's `(w,h)` even when the origin is bogus (a `489×60`
dialog window vs a `700×550` main frame). Pick the frame whose `(w,h)` is closest
to the X window's, accepting it only within a tolerance (`max(16, dim·0.12)`, so
window-manager decoration offsets are absorbed). The IoU path and the exact-title
short-circuit are untouched, so well-behaved apps are unaffected.

**Proof.**  *Live gnome-chess*, same open modal, after the fix:
`uia_children(dialog)` returns the label *"Save this game before starting a new
one?"* and the three push buttons; `uia_find(dialog, name='Cancel')` →
`rect (17,31,…)`; `uia_find(dialog, name='Abandon game')` → `rect (180,31,…)`;
`uia_invoke(dialog, name='Cancel')` → `True` and the dialog window vanishes —
the modal is now driven end-to-end through the semantic floor. The main window
still resolves to the board (no regression). *Synthetic* (`_test_f243.py`,
pure-Python, no live AT-SPI): models one pid with a `700×550` main and a
`489×60` dialog frame both at origin `(0,0)`; asserts the dialog window resolves
to the dialog frame and the main window to the main frame; a second scenario
with real screen-coord extents confirms the IoU path still wins, and a third
confirms the exact-title short-circuit still fires. Without the fix the
dialog-window assertion fails (it resolves to `cands[0]`, the board).

---

> 大成若缺，其用不敝。 The tolerant equality already existed; the waits it was
> written for never used it. Completing the wiring, not adding a part.

## F244 — the two waits never adopted the tolerant equality made for them

Stress-testing the deepest interconnected case — an **asynchronous opponent**:
play White, let gnome-chess's Stockfish engine *think* for an unknown time, then
reply. A closed-loop agent must detect *the reply* (not its own move's
animation, and not before the reply lands). The canonical idiom is
`baseline = crop(board); my_move(); wait_for_change(board, baseline)` then
`wait_until_stable(board)` — catch the onset of the reply, then its settling.

But reading the two waits closely surfaced a latent structural gap. `region_diff`
(F134) was written *explicitly* to give the waits a tolerant notion of equality
— its own docstring says `wait_until_stable` and `wait_for_change` "judge
sameness by exact byte-equality — and that is brittle … a shift of +2 per channel
is invisible to the eye yet makes an exact compare report every pixel as changed,
so 'did it change?' fires on noise and 'has it settled?' never settles." Yet the
primitive was never wired in: `wait_for_change` still did `patch != baseline` and
`wait_until_stable` still did `patch == prev` — **byte-exact**. So a blinking
caret, a focus ring, a hover highlight, a one-bit antialiasing wobble, or the
mouse cursor passing through the bbox would trip the onset waiter spuriously
("it happened" when nothing did) and reset the settle counter forever ("never at
rest" while perfectly still). The whole *spatial* change family (`locate_change`,
`locate_change_blobs`) already takes `tol`/`min_count`; the *temporal* waiters,
the ones `region_diff` was authored for, were the only change consumers still
byte-exact. The same "narrow the field / look past noise" discipline F240–F242
gave colour/template/change, applied to the time axis.

**Fix** (`osctl.wait_for_change`, `wait_until_stable`). Both now measure sameness
through `region_diff(tol=…)["pixels"]` against a `min_count` threshold:
`wait_for_change` fires when `pixels >= min_count`, `wait_until_stable` counts a
capture "at rest" when `pixels < min_count`. The defaults `tol=0, min_count=1`
are exact byte-equality — `pixels >= 1 ⟺ patch != baseline` and
`pixels < 1 ⟺ patch == prev` — so existing callers are byte-for-byte unchanged.
Raising them makes the onset waiter a *meaningful*-change detector and lets a
region settle past sub-threshold jitter. `wait_for_change` now also returns
`pixels` (how many differed at the firing capture).

**Proof.**  *Live gnome-chess vs Stockfish*: White pawn move, then
`wait_for_change(BOARD, baseline, tol=24, min_count=30)` caught the engine's
**asynchronous reply** — `changed=True, pixels=610` after `1.73 s` of engine
thinking (21 polls) — and `wait_until_stable(BOARD, tol=24, min_count=30)` then
confirmed it settled in `0.80 s`; the move list read *"1b. Black knight moves
from g8 to f6"*, i.e. exactly the reply that was detected, end-to-end in 2.53 s.
*Synthetic* (`_test_f244.py`, pure-Python, faked capture stream): with defaults,
`wait_for_change` fires on a single changed pixel (old behaviour); with
`tol=24` a uniform +2 wobble is ignored; with `min_count=30` a 10-pixel flicker
is ignored but a 40-pixel block fires. For `wait_until_stable`, a strictly
alternating 10-pixel flicker never settles under the exact default but *does*
settle under `tol=24, min_count=30`. (Honest caveat: this VM's capture path does
not composite the software cursor, so a static board shows 0 jitter here — the
noise-rejection benefit is shown synthetically; live confirms the positive
async-reply path.)

---

> 為學者日益，聞道者日損。損之又損，以至於無為。 The waits read the whole desktop
> every tick to look at one fixed rectangle. Take away what was never needed.

## F245 — the pixel waiters grabbed the whole screen to watch one small region

F244 made `wait_for_change`/`wait_until_stable` *correct* about noise; profiling
the live async-reply loop next exposed a *cost* gap on the same two waiters. They
poll a fixed `bbox` many times a second, but each tick did
`capture_rgb()` — a full **1600x1200** `XGetImage` of the root window — and then
`crop_rgb` threw ~93% of it away. Watching a chess board (`361x381`, ~7% of the
screen) for a 25 s engine reply meant ~300–500 whole-desktop grabs, ~5.76 MB
read and discarded each time. The backend already had the cheaper read: F142's
foveal `capture_rgb(x, y, w, h)` asks `XGetImage` for **only** that rectangle.
The waiters simply never used it — the floor had the part, the consumers polled
the wasteful way.

**Fix** (`osctl.capture_patch` + the two waiters). New `capture_patch(bbox)`
returns `(patch, pw, ph)` for the inclusive `(minx,miny,maxx,maxy)` rectangle via
one foveal `capture_rgb(x0, y0, x1-x0+1, y1-y0+1)`. For any in-bounds bbox it is
**byte-for-byte identical** to `crop_rgb(capture_rgb()…, bbox)` (the bbox
convention and packing match exactly), so the waiters' behaviour — including
F244's `tol`/`min_count` semantics and any caller-supplied `baseline` taken via
the old crop path — is unchanged; only the read shrinks. Both waiters now call
`capture_patch(bbox)` instead of full-grab-then-crop.

**Proof.** *Live, board ROI `(595,378,955,758)`*: `capture_patch(BOARD)` is
`== crop(capture_rgb(), BOARD)` byte-for-byte (`361x381`); the per-poll grab
drops **7.9x** (`7.22 ms` full-grab+crop → `0.91 ms` foveal, ~6.3 ms saved/poll,
reading 7% of the bytes). *Closed loop with the now-foveal waiters*: White plays
`2.c4`, `wait_for_change(BOARD, tol=24, min_count=30)` catches Stockfish's
**asynchronous reply** (`changed=True, pixels=1105`, `1.91 s`, 25 polls) and
`wait_until_stable` confirms it settled in `0.39 s`; the move list reads
*"2b. Black pawn moves from e7 to e6"* — exactly the reply detected, end-to-end
in `2.3 s`. *Synthetic* (`_test_f245.py`, pure-Python, faked screen): for five
bboxes (incl. degenerate 1-px and screen-edge), `capture_patch` equals
full-grab+crop byte-for-byte **and** issues a single foveal sub-rect grab of the
inclusive `(w,h)`, never a whole-screen one.

**Honest boundary.** The foveal grab removes the IO/memory waste (7.9x cheaper
read, 93% less data per poll), but `region_diff` itself — pure-Python over
`361x381` ≈ 137k pixels at ~26 ms — now dominates each poll's wall-clock. That is
a *different* axis (the comparison loop, not the capture) and the next thread to
pull, not part of F245.

---

> 絕利一源，用師十倍。 The waits diff a board-sized patch every tick — but while
> nothing has changed yet the two patches are *identical*. Compare the bytes, not
> the pixels.

## F246 — region_diff counted every pixel even when the patches were identical

F245 cut the *capture* waste in the two pixel waiters; profiling the same loop
then showed the *comparison* had become the floor of each poll. `region_diff`
(F134) walks the patch pixel-by-pixel in pure Python — ~26 ms over a board-sized
`361x381` (~137k px) patch. The waiters poll a fixed region many times a second,
and **almost every one of those polls happens while nothing has changed yet**:
during an engine's think the watched board is dead still, so capture after
capture comes back byte-for-byte identical (measured: `True` on this VM, no
cursor compositing). Yet `region_diff` still ran the full per-pixel loop on two
identical buffers — spending tens of ms to (re)discover `pixels == 0`. A 25 s
wait did ~480 such polls, each paying the full count for a foregone answer.

**Fix** (`osctl.region_diff`). One exact short-circuit at the top: if `a == b`
the patches are byte-identical, so *no* pixel can differ by more than any
`tol >= 0` — return `{pixels:0, total, frac:0.0}` immediately. This is the
verdict, not an approximation: byte-equality ⟹ zero pixels over threshold for
every tol. The bytes compare is a single C-level `memcmp` (microseconds); only a
poll where the region *actually* changed falls through to the per-pixel loop, so
the reported `pixels` stays exact whenever it is non-zero. No API change; the
two waiters and `region_diff`'s other callers are untouched.

**Proof.** *Synthetic* (`_test_f246.py`, pure-Python): for `tol` in
`{0,8,24,255}` identical buffers return `{pixels:0,...}`; the differing-patch
counts (`noise@tol0=N`, `noise@tol2=0`, `sig@tol8=50`, `sig@tol0=50`) are all
unchanged; the identical case times ~2000x faster than the differing one.
*Live* (board ROI `(595,378,955,758)`, ~137k px): an idle poll (`a==b`) drops to
`0.008 ms` from the full count's `31.17 ms` — **~4080x** — so a 25 s wait over a
static board did `487` polls at near-zero CPU each (vs ~26 ms each before).
*Closed loop with both F245 foveal grab and the F246 fast path live*: White
`b2-b4`, `wait_for_change(BOARD, tol=24, min_count=30)` caught Stockfish's
**asynchronous reply** (`changed=True, pixels=860`, `1.98 s`, 39 polls),
`wait_until_stable` settled it in `0.65 s`; the move list read *"3b. Black knight
moves from b8 to c6"* — exactly the reply detected, end-to-end in `2.63 s`.

F245 (don't read what you won't look at) and F246 (don't recompute what hasn't
changed) are the two halves of the same 損之又損 on the polling loop: the grab and
the diff. Together a poll over a still region went from a 1600x1200 grab + 137k-px
Python diff to a foveal sub-rect read + a `memcmp`.

---

> 大制無割。 A board is one lattice, not two hundred lonely reads. Give the floor
> the verb for the whole grid, and let it look only where each cell lives.

## F247 — every grid game hand-rolls the cell loop; the floor had no grid verb

F245/F246 made the *waiters* cheap; this turns to the other dominant perception
shape. Tetris, mines, sudoku, a chess board, a mahjongg layer — a recurring GUI
is a fixed lattice of equal cells and the question is *what is in every cell*. But
the floor only had `sample_color` (one region), so each of those games re-derives
the same geometry and runs the same double loop, one `sample_color` (or crop) per
cell. Two costs paid every frame: the caller recomputes the grid, and each call
crops a fresh buffer and averages the **whole** cell. Measured on quadrapassel's
10x20 playfield: reading the board cell-by-cell is **17.7 ms/frame** — which a
real-time game (a piece falling, sampled and steered per tick) cannot spend.

**Fix** — `osctl.sample_grid(bbox, cols, rows, inset=0.25)`: the grid
generalisation of `sample_color`. Divides `bbox` into `cols`x`rows` equal cells
and returns a `rows`x`cols` array of `{r,g,b,count}` means from ONE capture. Two
losses cut (損之又損): it indexes straight into the single capture instead of
allocating a crop per cell, and `inset` averages only each cell's central window
(default 0.25 keeps the central half per axis, ~a quarter of the pixels) — which
both **skips the grid lines / borders between cells** so a separator never
pollutes a cell's colour, and reads far fewer pixels. For a uniform cell the
centre mean equals the whole-cell mean.

**Proof.** *Synthetic* (`_test_f247.py`, pure-Python 10x20 lattice, each cell a
bright border over a distinct centre): every cell resolves to its *centre* colour
exactly — border ignored — and equal to a centred `sample_color`; `inset=0`
instead reads the whole cell and the border pulls the mean off the centre (proving
it really samples the centre window); arg validation (`cols/rows>=1`,
`0<=inset<0.5`, `rgb` needs `size`); **2.8x** faster than the per-cell whole-cell
loop. *Live* (quadrapassel, board `(564,326,838,876)`, 10x20): `sample_grid`
**6.1 ms** vs the per-cell loop's **17.7 ms** = **2.9x**, and its occupancy map is
**byte-for-byte identical** to the per-cell read on a clean board (the yellow
S-piece read at rgb ~(238,219,60) in the right cells). *Closed loop* (perceive →
act → verify, all through `sample_grid`): fresh game, piece at top with min column
4; `tap(Left)`x3 (held so the self-drawn canvas samples each rising edge, F232);
re-read — min column **4 → 1**, an exact three-cell leftward shift, with the piece
one row lower. The grid was perceived, steered, and confirmed by the new verb
alone.

Honest attribution: the speedup is the *inset* (reading each cell's centre, not
its whole area); batching itself is roughly neutral against a per-cell centre
loop — its gift is the API, the single capture, and the geometry the caller no
longer repeats. `sample_color` maps one place→colour; `sample_grid` maps a whole
lattice→colour, the read a grid GUI actually asks for.

---

> 既得其母，以知其子。 Find the lattice first; then every cell follows. The grid
> verb (F247) reads the cells — but only once the caller has *told* it the
> lattice. Give the floor the verb that finds the lattice itself.

## F248 — sample_grid must be told the lattice; the floor had no verb to find it

F247 reads a whole grid in one call, but it must be handed the lattice — `bbox`,
`cols`, `rows`. Where does that come from today? Each ruled-grid game re-derives
it by hand with screen-specific magic: `_game_sudoku.detect_board` scans fixed
pixel ranges (280..920, 420..1160) for "mostly dark over the board span" columns,
takes the first/last as the border, and **hard-codes `/9`** for the cell count.
That is unportable (the magic ranges are this window at this size) and it cannot
even *count* — it assumes 9. A generic table / board has nowhere to turn. This is
the companion gap to F247: a verb that *finds* a regular lattice.

What recurring structure does a ruled grid actually present? **Periodic edges** —
its cell separators are equally spaced lines, so the per-column / per-row edge
energy (`|Δluma|` summed across the other axis) spikes at every boundary and
nowhere else. The catch: cell *content* also makes edges (a digit, a glyph, a
piece), so a naive "peak spacing" reading is polluted. The principled fix is to
treat it as periodic-structure recovery: take the boundary candidates (gradient
peaks, clustered to centres) and fit the **longest evenly-spaced chain** through
them — the real lattice votes as one comb (cols+1 teeth at a constant pitch),
while stray content edges fall off the comb and are skipped. The cell count then
drops out of the chain length; it is *measured*, not assumed.

**Fix** — `osctl.detect_grid(search, ...)`: returns
`{bbox,(x0,y0,x1,y1), cols, rows, cw, ch, xs, ys}` — feed `bbox`/`cols`/`rows`
straight to `sample_grid` — or `None` when no regular lattice of `min_cells` per
axis is present. `search` narrows the scan (the F240 ROI discipline again).

Honest scope. This keys on the *separators* being the dominant periodic edge,
which holds for ruled grids — sudoku, spreadsheets, calendars, go / bordered
boards. Probing it live exposed the boundary cleanly: on a fresh **gnome-chess**
board the rank/file edges are real, but the pieces' silhouettes inject as many
strong edges as the squares, and the longest chain no longer recovers 8x8. So
`detect_grid` is deliberately *not* the tool for boards whose cells carry no
separators (a Tetris well — find its bbox by colour) or where cell content
out-weighs the lines (a chess mid-game); those find geometry another way and pass
their known dims to `sample_grid`. The finding itself matters: grid-geometry
detection does not reduce to one universal cue — it is separator-periodicity here,
colour-step there, AT-SPI rects elsewhere — and the floor should own the one
clean, broad case (ruled separators) rather than pretend universality.

**Proof.** *Synthetic* (`_test_f248.py`, pure-Python ruled grids): exact recovery
of origin/pitch/dims across several geometries; **robust to off-comb content** —
filling four cells with solid colour does not shift the recovered 9x9 lattice
(the chain skips their edges); it then **composes with `sample_grid`**, whose
read of those cells returns the planted colours; and it **rejects** a blank region
and a 2x2 (< `min_cells`) and validates args. *Live* (gnome-sudoku, Easy board):
`detect_grid((480,290,1110,900))` returns **9x9 @ (511,312,1089,890), cw 64.22** —
matching the hand-rolled `detect_board` to within 1 px on origin and exactly on
pitch, while additionally **recovering the count 9 that detect_board hard-codes**.
Fed straight into `sample_grid`, the detected lattice classifies the board's
given / empty cells. Cost is a one-shot **183 ms** over a 630x610 search at
stride 2 — paid once at calibration, not per frame (then `sample_grid` runs the
hot path); raise `stride` to trade accuracy for speed. `sample_grid` answers
"what is in each cell"; `detect_grid` answers "where are the cells" — together the
floor reads a ruled grid end to end without the caller hand-coding geometry.

---

> 大成若缺。 A read primitive that dies on a small cell is not finished. The crop
> a caller computes can run past the cell or the frame — clamp it, name the empty
> one, and never let the floor crash on a negative bytearray.

## F249 — ocr_text crashes opaquely on a degenerate / off-frame crop

Driving gnome-mines through the floor's own player surfaced this on the very
first read: `read_board` crashed with `ValueError: negative count` from inside
`bytearray(rw*rh*3)`. Root: the cell-digit crop is computed by insetting a
*fixed* pixel margin — `(cx+25, cy+20, cw-50, ch-40)` — and the live board's
cells are **48 px**, so `cw-50 = -2`: a negative width fed straight into a
`bytearray`. This is the F237 trap resurfacing at the floor boundary — a fixed
margin is unportable across cell sizes, and worse, `ocr_text` met the bad region
with an *opaque* internal crash instead of a clear contract error. Any vision
caller that computes a crop near a frame edge or from a small cell hits this.

**Fix (two layers).** *Floor*: `ocr_text` now routes every explicit region
through `_clamp_region` — it trims the crop to the frame (a crop hanging past the
right/bottom edge, or starting at a negative origin, reads the visible remainder
instead of a wrong/short slice) and raises a **named** `ValueError` ("region is
empty after clamping ...", or "must have positive width/height" on the capture
path) only when nothing is left — never the downstream `negative count`. *Caller*
(`_game_mines._classify`): the digit crop is inset by a *fraction* of the cell
(`max(2,int(cw*0.25))` / `*0.20`) instead of a fixed 25/20 px, so it stays a
sensible centred window at any cell size.

**Proof.** *Synthetic* (`_test_f249.py`, pure-Python, no tesseract): a
fully-inside region passes through unchanged; the F237 cell (48px inset 25 →
width −2) and other non-positive crops raise a clear "empty" error instead of
crashing; partly-off-frame crops clamp to the on-frame remainder
(`(190,0,30,10)` on a 200-wide frame → `(190,0,10,10)`); fully-off-frame raises;
and `ocr_text`'s capture branch rejects a non-positive region up front with
"positive width/height" before any tesseract call. *Live* (gnome-mines, 8x8 @
48px cells): `read_board` went from **crashing on the first cell** to reading the
full board in ~3 s, and the floor's mines solver then **played it end to end** —
placing 7/10 correct flags and clearing most of the board through perceive →
deduce → click, with no crash and no mine hit (it reached the round cap before a
full clear; convergence is solver logic, separate from this floor fix). The read
primitive no longer has a small-cell cliff.

---

> 為學者日益，聞道者日損。 The reader that re-reads every cell each step is
> learning by addition; the floor's way is subtraction — read once, then touch
> only what moved.

## F250 — grid_changes: re-read only the lattice cells that actually moved

Driving gnome-mines through the floor's player stalled at the round cap, and the
profile was unambiguous: each round re-reads all 64 cells (64 OCR calls) just to
learn that a move touched two of them. The same waste F245/F246 cut for the pixel
waiters — redoing work on pixels that did not change — was never cut for grids.
`sample_grid` (F247) reads the whole lattice in one capture, but an incremental
grid game (mines reveals a few, sudoku fills one, a chess move touches two) wants
the *delta*, not the whole board, every step.

**New verb** `osctl.grid_changes(prev, cur, bbox, cols, rows, size, inset, tol,
min_count) -> [(row, col), ...]` — the per-cell `locate_change` for grids. Given
two captures and the *same* geometry you hand `sample_grid`, it compares only
each cell's central window and returns the cells where more than `min_count`
pixels differ by more than `tol`. The caller then re-classifies only those and
reuses its prior reading for the rest. Geometry (cell windows, bounds clamping,
`inset` meaning) is byte-identical to `sample_grid`, so the `(r,c)` indices line
up one-to-one; and like F246 each cell stops counting the instant the verdict is
in (損之又損). `tol=0, min_count=1` is exact.

**Proof.** *Synthetic* (`_test_f250.py`): nothing-changed → `[]`; flipping two
cells → exactly those two in row-major order; `tol` hides a sub-threshold wobble;
`min_count` gates a single-pixel change; the flagged set equals the set of cells
whose `sample_grid` mean moved (one-to-one indexing); args validated. *Live*
(gnome-sudoku Easy): captured the board, filled one empty cell, and
`grid_changes` returned exactly the cells that moved — the newly-filled cell
**and** the previously-selected cell whose blue highlight cleared when focus left
it (both genuine pixel changes; an incremental reader re-checks both cheaply and
keeps the other 79 cells from its prior read).

**Honest edge found while validating.** `capture_patch` (F245) returns a
*patch-local* buffer, but `sample_grid`/`grid_changes` take a bbox in whatever
frame the buffer is in — so composing them on a foveal patch requires passing a
patch-local bbox `(0, 0, pw-1, ph-1)`, not the screen bbox. Mixing the two
(screen bbox against a patch buffer) silently clamps every cell to the patch edge
and reads them identical. Documented here rather than papered over with more API;
the common path (`sample_grid(bbox)` with no rgb, full-screen capture) is
unaffected.

### F250 end-to-end payoff (mines solver wired to read_delta)

Wired the gnome-mines player to F250: `read_full` once, then every round
`read_delta` re-classifies only the cells `grid_changes` flags and copies the
rest. Live 8x8 run (80 rounds): **127 cell-classifies total vs 5184** a
full-re-read-each-round would cost — **98% fewer**, because most rounds change
one cell (a flag toggle / a single open) or nothing at all, and the old reader
paid 64 OCR-classifies every round regardless. Faithfulness checked two ways: a
no-op delta (static board between captures) reclassifies **0**, and the
delta-tracked board matches a fresh full ground-truth read **0/64 mismatches** —
the saving is from not redoing unchanged work, not from missing changes. (The
solver still hits the round cap without a full clear; convergence is solver logic,
not a floor gap — F250 is purely about not re-reading what didn't move.)

---

> 大制不割。 A board is read whole, in one capture, in one verb — not re-derived
> cell by cell by every caller who happens upon a lattice of glyphs.

## F251 — ocr_grid: read a glyph lattice into a 2D array, ink-gated

Exercising games live to find the next friction, the first move was the obvious
one: read the gnome-sudoku board. Two ways failed in instructive ways. Whole-
board `ocr_text` on the 9x9 returned `''` — tesseract will not segment a sparse
field of digits ruled by gridlines. So drop to per-cell. The *naive* per-cell
loop (no whitelist, default psm) read the givens but **hallucinated**: empty
grey cells came back as `"a"` (rows 1,2,5,7,8 each grew a stray glyph from the
shaded-cell border), so the board mis-filled. The cure for *accuracy* was
already known (F235: `whitelist='123456789'`, `psm=6`) and indeed read 81/81 —
but only because the caller also hand-rolled an **ink gate** (skip a cell with
too little dark ink) so empties never reach OCR, plus the geometry double-loop
and the whitelist/psm/scale tuning. Grepping the floor's own players confirmed
the smell: `_game_sudoku` and `_game_mines` *both* re-derive that exact triple
(geometry loop + per-cell gate + whitelist/psm), each slightly differently.

**New verb** `osctl.ocr_grid(bbox, cols, rows, rgb, size, inset, whitelist, psm,
scale, invert, ink_tol, ink_min, xs, ys) -> [[str, ...], ...]` — the OCR grid
that `sample_grid` (F247) is for colour. It divides the board with the *exact*
`sample_grid`/`grid_changes` geometry and, for each cell, gates on ink before
reading: it measures the central window and counts pixels whose luminance
deviates from the window mean by more than `ink_tol`; a cell with fewer than
`ink_min` such pixels is blank — returned `""` and **never sent to tesseract**.
Only inked cells are OCR'd (with the given whitelist/psm/scale/invert). Two
losses cut (損之又損): the empty-cell hallucination is gone (a blank is decided
by pixels, never by OCR), and the dominant cost on a sparse board is skipped
(the F250 lesson — don't read what holds nothing — applied to OCR). The gate is
polarity-agnostic (deviation from the cell's own mean fires for dark-on-light
*and* light-on-dark), so it needs no `invert` to classify blankness.

**Honest edge found while validating — why `xs`/`ys` exist.** First cut divided
`bbox` into equal cells (the `sample_grid` convention) and read the live board at
**78/81**: three mid-board `4`s came back blank. Not the gate (ink=213, far over
threshold) and not OCR (the same crop off `detect_grid`'s real edges read `'4'`).
It was *drift*: a real board's pitch is not perfectly uniform — the heavy 3x3
rules make some columns a pixel wider — and where colour sampling shrugs that off,
an OCR crop does not; two pixels of accumulated offset shifts a mid-board crop
onto the cell edge, clips the glyph, and psm=6 then reads nothing. So `ocr_grid`
also takes the exact `xs`/`ys` line positions `detect_grid` already returns and,
when given, crops each cell on its true `[xs[c], xs[c+1]]` box. With them the live
board read **81/81**. The intended pipeline is therefore
`g = detect_grid(...); ocr_grid(g['bbox'], g['cols'], g['rows'], xs=g['xs'], ys=g['ys'], ...)`.

**Proof.** *Synthetic* (`_test_f251.py`, no display, no tesseract — `ocr_text`
is stubbed to a recorder): only inked cells are read and blanks are `""` with
OCR never called on them; the gate is polarity-agnostic (light-on-dark trips it)
and honours `ink_tol`/`ink_min` (a sub-tol mark stays blank); the gated set
equals the cells `sample_grid` sees as non-background; with uneven `xs`/`ys` the
crop handed to OCR sits inside the *true* cell, not the uniform split; args
validated (bad cols/rows/inset/ink_min, wrong `xs`/`ys` length, rgb-without-size).
*Live* (gnome-sudoku Easy): `ocr_grid` off `detect_grid`'s edges read the board
**81/81, 0 hallucinations**, in 1.24s vs 1.7s for the read-every-cell loop
(~60 empties skipped).

### F251 end-to-end payoff (sudoku player wired to ocr_grid)

Rewrote `_game_sudoku`'s `Board.read` — previously a `read_cell`/`_dark`
double-loop — to one `ocr_grid` call off the detected `xs`/`ys`, deleting the
hand-rolled gate and per-cell OCR plumbing. Driven live: the floor read the Easy
board 81/81, solved it by backtracking, drove the 54 empties back in with
`click`+`type_unicode`, and gnome-sudoku put up **"Well done, you completed the
puzzle in 9 minutes!"** — a full board read → solve → fill round through the
floor, with the glyph-lattice read now a single primitive any grid game shares.

**Negatives recorded the same session (no verb earned).** Two suspected
frictions were chased and *cleared*, which is itself the point of exercising
live. (1) **drag on GTK4 DnD**: gnome-tetravex moved a tile only every *other*
identical drag (a clean 3/6 alternation). Instrumented `mouse_state` (button
never stuck), tried hover-settle, nudge-onto-source, dwell-at-target, and a 2.5s
inter-drag settle — all still 3/6. The decider: the system's own `xdotool` drag
alternates **3/6 identically**, so the floor's `drag` is on par with the
reference X11 injector and the alternation is tetravex's DnD semantics, not a
floor gap — no fix made. (2) **detect_grid undercount**: it returned 8x8 for the
9x9 sudoku, but only because the search box clipped the board's outer rule;
widened to contain the border it returns 9x9 exactly (last line at x=880). Both
are recorded so the next reader doesn't re-chase them.

## F252 — classify_grid: read a lattice of sprites against a template library

The next board exercised live was gnome-chess. Reading it broke every reader the
floor had. Whole-board `ocr_text` reads nothing — the pieces are *vector glyphs*,
not text. `sample_grid` (F247) sees a cell's mean colour and so tells *piece
present and its shade* but **not its type**: the black back rank `R N B Q K B N R`
sampled to luma `[56,37,92,56,69,79,44,49]` — rook `56` and queen `56` are
*identical*, so colour cannot separate a rook from a queen. `ocr_grid` (F251) is
the right shape but the wrong channel (there is no text to read). The only verb
that keys on *appearance* was `match_template` (F053) — but it **locates one
patch**, so reading 64 squares meant hand-rolling the per-cell loop: crop the
cell, score it against every candidate sprite, take the argmin, and gate out the
empties. That is the same orchestration `sample_grid`/`ocr_grid` already absorbed
for colour and text, missing for sprites.

**New verb** `osctl.classify_grid(bbox, cols, rows, templates, rgb, size, inset,
ink_tol, ink_min, norm, empty_label, unknown_label, max_score, xs, ys) -> [[str,
...], ...]` — the appearance grid that `sample_grid` is for colour and `ocr_grid`
for text. It divides the board with the *exact* `sample_grid`/`ocr_grid` geometry
(same `inset`, same clamping, optional `detect_grid` `xs`/`ys` edges, so the
`[r][c]` indices line up one-to-one) and, for each cell: gates on ink exactly as
`ocr_grid` does (a cell with fewer than `ink_min` pixels deviating more than
`ink_tol` from its own mean is blank → `empty_label`, never scored), then
resamples the cell to a fixed `norm`×`norm` luma signature and scores it against
each `(label, patch, pw, ph)` template by **mean-absolute-difference per pixel**.
The lowest mean-diff label wins. Templates are harvested once from a known frame
(the chess start position gives all twelve pieces at known squares) with
`crop_rgb`, then every later board is one call.

**Two design points the live board forced out.** (1) **Shade-invariance via the
shared `inset`.** First cut resampled the *whole* cell and scored raw luma → the
checkerboard wrecked it (3/64): a bishop on a light square differs from a bishop
harvested on a dark square mostly in *background shade*, and that swamps the SAD.
The fix is to score only the **inset central window** — glyph-dominated, so the
score keys on the sprite, not the square behind it — and to inset the *template*
patch by the same fraction so the two windows are commensurate. With that the
live start position read **0/64**. (2) **Size-invariance via the resample.** A raw
SAD favours whichever sprite covers fewer pixels, and on an uneven `xs`/`ys` pitch
no two cells are even the same size; resampling every cell *and* every template to
one `norm`×`norm` grid makes the mean-diff comparable across templates and across
unequal cells. (3) **`max_score` as a strictness knob.** The argmin always returns
*some* label; when `max_score` is set and even the best mean-diff exceeds it the
cell is `unknown_label` — so an off-nominal cell (a highlighted last-move square, a
piece mid-animation) is *flagged*, not silently mislabelled.

**Proof.** *Synthetic* (`_test_f252.py`, no display — `classify_grid` is
self-contained pixel maths): a lattice of painted sprites is classified against a
harvested library with blanks gated to `empty_label` and only placed cells
labelled; the **shade-invariance** is asserted directly (the same sprite over a
much darker background still matches the light-background template); `max_score`
flags an off-library sprite as unknown yet a `None` threshold forces the nearest
label; an uneven `xs`/`ys` pitch classifies off the true edges; args validated
(bad cols/rows/inset/ink_min/norm, empty library, bad patch length, negative
`max_score`, wrong `xs`/`ys` length, rgb-without-size). *Live* (gnome-chess):
`classify_grid` off twelve start-position templates read the **full start board
0/64 in 0.06s**, then — after the floor played `e2e4` by `click`+`click` and the
engine replied `c7c5` — re-read the new position **perfectly** (e4 white pawn, c5
black pawn, e2/c7 empty, 0 unknowns), proving it classifies an *arbitrary* board,
not just the memorised start. With a tight `max_score=45` the just-moved
highlighted `e4` square is correctly flagged `?`, the knob behaving as designed.

### F251 follow-up — sudoku reader hardened onto detect_grid (kill the bespoke scan)

**Friction.** Recording the floor play a *full* gnome-sudoku round surfaced a
latent brittleness in the player, not the floor. `_game_sudoku.detect_board`
hand-rolled its geometry: it scanned a **hard-coded screen rectangle**
(`x 420..1160, y 280..920`) for the four heavy 3×3 box-border lines. That window
was tuned to one particular launch position/size. On this VM the default board
runs to `y≈1040` and a maximised board fills the screen — both fall outside the
scan box, so `detect_board` raised `board borders not found` and the player could
not even start. The reader was sound (`ocr_grid` reads the digits fine); the
**locator** was the weak link, and its own docstring already *claimed* "no
hard-coded pixels" — aspirational, not true.

**Fix.** Delete the bespoke scan (`_lum`/`_runs`/`DARK` and the fixed ranges) and
locate the lattice with the floor primitive built for exactly this — `detect_grid`
— **scoped to the live window rect** from `window_geometry`: find the `Sudoku`
window, take its interior (below the ~44px header), and let `detect_grid` return
the true `bbox`/`xs`/`ys`. `Board` now reads off those detected edges (uneven
pitch tolerated) and computes cell centres from `xs`/`ys` midpoints. The
docstring's "no hard-coded pixels" is now *literally* true, and the reader
survives the window being moved or resized.

**Lesson (architecture).** Every game player that hand-rolls "find the board"
geometry is a brittle re-implementation of `detect_grid`. The friction was not a
missing verb — `detect_grid` already existed (F-series) — but a *caller* that
predated it and never adopted it. Eating bespoke locators back into the primitive
is the same flow→primitive consolidation as F250/F251, applied to the call site.
One caller-side caveat worth recording: a search box that *clips* the board makes
`detect_grid` return a smaller-but-valid lattice (a clipped top read 9×7 with no
error), so the caller must hand it a generous, board-containing region — here the
whole window interior — rather than a tight guess.

**Proof.** *Live, default window*: the hardened reader detects `bbox=(511,312,
1089,890)` 9×9 and reads **32/32 givens**, solver returns a complete solution.
*Live, maximised window* (the exact case the old scan crashed on): detection now
*adapts* — `bbox=(271,73,1328,1130)` 9×9 located, no crash (OCR at ~2× cell size
drops a few, a separate accuracy matter; detection itself is robust). *End-to-end
recording*: the floor read → solved → filled all **49 empty cells** via
`click`+`type_unicode`, and gnome-sudoku put up **"Well done, you completed the
puzzle in 4 minutes!"** — a complete autonomous round. All ten synthetic friction
tests (F243–F252) still pass, no regressions.

### F253 — detect_cascade: the ragged overlapping pile detect_grid can't see

**Friction.** Driving the floor over a fresh GUI — gnome-aisleriot (Klondike) —
to widen the practice surface surfaced a shape the read stack had no answer for.
`detect_grid` fits a *uniform* lattice: the right tool for a ruled board, and it
even "succeeds" on a tableau (it returns a 7×11 grid by reading the deepest pile's
overlap strips as rows). But that lattice is a lie. A solitaire tableau is seven
**piles of overlapping cards** that run to *different* depths — column 1 holds one
card, column 7 holds seven — and only the **bottom** card of each is fully shown.
The uniform 7×11 grid's cells mostly land on nothing (a shallow column is felt
below its single card) or on the wrong thing (a strip of a covered card, not a
readable face). Every cascade game would then hand-roll its own pile walk, exactly
the kind of bespoke geometry F-series exists to eat.

**Fix — a new perception primitive, `detect_cascade`.** Rather than a uniform
lattice, return per column the **face-up (bottom) card** — the thing you actually
read and click. The temptation is to segment *every* overlapped card, but that is
theme-brittle: a card back's pattern and a court card's inner frame both fake
full-width "card-top" lines, and the first cut at this (count dark full-width
edges) over-counted a 1-card pile as six. The robust invariant is coarser and
sufficient: **a pile is one contiguous non-felt run** (cards touch, no felt
between), so its top/bottom are unambiguous from a felt-vs-card test alone, and the
face-up card is the **bottom `card_h` px** of that run (it is drawn on top, fully
visible, felt just below it). Depth needn't be segmented at all — piles one card
apart differ in height by one overlap `pitch` — so `depth ≈ round((height −
card_h)/pitch) + 1`, and **`card_h`/`pitch` are inferred from the columns
themselves** (the shortest pile is a lone card → `card_h`; the modal positive step
between sorted pile heights → `pitch`). A fresh deal needs no magic numbers.

**Lesson (architecture).** `detect_grid` and `detect_cascade` are the two board
*shapes* the floor now perceives — a **uniform tiling** vs a **ragged overlapping
stack** — the same way `sample_grid`/`ocr_grid`/`classify_grid` are the three cell
*contents* (colour / text / sprite). The win came from refusing the brittle "read
every card" framing and keeping only the invariant that actually holds across
themes (contiguous run + height→depth), which is why it survived a back-pattern
and court-card frames that defeated the first attempt.

**Proof.** *Live, default Klondike deal*: `detect_cascade` returns depths
**`[1,2,3,4,5,6,7]`** — exactly the deal — with `card_h=152`/`pitch=30` inferred,
and the seven `faceup` boxes land on Q♦/5♣/6♥/8♥/8♠/2♥/3♣ (verified: suit-colour
read off those boxes is **7/7** correct). *Synthetic* (`_test_f253.py`, no display):
ragged depths off pile height with `card_h`/`pitch` inferred, empty columns flagged
`present=False` (no phantom pile), the face-up box pinned to the bottom card
(bottom hugs the pile bottom, height ≈ `card_h`, starts below the pile top when
depth>1), `bg` auto-detected, and args validated. All eleven floor friction tests
pass (F253 plus the prior ten), no regressions.

### F254 — classify_boxes: reading the boards that aren't a lattice

**Friction.** Widening the practice surface to gnome-mahjongg surfaced the dual
of F253. `find_color_blobs` already *segments* the board fine — keyed on the
cream face colour it returns one ~71×98 box per fully-exposed tile (the only
tiles a player can ever click), occluded slivers falling out as smaller blobs.
So *where* the tiles are was never the wall. *What* each one is was: the floor's
only sprite reader, `classify_grid`, demands a `cols`×`rows` **lattice**, and a
mahjongg layout is tiles stacked in offset 3-D layers — no lattice exists. The
same gap reappears wherever the targets aren't ruled: `detect_cascade`'s seven
`faceup` boxes (ragged depths), `locate_change_blobs`'s change regions (wherever
they fell). Every such caller re-rolled the *identical* loop `classify_grid`
already owns — crop, ink-gate, resample, argmin, threshold — just over its own
boxes instead of a grid.

**Fix — `classify_boxes`, the lattice-free sibling of `classify_grid`.** Pull
that loop's pixel core out (`_classify_lib` resamples the template library once;
`_classify_box` insets / ink-gates / resamples / scores one box) and let *both*
entry points call it: `classify_grid` over the cells it derives from a `bbox`,
`classify_boxes` over an explicit box list. `detect_*` answers *where*; this
answers *what*. One library, harvested once, now reads both a grid and a
scatter. `classify_grid` is unchanged behaviourally (its F252 test passes
untouched) — it is now a thin lattice-geometry shell over the shared core.

**The 1-px lesson.** The first cut returned `?` even when a tile was scored
against a template harvested from *itself*. Cause: `crop_rgb` and every `*_blobs`
`bbox` are **inclusive** (`minx..maxx`, width `x1−x0+1`), but the cell-rect
arithmetic `classify_grid` feeds the core is **half-open** (width `x1−x0`). A
template harvested 71-px wide, read back 70-px wide, shifts the inset window one
pixel — and on a sharp glyph a one-pixel shift misaligns the strokes enough to
blow the mean-abs-diff clean past threshold (the live diff histogram is a hard
gap: identical tiles at **0.0**, the next-nearest distinct tile at **8.4**, so a
1-px self-mismatch is fatal, not noise). The fix is to make `classify_boxes`
speak the convention its box sources actually emit: boxes are inclusive, mapped
`(x0,y0,x1+1,y1+1)` before the half-open core — so a box segmented one frame and
its library harvested another line up to the pixel.

**Lesson (architecture).** The read stack is now a clean *where × what* product.
**Where:** `detect_grid` (uniform tiling), `detect_cascade` (ragged stack),
`find_color_blobs` / `locate_change_blobs` (free scatter). **What:** `sample_grid`
(colour), `ocr_grid` (text), `classify_grid` (sprite-on-a-lattice), and now
`classify_boxes` (sprite-anywhere). `classify_grid` and `classify_boxes` sharing
one pixel core is the point — the lattice was never essential to *reading* a
sprite, only to *locating* it, so the two concerns split and the reader stopped
caring about board shape. Consolidation, not a new algorithm: the friction was
that geometry and recognition were fused, and prising them apart let one library
serve every board the floor can segment.

**Proof.** *Live, gnome-mahjongg "Easy" (the turtle)*: `find_color_blobs` on the
face colour yields **81** fully-exposed tile boxes; clustering them with
`classify_boxes` (seed the library on first sight, `max_score=4`) collapses them
to **58 tile types** with multiplicities up to 3 — **41** faces fall into a type
seen ≥2× and re-classifying every box against the harvested library is **stable**
(round-trips to the same labels). The annotated frame shows matched tiles sharing
an outline colour (the two 三萬, the two 東 east-winds, the 伍萬 pairs, the dot
tiles), i.e. visually-identical faces read to one label across the scattered,
occluded board. *Synthetic* (`_test_f254.py`, no display): sprites scattered at
irregular positions read back in input order; a `crop_rgb`-harvested box
self-matches at near-zero cost (the inclusive-box regression guard); blanks gate
to `empty_label`; an off-library sprite is `unknown` under `max_score` and forced
to its nearest label without; and `classify_boxes` **agrees with `classify_grid`**
label-for-label on the same cells (the shared-core guarantee). All twelve floor
friction tests pass (F254 plus the prior eleven), no regressions.

### F255 — ocr_grid(invert="auto"): the board that mixes ink polarities

**Friction.** Driving gnome-tetravex broke the OCR reader on a kind of board the
floor had not met: one where the *ink polarity flips within a single board*. A
tetravex tile is quartered by its diagonals into four triangles, each carrying a
digit, and the triangles are painted in saturated colours — so the same digit
"3" is **white on a dark-red triangle** in one cell and **black on a yellow one**
in the next. `ocr_grid` took `invert` as a single bool applied to every cell, and
tesseract only reads dark-on-light: with `invert=False` the white-on-dark digits
came back **empty**, with `invert=True` the black-on-light ones did. There is no
one bool that reads the board — the caller would have to pre-sort cells by colour
and call `ocr_grid` twice with disjoint masks, re-rolling per game the very thing
the grid reader exists to spare them. (Empirically the wall was sharp: a single
global polarity read **21/36** tile digits; the misses were exactly the
wrong-polarity cells reading nothing.)

**A discarded hypothesis (worth recording).** The first instinct was that this
was a *template* problem — that a luma sprite of a white "3" is the photographic
inverse of a black "3", so `classify_*` should score a cell against both a
template and its inverse and keep the better. That is true but it does not fix
*this* board: tetravex digits are small glyphs on busy multi-colour triangles cut
by diagonal edges, and a polarity-invariant template still keys on the triangle's
colour and diagonal, not the digit — both polarities scored ~15/36, no better
than chance-adjacent. The honest reader for small glyphs is OCR, and the friction
is OCR's, so the fix belongs in `ocr_grid`, not in the template scorer. Following
the symptom to the wrong layer would have shipped a primitive that proved nothing.

**Solution.** Add `invert="auto"` to `ocr_grid`. The per-cell ink gate already
measures each cell's mean luma and the pixels that deviate past `ink_tol` (the
glyph ink) — the very statistic that decides polarity. So `auto` reuses it: if a
cell's ink is *brighter* than its mean the glyph is light-on-dark and the cell is
read inverted, otherwise upright; and if the chosen polarity reads nothing, the
opposite is tried before the cell is given up. No new measurement, no second
capture, no caller-side colour masking — the gate that already runs per cell now
also chooses that cell's polarity, so a board that mixes polarities reads in one
call. The bool path is untouched (and keeps its early-out on the ink count; only
`auto`, which needs the ink's brightness, sums it).

**Lesson (architecture).** The reader's job is to *normalise away* a board's
incidental presentation so the recogniser sees something canonical — and polarity
is presentation, not content. The floor already made the ink *gate*
polarity-agnostic (it fires on deviation, either sign); F255 finishes the thought
by making the *read* polarity-adaptive too, per cell rather than per board. The
unit of adaptation is the cell, because that is the unit at which a real board's
appearance actually varies — the same reason `ocr_grid` reads per-cell edges
(F251) and `classify_boxes` reads per-box (F254). Push the adaptation down to the
grain at which the world varies, and the caller stops pre-sorting the world to fit
the tool.

**Proof.** *Live, gnome-tetravex (3×3 stock, 36 triangle digits, mixed polarity)*:
a single global polarity reads **21/36**; `ocr_grid(invert="auto")` reads
**35/36** — every white-on-dark and black-on-light digit but one, the lone miss a
genuine tesseract `8`→`3` glyph confusion (not a polarity error). The annotated
frame overlays each auto-read digit on its triangle: the magenta labels track the
glyphs across saturated reds, navies and purples (white ink) and yellows, oranges
and light-blues (black ink) alike. *Synthetic* (`_test_f255.py`, no display, OCR
engine stubbed to mimic tesseract's dark-on-light requirement): on a board mixing
both polarities, `invert=False` reads only the dark-on-light cells and
`invert=True` only the light-on-dark, while `invert="auto"` reads **every** cell;
auto picks the matching polarity first try (one OCR call per cell when its guess
is right); it retries the opposite polarity on an empty read; a blank cell is
still gated out before OCR even under `auto`; and a non-bool/non-"auto" `invert`
is rejected. All thirteen floor friction tests pass (F255 plus the prior twelve),
no regressions.

### F256 — cluster_boxes: reading a board whose alphabet you don't know yet

**Friction.** `classify_grid`/`classify_boxes` answer *what* each cell is — but
only after you have harvested a labelled template per class. Driving gnome-chess
made the precondition the problem: to read the start position you would harvest
the twelve pieces from… the start position, which is circular, and a *mid-game*
board (or an unfamiliar mahjongg tileset, or the change-regions of a never-seen
game) gives no known frame to crop labels from at all. Worse, F254 had already
*hand-rolled the escape* inline for mahjongg — seed a one-tile library on first
sight, start a new entry whenever the best match exceeds a radius — i.e. the
floor kept re-deriving an unsupervised grouping loop per game, the exact
boilerplate the `classify_*` primitives exist to retire.

**A discarded framing (worth recording).** The first instinct on chess was a
different friction: the same piece sits on both light and dark squares, so maybe
`classify_grid`'s whole-cell luma signature confuses a piece by its *background*
and needs a foreground/background separation primitive. Measured, the worry
evaporated: a white pawn on a light vs a dark square differs by **22** per-pixel
mean-abs-diff, while a pawn vs a rook on the *same* square differs by **75–87** —
the inset window is glyph-dominated, so `classify_grid` already reads chess with a
wide margin (F252's "a bishop on a light square matches one harvested from a dark
one" was true all along). The real gap was not separating fore from back; it was
not needing a labelled library in the first place.

**Solution.** `cluster_boxes(boxes, max_score=…)` — the unsupervised sibling of
`classify_boxes`. It factors the per-box pixel core out of `_classify_box` into a
shared `_box_signature` (inset to the glyph-dominated centre, ink-gate, resample
to a norm×norm luma signature) and groups the boxes by single-pass *leader
clustering*: each box joins the nearest existing cluster whose exemplar is within
`max_score` mean-abs-diff per pixel, else founds a new cluster and becomes its
exemplar. Ids are assigned in first-appearance order (deterministic, order-stable),
blanks gate to a sentinel and never cluster. Because the signature core is the
*same* one `classify_boxes` uses, the workflow composes: cluster to discover the
alphabet, label the few exemplars once, then `classify_boxes` with them — and the
labels reproduce the clustering pixel-for-pixel.

**Lesson (architecture).** The `classify_*` family assumed the alphabet is known
and the question is *recognition*; but the prior, cheaper question is *typing* —
"which of these are the same?" — and it needs no labels, just the metric. Reading
splits into two stages the floor had been fusing: **discover** the equivalence
classes from the board itself (`cluster_boxes`), then optionally **name** them
(`classify_boxes`). Supervised recognition is the special case where stage one was
done off-board by a human harvesting templates. Exposing the unsupervised stage as
its own primitive is what stops every new game from re-rolling the leader loop —
the same move F251–F254 made for the per-cell read loops. `max_score` is the one
knob, in the same luma units as the classify threshold: too tight and a class
over-splits on incidental variation (a piece's square colour), too loose and
classes merge; there is a wide plateau between, so the knob is forgiving.

**Proof.** *Live, gnome-chess start position*: the 32 occupied squares cluster, at
`max_score` anywhere in **28–48**, into exactly **12** classes — sizes
`[8,8,2,2,2,2,2,2,1,1,1,1]` — and the assignment is structurally correct: the
black back rank reads `[0,1,2,3,4,2,1,0]` (rook, knight, bishop, queen, king,
bishop, knight, rook — symmetric), the white back rank `[7,8,9,10,11,9,8,7]`
(distinct ids — white pieces never merge with black), and each side's eight pawns
fall in one cluster. No template was supplied. Tightening to `max_score=18`
over-splits to 14 (the cross-background variation splitting two piece types),
confirming the radius is the only knob and 28–48 a stable plateau. *Synthetic*
(`_test_f256.py`, no display): two each of three shapes drawn on alternating
background shades cluster to `[0,1,2,0,1,2]` (grouped by shape, background
ignored) on the default radius; a too-tight radius over-splits each onto its own
background; a blank box gates to the (configurable) sentinel without consuming a
cluster id; the result is deterministic; and feeding one exemplar per discovered
cluster back to `classify_boxes` as a labelled library reproduces the grouping
exactly. All fourteen floor friction tests pass (F256 plus the prior thirteen),
no regressions.

### F257 — sample_grid(stat="mode"): the fill colour, immune to the mark on it

**Friction.** `sample_grid` reads a cell's *mean* colour, and a mean cannot tell
the cell's **fill** from a **mark painted on it**. The two blend in proportion to
how much of the cell the mark covers — so two cells with the *same* fill but
different-sized marks read as *different* colours, and the signal you wanted (the
fill) is gone. gnome-mines made this concrete in a way I had the friction backwards
on first. Classic minesweeper tints the *digit* (1 blue, 2 green, 3 red) on a
neutral cell, and I expected to need a "read the glyph's hue" primitive — but the
installed GTK theme does the opposite: the digit is always dark, and the **cell
background** is tinted by the count (1 green, 2 tan, 0/empty near-white, covered
grey). So the value lives in the fill, and a dark digit sits on top of it whose ink
*grows with the count*. `sample_grid` mean: a "1" cell read `(170,193,154)`, a "2"
`(213,214,174)`, empty `(222,222,220)`, covered `(186,189,182)` — the fills smear
toward each other and toward grey, because the heavier "2" glyph drags its mean
further down than the lighter "1", i.e. the very glyph you are trying to see past
corrupts the very measurement that would let you. Neither existing reader fits: the
glyphs are too small and antialiased for reliable OCR at speed, and `classify_grid`
/`cluster_boxes` reduce to a *luma* signature that is deliberately colour-blind
(it would also have to template every digit), when the count is cleanly there in
one cheap number — the fill hue — if only the mark would stop polluting it.

**Solution.** A `stat` parameter on `sample_grid`: `"mean"` (default, unchanged)
or `"mode"`. `"mode"` buckets the cell's central window into a coarse colour
histogram (each channel quantised to `quant`-wide bins, default 24), takes the
most-populated bin, and returns the **exact mean of the pixels in that bin**. The
fill is the majority of the window and the mark a minority, so the fill bin always
wins; de-quantising back to the real pixel mean keeps the colour precise rather
than snapped to a bucket centre. `count` becomes the modal bin's dominance (how
solid the fill is). It is the same loss-cutting double loop, the same geometry,
inset, clamping and `{r,g,b,count}` shape as the mean path — only the per-cell
reduction changes — so it composes with `detect_grid` edges and `capture_patch`
exactly as before, and `stat="mean"` is byte-for-byte the old behaviour.

**Lesson (architecture).** `sample_color`/`sample_grid` had quietly assumed a cell
is *solid* — that its mean *is* its colour. A cell with a mark on it breaks that
assumption, and the fix is not a new reader but the **right reduction**: mean is the
estimator for a uniform region, mode is the estimator for "a dominant fill plus
clutter". The floor's colour reader now spans both, and the choice is one keyword.
This is the same move as `ocr_grid`'s `invert="auto"` (F255): a reader grows a
*statistic option* to stay correct on a board that violates its tacit assumption,
rather than the caller pre-cleaning the pixels or a near-duplicate primitive being
spawned (損之又損). Reading a fill under a mark is not a mines quirk — it is a
button's colour under its label, a card's colour under its number, a token's team
colour under its symbol, or just telling covered / empty / numbered apart by fill
at a size where the glyph itself is illegible.

**Proof.** *Live, gnome-mines 8x8*: `sample_grid(stat="mode", inset≈0.22)` returns
four crisply separated fills — covered `(180,180,180)`, empty `(228,228,228)`,
"1" `(228,252,204)` green, "2" `(228,228,180)` tan — where the mean of the same
cells smears them together. Measured on the live board, the within-class colour
spread of the "2" cells (which should all read identically) is **65** under mean
but **33** under mode: the mark-immunity halves the scatter of a class that ought
to be a single point, which is the difference between a fixed colour rule working
and not. *Synthetic* (`_test_f257.py`, no display/capture): fills painted under
centred marks of growing area — mode recovers each true fill within tolerance
regardless of ink and reads two same-fill/different-mark cells as the *same*
colour, while mean drifts the heavily-inked cell far from its fill and smears the
class apart (within-class spread collapses under mode, stays large under mean);
`count` tracks modal dominance; on a solid mark-free cell mode equals mean (it adds
nothing when there is nothing to be immune to); the default stays mean
(backward-compatible); args validated. All fifteen floor friction tests pass
(F257 plus the prior fourteen), no regressions.

### F258 — label_regions: the labels→objects layer (connected components)

**Friction.** Every reader the floor grew answers *what is in each cell* —
`sample_grid` a colour, `ocr_grid` text, `classify_grid`/`cluster_boxes` a type.
But a *thing* in a game is rarely one cell. swell-foop made this unavoidable: its
entire mechanic is "click a **connected group** of same-colour tiles", and the
move does not exist at the cell level — it is a property of the *group*. Reading
the 6x5 board with `sample_grid(stat="mode")` (F257 paid off immediately — each
tile is a coloured fill under a bevel/symbol mark, and the mode reads the fill
cleanly) gives a clean label grid, and then... there was nothing. To find the
groups I hand-wrote a flood fill over the grid — the exact flood fill a mines
player would write to find an opened pocket, a klotski player to find a piece
spanning cells, a tetris player to find a settled tetromino, a five-or-more player
to find a line. The readers stop one layer too early: they hand you labelled
cells and leave "which cells are the same object" to every caller.

**Solution.** `label_regions(grid, background=None, connectivity=4)` — the flood
fill made a primitive. It consumes *any* reader's `rows`x`cols` label grid and
returns its objects: a list of `{label, cells, size, bbox}`, regions ordered by
first row-major appearance (deterministic), each `cells` row-major sorted so
`cells[0]` is always a real in-region cell — a safe click target for any shape,
unlike a bbox centre which can fall in a concavity/hole. `background` (one label
or a set) is never grouped — swell-foop's cleared cells, mines' covered cells.
`connectivity` is 4 or 8 (a five-or-more diagonal line, a king's reach). The flood
uses an explicit stack, never recursion, so a board larger than Python's recursion
limit is fine. It depends on no pixels — it is pure grid topology — which is the
point: perception now splits cleanly into *read the cells* (a reader) then
*assemble cells into objects* (this), and the two compose without either knowing
the other.

**Lesson (architecture).** The floor had been growing *readers* (pixels → labels)
and *geometry* (where the cells are: `detect_grid`, `detect_cascade`,
`find_color_blobs`), but the rung between "I have a labelled grid" and "I have the
game's objects" was missing, so it was re-implemented per game as a private flood
fill. Naming that rung as one primitive is the same 損之又損 move as the readers:
the shared structure (group adjacent equal cells) is extracted once, and each game
keeps only its *own* logic (swell-foop: click the biggest group; five-or-more:
keep groups that are collinear runs ≥5; mines: a pocket's frontier). A reader says
*what*, `label_regions` says *which together* — and most board games' "legal move"
or "win" predicate is a function of the second, not the first.

**Proof.** *Live, gnome-mines theme aside — gnome-swell-foop 6x5*: read with
`sample_grid(stat="mode")`, snap each cell to {B,G,Y}, `label_regions(grid,
connectivity=4)` → **12 regions, 6 of them clickable (size ≥ 2)**, largest a
9-cell blue group `[(1,3),(2,3),(2,4),(2,5),(3,2),(3,3),(4,1),(4,2),(4,3)]`.
Clicking that group's `cells[0]` (mapped to its pixel centre) cleared it and the
board reflowed — **17 of 30 cells changed** in one move (9 removed + gravity drop),
i.e. the primitive selected and drove a real, legal swell-foop move end to end.
*Synthetic* (`_test_f258.py`, no display): a swell-foop-like grid plus targeted
shapes verify every cell lands in exactly one region and sizes sum to the cell
count; a same-label run does not leak across a different label between it; 4- vs
8-connectivity splits/joins a diagonal contact; `cells[0]` is in-region while a
ring's bbox centre is the hole; background labels (single or set) never form
regions; deterministic first-appearance order and re-run identity. All sixteen
floor friction tests pass (F258 plus the prior fifteen), no regressions.

### F259 — line_runs: the straight-line predicate label_regions can't answer

**Friction.** `label_regions` (F258) groups a reader's label grid into connected
*blobs*, and I reached for it on gnome-four-in-a-row — only to find a blob is the
wrong shape for the one question that game asks. Four-in-a-row's entire rule is a
**straight line**: four of your discs collinear, in any of four directions, wins.
Reading the live 7x6 board with `sample_grid(stat="mode")` (F257 again paid off —
each disc is a coloured fill under a bevel/star mark) gave a clean `{R,G,.}` grid,
and then `label_regions(connectivity=8)` was useless for the move: it lumps the
bottom-row horizontal three `R R R`, the diagonal red touching it, and the red
stack above into one eight-cell region and reports *no line at all* — neither that
there is a horizontal three (a threat) nor where it points. A line is a property
of a *direction*, not of bare adjacency, and connected-components is direction-blind
by construction. So to pick a move I started hand-writing the same four-axis scan
every line game needs — the very scan F258's own lesson had punted ("five-or-more:
keep groups that are collinear runs ≥5") back to the caller.

**Solution.** `line_runs(grid, background=None, min_len=2, directions=("h","v","d","a"))`
— that scan made a primitive. For each requested axis (`h` →, `v` ↓, `d` ↘, `a` ↙)
it walks the grid and returns every **maximal** run of equal, non-`background`
cells: a `{label, cells, length, direction, start, end}` with `cells` ordered along
the axis (`cells[0]==start`, `cells[-1]==end`). "Maximal" is enforced by starting a
run only at a cell whose predecessor along the axis is off-grid or a different
label, so each run is found exactly once and never as a sub-run of a longer one (a
five is one run of five, not two overlapping fours). `min_len` gates output — set it
to the win length to get *only* wins, the cheapest possible "did anyone win" query;
default 2 drops singletons. `background` (one label or a set) never forms a run and
is the only thing that bounds them. It reads no pixels — pure grid topology, the
twin of `label_regions`: that one says *which cells are one blob*, this one says
*which cells are one line*.

**Lesson (architecture).** The floor's perception had grown *readers* (pixels →
labels), *geometry* (where the cells are), and `label_regions` (cells → blobs), but
the second topological reducer — cells → **lines** — was missing, so every line game
re-derived it. Blob and line are the two shapes a "group of cells" can mean, and a
game's win/legal-move predicate is almost always a function of one or the other:
swell-foop/mines want the blob, four-in-a-row/gomoku/tic-tac-toe want the line.
Naming the line reducer next to the blob reducer is the same 損之又損 move as the
readers — extract the shared scan once, leave each game only its own threshold (4,
5, 3). A reader says *what*, `label_regions` says *which together*, `line_runs` says
*which in a row*.

**Proof.** *Live, gnome-four-in-a-row (One player, Easy)*: a driver
(`_game_fourinarow.py`) reads the board each turn with `sample_grid(stat="mode")`,
then uses `line_runs` as its whole brain — win if a drop makes a 4-run, else block
the opponent's, else play the column that most extends my longest run — with **no
bespoke line scan anywhere**. It played a full 20-move game against the AI and won;
`line_runs` flagged the winning move and then read the result off the final board as
a single **anti-diagonal** run `R@[(2,5),(3,4),(4,3),(5,2)]`, length 4 — the window
title turned "You win!". *Synthetic* (`_test_f259.py`, no display): the exact live
board fixture yields the bottom-row `R R R` as one length-3 horizontal run with
correct endpoints (and the row-4 three, and a G three), while the column-0 vertical
G three does not swallow the R's that bound it; a clean four in each of the four axes
surfaces as exactly one run in its own direction, ordered along the axis (the
anti-diagonal starts top-right); a five is one run not overlapping fours; `min_len`
selects threats (2) vs wins (4) vs singletons (1); `directions` selects axes;
`background` (single or set) bounds runs and is never itself a run; deterministic
order and re-run identity; args validated. All seventeen floor friction tests pass
(F259 plus the prior sixteen), no regressions.

### F260 — react_pixel: the reflex wait_pixel couldn't be, where the act is the score

**Friction.** I went looking for the floor's realtime ceiling and opened the Human
Benchmark **Reaction Time** test — a box sits red ("wait for green"), turns green at a
random instant, and the site scores the *milliseconds* from the green frame to your
click. Every turn-based game the floor has played so far measures nothing about *when*
you act; this game measures only that. So I played it the idiomatic way: `move` to the
box, `wait_pixel(center, GREEN, interval=0)` to watch the one pixel, then `click` the
instant it returns. The site read **34-38 ms**. Good — until I read where those
milliseconds went. Two leaks, both structural, neither about the screen:

1. **`wait_pixel` watches but cannot act.** It returns a *bool*, so the reflex is two
   verbs: the watch returns into my Python, my Python decides, my Python calls `click`.
   The detection edge and the action are separated by a whole round-trip back through
   the caller — exactly the seam a reflex must not have.
2. **`click` re-homes the pointer every time.** `click(x,y)` does `move(x,y)` then
   `time.sleep(0.02)` (let the cursor land) *then* presses. In a reaction game the
   cursor is already on the box — I put it there to start — so that move + **20 ms**
   settle is pure dead latency that the game scores against me. Measured: of the
   34-38 ms, ~20 ms was the settle alone. The floor had a patient *watch* (`wait_pixel`)
   and a careful *click*, but no **reflex** — no way to fire on the same edge the eye
   sees, in place, now.

**Solution.** `react_pixel(x, y, rgb, tol=24, timeout=5.0, interval=0.0, act="click")`
— the reactive twin of `wait_pixel`. It spin-reads the one pixel (a single-pixel grab
is the floor's cheapest read, ~0.03 ms, so `interval=0.0` polls at tens of kHz) until
within `tol` of `rgb`, then performs `act` **in the same breath**, with no return to
the caller in between: `"click"`/`"press"` press+release the left button *where the
cursor already sits* — no move, no settle; `"none"` just detects (a `wait_pixel` that
reports latency instead of a bool); a zero-argument *callable* fires once at the
detection instant (tap a key, click elsewhere, anything). It returns `{matched,
wait_ms, act_ms, polls, rgb}` — `wait_ms` is call→detect, `act_ms` is
detect→action-returned: the very gap the verb exists to crush, now reported so you can
see it is gone. Pre-position with `move(x,y)` and the press path costs nothing the game
can measure.

**Lesson (architecture).** The floor's waiting verbs were all *observers* — they watch
a state and hand a verdict back to the caller, who then acts. That seam is invisible
when the deadline is "before the human notices" but it *is* the score when the deadline
is the next monitor frame. The fix is not a faster `click`; it is collapsing
perceive→decide→act into one primitive so there is no seam to leak through, and
exposing the latency it removes (`act_ms`) so the saving is measurable rather than
asserted. `wait_pixel` is to `react_pixel` what a glance is to a reflex: the same watch,
but the hand moves on the same edge the eye sees. This is the first floor verb whose
*whole value is temporal* — the realtime dual of the spatial reducers (`label_regions`,
`line_runs`): those say *where*, this says *when*, and acts there.

**Proof.** *Live, Human Benchmark Reaction Time*: a driver (`_game_reaction.py`)
pre-positions the cursor and uses `react_pixel(center, GREEN, act="press")` as its whole
reflex; across rounds it spun ~95k-135k times over the random 2-3 s red, then fired with
`act_ms` of **0.2-1.9 ms** (versus `click`'s fixed 20 ms settle) and scored as low as
**18 ms** on the site — against the human median of 273 ms shown on the same screen
(the residual 18 ms is browser render + monitor latency, no longer the floor). The same
driver plays one round the old `wait_pixel`+`click` way for contrast. *Synthetic*
(`_test_f260.py`, no display — the screen and mouse are stubbed): the button fires
exactly once, on the poll that first matches and never on any earlier one; `act="none"`
detects mouse-free; a callable fires once at the detection instant; `timeout` returns
`matched=False` having fired nothing; per-channel `tol` gates a near-miss so an
anti-aliased edge won't false-fire; and `{wait_ms, act_ms, polls, rgb}` report the
budget. All eighteen floor friction tests pass (F260 plus the prior seventeen), no
regressions.

### F261 — move_rel: the motion move() couldn't make, where the cursor isn't a place

**Friction.** Pushing past single-player reaction trainers into a *complex* realtime
GUI, I installed an open-source FPS (AssaultCube, software-GL, ~110 fps on the VM) — not
to win, but to find what driving a 3D camera demands of the floor that flat desktops
never did. The first wall was immediate and total: I could not turn the view. Every
pointer verb the floor owns — `move`, `drag`, `glide`, every click — names an *absolute*
screen pixel, which is exactly right for a desktop where the cursor and the coordinate
are the same thing. But an FPS *grabs* the pointer and steers the camera from its
**motion**, warping the OS cursor back to centre every frame and integrating the deltas.
So `move(x,y)` — a warp to a fixed pixel — has nothing to say to it: I swept the cursor
across the screen and the camera sat frozen. Worse, it also broke the game's *own* menus:
the in-game menu pointer is decoupled from the OS cursor, so an absolute click landed
nowhere. The floor had a rich vocabulary of *destinations* and not one word for a
*delta*. (Where a relative-mode SDL backend happens to read warp-deltas the camera does
drift, but it is an uncontrolled, irreversible nudge — you command a pixel, never a turn
— and on raw-input games, Windows SendInput-absolute, or a Pointer-Lock browser canvas
the absolute warp does precisely nothing.)

**Solution.** `move_rel(dx, dy, steps=1, delay=0.0)` — relative pointer motion, the
write-side dual of `move` that speaks deltas instead of destinations. It emits relative
motion through the backend (XTEST `FakeRelativeMotionEvent` on X11, `SendInput` without
`ABSOLUTE` on Windows — both newly wired leaf primitives). `steps` splits a large delta
into that many equal relative events `delay` apart, because a big sweep sent as one giant
jump can be clamped or dropped by a game that integrates per frame; the remainder is
spread so the steps sum *exactly* to `(dx, dy)` with no rounding drift, and motion stays
monotonic toward the target. `steps=1` is a single immediate event. It returns the
integer `(dx, dy)` actually emitted, and raises rather than silently no-op'ing on a
backend too old to have the leaf — a silent no-op would look exactly like a frozen camera.

**Lesson (architecture).** The floor had quietly assumed that *the cursor is a place*:
to act on a point you put the cursor there, and where it is *is* what you mean. A whole
class of surfaces denies that — they take the pointer captive and care only how it
*moves*. Absolute and relative motion are not two settings of one verb; they are two
different relationships to the screen, and the floor only had one. `move_rel` is the
other: the same hand, but a turn of the head instead of a step of the foot. It is the
foundation under anything pointer-captured — FPS/3D camera look, orbit-drag in an editor,
a Pointer-Lock canvas — and it pairs with F260's reflex (`react_pixel` decides *when*,
`move_rel` decides *how much to turn*) toward driving a moving target rather than a still
one.

**Proof.** *Live, AssaultCube*: a driver (`_game_fps.py`) reaches gameplay by probing
with a `move_rel` sweep (the camera turns only when live, so the sweep itself detects a
menu and clears it), then sweeps the view right by a yaw delta of 600 and sweeps the same
delta back. The viewport changed by mean-pixel-diff **23.1** at full right yaw and
returned home after the reverse sweep with a residual of **0.000** — proportional,
pixel-perfect *reversible* mouse-look, the controlled turn the absolute pointer family
could never express (the compass rotates and settles back; before/after frames captured).
*Synthetic* (`_test_f261.py`, no display — the backend's relative leaf is stubbed): one
event carries the exact asked delta, floats round to integer pixels, a large sweep splits
into `<= steps` events that sum *exactly* to the target with monotonic drift-free
progress, zero-noise sub-events are skipped, a leaf-less backend raises instead of
silently freezing, and arguments are validated. All nineteen floor friction tests pass
(F261 plus the prior eighteen), no regressions.

### F262 — servo: the loop move_rel couldn't close, where one shot can't aim

**Friction.** With `move_rel` (F261) the AssaultCube camera finally *turned*, so I tried the
obvious next thing: point at something. Lock `match_template` onto a feature, compute how
far it is from the crosshair, turn that far, done — the way `move(x,y)` clicks a button in
one shot. It does not work, and it cannot. `move(x,y)` lands on pixel `(x,y)` because the
unit *is* the pixel; `move_rel` speaks mouse **counts**, and how many pixels a feature then
slides depends on the field of view and the surface's own sensitivity — a number the floor
does not know and cannot assume. I measured it live: near the crosshair AssaultCube slid the
world ~1.3 px per count, but a count large enough to "snap" the feature to centre overshot
and carried it clean out of the search window (the match score jumped from ~2200 to ~8800 —
tracking lost). So the scale is both *unknown a priori* and *only locally linear*. There is
no single delta to compute. Every realtime aim task hit this same wall: F260 (`react_pixel`)
says *when* to act, F261 (`move_rel`) says *turn*, but nothing closed the loop between
*seeing where a thing is* and *steering it where it belongs* — and without that loop the
relative actuator is a hand that can move but not reach.

**Solution.** `servo(locate, target, actuate=move_rel, *, gain=None, probe=30, tol=4,
max_iter=16, damping=0.6, max_step=400, settle=0.03)` — the perceive→act loop itself, and
nothing smaller. `locate()` returns the feature's current `(x,y)` (a `find_color` centroid,
a `match_template` match) or `None` if lost; `target` is where it should end up; `actuate`
emits a relative motion (defaults to `move_rel`). With `gain` unknown it first **calibrates**
— one small `probe` nudge per axis, measuring the resulting pixel displacement to learn
*signed* units-per-pixel, the sign too, so it is never told that turning the view right
slides the world left. Then it steers proportionally, `step = error * gain * damping`,
clamped to `max_step` so a rough estimate cannot fling the feature out of sight, re-locating
after each move until the feature is within `tol` of `target` or `max_iter` runs out.
`damping < 1` makes the loop converge geometrically instead of ringing. It returns
`{hit, iters, err, gain, pos, start, reason}`; the learned `gain` is the reusable part —
feed it back to skip re-probing, or call `servo` repeatedly to *track* a mover, each call a
fresh closed-loop correction.

**Lesson (architecture).** The floor's actuators were all *open-loop and self-calibrated*:
`move` knew its own units (pixels), so acting was a single feed-forward write. A relative
actuator severs that — it acts in units whose mapping to the world is unknown and
non-constant — and the only honest response is to *measure by acting and watching*, then
correct, repeatedly. That is the difference between a hand that moves and a hand that
reaches. `servo` is the floor's first **closed-loop** primitive: it makes perception and
action a single feedback verb rather than two open-loop ones the caller must stitch, and it
sits over *any* locator and *any* relative actuator (FPS aim, 3D orbit framing, a
Pointer-Lock canvas, a slider whose pixels-per-unit you don't know) — the general shape of
controlling a world you can see but whose controls you must learn.

**Proof.** *Live, AssaultCube* (`_game_servo.py`): `match_template` locks onto a wall
feature placed **174.9 px** off the crosshair; `servo` measures the unknown scale
(gain ≈ `(-0.78, -0.74)` counts/px — negative, learned, never told) and drives the feature
onto the crosshair to within **5.7 px in 4 steps**, `hit=True` (before/after frames captured;
the compass rotates and the recessed patch ends under the crosshair). *Synthetic*
(`_test_f262.py`, no display — a fake world slides a feature opposite each actuation at an
unknown, anisotropic, optionally nonlinear scale): convergence from off-target, learned gain
sign and magnitude, anisotropic axes, pre-supplied gain skipping calibration, lost-at-start
and lost-mid-flight handling, a zero-displacement probe raising rather than spinning,
already-on-target as a zero-move hit, `max_step` clamping every emitted step, convergence
under a locally-nonlinear scale, bounded error while *tracking* a drifting target across
repeated calls, and argument validation. All twenty floor friction tests pass (F262 plus the
prior nineteen), no regressions.

### F263 — match_unique: the lock match_template couldn't be sure of, where a tie is a trap

**Friction (and an honest correction).** Chasing F262's servo onto a *moving* bot,
I expected the next wall to be prediction — leading a target the loop only knows the
past of. Practice said otherwise, and then practice corrected *me*. Re-locating a
patch frame-to-frame in OpenArena, I first ran a quick, *coarse* (4×-subsampled,
`step=6`) SAD probe and it reported the global best landing on a *different* wall
instance than the one I cut from — a textbook false-lock, with a runner-up scoring
within ~1 % of the winner. It was a tidy story. It was also wrong: when I measured
again with the *real* `match_template` at fine step, every one of 18 sampled
surfaces — many wall angles and the tiled floor — located back at its true spot
(max error 8 px). OpenArena's software-GL surfaces are simply not periodic enough
to tie the arg-min. The "false-lock" was an artifact of my lossy probe, not the
primitive. The lesson landed twice: *a coarse measurement manufactures the very
ambiguity it claims to find*, and the honest gap is not "the matcher is wrong" but
"the matcher cannot tell you **how sure** it is."

Because the trap is real wherever a surface *is* periodic — a brick wall, a list of
identical rows, a grid of like icons, a board of identical tiles — and there
`match_template` returns *a* point with the same confidence it returns the *only*
point. A tracker built on it cannot distinguish "the unique match" from "one of
five copies the noise happened to pick," and silently jumps copies.

**Solution.** `match_unique(patch, pw, ph, ..., min_margin=0.18, require_unique=True)`
— it judges *trustworthiness* before returning a point. It scans for every instance
(`match_template_all`, one pass, NMS so each copy yields one hit), takes the best and
its strongest **rival** at least a patch-size away, and scores distinctiveness as
`margin = (rival.score - best.score) / rival.score ∈ [0, 1)` — ~0 means a near-tie
(ambiguous), 1.0 means the patch occurs once. With `require_unique` (default) an
ambiguous match returns `None` — turning a silent false-lock into an honest "I can't
uniquely place this," a safe drop-in for `match_template` inside a tracking loop.
With `require_unique=False` it returns `{x, y, score, bbox, margin, unique, rival}`
so a caller can read the confidence and decide.

**Lesson (architecture).** Every locator the floor had — `find_color`, `match_template`,
`detect_grid` — answered *where* with total confidence and no notion of *how sure*.
That is fine on a unique feature and a trap on a repeated one, and GUIs are full of
repeated ones. `match_unique` is the floor's first **ambiguity gate**: a locator that
can say "not uniquely," converting a silent wrong-lock into an honest refusal. It is
the perceptual analogue of `servo`'s honesty (which measures rather than assumes its
gain) — here perception measures rather than assumes its own certainty. It sits under
any tracker on any repetitive surface, FPS or filing cabinet.

**Proof.** *Live, OpenArena* (`_game_f263.py`): across 18 sampled surfaces the real
matcher never false-locked (max locate-error 8 px), while `match_unique` reported a
graded distinctiveness margin from **1.00** (a patch that occurs once) down to
**0.15** on a busy floor region — two frames it flagged *ambiguous* (`unique=False`),
i.e. one near-tie away from the wrong region, a warning `match_template` cannot emit.
Then, to show the failure where it genuinely bites, one live patch is tiled ×5 into a
periodic strip (a brick wall / list / icon grid built from real game pixels):
`match_template` confidently returns one of the five identical copies (chosen by
noise), and `match_unique` *refuses* it (`margin=0.000`, `None`). *Synthetic*
(`_test_f263.py`, no display — ambiguous and distinctive motifs on a fabricated
canvas): the default refuses an ambiguous motif and trusts a distinctive one with
correct coordinates and a large margin; `require_unique=False` exposes the margin and
rival; the `min_margin` knob accepts a tie at `0.0` and still trusts a truly-alone
match at a high threshold; a locality `search` window around one copy makes it unique
again; a search smaller than the patch finds nothing; a coarse `step` still locates;
and `min_margin` outside `[0, 1)` raises. All twenty-one floor friction tests pass
(F263 plus the prior twenty), no regressions.

---

## F264 — `lead`: aim where the target is going, not where it has been

**Friction (the one I predicted at F262, finally reached by practice).** `servo`
relocates every step, then actuates toward where it *just* found the feature. For
a still target that is exact; for a moving one it is forever one frame behind —
it converges on the trail, never the target. I had named this at F262 ("目标在动 →
需要预测/提前量") and detoured through F263; F264 is where I actually measured it.

**A negative first (反者道之动).** My first guess for the moving-target wall was
*egomotion*: when the camera turns, frame-differencing (`locate_change_blobs`)
should drown in self-motion. It does — a still frame diffs at 4.5 % of pixels
(the software-GL noise floor), but a small camera turn jumps to 18–25 % and
`locate_change_blobs` shatters into **98 phantom regions**. So I reached for an
`estimate_shift` primitive (median block displacement → compensate the global
slide). Practice refused it: panning the view, a grid of tracked blocks scattered
−34..+20 px in x and −36..+42 px in y, and compensating by the median shift barely
moved the diff (0.168 → 0.112). FPS yaw is **not** a global translation — it is a
rotational/perspective flow field (near walls slide fast, the far end barely), so
a single-shift model is the wrong model, and the floor's `wait_until_stable`
already covers the honest workaround (diff only when the view is at rest). I threw
the shift primitive away rather than ship a clever thing that doesn't hold —
前識者，道之華也. The egomotion probe's real yield was negative knowledge, and the
narrower, truer friction underneath it: the lag itself.

**Solution.** `lead(samples, horizon=0.0, min_samples=2)` — it turns a short
history of `(t, x, y)` locations (each typically a `match_unique` /
`locate_change_blobs` hit) into an image-plane **velocity** and a predicted lead
point. Velocity is the least-squares slope of `x(t)` and `y(t)` (optimal for the
zero-mean matcher jitter, and it down-weights a single bad locate instead of
trusting the last pair); observations whose `x`/`y` is `None` — a frame the locate
refused or lost — are skipped, so it pairs directly with `match_unique`'s honest
`None` with no gap-stitching by the caller. It returns
`{vx, vy, speed, x, y, t, n, px, py, horizon}`, where `(px, py) = (x + vx·horizon,
y + vy·horizon)` is the point to feed `servo`/`move_rel` so the actuator targets
the **interception**, not the trail. The model is constant-velocity by design —
honest only over the short horizon a relocating loop predicts into, which is the
only horizon it needs.

**Lesson (architecture).** Every perception verb the floor had answered a question
about *now*: where a feature is (`match_unique`), what changed (`locate_change`),
whether motion has stopped (`wait_until_stable`). None held a belief *across* time.
`lead` is the floor's first **temporal estimator** — the smallest such belief, a
constant velocity — and the natural completion of the closed loop: `react_pixel`
says *when*, `move_rel` says *how much*, `servo` measures its own *gain*,
`match_unique` measures its own *certainty*, and `lead` measures the target's own
*motion* so the loop can aim ahead of it. It sits under any "click/track the moving
thing" task — a dragged window, a scrolling row, a cursor, a bot — none of which a
now-only locator can lead.

**Proof.** *Live, OpenArena* (`_game_f264.py`): panning a wall feature at a steady
rate, `match_unique` tracks it frame to frame while `lead` fits a velocity of
~45 px/s; one-step-ahead prediction errs **24.0 px** under the "assume it stays"
model (servo's implicit one) versus **10.5 px** with `last + v·dt` — and the fit
absorbs a single mis-located frame (one sample jumped 38 px and back) without
chasing it. *Synthetic* (`_test_f264.py`, no display): exact velocity and
prediction recovery on a clean constant-velocity track; lead beats "assume-stays"
on a jittered track in the motion-dominates-noise regime practice measured; `None`
rows are skipped and only valid points counted; refusal on too few points, on a
single time instant (no time base), and below `min_samples`; `horizon=0` predicts
the last point exactly; two-sample and negative/2-D velocities correct. 18
assertions; all twenty-two floor friction tests pass (F264 plus the prior
twenty-one), no regressions.

## F265 — `consensus_shift`: one shift from a cloud of disagreeing votes

**反者道之动 (reverse the motion) — a new game to test the old hypothesis.** F264
rejected a global `estimate_shift` because FPS yaw is a *rotational* flow field
(near walls slide fast, the far end barely) — no single translation fits it. But
that rejection was about FPS geometry, not about the idea of a global shift. The
honest move was not to bury the idea but to take it to a world where the camera
motion genuinely *is* a single translation: a side-scroller. So F265 left the FPS
and ran Tux right through a SuperTux ice level, where the camera-follow slides the
whole world — one depth, one plane — under the view. There a per-block flow
*should* read one uniform shift, and the hypothesis F264 couldn't honour in FPS
gets its fair test.

**The hypothesis half-held — and broke on measurement, not geometry.** Panning
SuperTux, the world shift between two frames truly is one translation (measured:
a clean −19 px/frame slide, all in x, none in y — exactly the side-scroller
prediction). But recovering it from a block-flow is *not* clean. The repeating ice
texture is the F263 trap in the flow domain: every block has near-identical
periodic neighbours, so each `match_unique` vote lands a tile-fraction off the
true shift, and a handful of blocks gross-mislock to the wrong tile entirely. The
result is a **bag of disagreeing votes**, not a value. Standing perfectly still,
an *ungated* `match_template` block-flow fabricated a confident −32 px shift at
2 % internal agreement — the aliasing inventing motion where there is none. Even
gated, a real −19 px pan produced per-block votes whose plain median read −16 px
but with only **33 % of blocks within a pixel of it**; another frame's median read
−22 px at **15 %** agreement. The median always returns *a number*; it cannot say
that the number is meaningless.

**Friction (what no floor verb did).** Nothing turned a cloud of displacement
votes into one shift *with a stated confidence*, and nothing **refused** when the
votes had no agreement at all (a scene cut, a death frame, motion past the search
window scatters votes across the whole range with no dominant value). `match_unique`
(F263) gates a *single* feature's match by best-vs-rival margin; this is its
spatial-aggregate twin — gate the *fusion of many* features by how many agree.

**Solution.** `consensus_shift(votes, tol=8.0, min_support=0.5, min_votes=4)` —
the spatial dual of `lead` (F264 fits one feature's velocity over *time*; this
fuses *many* features at one instant into one shift). It finds the `(dx, dy)` with
the most votes within `tol` (Chebyshev) of it — a coarse 2-D translation mode /
Hough vote — and refines to the mean of those inliers. It returns `None` when
fewer than `min_votes` survive or the best shift's **support** (inlier fraction)
is below `min_support`: report a shift only when one shift commands a majority,
the flow-domain analog of `match_unique`'s margin gate. Votes with a `None`
component (a block the matcher refused) are dropped, so it pairs with
`match_unique`'s honest misses without the caller stitching gaps. It returns
`{dx, dy, support, inliers, n, tol}` — the shift *and* the confidence the median
could not state.

**Lesson (architecture).** The floor's certainty verbs now come in two scales.
`match_unique` asks "is *this one* match trustworthy?" (margin over the rival).
`consensus_shift` asks "do *these many* measurements agree on one answer?"
(support over the bag). Both refuse rather than fabricate — the recurring shape of
this whole arc: a verb that knows when it does not know. And the F264 reversal is
completed honestly: the global-shift idea was right, just mis-homed; it belongs to
translational cameras (side-scrollers, map pans, scroll views, drag-to-pan
canvases), not rotational ones, and even there it needs a dominance gate to
survive periodic texture.

**Proof.** *Live, SuperTux* (`_game_f265.py`): standing still, the ungated
block-flow fabricates a −32 px shift at 2 % agreement while `consensus_shift`
returns `None` (no majority) and the gated flow returns ~0 px at 95 % support;
running right under real camera-follow, across five frames the naive median reads
−16/−22/−24/−20/−24 px at only 15–33 % agreement every time, while
`consensus_shift` recovers −19.3 px at **100 %** support (0 outliers), −35.8 px at
62 % (rejecting 10 mislock votes), −33.9 px at 70 %, −26.6 px at 90 %, and on the
fifth — a genuine scatter frame — honestly returns `None`. *Synthetic*
(`_test_f265.py`, no display): exact recovery and full support on unanimous votes;
recovery of a clustered shift while a plain mean is dragged toward gross outliers;
the real SuperTux dt≈110 ms vote histogram resolved to the ~−26 px pan at majority
support; ~zero with high support standing still; refusal on scattered votes with
no dominance, on too few votes, and on all-`None` votes; `None` components dropped;
input/argument hygiene. 21 assertions; all twenty-three floor friction tests pass
(F265 plus the prior twenty-two), no regressions.

## F266 — `distinctive` (refuted): self-similarity is the wrong frame to ask about trackability

**反者道之动 — chase the residual, and find the hypothesis was the flower of the
Way.** F265 left a loose thread: `consensus_shift` recovers the camera pan by
out-voting periodic mislocks, but *which* blocks mislock? The tidy story was that
a patch cut from the repeating ice field is intrinsically untrackable — it has
identical twins one tile over, so any matcher hands it to the wrong twin — and
that this could be judged from **one frame**, before a second frame even exists,
by how alone the patch is in its own neighbourhood. I built that judge:
`distinctive(rgb, size, box, radius, min_rival)` slides the patch over its own
surroundings with `match_template_all` and reports `rival_per_px`, the SAD/px to
the nearest non-self twin; a low rival means a periodic, un-seedable patch. A
hand-picked probe (`_probe_f266b`) looked like a clean win: on chosen patches the
rival distance separated a busy-but-periodic ice tile (twin at ~0 SAD/px) from a
faint snow-cap edge (no twin within radius, ~18 SAD/px), and — the seductive part
— luma *variance* did not (a var≈3050 tile was hopelessly periodic, a var≈139 edge
was unique). It even passed a synthetic suite. The华 (flower) was beautiful.

**Then the live grid refuted it — three times, decisively.** Taken off
hand-picked patches and run across a real grid of SuperTux seeds during a pan,
the rival score has **no monotonic relationship** to whether a seed actually
tracks. `_probe_f266c` (156 seeds, 4 pairs) sorted seeds by rival and bucketed
correctness (a seed is "correct" iff `match_unique` finds it AND its displacement
equals the known pan): the two lowest quartiles were **both** `rival=0.0`, yet one
tracked **0 %** and the other **100 %** — identical self-similarity, opposite
outcomes — and the **most distinctive** quartile (rival 2.6–43) tracked the
**worst** (62 %). As a downstream block-flow pre-gate the score was no better:
across two runs it flipped from "ambiguous mislock 1.3× more" to "distinctive
mislock *more*", i.e. noise. The single-frame self-similarity score simply does
not predict live trackability.

**Why — the F263 lesson, reincarnated.** What dooms a track is not whether a twin
exists *somewhere in the same frame's neighbourhood*; it is whether the patch's
true match is ambiguous *across frames, inside the bounded search window* the
tracker actually looks in. A patch with an identical twin 32 px away in frame A
tracks perfectly when the A→B search is bounded to ±16 px around the predicted
spot and the true match dominates *there*. That cross-frame, search-local
dominance is exactly what `match_unique` (F263) already measures. `distinctive`
asks about ambiguity in the wrong frame and the wrong scope — the same mistake as
F263's coarse probe that "manufactured the ambiguity it claimed to find", wearing
a single-frame disguise. The clean separation on hand-picked patches was a
selection artifact, not a law.

**And the real failure mode is not per-seed at all.** `_probe_f266c`'s failures
clustered in pair-sized blocks; `_probe_f266d` caught only clean pairs and tracked
**100 %** in every quartile of both x-gradient energy and Shi-Tomasi cornerness
(so the aperture-problem hypothesis is, here, untestable for lack of failures);
`_probe_f266e` (8 pairs) showed every clean translational pair tracks 97–100 % at
87–90 % consensus support, regardless of seed structure. In a clean pan,
`match_unique` + `consensus_shift` already track essentially every
variance-passing seed — **no per-seed quality gate earns its keep.** Failures,
when they come, are global/pair-level (a non-rigid frame, a snap, a death frame),
which `consensus_shift`'s support fraction already flags. There was no gap for a
new primitive to fill.

**Outcome — ship nothing; this is the deliverable.** Per 前識者，道之華也，而愚之
首也 — foreknowledge is the flower of the Way and the beginning of folly — the
clever single-frame gate is discarded rather than dressed up and shipped. `osctl.py`
is unchanged; the floor gains no `distinctive`. What it gains is a sharpened, tested
law: **trackability lives in the cross-frame match's bounded-window dominance
(`match_unique`), not in a patch's single-frame self-similarity, and not, in clean
pans, in any per-seed structure measure at all.** The proof scripts remain as the
record (`_probe_f266c/d/e`, `_game_f266.py`); the synthetic-only test and the
primitive were removed because a primitive whose live proof fails must not ship —
that is the floor's standing rule (synthetic *and* live), honoured here by saying
no. The next honest direction is pair-level: when a frame pair is *not* a clean
rigid translation, name it (deformation / cut / occlusion), rather than gating the
seeds within a pair that already tracks fine. All twenty-three floor friction tests
(F243–F265) pass unchanged; no regressions.


---

## F267 · consensus_affine — the camera-rotation flow consensus_shift could only refuse

`consensus_shift` (F265) fits one global translation and, in its own docstring,
names FPS yaw as the case it refuses: a yaw is not a single shift. F264 had
already rejected a global-shift model for yaw and called the flow
"rotational / range-dependent". The open question for a multi-motion primitive
was the **shape** of that flow: does it cluster into a few discrete coherent
modes (a layer/segmentation primitive could recover those), or is it a smooth
continuum (for which discrete modes are the wrong model)?

**Practice answered it, and it overturned my own first guess.** I yawed the live
OpenArena view by a fixed delta, laid a seed grid over the central viewport,
measured each seed's displacement with `match_unique`, and bucketed `dx` by
screen-Y. The probe's own comment predicted *uniform* `dx` ("a pure yaw is
camera rotation, whose optical flow is depth-INDEPENDENT"). The data said
otherwise — a clean, repeatable ramp down the frame, identical across three
trials:

```
screen-y [  0..107]: median dx -72   IQR[-75,-66]
screen-y [107..214]: median dx -60   IQR[-63,-57]
screen-y [214..321]: median dx -48   IQR[-51,-42]
screen-y [321..428]: median dx -36   IQR[-39,-30]
```

Two further probes killed the obvious confounders. `_probe_f267b` swept the yaw
magnitude (10..320 counts) and found the per-count gain flat at ~0.95–1.05
px/count over the usable range — **no acceleration**, so the ramp is not a
gain nonlinearity. `_probe_f267c` held total yaw fixed and varied the step count
(1..16); all produced the same ~42 px — **no per-step dead zone**. The ramp is a
property of the *scene's projection under rotation*, not of the actuator.

**So both rival models are wrong.** It is not one shift (`consensus_shift`
returns `None`, correctly — no single value owns a majority). It is not discrete
layers either: the `dx` histogram is a gap-free plateau from −36 to −72 with no
clusters, and the per-band medians form a smooth line, not 2–3 modes. An FPS yaw
is a **smooth affine flow gradient** — exactly what a camera rotation /
perspective pan produces, image velocity affine in image position.

**The honest generalisation is therefore a model, not a clusterer.** Where
`consensus_shift` fits `dx = const` (a translation) and refuses anything else,
`consensus_affine` fits `dx ≈ c0 + c1·x + c2·y` (and `dy` likewise) — a global
affine field that *represents* the ramp `consensus_shift` can only reject, and
**degrades back to a pure translation when its linear terms vanish** (a
side-scroller pan, the F265 regime). Centring the seed positions collapses the
normal equations to a 2×2 solve per component (the constant term is just the mean
displacement); the fit is made robust by iteratively trimming seeds whose
residual exceeds `median + k·MAD` and refitting, so a few gross mislocks — or a
single independently-moving object in the frame — do not bend the global field.
It refuses (`None`) on too few votes and on degenerate geometry (collinear seeds,
where a gradient is unidentifiable — an honest refusal, not a wild
extrapolation). Its quality signal is the inlier `rms`, which the caller reads.

**Proof.** Synthetic `_test_f267.py` (22 assertions): recovers a pure gradient's
centre-shift and per-pixel slope; degrades to a translation on a uniform pan and
matches `consensus_shift` there; reproduces the measured OpenArena ramp as a
gradient on the very vote-bag where `consensus_shift` returns `None`; rejects a
compact independently-moving cluster without bending the field; refuses on too
few votes and single-column geometry; drops `None` components; leaves a large
`rms` on no-model votes. Live `_game_f267.py` on the running ioquake3 window:
across three yaw round-trips, the two clean frames recovered a gradient of
+0.13 / +0.11 px/px at rms 1.7 px and ~73 % support while `consensus_shift`
refused; the third frame was noisy and `consensus_affine`'s rms rose to ~20 px —
the quality gate doing its job (honest "this fit is poor"), not a silent wrong
answer. The measured slope matches the probe's ~0.11 px/px. All twenty-four floor
friction tests (F243–F267) pass; no regressions.

The closed-loop chain now reads: `react_pixel` (when) · `move_rel` (how much) ·
`servo` (gain) · `match_unique` (is the lock trustworthy) · `lead` (where it is
going) · `consensus_shift` (one shift, or honestly none) · `consensus_affine`
(the rotational/perspective field a single shift can only refuse). 反者道之動：
the model belongs to the geometry it was built for.


## F268 — flow_residual: what moves independently of the camera

Anchor (user, this session): the floor must *wholly replace* the official
computer-use tool — superior robustness, adaptability, efficiency. That re-aims
friction-discovery: each step targets a capability the official tool would cover
that the floor cannot yet do robustly. The official tool spots a moving enemy by
looking; the floor needs to spot it by geometry, and to do so *while the camera
itself is moving* — the case where naive looking fails.

反者道之動: F267's `consensus_affine` fits the camera's egomotion as a global
affine flow and *discards* the seeds that disagree with it as outliers. Those
discarded seeds are not noise — under a moving camera they are the signal: a
strafing bot, the lift, a thrown grenade. The model built to model the world
throws away exactly what moves in the world. That discard is the next primitive.

The gap pinned in practice (live OpenArena): while the camera pans, raw
frame-diff (`locate_change_blobs`) read **27% of the viewport as "changed", 219
separate blobs** — a flood; it cannot point at a mover because the whole world is
sweeping. Subtracting a single `consensus_shift` translation is wrong for a yaw
(F267). Nothing in the floor turned "motion *relative to the modelled flow
field*" into "here is an object moving on its own, at this position, this fast."

`flow_residual(votes, field=None, min_resid, cluster_radius, min_cluster)`:
subtract the affine field's prediction from each `(x,y,dx,dy)` seed; keep the
seeds whose residual ≥ `min_resid`; single-link cluster the survivors (the
`cluster_boxes` idiom) into objects `{x,y,rdx,rdy,speed,n,bbox}` — centroid is a
clickable/aim point, `(rdx,rdy)` the motion *after the camera's is removed*. When
`field` is None it fits `consensus_affine` itself. Returns an honest empty
objects list for a pure pan over a static map — the answer frame-diff cannot give.

Proof. Synthetic `_test_f268.py` (16 assertions): no object for pure egomotion;
one object isolated at its true position and true residual velocity against a
strong yaw field where frame-diff would flag the whole frame; an object under a
still camera (field≈0, residual = raw motion); two movers → two clusters;
`min_resid`/`min_cluster` gates; precomputed field; None-dropping; refusal below
`min_votes`. Live `_game_f268.py` on a real ioquake3 bot skirmish, two regimes:

  • STILL camera — the clean win. Field ≈ 0 (grad 0.000). `flow_residual`
    isolated ONE compact mover (a bot) at (393,190), rel-vel (+4,−12), 13 px, and
    reported a truthful EMPTY on quiet frames. No false positives.

  • PANNING camera — field = the F267 yaw ramp (grad +0.122). Frame-diff flooded
    (219 blobs, 27% changed); `flow_residual` narrowed to ~53/462 residual seeds.
    Honest read: the panning clusters were **byte-identical across all three
    trials** — a real bot would vary frame-to-frame, so they are NOT bots but the
    structural residual a *first-order* field leaves: (a) the first-person
    weapon/HUD band, which is camera-locked and so genuinely does not move with
    the world (correctly flagged as independent), and (b) perspective curvature
    at the frame edges that a linear affine field under-fits (largest where the
    flow is largest).

前識者，道之華也: the primitive is correct — it faithfully reports motion relative
to the modelled world, which frame-diff cannot. The still regime certifies it.
The panning regime honestly surfaces the next friction: the *trustworthiness of a
residual depends on the field model's order*. A first-order affine field
under-models perspective yaw curvature, so residual at high-flow regions is part
model error, not all independent motion. The next step is residual confidence as
a function of local field magnitude/curvature (or a higher-order field, or
masking camera-locked overlays) — not a louder claim, a humbler gate.

All twenty-five floor friction tests (F243–F268) pass; no regressions.

The closed-loop chain now reads: `react_pixel` (when) · `move_rel` (how much) ·
`servo` (gain) · `match_unique` (is the lock trustworthy) · `lead` (where it is
going) · `consensus_shift` (one shift, or honestly none) · `consensus_affine`
(the rotational/perspective field) · `flow_residual` (what moves *against* that
field — the world model's leftover is the foreground). 道法自然.


## F269 — an honest double-negative, and a correction to F268

反者道之動 sent me to the friction F268 named for itself: under a pan,
`flow_residual` reported objects that were byte-identical across trials (not
bots). F268's entry attributed them to "perspective curvature at the frame
edges that a first-order affine field under-fits", and proposed F269 = a
residual gate normalised by local flow magnitude (curvature error should scale
with flow). I went to measure it before building it (the whole session's
lesson). The measurement refused both the theory and my own F268 words.

`_probe_f269.py` (live OpenArena pan, 3 trials): bin every seed's residual by the
local field flow magnitude |field(x,y)|. If curvature were the cause, median
residual would rise with flow. It did not — median residual is **flat at ~1.5 px
across all four flow quartiles** (flow 2→46 px), and the field's rms is ~1.5 px
everywhere. **The affine field fits uniformly well.** So the F268 attribution was
wrong: the panning false-positives are NOT field curvature, and a flow-normalised
gate has nothing to normalise. 前識者，道之華也 — including when the 前識 is one's
own prior entry; the honest record corrects it rather than hiding it.

`_probe_f269b.py`: the one principled gate left — drop residual seeds whose
*predicted correspondence leaves the captured frame* (boundary mismatch). It
changed nothing (gated objects == raw objects, all 3 trials): the ~20–44 px flow
never carries a match out of frame, so boundary loss is not the source either.
Refuted.

What the data actually shows: the false-positives are **scene-specific and
deterministic** — a small left-edge cluster @(81,330) reproduced identically in
all three trials, plus the camera-locked weapon/HUD band. They repeat because the
pan is identical and the map is static, so the same features mismatch the same
way every time. There is no clean single-frame geometric signal (flow magnitude,
frame boundary) that separates them from a real mover — both produce a residual
cluster. The genuine discriminator the data points to is **temporal**: a real
mover moves *coherently across consecutive frames*, while a deterministic artifact
repeats under identical camera motion and flickers under live play. That is a
multi-frame validation, kin to `lead` (F264, the floor's time-domain estimator),
not a single-pair gate.

Decision (無為): ship no primitive. `flow_residual` (F268) stands — it correctly
reports motion relative to the modelled world; its single-pair output simply
should not be over-trusted under a pan, and the honest next step is temporal
persistence, to be *probed* (F270) before any claim. The deliverable here is the
correction and the archived refutations (`_probe_f269.py`, `_probe_f269b.py`),
which is itself progress: the map of the territory is now true where it was
wrong. All twenty-five floor friction tests still pass; no code changed.

道法自然：去彼取此 — drop the flower of cleverness, keep the fruit of what the
measurement actually said.


## F270 — link_tracks: what disagreed coherently over time

F269's negative left a positive pointer: a single frame-pair cannot tell a real
mover from a deterministic match artifact (both make a residual cluster), but
TIME can — a real mover persists across consecutive frames and translates
coherently, a transient mismatch flickers (one frame), a camera-locked overlay
persists but stays pinned. I probed it before building (`_probe_f270.py`): a slow
live pan produced 17 single-pair `flow_residual` detections; linking them across
the sequence collapsed them to 2 persistent translating tracks and 15 one-frame
flickers, while the still-camera weapon band showed up as a single PINNED track
(span 7 px). Persistence is a real discriminator. So the primitive is warranted.

`link_tracks(frames, max_gap, max_skip, min_len)`: greedy nearest-neighbour data
association, resolved per step in ascending-distance order so each detection and
each open track is used at most once; a detection joins the nearest open track
whose last point is within `max_gap` px and at most `max_skip+1` steps back (so
`max_skip=1` bridges a one-frame drop-out), else it opens a new track. Each track
reports `{points, length, span, net, bbox}`. The caller reads the gate the floor
could not give from one pair: `length==1` is a flicker (drop it); `length>1` with
`span≈0` is a pinned overlay (HUD/weapon); persistent *and* translating is a
genuine mover. Inputs are dicts (`x`,`y`, any extra keys preserved under `det`)
or `(x,y)` tuples — so it links `flow_residual` objects, `match_unique` hits, or
any point detector's output.

Proof. `_test_f270.py` (17 assertions, no display): a straight-line mover into
one track with correct net translation; a constant point into one pinned track
(span≈0); a lone detection as a length-1 flicker; a one-frame drop-out bridged at
`max_skip=1` and split at `0`; two separated movers into two tracks; a contested
step resolved one-to-one (nearest wins, the other opens its own); a >`max_gap`
teleport not linked; `min_len`; payload preservation; tuple input; empty frames.
Live `_game_f270.py` (panning ioquake3): **20 single-pair detections → 4
persistent translating tracks, 11 flickers dropped by time** — the noise no
single pair could reject, rejected. All twenty-six floor friction tests pass.

The chain now closes a loop in time as well as space: `react_pixel` (when) ·
`move_rel` (how much) · `servo` (gain) · `match_unique` (is this lock
trustworthy) · `lead` (where it is going) · `consensus_shift` (one shift, or
none) · `consensus_affine` (the camera's flow field) · `flow_residual` (what
disagrees with that field *now*) · `link_tracks` (what disagreed *coherently
over time* — the real mover the single frame could only suspect). 道法自然.

## F271 — find_color_blobs gains `step`: the acuity find_color always had, finally for *several* targets

The motion arc (F260–F270) gave the floor a clock and an ego-motion model; this
turns back to the oldest verb in the spatial family and pays a debt. Playing the
Human Benchmark **Aim Trainer** — 30 targets pop one at a time on a blue field,
scored as average ms/target — the idiomatic reflex is purely spatial: segment the
target's light-blue fill into blobs, take the largest, click its centroid, repeat.
I probed where the per-target time went (`_probe_f271.py`): the **scan dominated**.
A full-resolution `find_color_blobs` over the ~1.5 MP field measured **~70–130 ms**,
versus **~20 ms** for the move+click it gated — the eye, not the hand, set the pace.

The fix is not a new verb but a debt repaid. `find_color` has carried a `step`
*acuity* knob since F144: sample every n-th pixel on every n-th row, do ~1/n² the
work, and a solid blob's centroid is unbiased under regular subsampling — coarse
to find *where*, then refine in a fovea. The *multi-region* segmenter never got
it, so any tight perceive→act loop over **distinct** same-coloured targets had to
pay full resolution every frame. F271 gives `find_color_blobs(..., step=n)` the
same trade, with the one wrinkle a segmenter adds: connectivity is judged on the
**sample lattice** — a matched sample unions with the matched sample `n` to its
left / `n` above (a cross-row wrap guard keeps the left edge from joining the
previous row's tail). `count` is now matched *samples* (≈ area/n²) so a `min_count`
threshold must scale with `step`; `bbox` rounds to the sample grid. `step=1` is
byte-identical to before (the default), so nothing downstream moves.

Proof. `_test_f271.py` (8 checks, no display): `step=1` reproduces the old result
exactly; at `step=4` two well-separated blobs keep their centroids (±2 px) for a
quarter… a sixteenth of the samples; `min_count` reads in sample units; a 1-px
line is the documented acuity casualty (skipped when its row isn't sampled); a
gap wider than `step` splits and one narrower bridges (lattice connectivity); no
cross-row union wrap; `step≤0` clamps to 1. Live `_game_f271.py` (the Aim Trainer):
the same target found in **4.5 ms at step=4 vs 68.6 ms at step=1** (~15×), and the
floor cleared all **30/30 targets at a site-scored 106 ms/target** — against the
~400 ms human peak on the same page's histogram. The reflex is now bounded by the
hand, not the eye.

Lesson: when a knob proves itself on the single-target finder, the multi-target
finder is not automatically richer for ignoring it — generality means the *whole*
family carries the trade, or the loop that needs several targets quietly pays the
price the loop that needs one stopped paying long ago. `find_color` · step (one
centroid, cheap) → `find_color_blobs` · step (every centroid, just as cheap). 道法自然.

## F272 — detect_sequence: which of several regions fired, and in what order

`react_pixel` answers *when did this pixel cross a level* for one point. The
**Sequence Memory** test asks it of nine tiles at once and cares only about
ORDER: the board flashes tiles white one after another and you replay the order,
one tile longer each level. Nothing on the floor turned "these regions' levels
over time" into "which fired, in what order" — so the caller re-derived it by
hand every time: poll each tile each frame, remember its previous level, detect
the rising edge, and debounce a flash that spans several frames (`_probe_f272.py`
does exactly this bookkeeping, and catching level 1's lone flash — cell 6 to 255
while the other eight sat at 114 — showed why it wants owning).

`detect_sequence(levels, thresh, refractory, baseline, peak)` owns it as a pure
function over a time series. `levels` is one entry per frame, each a list of the
regions' activation (or a `{name: scalar}` map). A region fires on the frame its
level first *rises* across its gate — edge-triggered, not level: while it stays
hot no further event fires; it must fall back for `refractory` frames to re-arm,
so one flash is one event and a tile that flashes *twice* is two. The gate is
per-region, `base_i + thresh*(peak_i - base_i)`, judged on each region's own
dynamic range; `baseline`/`peak` may be pinned explicitly. Returns
`[{region, frame, level}]` in fire order. It is the temporal sibling of the
spatial `find_color_blobs`: that one says *where* the separate targets are, this
one says *when*, in sequence.

Proof. `_test_f272.py` (17 checks, no display): a lone flash; three flashes
recovered in fire order; a flash held high across many frames as ONE event; a
region flashing twice as two, collapsed back to one under `refractory=2`;
per-region dynamic range; a flat region silent; dict input with key order; an
explicit gate suppressing an auto-detected one; within-frame tie-break by region;
empty input; `refractory<=0` clamp; ragged frames rejected. Live `_game_f272.py`
(the real test): fed windowed `capture_rgb` tile luminances, it **solved through
level 8** — `[8, 0, 1, 8, 2, 6, 4, 5]`, cell 8 flashing *twice* and detected as
two ordered events by the live refractory. All twenty-eight floor tests pass.

Lesson (paid in the live run, worth the scar). The first attempt let `baseline`/
`peak` auto-fill from each region's own min/max over the window — and lit up all
nine tiles at level 2. A tile that never flashes is not flat but *nearly* flat:
~114 with a few counts of sensor noise, so its auto span is tiny and its gate
sits a noise-hair above baseline, which that same noise then crosses. The
docstring's "flat region never fires" is true only for a *perfectly* flat one;
under real capture noise, auto-scaling manufactures a gate the noise clears.
The fix is composition, not a new knob: pin `peak` to the *known* active level
(here white, 255) so an idle region is judged against the real signal, not
against its own jitter. Auto min/max is a convenience for regions you know all
activate; when some may stay dark, tell the verb what "on" looks like. 道法自然.
