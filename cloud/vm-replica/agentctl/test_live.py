"""Live, end-to-end validation of agentctl primitives against a real Chrome.

This is not a mock suite.  Each round drives the *actual* browser on the CDP
endpoint and reads back observable state — the same loop the agent uses to
operate a GUI.  Friction surfaces that need determinism (JS dialogs, iframes,
file inputs, shadow DOM, async re-render) are served from local ``file://``
fixtures so the behaviour is reproducible; navigation/typing/clicking also run
against the public web when reachable.

Run:  python test_live.py            (all rounds)
      python test_live.py --offline  (skip rounds needing the public internet)
"""

from __future__ import annotations

import os
import sys
import tempfile
import time

# Results carry Unicode (CJK type-tests, em-dash detail separators). A legacy
# console codepage (e.g. cp1252 on Windows) would crash printing them, so force
# the streams to UTF-8 where the runtime supports it.
for _stream in (sys.stdout, sys.stderr):
    _rc = getattr(_stream, "reconfigure", None)
    if _rc is not None:
        _rc(encoding="utf-8", errors="backslashreplace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser  # noqa: E402
import osctl  # noqa: E402

FIX = tempfile.mkdtemp(prefix="agentctl_fix_")
_results: list[tuple[str, bool, str]] = []


def fixture(name: str, html: str) -> str:
    path = os.path.join(FIX, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    return "file:///" + path.replace("\\", "/")


def check(name: str, ok: bool, detail: str = "") -> bool:
    _results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    return ok


# --------------------------------------------------------------------------- #
def round_navigate_read(b: Browser, offline: bool) -> None:
    print("R1: navigate + semantic read")
    html = fixture("hello.html", "<!doctype html><title>R1</title><h1>hello agentctl</h1>")
    b.navigate(html)
    check("navigate arrives", b.title() == "R1", b.title())
    check("deep read h1", b.get_text("h1") == "hello agentctl", b.get_text("h1") or "")


def round_atomic_type(b: Browser, offline: bool) -> None:
    print("R2: atomic in-page typing + read-back (F002/F003)")
    html = fixture("type.html",
                   "<!doctype html><title>type</title><input id=q>"
                   "<div id=echo></div><script>q.addEventListener('input',"
                   "()=>echo.textContent=q.value)</script>")
    b.navigate(html)
    payload = "the quick brown fox \u4e2d\u6587 123"
    b.type_text("#q", payload)
    got = b.eval("document.getElementById('q').value")
    check("atomic type lands fully", got == payload, repr(got))
    check("input event fired (echo)", b.get_text("#echo") == payload)


def round_click_text(b: Browser, offline: bool) -> None:
    print("R3: click by visible text → state change")
    html = fixture("click.html",
                   "<!doctype html><title>click</title>"
                   "<button onclick=\"document.title='clicked!'\">Press Me</button>")
    b.navigate(html)
    check("found+clicked by text", b.click_text("Press Me"))
    check("click took effect", b.wait_for("document.title==='clicked!'", timeout=3))


def round_dialog(b: Browser, offline: bool) -> None:
    print("R4: JS dialog handling without deadlock (F006)")
    html = fixture("dialog.html",
                   "<!doctype html><title>dlg</title>"
                   "<script>function ask(){var r=confirm('go?');"
                   "document.title=r?'accepted':'dismissed';}</script>"
                   "<button onclick=ask()>ask</button>")
    b.navigate(html)
    b.expect_dialog(accept=True)
    b.click_text("ask")
    ok = b.wait_for("document.title==='accepted'", timeout=3)
    check("confirm accepted via off-thread handler", ok, b.title())
    b.clear_dialog_policy()


def round_frame(b: Browser, offline: bool) -> None:
    print("R5: cross-frame execution context (F008)")
    inner = fixture("inner.html",
                    "<!doctype html><title>inner</title><p id=msg>inside-iframe</p>")
    outer = fixture("outer.html",
                    f"<!doctype html><title>outer</title>"
                    f"<iframe src='{inner}'></iframe>")
    b.navigate(outer)
    time.sleep(0.5)
    # The top frame cannot read the child's #msg via document; only the iframe's
    # own execution context can. Find the context whose document has #msg.
    frame_ctx = None
    found = False
    for cid in list(b.cdp.contexts.keys()):
        try:
            val = b.cdp.evaluate(
                "document.getElementById('msg')?document.getElementById('msg').textContent:null",
                context_id=cid)
            if val == "inside-iframe":
                found = True
                frame_ctx = cid
                break
        except Exception:
            continue
    check("iframe context discovered + readable", found, f"ctx={frame_ctx}")


def round_file_input(b: Browser, offline: bool) -> None:
    print("R6: native file chooser bypass (F009)")
    # NB: avoid id="name" — it collides with the special global window.name
    # (always a string), so `name.textContent=...` would be a silent no-op.
    html = fixture("file.html",
                   "<!doctype html><title>file</title><input type=file id=f>"
                   "<div id=fname></div><script>f.addEventListener('change',"
                   "function(){document.getElementById('fname').textContent="
                   "f.files[0]?f.files[0].name:'';})</script>")
    b.navigate(html)
    sample = os.path.join(FIX, "upload_me.txt")
    with open(sample, "w") as fh:
        fh.write("payload")
    b.set_file_input("#f", [sample])
    check("file set without OS chooser",
          b.wait_for("document.getElementById('f').files.length===1", timeout=3))
    # setFileInputFiles dispatches 'change' asynchronously (like a real picker),
    # so observe the echo rather than reading instantly (same lesson as F043).
    check("change event carries filename",
          b.wait_for("document.getElementById('fname').textContent==='upload_me.txt'",
                     timeout=3),
          b.get_text("#fname") or "")


def round_shadow(b: Browser, offline: bool) -> None:
    print("R7: shadow DOM piercing (deep_query)")
    html = fixture("shadow.html",
                   "<!doctype html><title>shadow</title><div id=host></div>"
                   "<script>var r=host.attachShadow({mode:'open'});"
                   "r.innerHTML='<button class=deep>shadow-btn</button>';</script>")
    b.navigate(html)
    plain = b.eval("!!document.querySelector('.deep')")
    deep = b.exists(".deep")
    check("querySelector blind to shadow (expected)", plain is False, f"plain={plain}")
    check("deep_query pierces shadow root", deep is True, f"deep={deep}")


def round_async(b: Browser, offline: bool) -> None:
    print("R8: async re-render — wait_change settles on final value (F043)")
    html = fixture("async.html",
                   "<!doctype html><title>async</title><div id=v>start</div>"
                   "<button onclick=\"setTimeout(()=>v.textContent='final',600)\">go</button>")
    b.navigate(html)
    before = b.get_text("#v")
    b.click_text("go")
    res = b.wait_change("document.getElementById('v').textContent", timeout=4)
    check("wait_change observed transition", res.get("changed") and res.get("after") == "final",
          f"{before!r}->{res.get('after')!r}")


def round_omnibox(b: Browser, offline: bool) -> None:
    print("R9: OS-level omnibox atomic paste (F003/F005) — osctl channel")
    # Land somewhere known, then drive the *address bar* (outside the DOM) via OS input.
    html = fixture("seed.html", "<!doctype html><title>seed</title><h1>seed</h1>")
    b.navigate(html)
    target = fixture("omni_target.html", "<!doctype html><title>OMNI-OK</title><h1>omni</h1>")
    # Strip the file:/// scheme robustly: Chrome accepts the full file URL pasted in.
    osctl.omnibox_go(target)
    ok = b.wait_for("document.title==='OMNI-OK'", timeout=5)
    check("address-bar atomic paste navigated", ok, b.title())


def round_hover_menu(b: Browser, offline: bool) -> None:
    print("R10: hover-only menu reveal (F046)")
    html = fixture("hover.html",
                   "<!doctype html><title>hover</title><style>"
                   "#menu{position:absolute;top:40px;left:40px;width:120px;height:30px;background:#ccc}"
                   ".submenu{display:none;position:absolute;top:30px;left:0;width:150px;background:#eee}"
                   "#menu:hover .submenu{display:block}"
                   ".submenu button{display:block;width:100%;height:30px}</style>"
                   "<div id=menu>Menu<div class=submenu>"
                   "<button id=set onclick=\"document.title='SET-OK'\">Settings</button>"
                   "</div></div>")
    b.navigate(html)
    # Friction: the item is in the DOM but display:none, so a naive click_text
    # lands on the visible ancestor (#menu) and silently does nothing.
    check("submenu hidden before hover", b.is_visible(".submenu") is False)
    b.click_text("Settings")
    check("naive click misses hidden item (title unchanged)", b.title() == "hover", b.title())
    # Primitive: hover the trigger, wait for the reveal, then the item is hittable.
    check("hover_reveal opens menu", b.hover_reveal("#menu", ".submenu"))
    b.click_text("Settings")
    check("revealed item click took effect",
          b.wait_for("document.title==='SET-OK'", timeout=3), b.title())


def round_dnd(b: Browser, offline: bool) -> None:
    print("R11: HTML5 drag-and-drop (F047)")
    html = fixture("dnd.html",
                   "<!doctype html><title>dnd</title>"
                   "<div id=src draggable=true>DRAG</div><div id=dst>DROP HERE</div>"
                   "<script>"
                   "src.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','payload'));"
                   "dst.addEventListener('dragover',e=>e.preventDefault());"
                   "dst.addEventListener('drop',e=>{e.preventDefault();"
                   "document.title='DROP:'+e.dataTransfer.getData('text/plain')});"
                   "</script>")
    b.navigate(html)
    check("drop not yet fired", b.title() == "dnd", b.title())
    check("dnd dispatched", b.dnd("#src", "#dst"))
    check("drop handler ran with shared DataTransfer",
          b.wait_for("document.title==='DROP:payload'", timeout=3), b.title())


def round_virtual_scroll(b: Browser, offline: bool) -> None:
    print("R12: scroll-virtualized list (F048)")
    html = fixture("vlist.html",
                   "<!doctype html><title>vlist</title><style>"
                   "#vp{height:200px;width:200px;overflow:auto;border:1px solid #000;position:relative}"
                   ".row{position:absolute;height:20px;left:0;right:0}</style>"
                   "<div id=vp><div id=spacer></div></div><script>"
                   "var N=1000,H=20,vp=document.getElementById('vp'),sp=document.getElementById('spacer');"
                   "sp.style.height=(N*H)+'px';"
                   "function render(){var top=vp.scrollTop,first=Math.floor(top/H),"
                   "last=Math.min(N-1,Math.ceil((top+vp.clientHeight)/H));sp.innerHTML='';"
                   "for(var i=first;i<=last;i++){var d=document.createElement('div');"
                   "d.className='row';d.style.top=(i*H)+'px';d.textContent='Item '+i;"
                   "d.onclick=(function(k){return function(){document.title='CLICK:'+k}})(i);"
                   "sp.appendChild(d);}}"
                   "vp.addEventListener('scroll',render);render();</script>")
    b.navigate(html)
    # Friction: a far row is not in the DOM at all, so a naive click can't find it.
    check("far row absent before scroll",
          b.eval("!window.__agentctl.byText('Item 800')"))
    check("naive click_text fails on unrendered row", b.click_text("Item 800") is False)
    # Primitive: scroll the container until the row materializes, then click it.
    check("scroll_to_text materializes row", b.scroll_to_text("Item 800", container="#vp"))
    b.click_text("Item 800")
    check("clicked the scrolled-in row",
          b.wait_for("document.title==='CLICK:800'", timeout=3), b.title())
    # And a non-existent row fails fast (saturation guard, no infinite spin).
    check("missing row fails fast", b.scroll_to_text("Item 99999", container="#vp") is False)


def _serve(port: int, body: bytes):
    """Start a throwaway localhost HTTP server returning `body` for any GET."""
    import http.server
    import socketserver

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # silence
            pass

    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", port), H)
    import threading
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def round_xorigin_iframe(b: Browser, offline: bool) -> None:
    print("R13: cross-origin iframe read/act (F049)")
    # Two real origins: same IP, different port == cross-origin. The parent's JS
    # is walled off from the child by the same-origin policy.
    parent_port, child_port = 8901, 8902
    parent = (b"<!doctype html><title>xo-parent</title><h1>parent</h1>"
              b"<iframe id=f src='http://127.0.0.1:8902/c' "
              b"style='width:300px;height:120px'></iframe>")
    child = (b"<!doctype html><title>xo-child</title><body>"
             b"<div id=secret>CHILD-SECRET-42</div>"
             b"<button id=cb onclick=\"document.getElementById('secret')"
             b".textContent='CHILD-CLICKED'\">go</button></body>")
    sp = _serve(parent_port, parent)
    sc = _serve(child_port, child)
    try:
        b.navigate(f"http://127.0.0.1:{parent_port}/")
        time.sleep(0.3)
        # Friction: parent JS cannot reach into the cross-origin child.
        reach = b.eval("(function(){var f=document.getElementById('f');"
                       "try{return f.contentDocument?"
                       "f.contentDocument.getElementById('secret').textContent"
                       ":null}catch(e){return 'ERR'}})()")
        check("parent JS walled off from child (contentDocument null)",
              reach is None, repr(reach))
        check("deepQuery can't pierce cross-origin frame",
              b.eval("!window.__agentctl.deepQuery('#secret')"))
        # Primitive: address the child's own execution context via CDP.
        check("eval_in_frame reads across the origin barrier",
              b.eval_in_frame("8902", "document.getElementById('secret').textContent")
              == "CHILD-SECRET-42")
        check("eval_in_frame acts across the barrier (click)",
              b.eval_in_frame("8902", "document.getElementById('cb').click(); true")
              is True)
        check("child state changed by cross-origin action",
              b.eval_in_frame("8902", "document.getElementById('secret').textContent")
              == "CHILD-CLICKED")
        # A frame that doesn't exist fails fast rather than hanging.
        check("absent frame returns None fast",
              b.eval_in_frame("65535", "1", timeout=0.5) is None)
    finally:
        sp.shutdown()
        sc.shutdown()


def main() -> int:
    offline = "--offline" in sys.argv
    b = Browser()
    rounds = [round_navigate_read, round_atomic_type, round_click_text, round_dialog,
              round_frame, round_file_input, round_shadow, round_async, round_omnibox,
              round_hover_menu, round_dnd, round_virtual_scroll, round_xorigin_iframe]
    for r in rounds:
        try:
            r(b, offline)
        except Exception as e:
            check(r.__name__ + " (exception)", False, repr(e))
    b.close()

    passed = sum(1 for _, ok, _ in _results if ok)
    total = len(_results)
    print(f"\n=== {passed}/{total} checks passed ===")
    for name, ok, detail in _results:
        if not ok:
            print(f"  FAILED: {name} :: {detail}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
