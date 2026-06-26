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
