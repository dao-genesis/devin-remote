"""agentctl.browser — human-like action + perception primitives over CDP.

These primitives were not designed up front; each one is the residue of a real
friction hit while operating live web pages (see ``JOURNAL.md``).  The recurring
lesson is **closed loop**: act, then read back, then verify *semantic* arrival —
not just that the action fired.

Channel split discovered empirically:

* Mouse gestures (click / drag / scroll / hover) are *trusted* and reliable when
  dispatched through CDP ``Input.*`` — but a click must be preceded by a
  ``mouseMoved`` so Chrome's hit-test is on the right element (F024).
* Per-character keyboard typing is racy (F001/F002/F003).  In-page text goes in
  **atomically** via ``Input.insertText`` after focusing the field; the omnibox
  (out-of-DOM) is handled by ``osctl`` atomic paste.

Async friction (F043): a DOM mutation often lags the action that triggered it.
``wait_for`` / ``wait_stable`` / ``wait_change`` make the wait explicit instead
of sleeping and hoping.
"""

from __future__ import annotations

import base64
import json
import math
import os
import sys
import time

# This VM ships an *embedded* Python whose ._pth omits the script directory, so
# sibling imports fail unless we put our own directory on the path first.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cdp import CDP, CDPError  # noqa: E402

# JS helper installed once per navigation: locate elements (incl. by visible
# text) and pierce shadow roots (F0xx — querySelector can't cross shadow DOM).
_HELPERS_JS = r"""
window.__agentctl = (function () {
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && el.offsetParent !== null
        || s.position === 'fixed';
  }
  function center(el) {
    const r = el.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2,
            w: r.width, h: r.height, top: r.top, left: r.left};
  }
  // Recursively walk light + shadow DOM.
  function* walk(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.querySelectorAll) {
        for (const el of node.querySelectorAll('*')) {
          yield el;
          if (el.shadowRoot) stack.push(el.shadowRoot);
        }
      }
    }
  }
  function deepQuery(sel) {
    const direct = document.querySelector(sel);
    if (direct) return direct;
    for (const el of walk(document)) {
      try { if (el.matches && el.matches(sel)) return el; } catch (e) {}
    }
    return null;
  }
  function clickable(el) {
    // A truthy rank => prefer this element as the real interactive target.
    if (/^(A|BUTTON)$/.test(el.tagName)) return 3;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT'
        || el.tagName === 'TEXTAREA') return 3;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    if (role === 'button' || role === 'link') return 2;
    if (el.onclick || (el.tabIndex >= 0)) return 1;
    return 0;
  }
  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }
  function byText(text, tagHint) {
    const t = text.trim().toLowerCase();
    // Among all visible elements whose text contains the target, pick the
    // best *interactive* target. A wrapper <p> and its child <a> can share
    // identical textContent ("Learn more"); ranking by text length alone
    // keeps the wider ancestor, whose geometric center misses the anchor.
    // Rank: clickable first, then smallest text, then smallest area (leaf).
    let best = null, bestRank = -1, bestLen = 1e9, bestArea = 1e18;
    for (const el of walk(document)) {
      if (tagHint && el.tagName !== tagHint.toUpperCase()) continue;
      const own = (el.textContent || '').trim().toLowerCase();
      if (!own.includes(t)) continue;
      if (!visible(el)) continue;
      const rank = clickable(el), len = own.length, a = area(el);
      const better = rank > bestRank
        || (rank === bestRank && len < bestLen)
        || (rank === bestRank && len === bestLen && a < bestArea);
      if (better) { best = el; bestRank = rank; bestLen = len; bestArea = a; }
    }
    return best;
  }
  // F061: the point we will actually click. A trusted click lands on whatever
  // paints topmost at (x,y) — not necessarily the element we located. An overlay
  // (scrim, sticky header, cookie wall) sitting above the target swallows the
  // click. So probe a few points across the element's box and return the first
  // where elementFromPoint resolves back into the element (so the click truly
  // reaches it — exactly the visible spot a human would aim for). If every
  // sampled point is covered, report the target as occluded with its blocker
  // rather than firing a click that lies.
  function hitPoint(el) {
    if (!el || !visible(el)) return null;
    let r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      el.scrollIntoView({block: 'center', inline: 'center'});
      r = el.getBoundingClientRect();
    }
    if (r.width <= 0 || r.height <= 0) return null;
    const fx = [0.5, 0.5, 0.5, 0.3, 0.7, 0.5, 0.5, 0.15, 0.85];
    const fy = [0.5, 0.3, 0.7, 0.5, 0.5, 0.15, 0.85, 0.5, 0.5];
    for (let i = 0; i < fx.length; i++) {
      const x = r.left + r.width * fx[i], y = r.top + r.height * fy[i];
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) {
        return {x: x, y: y, w: r.width, h: r.height, occluded: false};
      }
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const blk = document.elementFromPoint(cx, cy);
    return {x: cx, y: cy, w: r.width, h: r.height, occluded: true,
            blocker: (blk && (blk.id || blk.tagName)) || null};
  }
  return {visible, center, deepQuery, byText, hitPoint};
})();
"""


class Browser:
    def __init__(self, cdp: CDP | None = None, port: int = 29229):
        self.cdp = cdp or CDP(port=port).connect()
        self._inject_helpers()

    # ---- low-level -------------------------------------------------------- #
    def eval(self, expr: str, await_promise: bool = False, timeout: float = 20.0):
        return self.cdp.evaluate(expr, await_promise=await_promise, timeout=timeout)

    def _inject_helpers(self) -> None:
        try:
            self.cdp.evaluate(_HELPERS_JS)
        except CDPError:
            pass

    # ---- F049: cross-origin iframes --------------------------------------- #
    def frames(self) -> list[dict]:
        """Every execution context CDP currently sees, including cross-origin
        child frames (which carry a distinct ``origin`` and ``frameId``)."""
        out = []
        for cid, ctx in self.cdp.contexts.items():
            aux = ctx.get("auxData") or {}
            out.append({"context_id": cid, "origin": ctx.get("origin"),
                        "frame_id": aux.get("frameId"),
                        "is_default": aux.get("isDefault")})
        return out

    def _frame_context(self, match: str):
        # contexts preserve insertion order, so the *last* match is the freshest
        # registration of that frame (a reload re-registers a new context). Keys
        # may be a page-session int id or an out-of-process "<sessionId>:<id>"
        # string (F059), so we never order-compare them — we just take the last.
        best = None
        for cid, ctx in self.cdp.contexts.items():
            aux = ctx.get("auxData") or {}
            if match in (ctx.get("origin") or "") or match == aux.get("frameId"):
                best = cid
        return best

    def wait_frame(self, match: str, timeout: float = 5.0,
                   interval: float = 0.1) -> int | None:
        """Wait for a frame whose origin/frameId matches to register a context."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            cid = self._frame_context(match)
            if cid is not None:
                return cid
            time.sleep(interval)
        return None

    def eval_in_frame(self, match: str, expr: str,
                      await_promise: bool = False, timeout: float = 5.0):
        """F049: read/act inside a cross-origin iframe's own execution context.

        A cross-origin child blocks the parent's JS — ``iframe.contentDocument``
        is ``null`` and ``deepQuery`` cannot pierce it — because the same-origin
        policy forbids the parent *document* from touching it. CDP, though,
        evaluates per **execution context** at the renderer level, beneath that
        policy: addressing the child's own ``contextId`` reaches straight in to
        read text or invoke ``element.click()``. ``match`` is a substring of the
        frame's origin (e.g. a port) or its exact ``frameId``. Returns ``None``
        if no such frame context exists.
        """
        cid = self.wait_frame(match, timeout=timeout)
        if cid is None:
            return None
        return self.cdp.evaluate(expr, context_id=cid,
                                 await_promise=await_promise)

    # ---- F060: new top-level tabs / popup windows ------------------------- #
    def pages(self) -> list[dict]:
        """Every open top-level tab/window, newest first. A ``target=_blank``
        link or ``window.open`` spawns one of these — a separate page target the
        opener's session cannot see into."""
        return [{"title": p.get("title"), "url": p.get("url"),
                 "target_id": p.get("id"), "ws": p.get("webSocketDebuggerUrl")}
                for p in self.cdp.list_pages()]

    def switch_page(self, match: str, timeout: float = 5.0,
                    interval: float = 0.2) -> bool:
        """Drive a *different* top-level tab whose url/title contains ``match``
        (F060). A click that opens a new tab leaves the connection on the opener;
        site-isolation auto-attach (F059) only reaches child frames, not sibling
        top-level targets. So we re-point this connection at the new tab's own
        devtools endpoint — the programmatic equivalent of a human clicking the
        new tab — and re-inject helpers. Returns True once switched."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            for p in self.cdp.list_pages():
                if match in (p.get("url") or "") or match in (p.get("title") or ""):
                    ws = p.get("webSocketDebuggerUrl")
                    if ws:
                        self.cdp.close()
                        self.cdp.connect(ws_url=ws)
                        self._inject_helpers()
                        return True
            time.sleep(interval)
        return False

    # ---- navigation (F003/F004: arrival, not just fired) ------------------ #
    def navigate(self, url: str, timeout: float = 30.0) -> str:
        self.cdp.call("Page.navigate", {"url": url}, timeout=timeout)
        self.wait_ready(timeout=timeout)
        self._inject_helpers()
        return self.eval("location.href")

    def wait_ready(self, timeout: float = 30.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.eval("document.readyState") in ("interactive", "complete"):
                    return
            except CDPError:
                pass
            time.sleep(0.2)

    def url(self) -> str:
        return self.eval("location.href")

    def title(self) -> str:
        return self.eval("document.title")

    # ---- element location ------------------------------------------------- #
    def _center_of(self, selector: str, by_text: bool = False, tag: str | None = None):
        self._inject_helpers()
        if by_text:
            tag_lit = repr(tag) if tag else "null"
            js = (f"(function(){{var el=window.__agentctl.byText({selector!r},"
                  f"{tag_lit});return el?window.__agentctl.center(el):null;}})()")
        else:
            js = (f"(function(){{var el=window.__agentctl.deepQuery({selector!r});"
                  f"return el?window.__agentctl.center(el):null;}})()")
        return self.eval(js)

    def _hit_point_of(self, selector: str, by_text: bool = False,
                      tag: str | None = None):
        self._inject_helpers()
        if by_text:
            tag_lit = repr(tag) if tag else "null"
            locate = f"window.__agentctl.byText({selector!r},{tag_lit})"
        else:
            locate = f"window.__agentctl.deepQuery({selector!r})"
        return self.eval(f"(function(){{var el={locate};"
                         f"return el?window.__agentctl.hitPoint(el):null;}})()")

    def exists(self, selector: str) -> bool:
        return bool(self.eval(
            f"!!window.__agentctl.deepQuery({selector!r})"))

    def get_text(self, selector: str) -> str | None:
        return self.eval(
            f"(function(){{var el=window.__agentctl.deepQuery({selector!r});"
            f"return el?el.textContent.trim():null;}})()")

    # ---- mouse gestures (trusted CDP input) ------------------------------- #
    def _move(self, x: float, y: float) -> None:
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseMoved", "x": x, "y": y})

    def click_xy(self, x: float, y: float, button: str = "left") -> None:
        # F024: move first so the hit-test resolves to the intended element.
        self._move(x, y)
        for t in ("mousePressed", "mouseReleased"):
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": t, "x": x, "y": y, "button": button,
                           "clickCount": 1})

    def click_n_xy(self, x: float, y: float, count: int,
                   button: str = "left") -> None:
        """Click at ``x,y`` carrying ``clickCount`` (F071). A double (2) or triple
        (3) press is what Chrome turns into a word- or paragraph-level selection;
        ``click_xy`` hard-codes ``clickCount:1`` (a caret), so it can never select.
        We escalate the count on the final press the way a human's repeated taps
        do."""
        self._move(x, y)
        for n in range(1, count + 1):
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": "mousePressed", "x": x, "y": y,
                           "button": button, "clickCount": n})
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": "mouseReleased", "x": x, "y": y,
                           "button": button, "clickCount": n})

    def _text_point_of(self, selector: str) -> dict | None:
        """Centre of the element's first *text* rect (F071). A block's layout box
        is often far wider than its glyphs, so its geometric centre falls in empty
        space; double-clicking there selects nothing. A ``Range`` over the
        contents reports the rectangles the text actually occupies — we aim at the
        middle of the first one, a spot that lands on a real word."""
        return self.eval(
            "(function(){var el=window.__agentctl.deepQuery(%r);if(!el)return null;"
            "var r=document.createRange();r.selectNodeContents(el);"
            "var rs=r.getClientRects();if(!rs||!rs.length)return null;"
            "var b=rs[0];return {x:b.left+b.width/2,y:b.top+b.height/2};})()"
            % selector)

    def select_word(self, selector: str) -> str | None:
        """Double-click to select the word under a point (F071). Formatting
        toolbars, "copy selection", highlight/define popovers all gate on a
        *non-collapsed* Selection; a plain ``click`` collapses the caret to a
        zero-width point and ``getSelection()`` stays empty, so the toolbar never
        enables. A human double-clicks on a word. We aim at the element's first
        text rect (not its wider layout box, whose centre is blank), then press
        with ``clickCount:2`` — the signal Chrome turns into a word selection.
        Returns the selected string (``''`` if nothing landed), or ``None`` if the
        target is absent."""
        p = self._text_point_of(selector)
        if not p:
            return None
        self.click_n_xy(p["x"], p["y"], 2)
        return self.eval("String(getSelection())")

    def select_paragraph(self, selector: str) -> str | None:
        """Triple-click to select the whole line/paragraph under a point (F071).
        Same gate as :meth:`select_word`, one rung wider: a triple-click
        (``clickCount:3``) selects the entire block, the unit a human grabs to
        re-style or replace a paragraph. Returns the selected string, or ``None``
        if the target is absent."""
        p = self._text_point_of(selector)
        if not p:
            return None
        self.click_n_xy(p["x"], p["y"], 3)
        return self.eval("String(getSelection())")

    def _caret_point_of(self, selector: str, offset: int) -> dict | None:
        """Pixel position of the caret at character ``offset`` inside an element's
        text (F072). Walks the element's text nodes, finds the node that holds the
        offset, collapses a ``Range`` there and reads its rect — the x/y a human's
        cursor would sit at between two glyphs."""
        return self.eval(
            "(function(){var el=window.__agentctl.deepQuery(%r);if(!el)return null;"
            "var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),n,acc=0,off=%d;"
            "while(n=w.nextNode()){var len=n.nodeValue.length;"
            "if(off<=acc+len){var r=document.createRange();"
            "r.setStart(n,off-acc);r.setEnd(n,off-acc);"
            "var rs=r.getClientRects(),b=rs.length?rs[0]:r.getBoundingClientRect();"
            "return {x:b.left,y:b.top+(b.height||16)/2};}acc+=len;}return null;})()"
            % (selector, offset))

    def select_range(self, selector: str, start: int, end: int) -> str | None:
        """Drag-select an arbitrary character range ``[start, end)`` (F072).
        ``select_word``/``select_paragraph`` (F071) only snap to whole words or
        blocks; a precise span — bolding exactly two of four words, quoting half a
        sentence — has no ``clickCount``. A human presses on the first glyph, drags
        to the last, and Chrome grows the Selection under the moving cursor. We
        resolve the caret pixel for ``start`` and ``end`` (via a collapsed
        ``Range`` at each offset), press at the first, move through to the second,
        and release — a real drag that selects exactly that span. Returns the
        selected string, or ``None`` if the target/offsets are absent."""
        a = self._caret_point_of(selector, start)
        b = self._caret_point_of(selector, end)
        if not a or not b:
            return None
        self._move(a["x"], a["y"])
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": a["x"], "y": a["y"],
                       "button": "left", "clickCount": 1})
        steps = max(1, int(abs(b["x"] - a["x"]) / 12) + 1)
        for i in range(1, steps + 1):
            mx = a["x"] + (b["x"] - a["x"]) * i / steps
            my = a["y"] + (b["y"] - a["y"]) * i / steps
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": "mouseMoved", "x": mx, "y": my,
                           "button": "left", "buttons": 1})
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": b["x"], "y": b["y"],
                       "button": "left", "clickCount": 1})
        return self.eval("String(getSelection())")

    def _rect_of(self, selector: str) -> dict | None:
        """The element's viewport rectangle (F073), or ``None`` if absent."""
        return self.eval(
            "(function(){var el=window.__agentctl.deepQuery(%r);if(!el)return null;"
            "var r=el.getBoundingClientRect();"
            "return {left:r.left,top:r.top,width:r.width,height:r.height};})()"
            % selector)

    def set_slider(self, thumb: str, track: str, fraction: float,
                   axis: str = "x") -> bool:
        """Drag a slider handle to ``fraction`` of its track (F073). A custom
        slider — a volume/brightness/price control built from ``<div>``\\ s — has no
        ``.value`` to set (``set_value`` raises *Illegal invocation* on a
        ``<div>``) and ignores ``scrollTop``. It listens for ``pointerdown`` on the
        *thumb*, then ``pointermove`` along the *track*, mapping the cursor's
        fraction of the rail to a value — so a plain ``click`` on the track does
        nothing (the press never lands on the thumb), and there is no value to
        write. A human grabs the handle and slides it. We press at the thumb's
        centre, move in steps to ``fraction`` along the track (carrying
        ``buttons:1`` so a handler reading ``e.buttons`` still sees a drag), and
        release. ``axis`` picks the rail's direction. ``fraction`` is clamped to
        ``[0,1]``. Returns ``False`` if either element is absent."""
        th = self._rect_of(thumb)
        tr = self._rect_of(track)
        if not th or not tr:
            return False
        f = max(0.0, min(1.0, fraction))
        px = th["left"] + th["width"] / 2
        py = th["top"] + th["height"] / 2
        if axis == "y":
            tx = tr["left"] + tr["width"] / 2
            ty = tr["top"] + f * tr["height"]
        else:
            tx = tr["left"] + f * tr["width"]
            ty = tr["top"] + tr["height"] / 2
        self._move(px, py)
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": px, "y": py,
                       "button": "left", "clickCount": 1})
        span = abs(tx - px) + abs(ty - py)
        steps = max(1, int(span / 12) + 1)
        for i in range(1, steps + 1):
            mx = px + (tx - px) * i / steps
            my = py + (ty - py) * i / steps
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": "mouseMoved", "x": mx, "y": my,
                           "button": "left", "buttons": 1})
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": tx, "y": ty,
                       "button": "left", "clickCount": 1})
        return True

    def marquee(self, container: str, x0: float, y0: float,
                x1: float, y1: float) -> bool:
        """Rubber-band (marquee) select by dragging a rectangle over a container
        (F076). A file grid / canvas / photo board selects *several* items at once
        when you press on empty space and drag a box across them — each
        ``pointermove`` recomputes which item boxes the band intersects. A plain
        ``click`` selects nothing (it presses *on* an item or fires no band), and
        ``dnd`` (F047) presses on a *source element* then drops on a *target* — it
        has no empty-void press and no rectangle. The corners ``(x0,y0)`` and
        ``(x1,y1)`` are fractions ``[0,1]`` of the container's box, so the gesture
        is resolution-independent; the start should fall on empty space (where the
        band handler listens). We press the first corner, step diagonally to the
        second carrying ``buttons:1`` (so a handler reading ``e.buttons`` keeps the
        band live), and release. Returns ``False`` if the container is absent."""
        r = self._rect_of(container)
        if not r:
            return False
        def at(fx: float, fy: float) -> tuple[float, float]:
            return (r["left"] + max(0.0, min(1.0, fx)) * r["width"],
                    r["top"] + max(0.0, min(1.0, fy)) * r["height"])
        px, py = at(x0, y0)
        qx, qy = at(x1, y1)
        self._move(px, py)
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": px, "y": py,
                       "button": "left", "clickCount": 1})
        span = abs(qx - px) + abs(qy - py)
        steps = max(1, int(span / 12) + 1)
        for i in range(1, steps + 1):
            mx = px + (qx - px) * i / steps
            my = py + (qy - py) * i / steps
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": "mouseMoved", "x": mx, "y": my,
                           "button": "left", "buttons": 1})
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": qx, "y": qy,
                       "button": "left", "clickCount": 1})
        return True

    def drag_reorder(self, source: str, target: str, after: bool = False,
                     by_text: bool = False) -> bool:
        """Pointer-driven drag-to-reorder of a sortable list (F080). A SortableJS /
        drag-handle list reorders by listening to raw *mouse/pointer* events:
        ``mousedown`` on a row grabs it, every ``mousemove`` splices the row past
        whichever sibling midpoint the cursor crossed, ``mouseup`` drops it. It never
        uses the HTML5 drag API, so ``dnd`` (F047) — which synthesizes
        ``dragstart/dragover/drop`` DragEvents — fires nothing the handler hears and
        the order is unchanged. ``marquee`` (F076) presses on empty void and draws a
        rectangle; it grabs no row. We press on the source row's hit-verified point
        (refusing if occluded, like :meth:`click`), step the cursor in small
        increments toward the target carrying ``buttons:1`` so the live ``mousemove``
        reorder runs every frame, and release. ``after`` aims past the target's
        midpoint so the row lands *after* it (else *before*). Returns ``False`` if
        either row is absent or the source is occluded."""
        s = self._hit_point_of(source, by_text=by_text)
        if not s or s.get("occluded"):
            return False
        r = self._rect_of(target)
        if not r:
            return False
        tx = r["left"] + r["width"] / 2
        ty = r["top"] + (0.85 if after else 0.15) * r["height"]
        self._move(s["x"], s["y"])
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": s["x"], "y": s["y"],
                       "button": "left", "clickCount": 1})
        span = abs(tx - s["x"]) + abs(ty - s["y"])
        steps = max(2, int(span / 10) + 1)
        for i in range(1, steps + 1):
            mx = s["x"] + (tx - s["x"]) * i / steps
            my = s["y"] + (ty - s["y"]) * i / steps
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": "mouseMoved", "x": mx, "y": my,
                           "button": "left", "buttons": 1})
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": tx, "y": ty,
                       "button": "left", "clickCount": 1})
        return True

    def drag_by(self, selector: str, dx: float, dy: float,
                by_text: bool = False) -> bool:
        """Press a handle and drag it by an exact pixel delta (F088). A splitter /
        resize grip / pane divider sets a size from *how far the cursor travelled*:
        it grabs on ``mousedown`` and each ``mousemove`` adds the cursor's pixel
        offset to the panel's width. There is no destination *element* to aim at —
        the result is the delta itself — so :meth:`drag_reorder` (F080), which
        slides to a *target element's* midpoint, lands at that element's
        uncontrolled position, not a chosen size; :meth:`set_slider` (F073) needs a
        track to map a fraction onto; a plain :meth:`click` presses and releases at
        one point and moves the divider not at all. We press on the handle's
        hit-verified point (refusing if occluded, like :meth:`click`), step the
        cursor by exactly ``(dx, dy)`` in small increments carrying ``buttons:1`` so
        the live resize runs every frame, and release at the offset point. Returns
        ``False`` if the handle is absent or occluded."""
        s = self._hit_point_of(selector, by_text=by_text)
        if not s or s.get("occluded"):
            return False
        ex, ey = s["x"] + dx, s["y"] + dy
        self._move(s["x"], s["y"])
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": s["x"], "y": s["y"],
                       "button": "left", "clickCount": 1})
        steps = max(2, int((abs(dx) + abs(dy)) / 10) + 1)
        for i in range(1, steps + 1):
            mx = s["x"] + dx * i / steps
            my = s["y"] + dy * i / steps
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": "mouseMoved", "x": mx, "y": my,
                           "button": "left", "buttons": 1})
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": ex, "y": ey,
                       "button": "left", "clickCount": 1})
        return True

    def right_drag_by(self, selector: str, dx: float, dy: float,
                      by_text: bool = False, tag: str | None = None) -> bool:
        """Drag with the **right** button held by an exact pixel delta (F090). A map
        or 3D viewport that pans on right-drag, a node editor that box-selects with
        the right button, a canvas that orbits — these latch on a ``mousedown`` whose
        ``button===2`` and then read each ``mousemove`` only while ``buttons & 2`` is
        set; on release they ``preventDefault`` the context menu so the gesture reads
        as a drag, not a menu request. :meth:`drag_by` (F088) carries the *left*
        button (``buttons:1``), so its held moves never satisfy a ``buttons & 2``
        guard — the pane never pans. :meth:`context_menu` (F067) does press the right
        button but only to *raise the menu*: it presses and releases in place, moving
        nothing. The friction is again button identity, this time across a held drag.
        We resolve the honest hit point (F061), refuse if occluded, press the right
        button (``buttons:2``), step the cursor along ``(dx, dy)`` carrying
        ``buttons:2`` so the live pan handler runs each frame, and release at the
        offset point. Returns ``True`` once the drag completes, ``False`` if the
        handle is absent or occluded."""
        s = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not s or s.get("occluded"):
            return False
        ex, ey = s["x"] + dx, s["y"] + dy
        self._move(s["x"], s["y"])
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": s["x"], "y": s["y"],
                       "button": "right", "buttons": 2, "clickCount": 1})
        steps = max(2, int((abs(dx) + abs(dy)) / 10) + 1)
        for i in range(1, steps + 1):
            mx = s["x"] + dx * i / steps
            my = s["y"] + dy * i / steps
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": "mouseMoved", "x": mx, "y": my,
                           "button": "right", "buttons": 2})
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": ex, "y": ey,
                       "button": "right", "buttons": 0, "clickCount": 1})
        return True

    def scroll_into_view(self, selector: str, by_text: bool = False,
                         timeout: float = 2.0) -> bool:
        """Bring an element clipped out of a scroll container back into view (F081).
        A row can sit *in the DOM and laid out* yet be scrolled outside an
        ``overflow:auto`` panel's clip box: its ``getBoundingClientRect`` coordinates
        fall outside the clip, where ``elementFromPoint`` returns the container edge,
        so :meth:`click` honestly refuses (occluded — F061) even though a human would
        simply scroll the panel. ``scroll_until`` (F048) is for *virtual* lists where
        the row is absent from the DOM until mounted; here the row already exists, it
        is merely clipped. We ask the element's own scrollable ancestor chain to bring
        it to centre (``scrollIntoView``) and poll until its hit point is no longer
        occluded. Returns ``True`` once it is hittable, ``False`` if it is absent or
        stays occluded by a *real* overlay (not mere clipping) — so it doubles as an
        honest check that scrolling alone cannot expose it."""
        if by_text:
            tag_lit = "null"
            locate = f"window.__agentctl.byText({selector!r},{tag_lit})"
        else:
            locate = f"window.__agentctl.deepQuery({selector!r})"
        self._inject_helpers()
        moved = self.eval(
            f"(function(){{var el={locate};if(!el)return false;"
            f"el.scrollIntoView({{block:'center',inline:'center'}});return true;}})()")
        if not moved:
            return False
        deadline = time.time() + timeout
        while time.time() < deadline:
            p = self._hit_point_of(selector, by_text=by_text)
            if p and not p.get("occluded"):
                return True
            time.sleep(0.08)
        return False

    def ctrl_click(self, selector: str, by_text: bool = False) -> bool:
        """Ctrl+click to *toggle* an item into a discontiguous multi-selection
        (F077). A list / file grid / table picks several non-adjacent rows when you
        hold Ctrl (Meta on mac) and click each — the handler reads ``e.ctrlKey`` and
        adds that row to the set instead of replacing it. A plain ``click`` (F061)
        carries no modifier, so every handler sees ``ctrlKey:false`` and collapses
        the selection to just the last item: picking 0,2,4 ends with only ``{4}``.
        ``marquee`` (F076) drags a *contiguous* rectangle and so cannot skip the
        items in between. We aim at the element's hit-verified point (refusing if an
        overlay covers it, like :meth:`click`) and press/release with the Ctrl
        modifier bit set on every mouse event — the exact stream the row's listener
        expects. Returns ``False`` if the target is absent or fully occluded."""
        return self._modifier_click(selector, 2, by_text=by_text)

    def shift_click(self, selector: str, by_text: bool = False) -> bool:
        """Shift+click to select a contiguous *range* from the anchor (F078). After
        an anchor click, Shift+clicking another row selects the whole run between
        them — the universal file-manager / mail-list / table gesture. A plain
        ``click`` carries no modifier, so a handler reading ``e.shiftKey`` sees
        ``false`` and merely re-anchors: Shift+clicking row 4 after row 1 ends with
        only ``{4}`` instead of ``{1,2,3,4}``. ``ctrl_click`` (F077) toggles a
        *single* item and never fills the span. We aim at the same hit-verified
        point as :meth:`click` (refusing if occluded) and press/release with the
        Shift modifier bit (8) on every mouse event. The anchor is whatever the page
        last clicked, so a typical use is ``click(first)`` then
        ``shift_click(last)``. Returns ``False`` if the target is absent or fully
        occluded."""
        return self._modifier_click(selector, 8, by_text=by_text)

    def _modifier_click(self, selector: str, modifiers: int,
                        by_text: bool = False) -> bool:
        """Hit-verified click carrying a CDP modifier bitmask (Ctrl=2, Shift=8,
        Alt=1, Meta=4) on every mouse event — the shared core of :meth:`ctrl_click`
        (F077) and :meth:`shift_click` (F078). Returns ``False`` if the target is
        absent or fully occluded (F061 honesty)."""
        p = self._hit_point_of(selector, by_text=by_text)
        if not p or p.get("occluded"):
            return False
        self._move(p["x"], p["y"])
        for typ in ("mousePressed", "mouseReleased"):
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": typ, "x": p["x"], "y": p["y"],
                           "button": "left", "clickCount": 1,
                           "modifiers": modifiers})
        return True

    def click(self, selector: str, by_text: bool = False, tag: str | None = None,
              require_hit: bool = True) -> bool:
        # F061: aim at a point that actually reaches the element. hitPoint probes
        # the element's box and returns the first spot whose top-most paint is the
        # element (or a descendant). If every spot is covered by an overlay it
        # reports ``occluded`` — we refuse to fire a click that would land on the
        # blocker and lie about success. ``require_hit=False`` falls back to the
        # raw center for callers that knowingly want a geometric click.
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p:
            return False
        if p.get("occluded") and require_hit:
            return False
        self.click_xy(p["x"], p["y"])
        return True

    def click_text(self, text: str, tag: str | None = None) -> bool:
        return self.click(text, by_text=True, tag=tag)

    def double_click(self, selector: str, by_text: bool = False,
                     tag: str | None = None) -> bool:
        """Double-click to *activate* an element (F082). A file icon, a list row,
        a rename-on-dblclick label, an editable cell — these open/commit only on a
        ``dblclick`` event, never on a single ``click``. Two separate :meth:`click`
        calls do **not** produce one: each ``click_xy`` carries ``clickCount:1``, so
        Chrome's UA never raises its click-counter and the ``dblclick`` event is
        never synthesised — the handler stays silent (the file never opens) while
        ``click`` cheerfully reports success twice. ``click_n_xy`` (F071) does carry
        an escalating ``clickCount`` but only at raw screen coordinates, for *text*
        selection; it has no hit-verification, so it would fire blindly through an
        overlay. Here we reuse the honest hit point (F061) — refusing if every probe
        spot is occluded — then dispatch press/release with ``clickCount:1`` followed
        by press/release with ``clickCount:2`` at that same point, which is exactly
        the sequence Chrome turns into a ``dblclick``. Returns ``True`` once fired,
        ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p:
            return False
        if p.get("occluded"):
            return False
        self.click_n_xy(p["x"], p["y"], 2)
        return True

    def triple_click(self, selector: str, by_text: bool = False,
                     tag: str | None = None) -> bool:
        """Triple-click to select a whole **line / paragraph** of text (F087). To
        replace an entire field line — a title, a chat draft, one paragraph in a
        rich editor — a human triple-clicks to select the block, then types over it.
        A single :meth:`click` only drops a caret (selects nothing) and
        :meth:`double_click` selects a single *word*; neither can grab the line, yet
        both return ``True``. The difference is purely the click-counter: a
        paragraph selection is the gesture Chrome synthesises at ``clickCount:3``,
        which only a press/release escalating 1→2→3 at one point produces. We reuse
        the honest hit point (F061) — refusing if every probe spot is occluded —
        then drive ``click_n_xy(...,3)``. Returns ``True`` once the triple fires,
        ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p:
            return False
        if p.get("occluded"):
            return False
        self.click_n_xy(p["x"], p["y"], 3)
        return True

    def middle_click(self, selector: str, by_text: bool = False,
                     tag: str | None = None) -> bool:
        """Middle-click (the wheel button) to fire a control's ``auxclick`` (F089).
        Open-link-in-new-tab affordances, a tab's middle-click-to-close, a custom
        paste-on-middle pad, any handler gated on ``event.button===1`` respond only
        to the *middle* button — never to a left :meth:`click`. The friction is the
        button identity, not the geometry: a left press carries ``button:"left"``
        (DOM button ``0``) and Chrome folds it into ``click``, so the ``auxclick``
        handler stays silent while :meth:`click` still returns ``True``. The bare
        :meth:`click_xy` does take a ``button`` argument but it is geometric — no
        hit verification — and omits the ``buttons:4`` mask a faithful middle press
        carries, so it would fire blindly through an overlay. Here we resolve the
        honest hit point (F061), refuse if every probe spot is occluded, then
        dispatch a middle press/release (``buttons:4`` down, ``0`` up) at that point
        — exactly the sequence Chrome turns into an ``auxclick`` with ``button:1``.
        Returns ``True`` once it fires, ``False`` if the element is absent or
        occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p:
            return False
        if p.get("occluded"):
            return False
        x, y = p["x"], p["y"]
        self._move(x, y)
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": x, "y": y,
                       "button": "middle", "buttons": 4, "clickCount": 1})
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": x, "y": y,
                       "button": "middle", "buttons": 0, "clickCount": 1})
        return True

    def tap(self, selector: str, by_text: bool = False,
            tag: str | None = None) -> bool:
        """Tap an element with a real **touch** point to wake a touch-only handler
        (F091). A mobile-first carousel, a swipeable gallery, a custom control built
        on a touch library answer to ``touchstart`` / ``touchend`` and ignore the
        mouse entirely. A :meth:`click` produces a mouse sequence and a synthesized
        ``click`` — Chrome does *not* manufacture a ``touchstart`` from it — so the
        touch handler never runs, yet :meth:`click` still returns ``True``: a silent
        lie. The faithful gesture is a ``touchStart`` at the element followed by a
        ``touchEnd``; Chrome then fires ``touchstart``/``touchend`` (and, as a real
        device would, a compatibility ``click``). We resolve the honest hit point
        (F061), refuse if every probe spot is occluded, then dispatch the touch pair
        there. Returns ``True`` once it fires, ``False`` if the element is absent or
        occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        x, y = p["x"], p["y"]
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart",
                       "touchPoints": [{"x": x, "y": y}]})
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def swipe(self, selector: str, dx: float, dy: float,
              by_text: bool = False, tag: str | None = None) -> bool:
        """Swipe across an element with a held **touch** point (F092). A touch
        carousel advances by a finger drag, a pull-to-refresh pane reads the touch
        travel, a bottom-sheet is flung by ``touchmove`` distance — all gated on a
        moving touch, never on the mouse. :meth:`drag_by` (F088) carries mouse
        ``buttons:1`` moves, which a ``touchmove`` listener never sees; :meth:`tap`
        (F091) touches but does not travel, so a distance-based swipe stays at zero.
        We resolve the honest hit point (F061), refuse if occluded, press a touch
        point, step it along ``(dx, dy)`` issuing ``touchMove`` events so the live
        swipe handler runs each frame, then lift with ``touchEnd``. Returns ``True``
        once the swipe completes, ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        x, y = p["x"], p["y"]
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        steps = max(2, int((abs(dx) + abs(dy)) / 10) + 1)
        for i in range(1, steps + 1):
            mx = x + dx * i / steps
            my = y + dy * i / steps
            self.cdp.call("Input.dispatchTouchEvent",
                          {"type": "touchMove",
                           "touchPoints": [{"x": mx, "y": my}]})
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def pinch(self, selector: str, amount: float,
              by_text: bool = False, tag: str | None = None) -> bool:
        """Pinch an element with **two** touch points to zoom a gesture-driven view
        (F093). A map that scales on a two-finger pinch, an image viewer that zooms
        to the pinch midpoint, a photo gallery that reads the spread between two
        fingers — these compute the *distance* between two simultaneous touch points
        each ``touchmove`` and never look at one finger or the mouse. :meth:`swipe`
        (F092) carries a single travelling touch, so a two-finger distance stays
        constant; :meth:`zoom_pane` (F068) sends a ``ctrl``+wheel, which a
        pinch-only handler that reads ``e.touches.length===2`` never sees. The
        friction is finger *count*: the view answers only to a pair that spreads or
        closes. We resolve the honest hit point (F061), refuse if occluded, place
        two touch points astride the center separated by a small base gap, then step
        them symmetrically apart (``amount>0``) or together (``amount<0``) issuing
        two-point ``touchMove`` events so the live pinch handler runs each frame, and
        lift both with ``touchEnd``. Returns ``True`` once the pinch completes,
        ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        cx, cy = p["x"], p["y"]
        base = 20.0
        start = base / 2.0
        end = (base + amount) / 2.0
        steps = max(2, int(abs(amount) / 10) + 1)

        def _pair(off: float):
            return [{"x": cx - off, "y": cy, "id": 0},
                    {"x": cx + off, "y": cy, "id": 1}]
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart", "touchPoints": _pair(start)})
        for i in range(1, steps + 1):
            off = start + (end - start) * i / steps
            self.cdp.call("Input.dispatchTouchEvent",
                          {"type": "touchMove", "touchPoints": _pair(off)})
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def rotate(self, selector: str, degrees: float,
               by_text: bool = False, tag: str | None = None) -> bool:
        """Rotate an element with **two** touch points twisting about its center
        (F094). A map that spins to a heading, an image editor that rotates a layer
        to the two-finger twist, a knob driven by a circular gesture — these read
        the *angle* of the line between two simultaneous touch points each
        ``touchmove`` and never look at the spread. :meth:`pinch` (F093) moves the
        two points apart or together, so their separation changes but the angle
        between them does not — a rotate-only handler sees nothing; :meth:`swipe`
        (F092) carries a single touch that has no angle at all. The friction is the
        *orientation* of a finger pair: the view answers only to a twist that holds
        the distance and turns the line. We resolve the honest hit point (F061),
        refuse if occluded, place two points on opposite ends of a fixed-radius
        diameter through the center, then turn both around the center by
        ``degrees`` (positive sweeps the line clockwise in screen space) issuing
        two-point ``touchMove`` events so the live rotate handler runs each frame,
        and lift both with ``touchEnd``. The inter-finger distance is held constant
        throughout, so a pinch handler reads no scale change. Returns ``True`` once
        the rotation completes, ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        cx, cy = p["x"], p["y"]
        r = 60.0
        steps = max(2, int(abs(degrees) / 10) + 1)

        def _pair(deg: float):
            a0 = math.radians(180.0 + deg)
            a1 = math.radians(0.0 + deg)
            return [{"x": cx + r * math.cos(a0), "y": cy + r * math.sin(a0),
                     "id": 0},
                    {"x": cx + r * math.cos(a1), "y": cy + r * math.sin(a1),
                     "id": 1}]
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart", "touchPoints": _pair(0.0)})
        for i in range(1, steps + 1):
            self.cdp.call("Input.dispatchTouchEvent",
                          {"type": "touchMove",
                           "touchPoints": _pair(degrees * i / steps)})
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def touch_hold(self, selector: str, hold: float = 0.6,
                   by_text: bool = False, tag: str | None = None) -> bool:
        """Long-press an element with a stationary **touch** point held past a dwell
        (F095). A mobile context menu, a "press and hold to react", a drag-handle
        that only arms after a long touch — these listen on ``touchstart``, arm a
        timer, and fire only if neither ``touchmove`` nor ``touchend`` arrives
        before it elapses. :meth:`press_hold` (F083) holds the *mouse* down, but
        Chrome manufactures no ``touchstart`` from a mouse press, so the touch
        long-press never even arms (``touchstart`` count stays zero); :meth:`tap`
        (F091) does fire ``touchstart`` but lifts immediately, so the dwell timer is
        cancelled before it elapses and nothing commits. Both still return ``True``
        — a silent lie. The faithful gesture is a single ``touchStart`` that *stays
        down and still* for ``hold`` seconds while the page's dwell timer runs, then
        a ``touchEnd``. We resolve the honest hit point (F061), refuse if occluded,
        press one touch point there, hold it motionless past the dwell, then lift.
        No ``touchMove`` is issued, so a handler that cancels on movement keeps its
        timer armed. Returns ``True`` once the full press-hold-release completed,
        ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        x, y = p["x"], p["y"]
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        time.sleep(hold)
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def double_tap(self, selector: str, interval: float = 0.12,
                   by_text: bool = False, tag: str | None = None) -> bool:
        """Tap an element **twice in quick succession with touch** to trip a
        double-tap gesture (F096). A photo that zooms on a two-finger-quick
        double-tap, a map that scales, a "like" that fires on a fast double touch —
        these count two ``touchend`` events landing within a short window (often
        ~250–300 ms) and ignore the mouse. :meth:`double_click` (F040) sends a *mouse*
        double sequence and synthesizes ``dblclick``, but Chrome manufactures no
        ``touchstart``/``touchend`` from it, so the touch double-tap counter never
        advances — yet ``double_click`` returns ``True``: a silent lie. A single
        :meth:`tap` (F091) fires exactly one ``touchend``, arming the window but never
        completing it; a second tap that arrives too late (outside the page's
        interval) only re-arms instead of committing. The faithful gesture is two
        ``touchStart``/``touchEnd`` pairs separated by less than the page's window. We
        resolve the honest hit point (F061), refuse if occluded, dispatch the first
        touch pair, wait ``interval`` seconds (kept short so both land inside a tight
        double-tap window), then dispatch the second pair. Returns ``True`` once both
        taps fire, ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        x, y = p["x"], p["y"]
        for _ in range(2):
            self.cdp.call("Input.dispatchTouchEvent",
                          {"type": "touchStart",
                           "touchPoints": [{"x": x, "y": y}]})
            self.cdp.call("Input.dispatchTouchEvent",
                          {"type": "touchEnd", "touchPoints": []})
            time.sleep(interval)
        return True

    def two_finger_tap(self, selector: str, gap: float = 40.0,
                       by_text: bool = False, tag: str | None = None) -> bool:
        """Tap an element with **two fingers at once and lift without moving**
        (F097). A map that recenters on a two-finger tap, a viewer that zooms *out*
        one step, a trackpad-style "secondary tap" — these arm when
        ``e.touches.length`` reaches ``2`` on ``touchstart``, drop on any
        ``touchmove``, and commit at the final ``touchend`` (``touches.length===0``)
        only if no move arrived. :meth:`tap` (F091) lands a single finger, so the
        ``===2`` arm never trips; :meth:`pinch` (F093) and :meth:`rotate` (F094) do
        land two fingers but then *move* them, so a tap detector that drops on
        ``touchmove`` refuses; a mouse never makes a ``touchstart`` at all. The
        friction is a finger pair that touches and lifts *still*. Note Chrome always
        decomposes a multi-touch press/release into per-finger events — two
        ``touchstart`` (lengths ``1`` then ``2``) and two ``touchend`` (``1`` then
        ``0``) — so a faithful detector must read the pair at the *final* lift, not
        demand a simultaneous release. We resolve the honest hit point (F061),
        refuse if occluded, place two points astride the center ``gap`` px apart,
        and lift both with a single ``touchEnd`` (no ``touchMove`` between). Returns
        ``True`` once both fingers touch and lift, ``False`` if the element is
        absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        cx, cy = p["x"], p["y"]
        off = gap / 2.0
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart",
                       "touchPoints": [{"x": cx - off, "y": cy, "id": 0},
                                       {"x": cx + off, "y": cy, "id": 1}]})
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def touch_drag(self, selector: str, dx: float, dy: float,
                   arm: float = 0.25, by_text: bool = False,
                   tag: str | None = None) -> bool:
        """Drag an element by **long-pressing to arm, then moving the held touch**
        (F098). A sortable list that reorders rows only after a press dwells long
        enough to "pick up", a drag-handle that ignores a quick flick as a scroll, a
        kanban card that lifts on long-press then follows the finger — these arm a
        timer on ``touchstart`` and **cancel it on any ``touchmove`` that arrives
        before it elapses**, treating an early move as a scroll, not a drag; only a
        touch that stays still past the dwell, *then* travels, is accepted and
        committed at ``touchend``. :meth:`swipe` (F092) starts moving immediately, so
        the arm timer is cancelled and the drag never engages (travel reads as a
        scroll). :meth:`touch_hold` (F095) dwells and arms but never moves, so the
        handle is picked up yet dropped in place — no reorder. A mouse
        :meth:`drag_by` (F088) makes no ``touchstart`` at all. The faithful gesture
        is one finger that lands, *waits still* past the arm threshold, then drags
        and lifts. We resolve the honest hit point (F061), refuse if occluded, press
        one touch point, hold it motionless for ``arm`` seconds so the page's
        pick-up timer fires, step it along ``(dx, dy)`` issuing ``touchMove`` events
        so the live drag handler runs each frame, then lift with ``touchEnd``.
        Returns ``True`` once the drag completes, ``False`` if the element is absent
        or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        x, y = p["x"], p["y"]
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        time.sleep(arm)
        steps = max(2, int((abs(dx) + abs(dy)) / 10) + 1)
        for i in range(1, steps + 1):
            mx = x + dx * i / steps
            my = y + dy * i / steps
            self.cdp.call("Input.dispatchTouchEvent",
                          {"type": "touchMove",
                           "touchPoints": [{"x": mx, "y": my}]})
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def two_finger_pan(self, selector: str, dx: float, dy: float,
                       gap: float = 60.0, by_text: bool = False,
                       tag: str | None = None) -> bool:
        """Pan an element with **two fingers translating together** while holding
        their spread and their angle (F099). A map that scrolls under a two-finger
        drag, a touch pane that pans its content, an embedded scroller that moves
        only when a finger *pair* slides as one — these read two simultaneous touch
        points and accept the gesture only when both translate in parallel: the
        separation between them barely changes (so it is not a pinch) and the line
        through them does not turn (so it is not a rotate). :meth:`pinch` (F093)
        changes the spread, so a pan handler that rejects scale-change ignores it;
        :meth:`rotate` (F094) turns the line, so a pan handler that rejects
        angle-change ignores it; a one-finger :meth:`swipe` (F092) never reaches
        ``touches.length===2`` at all. The friction is a *rigid* finger pair: the
        view answers only to two points that keep their shape and slide together.
        We resolve the honest hit point (F061), refuse if occluded, place two touch
        points astride the center separated by ``gap``, then translate *both* by the
        same ``(dx, dy)`` each step issuing two-point ``touchMove`` events — so the
        inter-finger distance and angle stay fixed while the midpoint travels — and
        lift both with ``touchEnd``. Returns ``True`` once the pan completes,
        ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        cx, cy = p["x"], p["y"]
        off = gap / 2.0
        steps = max(2, int((abs(dx) + abs(dy)) / 10) + 1)

        def _pair(sx: float, sy: float):
            return [{"x": cx - off + sx, "y": cy + sy, "id": 0},
                    {"x": cx + off + sx, "y": cy + sy, "id": 1}]
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart", "touchPoints": _pair(0.0, 0.0)})
        for i in range(1, steps + 1):
            self.cdp.call("Input.dispatchTouchEvent",
                          {"type": "touchMove",
                           "touchPoints": _pair(dx * i / steps, dy * i / steps)})
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def three_finger_swipe(self, selector: str, dx: float, dy: float,
                           gap: float = 50.0, by_text: bool = False,
                           tag: str | None = None) -> bool:
        """Swipe an element with **three fingers translating together** (F100). A
        system-style app switcher, a three-finger scroll, a gesture pad that
        switches workspaces — these fire only when *three* simultaneous touch
        points slide as one, reading ``e.touches.length===3`` and ignoring any
        smaller count. A one-finger :meth:`swipe` (F092) never raises the count
        past one; a two-finger :meth:`two_finger_pan` (F099) reaches two and stops
        — neither ever presents the third finger the handler waits for. The
        friction is finger *count*: the gesture answers only to a trio that moves
        in unison. We resolve the honest hit point (F061), refuse if occluded,
        place three touch points abreast across the center (spaced by ``gap``),
        then translate *all three* by the same ``(dx, dy)`` each step issuing
        three-point ``touchMove`` events so the live handler sees a rigid triad
        travel, and lift all with ``touchEnd``. Returns ``True`` once the swipe
        completes, ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        cx, cy = p["x"], p["y"]
        steps = max(2, int((abs(dx) + abs(dy)) / 10) + 1)

        def _trio(sx: float, sy: float):
            return [{"x": cx - gap + sx, "y": cy + sy, "id": 0},
                    {"x": cx + sx, "y": cy + sy, "id": 1},
                    {"x": cx + gap + sx, "y": cy + sy, "id": 2}]
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart", "touchPoints": _trio(0.0, 0.0)})
        for i in range(1, steps + 1):
            self.cdp.call("Input.dispatchTouchEvent",
                          {"type": "touchMove",
                           "touchPoints": _trio(dx * i / steps, dy * i / steps)})
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def edge_swipe(self, selector: str, dx: float, dy: float,
                   edge: str = "left", margin: float = 4.0,
                   by_text: bool = False, tag: str | None = None) -> bool:
        """Swipe a gesture that must **begin at the element's edge** (F101). A
        back-swipe, an edge drawer, a peek-from-the-side panel — these arm only
        when the touch *starts* inside a thin band hugging one border and then
        travels inward, reading ``e.touches[0].clientX`` (or ``clientY``) at
        ``touchstart`` and ignoring any gesture that begins out in the body. A
        normal :meth:`swipe` (F092) starts at the *center* of the element, so the
        edge handler files it as a mid-start and never opens — the same finger,
        the same motion, but the wrong *origin*. The friction is the **start
        coordinate**, not the path: the view answers only to a stroke born on the
        rim. We resolve the honest hit point (F061), refuse if occluded, read the
        element rectangle (F073), place the first touch ``margin`` pixels inside
        the chosen ``edge`` (``"left"``/``"right"``/``"top"``/``"bottom"``) at the
        perpendicular center, then translate by ``(dx, dy)`` in steps issuing
        ``touchMove`` events so the handler sees the stroke leave the rim, and
        lift with ``touchEnd``. Returns ``True`` once the swipe completes,
        ``False`` if the element is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p or p.get("occluded"):
            return False
        r = self._rect_of(selector)
        if not r:
            return False
        left, top, w, h = r["left"], r["top"], r["width"], r["height"]
        cx, cy = left + w / 2.0, top + h / 2.0
        if edge == "right":
            sx, sy = left + w - margin, cy
        elif edge == "top":
            sx, sy = cx, top + margin
        elif edge == "bottom":
            sx, sy = cx, top + h - margin
        else:  # "left" (default)
            sx, sy = left + margin, cy
        steps = max(2, int((abs(dx) + abs(dy)) / 10) + 1)
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchStart",
                       "touchPoints": [{"x": sx, "y": sy, "id": 0}]})
        for i in range(1, steps + 1):
            self.cdp.call("Input.dispatchTouchEvent",
                          {"type": "touchMove",
                           "touchPoints": [{"x": sx + dx * i / steps,
                                            "y": sy + dy * i / steps, "id": 0}]})
        self.cdp.call("Input.dispatchTouchEvent",
                      {"type": "touchEnd", "touchPoints": []})
        return True

    def press_hold(self, selector: str, hold: float = 0.6,
                   by_text: bool = False, tag: str | None = None) -> bool:
        """Press and *hold* an element, then release (F083). A
        "hold to delete", "press and hold to confirm", press-to-talk, or a
        long-press menu commits only when the button stays down for some dwell:
        the handler arms a timer on ``mousedown`` and fires only if ``mouseup`` has
        *not* arrived when it elapses. :meth:`click` presses and releases within a
        millisecond, so the timer is always cancelled first — the action never
        commits, yet ``click`` returns ``True`` and lies. We aim at the honest hit
        point (F061), refuse if occluded, press, *keep the button down* for ``hold``
        seconds while the page's dwell timer runs, then release. Returns ``True``
        once the full press-hold-release completed, ``False`` if the element is
        absent or occluded. The dwell happens with the button physically down, so a
        page reading ``buttons & 1`` during the wait sees it held."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p:
            return False
        if p.get("occluded"):
            return False
        self._move(p["x"], p["y"])
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": p["x"], "y": p["y"],
                       "button": "left", "buttons": 1, "clickCount": 1})
        time.sleep(hold)
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": p["x"], "y": p["y"],
                       "button": "left", "buttons": 0, "clickCount": 1})
        return True

    def zoom_at(self, selector: str, steps: int = 1, out: bool = False,
                by_text: bool = False, tag: str | None = None) -> bool:
        """Pinch-zoom a pane with Ctrl+wheel (F084). A slippy map, an image or PDF
        viewer, a diagram canvas — these tell *zoom* apart from *pan* by the wheel's
        Ctrl modifier (``if(e.ctrlKey) zoom; else pan;``), which is exactly what
        Chrome turns a trackpad pinch into. :meth:`wheel_at` (F070) dispatches a
        ``mouseWheel`` with no modifiers, so it can only ever reach the *pan* branch
        — the pane never scales — yet it returns ``True`` and lies about having
        zoomed. We aim at the honest hit point (F061), refuse if occluded (a wheel
        is delivered to the topmost element under the point, so an overlay would
        swallow it), then dispatch ``mouseWheel`` carrying ``modifiers:2`` (Ctrl)
        with ``deltaY<0`` to zoom in (``out=True`` for ``deltaY>0`` to zoom out),
        repeated ``steps`` times — which the pane reads as ``e.ctrlKey`` and routes
        to its zoom path. Returns ``True`` once the wheels fire, ``False`` if the
        target is absent or occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p:
            return False
        if p.get("occluded"):
            return False
        dy = 120 if out else -120
        for _ in range(max(1, steps)):
            self.cdp.call("Input.dispatchMouseEvent",
                          {"type": "mouseWheel", "x": p["x"], "y": p["y"],
                           "deltaX": 0, "deltaY": dy, "modifiers": 2})
            time.sleep(0.03)
        return True

    def key_activate(self, selector: str, key: str = "Enter",
                     by_text: bool = False, tag: str | None = None) -> bool:
        """Activate a control with the **keyboard** (F085). A great many custom and
        ARIA controls bind their action to a *keydown* of Enter or Space on a
        *focused* element — ``role="button"`` divs, listbox options, custom
        checkboxes, menu items — and ignore mouse clicks outright: :meth:`click`
        dispatches a pointer click the ``keydown`` handler never hears, so the
        action stays dead while ``click`` returns ``True`` and lies. A human reaches
        such a control by Tab-then-Enter, not the mouse. Crucially the keyboard
        reaches a focusable element *even when a transparent overlay occludes the
        pointer* — exactly where :meth:`click` (F061) honestly refuses — so this is
        a second door when the first is blocked. We focus the element and verify it
        actually took focus (an element with no ``tabindex`` and no native
        focusability cannot be keyboard-activated → ``False``, an honest no), then
        dispatch a faithful ``keyDown``/``keyUp`` for Enter (vk 13) or Space (vk 32)
        so the handler reads the right ``e.key``. Returns ``True`` once fired,
        ``False`` if the element is absent or cannot hold focus."""
        if not self._focus(selector, by_text=by_text, tag=tag):
            return False
        desc = {"Enter": ("Enter", "Enter", 13),
                " ": (" ", "Space", 32),
                "Space": (" ", "Space", 32)}.get(key, (key, key, None))
        self.press_key(desc[0], desc[1], desc[2])
        return True

    def _focus(self, selector: str, by_text: bool = False,
               tag: str | None = None) -> bool:
        """Focus ``selector`` and return whether it actually took focus. An element
        with no ``tabindex`` and no native focusability cannot hold focus, so this
        is an honest test of keyboard-reachability (used by :meth:`key_activate` and
        :meth:`key_step`)."""
        if by_text:
            tag_lit = "null" if tag is None else repr(tag)
            locate = f"window.__agentctl.byText({selector!r},{tag_lit})"
        else:
            locate = f"window.__agentctl.deepQuery({selector!r})"
        self._inject_helpers()
        return bool(self.eval(
            f"(function(){{var el={locate};if(!el)return false;"
            f"el.focus();return el===document.activeElement;}})()"))

    _NAV_KEYS = {
        "ArrowRight": ("ArrowRight", "ArrowRight", 39),
        "ArrowLeft": ("ArrowLeft", "ArrowLeft", 37),
        "ArrowUp": ("ArrowUp", "ArrowUp", 38),
        "ArrowDown": ("ArrowDown", "ArrowDown", 40),
        "Home": ("Home", "Home", 36),
        "End": ("End", "End", 35),
        "PageUp": ("PageUp", "PageUp", 33),
        "PageDown": ("PageDown", "PageDown", 34),
        "Tab": ("Tab", "Tab", 9),
        "Escape": ("Escape", "Escape", 27),
        "Backspace": ("Backspace", "Backspace", 8),
        "Delete": ("Delete", "Delete", 46),
    }

    def key_step(self, selector: str, key: str = "ArrowRight", times: int = 1,
                 by_text: bool = False, tag: str | None = None) -> bool:
        """Drive a control by repeated **arrow / navigation keystrokes** (F086).
        Sliders, spinners, listboxes, menubars, radio groups, date pickers, tab
        strips — a huge family of widgets that move *only* on ``keydown`` of
        Arrow/Home/End/Page keys against a focused element, ignoring the mouse. A
        ``role="slider"`` advances on ``ArrowRight``; clicking it is a no-op and
        :meth:`key_activate` (Enter/Space) never moves it either, yet both return
        ``True``. Setting a precise value is *N taps of an arrow*, not a click at a
        guessed pixel. We focus the element (honest focus check — :meth:`_focus`),
        then dispatch a faithful ``keyDown``/``keyUp`` for the named navigation key
        ``times`` times, each carrying the right ``key``/``code``/``windowsVirtualKeyCode``
        so the handler reads ``e.key``. Returns ``True`` once the taps fire,
        ``False`` if the element is absent, cannot hold focus, or ``key`` is not a
        known navigation key."""
        desc = self._NAV_KEYS.get(key)
        if desc is None:
            return False
        if not self._focus(selector, by_text=by_text, tag=tag):
            return False
        for _ in range(max(1, times)):
            self.press_key(desc[0], desc[1], desc[2])
            time.sleep(0.01)
        return True

    def _pierce_node(self, selector: str) -> int | None:
        """nodeId of the first element matching ``selector`` anywhere in the
        document — *including inside closed shadow roots* (F074) — or ``None``.
        ``deepQuery`` walks shadow roots via ``el.shadowRoot``, which is ``null``
        for a ``mode:'closed'`` root, so page JS can never see inside one. CDP's
        DOM domain can: ``DOM.getDocument{pierce:true}`` returns every shadow root
        (each tagged ``shadowRootType:'closed'``) as a context node, and
        ``DOM.querySelector`` run *within* that node's id resolves selectors in its
        subtree. We collect the document plus every (nested) shadow root and query
        each in document order, returning the first hit."""
        doc = self.cdp.call("DOM.getDocument", {"depth": -1, "pierce": True})
        roots: list[int] = []

        def collect(node: dict) -> None:
            name = node.get("nodeName", "")
            if name == "#document" or node.get("shadowRootType"):
                roots.append(node["nodeId"])
            for c in node.get("children") or []:
                collect(c)
            for s in node.get("shadowRoots") or []:
                collect(s)

        collect(doc["root"])
        for rid in roots:
            try:
                q = self.cdp.call("DOM.querySelector",
                                  {"nodeId": rid, "selector": selector})
            except Exception:
                continue
            if q.get("nodeId"):
                return q["nodeId"]
        return None

    def _point_of_node(self, node_id: int) -> dict | None:
        """Centre of a CDP node's content box (F074), or ``None`` if it has no
        layout box (display:none / detached)."""
        try:
            box = self.cdp.call("DOM.getBoxModel", {"nodeId": node_id})
        except Exception:
            return None
        q = box.get("model", {}).get("content")
        if not q or len(q) < 8:
            return None
        return {"x": (q[0] + q[2] + q[4] + q[6]) / 4,
                "y": (q[1] + q[3] + q[5] + q[7]) / 4}

    def click_shadow(self, selector: str) -> bool:
        """Click an element sealed inside a *closed* shadow root (F074). A web
        component built with ``attachShadow({mode:'closed'})`` — a design-system
        control, a payment field, a media player's buttons — renders on screen and
        a human clicks it fine, but ``click``/``deepQuery`` resolve through
        ``el.shadowRoot`` (``null`` when closed) and return ``False``: the control
        is invisible to every page script and to our DOM tools. We locate it
        through the CDP DOM tree instead (:meth:`_pierce_node`), read its box
        geometry, and click its centre with a real trusted event. Returns ``False``
        if no such element exists or it has no layout box."""
        nid = self._pierce_node(selector)
        if not nid:
            return False
        p = self._point_of_node(nid)
        if not p:
            return False
        self.click_xy(p["x"], p["y"])
        return True

    def type_shadow(self, selector: str, text: str, clear: bool = True) -> bool:
        """Type into an ``<input>``/``<textarea>`` sealed in a *closed* shadow root
        (F075). ``click_shadow`` (F074) can press a sealed control, but typing is a
        different blindness: ``type_text``/``set_value`` resolve their target with
        ``deepQuery``, which is ``null`` past a closed root, so both return
        ``False`` and the field stays empty. The keystrokes themselves, though, go
        wherever focus is — they need no selector. We pierce the closed root for the
        node (:meth:`_pierce_node`), give it focus through ``DOM.focus`` (which acts
        on a CDP node id, not a page selector), optionally select-all + delete to
        clear, then dispatch a real ``keyDown``/``keyUp`` per character (carrying
        ``key``/``code`` and the inserted ``text``) — exactly the stream the field's
        own listeners expect. Returns ``False`` if no such element exists."""
        nid = self._pierce_node(selector)
        if not nid:
            return False
        self.cdp.call("DOM.focus", {"nodeId": nid})
        if clear:
            self.key_chord("a", ctrl=True, code="KeyA", key_code=65)
            self.cdp.call("Input.dispatchKeyEvent",
                          {"type": "keyDown", "key": "Delete", "code": "Delete",
                           "windowsVirtualKeyCode": 46, "nativeVirtualKeyCode": 46})
            self.cdp.call("Input.dispatchKeyEvent",
                          {"type": "keyUp", "key": "Delete", "code": "Delete",
                           "windowsVirtualKeyCode": 46, "nativeVirtualKeyCode": 46})
        for ch in text:
            d = self._key_descriptor(ch)
            if "windowsVirtualKeyCode" in d:
                d["nativeVirtualKeyCode"] = d["windowsVirtualKeyCode"]
            self.cdp.call("Input.dispatchKeyEvent",
                          {**d, "type": "keyDown", "text": ch})
            self.cdp.call("Input.dispatchKeyEvent", {**d, "type": "keyUp"})
        return True

    def context_click(self, selector: str, by_text: bool = False,
                      tag: str | None = None, require_hit: bool = True) -> bool:
        """Right-click to raise an app's own context menu (F067). Web apps replace
        the OS menu with a DOM menu shown on the ``contextmenu`` event — a file
        manager's row actions, an editor's spell menu, a data grid's cell options.
        ``click`` only ever dispatches the **left** button, so that event never
        fires and the menu (and every item inside it) stays unreachable. A human
        presses the *right* button; Chrome raises ``contextmenu`` at the cursor.
        We aim at the same hit-verified point ``click`` uses (so we don't fire into
        an overlay and lie), then dispatch a right-button press/release, which
        Chrome surfaces as a real ``contextmenu`` event the app handles. Returns
        ``False`` if the target is absent or (under ``require_hit``) occluded."""
        p = self._hit_point_of(selector, by_text=by_text, tag=tag)
        if not p:
            return False
        if p.get("occluded") and require_hit:
            return False
        self.click_xy(p["x"], p["y"], button="right")
        return True

    def hover(self, selector: str) -> bool:
        c = self._center_of(selector)
        if not c:
            return False
        self._move(c["x"], c["y"])
        return True

    def is_visible(self, selector: str) -> bool:
        """True iff a (possibly shadow-nested) element is laid out and shown."""
        return bool(self.eval(
            f"(function(){{var el=window.__agentctl.deepQuery({selector!r});"
            f"return el?window.__agentctl.visible(el):false;}})()"))

    def wait_visible(self, selector: str, timeout: float = 5.0,
                     interval: float = 0.12) -> bool:
        """Poll until a selector is *visible* (not merely present in the DOM)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.is_visible(selector):
                    return True
            except CDPError:
                pass
            time.sleep(interval)
        return False

    def hover_reveal(self, hover_selector: str, target_selector: str,
                     timeout: float = 3.0) -> bool:
        """F046: open a hover-only menu and wait for its content to appear.

        CSS ``:hover`` submenus exist in the DOM but are ``display:none`` until
        the trigger is hovered, so they have a zero-size box and ``byText``
        (which filters on visibility) cannot target them. Move onto the trigger
        first, *then* wait for the target to lay out. Pairs with a single-move
        ``click`` so the pointer jumps straight to the revealed item without
        crossing a gap that would re-close the menu (no intermediate hit-tests).
        """
        if not self.hover(hover_selector):
            return False
        return self.wait_visible(target_selector, timeout=timeout)

    def hover_chain(self, selectors: list[str], timeout: float = 3.0) -> bool:
        """Walk a *multi-level* hover menu, keeping every ancestor open (F079).
        A leaf like File > Export > PDF only lays out once its whole ancestor chain
        is hovered: hovering File reveals Export, hovering Export reveals PDF. A
        direct ``click`` on the leaf fails — it has a zero-size ``display:none`` box
        until the path is open — and ``hover_reveal`` (F046) opens only *one* level,
        so it cannot reach a depth-3 item. The ancestors also stay open only while
        the pointer is within the menu subtree, so the path must be traversed in
        order, each parent revealing the next before we move onto it. We hover each
        selector in turn, waiting for it to be visible before the move (so the menu
        has laid out), which leaves the entire chain open. Returns ``False`` if any
        level never appears (a wrong path, or a gap that re-closed the menu)."""
        for i, sel in enumerate(selectors):
            if i and not self.wait_visible(sel, timeout=timeout):
                return False
            if not self.hover(sel):
                return False
        return True

    def menu_select(self, path: list[str], timeout: float = 3.0) -> bool:
        """Open a nested hover menu along ``path`` and click its final item (F079).
        ``path[:-1]`` are the levels to hover open (keeping each ancestor revealed
        via :meth:`hover_chain`), and ``path[-1]`` is the leaf to click. This is the
        whole gesture a human makes for File > Export > PDF in one call. Returns
        ``False`` if the chain never opens or the leaf is absent/occluded."""
        if not path:
            return False
        if len(path) > 1 and not self.hover_chain(path[:-1], timeout=timeout):
            return False
        if not self.wait_visible(path[-1], timeout=timeout):
            return False
        return self.click(path[-1])

    def dnd(self, source: str, target: str) -> bool:
        """F047: HTML5 drag-and-drop from source onto target.

        Native pointer-driven DnD over CDP (`mousePressed`→moves→`mouseReleased`)
        is timing-nondeterministic: depending on the number/spacing of the
        intermediate `mouseMoved`s, Chrome's drag controller may fire `dragstart`
        yet never deliver the `drop`. Instead synthesize the exact event chain a
        real drag produces — `dragstart→dragenter→dragover→drop→dragend` — sharing
        one `DataTransfer` across all of them, so `setData` in `dragstart` is
        readable via `getData` in `drop`, just as the page's handlers expect.
        Pierces shadow roots via `deepQuery`. Returns False if either end is absent.
        """
        js = (
            "(function(s,t){"
            "var a=window.__agentctl.deepQuery(s),b=window.__agentctl.deepQuery(t);"
            "if(!a||!b)return false;"
            "var dt=new DataTransfer();"
            "function fire(el,type){var r=el.getBoundingClientRect();"
            "el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,"
            "composed:true,dataTransfer:dt,clientX:r.left+r.width/2,"
            "clientY:r.top+r.height/2}));}"
            "fire(a,'dragstart');fire(b,'dragenter');fire(b,'dragover');"
            "fire(b,'drop');fire(a,'dragend');return true;"
            f"}})({source!r},{target!r})"
        )
        return bool(self.eval(js))

    def scroll_until(self, found_js: str, container: str | None = None,
                     step: int = 180, max_steps: int = 150,
                     settle: float = 0.05) -> bool:
        """F048: scroll a container (or the window) until ``found_js`` is truthy.

        Virtualized lists only keep the rows near the viewport in the DOM, so a
        far item simply does not exist to be queried or clicked until you scroll
        it into the render window. Step the scroll position, let the list
        re-render (the ``settle`` pause), then re-test. Stops early when the
        scroll position saturates (reached the end) so a missing item fails fast
        instead of spinning ``max_steps`` times.
        """
        if self.eval(found_js):
            return True
        last = -1.0
        for _ in range(max_steps):
            if container:
                pos = self.eval(
                    "(function(){var c=window.__agentctl.deepQuery(%r);"
                    "if(!c)return -1;c.scrollTop+=%d;return c.scrollTop;})()"
                    % (container, step))
            else:
                self.scroll(step)
                pos = self.eval("window.scrollY")
            time.sleep(settle)
            if self.eval(found_js):
                return True
            if pos == last:
                break
            last = pos if isinstance(pos, (int, float)) else last
        return False

    def scroll_to_text(self, text: str, container: str | None = None,
                       **kw) -> bool:
        """Scroll until a row containing ``text`` is rendered and visible."""
        return self.scroll_until(
            f"!!window.__agentctl.byText({text!r})", container, **kw)

    def scroll(self, dy: float, dx: float = 0.0, x: float = 400, y: float = 300) -> None:
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseWheel", "x": x, "y": y,
                       "deltaX": dx, "deltaY": dy})

    def wheel_at(self, selector: str, dy: float, dx: float = 0.0) -> bool:
        """Dispatch a real wheel event over a *specific* pane (F070). A custom
        scroller — a zoomable map, a carousel, an "infinite" feed, a virtualized
        list that translates its own content — is not a native scroll container:
        it has no scrollbar and ignores ``scrollTop`` (so ``scroll_until``'s
        ``c.scrollTop+=`` is discarded), and ``scroll`` wheels at a fixed
        page-centre point that misses a pane sitting elsewhere. A human points at
        *that* pane and turns the wheel. We resolve the element's centre and
        dispatch ``Input.dispatchMouseEvent`` ``mouseWheel`` there, so the pane's
        own ``wheel`` handler fires. Returns ``False`` if the target is absent."""
        c = self._center_of(selector)
        if not c:
            return False
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseWheel", "x": c["x"], "y": c["y"],
                       "deltaX": dx, "deltaY": dy})
        return True

    def wheel_until(self, found_js: str, selector: str, dy: float = 120,
                    dx: float = 0.0, max_steps: int = 40,
                    settle: float = 0.04) -> bool:
        """Wheel a pane (F070) until ``found_js`` is truthy. Steps real wheel
        events over ``selector`` (via :meth:`wheel_at`), letting the pane re-render
        between turns, for surfaces that only advance on ``wheel`` (not on
        ``scrollTop``). Returns ``True`` once satisfied, ``False`` if the target is
        absent or the condition never holds within ``max_steps``."""
        if self.eval(found_js):
            return True
        for _ in range(max_steps):
            if not self.wheel_at(selector, dy, dx):
                return False
            time.sleep(settle)
            if self.eval(found_js):
                return True
        return False

    def drag(self, x1: float, y1: float, x2: float, y2: float, steps: int = 12) -> None:
        self._move(x1, y1)
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": x1, "y": y1,
                       "button": "left", "clickCount": 1})
        for i in range(1, steps + 1):
            self._move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
            time.sleep(0.01)
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": x2, "y": y2,
                       "button": "left", "clickCount": 1})

    def draw_path(self, points: list, hold: float = 0.012) -> bool:
        """Trace a freehand stroke through ``points`` (F065). A drawing surface — a
        signature pad, a sketch canvas, a map lasso — records a *path*
        (``pointerdown`` → many ``pointermove`` → ``pointerup``), not two endpoints.
        ``drag`` only walks a straight segment, so a pad that rejects a ruler-line
        (a "draw something", an anti-bot stroke check) is never satisfied. A human's
        pen sweeps a curve. We press at the first point, move through **every**
        intermediate point in order (each a real ``mouseMoved``, which Chrome also
        surfaces as a ``pointermove``), then release at the last — a connected,
        arbitrarily-curved stroke. Needs at least two points; returns ``False``
        otherwise."""
        if not points or len(points) < 2:
            return False
        x0, y0 = points[0]
        self._move(x0, y0)
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mousePressed", "x": x0, "y": y0,
                       "button": "left", "clickCount": 1})
        for x, y in points[1:]:
            self._move(x, y)
            if hold:
                time.sleep(hold)
        xn, yn = points[-1]
        self.cdp.call("Input.dispatchMouseEvent",
                      {"type": "mouseReleased", "x": xn, "y": yn,
                       "button": "left", "clickCount": 1})
        return True

    # ---- text input (atomic; F001/F002/F003) ------------------------------ #
    def type_text(self, selector: str, text: str, clear: bool = True) -> bool:
        """Focus a field and insert text atomically (no per-char race)."""
        if not self.click(selector):
            return False
        if clear:
            self.eval(
                f"(function(){{var el=window.__agentctl.deepQuery({selector!r});"
                f"if(el){{el.focus();el.value='';}}}})()")
        self.cdp.call("Input.insertText", {"text": text})
        return True

    def insert_text(self, text: str) -> None:
        """Insert text into whatever is focused (atomic)."""
        self.cdp.call("Input.insertText", {"text": text})

    # ---- F051: IME / composition (CJK) ------------------------------------ #
    def compose(self, selector: str | None, text: str,
                stages: list[str] | None = None, commit: bool = True) -> bool:
        """Enter text through the real IME composition lifecycle (F051).

        ``insert_text`` and ``osctl.type_unicode`` both deliver the final
        characters but fire **no** composition events — so a field that *gates*
        on them (CJK type-ahead, pinyin search-as-you-type, rich editors that
        suppress ``input`` while ``isComposing``) never reacts to the text. A
        human's IME instead emits ``compositionstart`` → ``compositionupdate``…
        (each with ``isComposing`` true) → ``compositionend`` on commit.

        CDP's ``Input.imeSetComposition`` drives the renderer's IME directly,
        beneath any key layout. We walk ``stages`` (default: progressive
        prefixes of ``text``, mimicking candidates resolving) — each a
        ``compositionupdate`` — then ``insert_text`` commits, firing
        ``compositionend``. Pass explicit ``stages`` (e.g. ``["ni","你","你好"]``)
        for a realistic romaji→hanzi progression, or ``commit=False`` to leave
        the composition open. ``selector=None`` composes into whatever is
        focused. Returns ``False`` if the field can't be focused.
        """
        if selector is not None and not self.click(selector):
            return False
        if stages is None:
            stages = [text[:i] for i in range(1, len(text) + 1)]
        for s in stages:
            self.cdp.call("Input.imeSetComposition",
                          {"text": s, "selectionStart": len(s),
                           "selectionEnd": len(s)})
        if commit:
            self.cdp.call("Input.insertText", {"text": text})
        return True

    def set_value(self, selector: str, value: str) -> bool:
        """DOM-level set + fire input/change (for React-style controlled inputs)."""
        js = (
            "(function(){var el=window.__agentctl.deepQuery(%r);if(!el)return false;"
            "var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;"
            "var set=Object.getOwnPropertyDescriptor(proto.prototype,'value').set;"
            "set.call(el,%r);"
            "el.dispatchEvent(new Event('input',{bubbles:true}));"
            "el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()"
        ) % (selector, value)
        return bool(self.eval(js))

    def select_option(self, selector: str, *, value: str | None = None,
                      label: str | None = None, index: int | None = None) -> bool:
        """Choose an option from a native ``<select>`` (F062). Clicking a select
        opens an **OS-drawn** popup that is neither in the DOM nor on the page's
        painted surface — a coordinate click where a row *looks* to be lands on
        nothing, and ``set_value`` (an ``<input>`` setter) throws ``Illegal
        invocation`` on a select. So we make the choice semantically: find the
        matching ``<option>`` by ``value`` / visible ``label`` / ``index``, set it
        through the real ``HTMLSelectElement.value`` setter (so React's value
        tracker is updated, not bypassed), and fire bubbling ``input``+``change``.
        Faster and surer than a human opening, scrolling, and clicking the popup.
        Returns True once the select actually reflects the chosen option."""
        crit = {"value": value, "label": label, "index": index}
        js = (
            "(function(){var s=window.__agentctl.deepQuery(%r);"
            "if(!s||s.tagName!=='SELECT')return false;"
            "var c=%s;var opt=null;"
            "for(var i=0;i<s.options.length;i++){var o=s.options[i];"
            "  if(c.index!=null){if(i===c.index){opt=o;break;}continue;}"
            "  if(c.value!=null&&o.value===c.value){opt=o;break;}"
            "  if(c.label!=null&&(o.textContent||'').trim()===c.label){opt=o;break;}}"
            "if(!opt)return false;"
            "var set=Object.getOwnPropertyDescriptor("
            "  HTMLSelectElement.prototype,'value').set;"
            "set.call(s,opt.value);s.selectedIndex=opt.index;"
            "s.dispatchEvent(new Event('input',{bubbles:true}));"
            "s.dispatchEvent(new Event('change',{bubbles:true}));"
            "return s.value===opt.value;})()"
        ) % (selector, json.dumps(crit))
        return bool(self.eval(js))

    def set_editable(self, selector: str, text: str) -> bool:
        """Replace the text of a ``contenteditable`` editor (F063). Rich editors
        (a comment body, a Slack/Gmail compose area) are ``<div contenteditable>``
        with **no ``.value``**: ``set_value`` throws ``Illegal invocation`` on a div,
        and ``type_text``'s clear step (``el.value=''``) is a no-op, so old text
        survives and new text merges into it. A human selects all (Ctrl+A) then
        types over the selection. We do exactly that *mechanism*: focus the editor,
        select its whole contents through the Selection API, then ``Input.insertText``
        — which replaces the selection and fires real ``beforeinput``/``input`` (so
        the editor's model updates), instead of poking a ``.value`` that isn't there.
        Returns ``False`` if the target isn't an editable host."""
        ok = self.eval(
            "(function(){var el=window.__agentctl.deepQuery(%r);"
            "if(!el||!el.isContentEditable)return false;el.focus();"
            "var r=document.createRange();r.selectNodeContents(el);"
            "var s=getSelection();s.removeAllRanges();s.addRange(r);return true;})()"
            % selector)
        if not ok:
            return False
        self.cdp.call("Input.insertText", {"text": text})
        return True

    def drop_file(self, selector: str, name: str, content: str,
                  mime: str = "text/plain") -> bool:
        """Drop a file onto a dropzone (F064). Many uploaders (Slack, Gmail, an
        image well) accept a file *dropped on a region* and have **no
        ``<input type=file>``** to set: ``set_file_input`` (F009) has no node to
        target, and a coordinate drag (``dnd``, F047) moves DOM elements but
        carries no ``File`` — the dropzone's ``drop`` handler reads
        ``e.dataTransfer.files`` and finds it empty. A human drags a file from the
        OS file manager; the only thing the page actually receives is a ``drop``
        event whose ``DataTransfer`` holds a ``File``. We construct exactly that: a
        real ``File`` placed in a ``DataTransfer``, dispatched as
        ``dragenter``→``dragover``→``drop`` at the target's centre (with
        ``dataTransfer`` forced onto each event, since the constructor leaves it
        null). The page reacts as if a human dropped the file. Returns ``False`` if
        the target is absent."""
        js = (
            "(function(){var el=window.__agentctl.deepQuery(%r);if(!el)return false;"
            "var dt=new DataTransfer();"
            "dt.items.add(new File([%s],%s,{type:%s}));"
            "var b=el.getBoundingClientRect();"
            "var x=b.left+b.width/2,y=b.top+b.height/2;"
            "['dragenter','dragover','drop'].forEach(function(t){"
            "  var e=new DragEvent(t,{bubbles:true,cancelable:true,"
            "    clientX:x,clientY:y});"
            "  Object.defineProperty(e,'dataTransfer',{value:dt});"
            "  el.dispatchEvent(e);});return true;})()"
        ) % (selector, json.dumps(content), json.dumps(name), json.dumps(mime))
        return bool(self.eval(js))

    def paste_into(self, selector: str, text: str, html: str | None = None) -> bool:
        """Paste into a field through its **paste pipeline** (F066). Rich editors
        intercept ``paste`` to *transform* what arrives — sanitising HTML, turning a
        bare URL into a link chip, converting markdown, splitting a spreadsheet
        cell. Writing the text directly (``type_text``/``set_editable``) bypasses
        that handler entirely, so the transform never fires and the editor stores
        raw text where a human's Ctrl+V would have produced a chip. A human's paste
        is a ``paste`` event whose ``clipboardData`` carries the payload; the editor
        reads ``getData('text/plain')`` (or ``text/html``) and reacts. We build that
        exactly: focus the target, populate a fresh ``DataTransfer`` with the
        ``text/plain`` (and optional ``text/html``) flavours, and dispatch a real
        ``ClipboardEvent('paste')`` with ``clipboardData`` forced on (the
        constructor leaves it ``null``). The editor's own paste logic runs. Returns
        ``False`` if the target is absent."""
        js = (
            "(function(){var el=window.__agentctl.deepQuery(%r);if(!el)return false;"
            "el.focus();var dt=new DataTransfer();"
            "dt.setData('text/plain',%s);"
            "%s"
            "var e=new ClipboardEvent('paste',{bubbles:true,cancelable:true});"
            "Object.defineProperty(e,'clipboardData',{value:dt});"
            "el.dispatchEvent(e);return true;})()"
        ) % (selector, json.dumps(text),
             ("dt.setData('text/html',%s);" % json.dumps(html)) if html else "")
        return bool(self.eval(js))

    def press_key(self, key: str, code: str | None = None,
                  key_code: int | None = None) -> None:
        base = {"key": key, "code": code or key}
        if key_code is not None:
            base["windowsVirtualKeyCode"] = key_code
            base["nativeVirtualKeyCode"] = key_code
        self.cdp.call("Input.dispatchKeyEvent", {**base, "type": "keyDown"})
        self.cdp.call("Input.dispatchKeyEvent", {**base, "type": "keyUp"})

    def press_enter(self) -> None:
        self.press_key("Enter", "Enter", 13)

    def key_chord(self, key: str, ctrl: bool = False, shift: bool = False,
                  alt: bool = False, meta: bool = False, code: str | None = None,
                  key_code: int | None = None) -> bool:
        """Fire a keyboard shortcut chord — modifier(s) held while a key is pressed
        (F068). Apps bind real work to chords: Ctrl+B bold, Ctrl+S save, Ctrl+Enter
        submit, Shift+Tab back-field. ``press_key`` sends a *bare* key with no
        modifier state, so a handler that checks ``e.ctrlKey``/``e.shiftKey`` never
        matches and the binding is simply dead — pressing ``s`` alone is not Ctrl+S.
        A human holds the modifier *down*, taps the key, then lets go. We do exactly
        that: press each modifier key (so Chrome reports ``ctrlKey``… on every event
        in between), tap the main key with the modifier **bitmask** set, then
        release the key and the modifiers in reverse order. Returns ``True``."""
        mask = (1 if alt else 0) | (2 if ctrl else 0) | (4 if meta else 0) \
            | (8 if shift else 0)
        mods = []
        if ctrl:
            mods.append(("Control", "ControlLeft", 17))
        if shift:
            mods.append(("Shift", "ShiftLeft", 16))
        if alt:
            mods.append(("Alt", "AltLeft", 18))
        if meta:
            mods.append(("Meta", "MetaLeft", 91))
        held = 0
        for mk, mc, mvk in mods:
            held = (held | {17: 2, 16: 8, 18: 1, 91: 4}[mvk])
            self.cdp.call("Input.dispatchKeyEvent",
                          {"type": "keyDown", "key": mk, "code": mc,
                           "windowsVirtualKeyCode": mvk, "nativeVirtualKeyCode": mvk,
                           "modifiers": held})
        base = {"key": key, "code": code or key, "modifiers": mask}
        if key_code is not None:
            base["windowsVirtualKeyCode"] = key_code
            base["nativeVirtualKeyCode"] = key_code
        self.cdp.call("Input.dispatchKeyEvent", {**base, "type": "keyDown"})
        self.cdp.call("Input.dispatchKeyEvent", {**base, "type": "keyUp"})
        for mk, mc, mvk in reversed(mods):
            held = (held & ~{17: 2, 16: 8, 18: 1, 91: 4}[mvk])
            self.cdp.call("Input.dispatchKeyEvent",
                          {"type": "keyUp", "key": mk, "code": mc,
                           "windowsVirtualKeyCode": mvk, "nativeVirtualKeyCode": mvk,
                           "modifiers": held})
        return True

    @staticmethod
    def _key_descriptor(ch: str) -> dict:
        """Map a single printable character to a CDP key descriptor (F069).

        Returns ``key``/``code``/``windowsVirtualKeyCode`` so the dispatched event
        carries a faithful ``e.key`` and ``e.code`` (what per-key handlers read),
        not just inserted text."""
        if "0" <= ch <= "9":
            return {"key": ch, "code": "Digit" + ch,
                    "windowsVirtualKeyCode": ord(ch)}
        if "a" <= ch <= "z":
            return {"key": ch, "code": "Key" + ch.upper(),
                    "windowsVirtualKeyCode": ord(ch.upper())}
        if "A" <= ch <= "Z":
            return {"key": ch, "code": "Key" + ch,
                    "windowsVirtualKeyCode": ord(ch)}
        if ch == " ":
            return {"key": " ", "code": "Space", "windowsVirtualKeyCode": 32}
        return {"key": ch, "code": ""}

    def type_keys(self, text: str, hold: float = 0.0) -> bool:
        """Type ``text`` as a stream of **real per-key events** (F069). Segmented
        fields — an OTP/passcode strip, a credit-card group, a "type each digit"
        box — render one input per character and advance focus *inside a*
        ``keydown`` handler reading ``e.key``. ``type_text`` delivers the whole
        string with a single ``Input.insertText``: one ``input`` event on the first
        box, **no ``keydown`` at all**, so focus never hops and only box one ever
        sees anything. A human taps one key at a time and focus walks box to box. We
        do exactly that: for every character dispatch a real ``keyDown`` (carrying
        ``key``/``code``/``windowsVirtualKeyCode`` *and* the inserted ``text`` so
        normal fields still receive the char) then ``keyUp`` — whatever currently
        holds focus, including a box that just received it from its predecessor.
        Returns ``True``."""
        for ch in text:
            d = self._key_descriptor(ch)
            if "windowsVirtualKeyCode" in d:
                d["nativeVirtualKeyCode"] = d["windowsVirtualKeyCode"]
            self.cdp.call("Input.dispatchKeyEvent",
                          {**d, "type": "keyDown", "text": ch})
            self.cdp.call("Input.dispatchKeyEvent", {**d, "type": "keyUp"})
            if hold:
                time.sleep(hold)
        return True

    # ---- F009: native file chooser bypass --------------------------------- #
    def set_file_input(self, selector: str, files: list[str]) -> None:
        node = self.cdp.call("DOM.getDocument", {"depth": 0})
        root = node["root"]["nodeId"]
        q = self.cdp.call("DOM.querySelector", {"nodeId": root, "selector": selector})
        self.cdp.call("DOM.setFileInputFiles",
                      {"files": files, "nodeId": q["nodeId"]})

    # ---- F006: dialogs ---------------------------------------------------- #
    def expect_dialog(self, accept: bool = True, text: str = "") -> None:
        """Arm auto-handling for the next JS dialog (alert/confirm/prompt)."""
        self.cdp.auto_dialog = {"accept": accept, "text": text}

    def clear_dialog_policy(self) -> None:
        self.cdp.auto_dialog = None

    # ---- async waits (F043) ----------------------------------------------- #
    def wait_for(self, expr_js: str, timeout: float = 10.0, interval: float = 0.15):
        """Poll a JS boolean predicate until truthy (or timeout)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.eval(f"!!({expr_js})"):
                    return True
            except CDPError:
                pass
            time.sleep(interval)
        return False

    def wait_stable(self, expr_js: str, timeout: float = 10.0, settle: float = 0.5,
                    interval: float = 0.15):
        """Wait until a JS expression stops changing for ``settle`` seconds."""
        deadline = time.time() + timeout
        last = object()
        stable_since = None
        while time.time() < deadline:
            try:
                cur = self.eval(expr_js)
            except CDPError:
                cur = last
            if cur == last:
                if stable_since and (time.time() - stable_since) >= settle:
                    return cur
            else:
                last = cur
                stable_since = time.time()
            time.sleep(interval)
        return last if last is not object() else None

    def wait_change(self, expr_js: str, timeout: float = 10.0, settle: float = 0.4,
                    interval: float = 0.12):
        """Snapshot a value, wait until it *differs* and then *settles*.

        Born from F043 (datatables async sort): clicking a header re-renders the
        table asynchronously, so reading immediately returns the stale order.
        We snapshot, poll until the value changes, then wait for it to stop
        changing — returning the final settled value.
        """
        try:
            snapshot = self.eval(expr_js)
        except CDPError:
            snapshot = None
        deadline = time.time() + timeout
        changed = False
        last = snapshot
        stable_since = None
        while time.time() < deadline:
            try:
                cur = self.eval(expr_js)
            except CDPError:
                cur = last
            if not changed:
                if cur != snapshot:
                    changed = True
                    last = cur
                    stable_since = time.time()
            else:
                if cur == last:
                    if stable_since and (time.time() - stable_since) >= settle:
                        return {"changed": True, "before": snapshot, "after": cur}
                else:
                    last = cur
                    stable_since = time.time()
            time.sleep(interval)
        return {"changed": changed, "before": snapshot, "after": last}

    # ---- perception ------------------------------------------------------- #
    def screenshot(self, path: str) -> str:
        res = self.cdp.call("Page.captureScreenshot", {"format": "png"})
        with open(path, "wb") as f:
            f.write(base64.b64decode(res["data"]))
        return path

    def close(self) -> None:
        self.cdp.close()


if __name__ == "__main__":
    b = Browser()
    print("url:", b.navigate("https://example.com"))
    print("title:", b.title())
    print("h1:", b.get_text("h1"))
    b.close()
