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

## Frontier (next honest rounds)

These are *not yet built* — they are the next real surfaces to push into. Each
will only grow a primitive once a real failure is reproduced.

- **R-next: a glyph atlas wider than one alphabet** — `read_glyph` (F058) reads
  among the few glyphs we carry; reading an *unknown* string needs per-character
  segmentation across a baseline and a fuller atlas (true OCR territory). Grow it
  only when a real control demands reading text we did not pre-enumerate.

> 為學者日益，聞道者日損。 We add primitives only by subtracting frictions.
