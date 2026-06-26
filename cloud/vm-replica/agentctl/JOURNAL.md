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

## Frontier (next honest rounds)

These are *not yet built* — they are the next real surfaces to push into. Each
will only grow a primitive once a real failure is reproduced.

- **R-next: a glyph atlas wider than one alphabet** — `read_glyph` (F058) reads
  among the few glyphs we carry; reading an *unknown* string needs per-character
  segmentation across a baseline and a fuller atlas (true OCR territory). Grow it
  only when a real control demands reading text we did not pre-enumerate.

> 為學者日益，聞道者日損。 We add primitives only by subtracting frictions.
