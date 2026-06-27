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

## Frontier (next honest rounds)

These are *not yet built* — they are the next real surfaces to push into. Each
will only grow a primitive once a real failure is reproduced.

- **R-next: an atlas built from the live page, not a fixture** — F103's atlas is
  rendered by the test itself; reading a *real* canvas control means capturing
  reference glyphs from the page's own rendering (a scratch canvas the app
  exposes, or known on-screen labels) before `read_text` can name unknown runs.

> 為學者日益，聞道者日損。 We add primitives only by subtracting frictions.
