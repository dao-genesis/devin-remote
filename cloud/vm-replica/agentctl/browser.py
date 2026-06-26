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
  return {visible, center, deepQuery, byText};
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

    def click(self, selector: str, by_text: bool = False, tag: str | None = None) -> bool:
        c = self._center_of(selector, by_text=by_text, tag=tag)
        if not c:
            return False
        self.click_xy(c["x"], c["y"])
        return True

    def click_text(self, text: str, tag: str | None = None) -> bool:
        return self.click(text, by_text=True, tag=tag)

    def hover(self, selector: str) -> bool:
        c = self._center_of(selector)
        if not c:
            return False
        self._move(c["x"], c["y"])
        return True

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
