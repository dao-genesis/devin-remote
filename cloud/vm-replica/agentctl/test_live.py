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

import math
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
    line = f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else "")
    # A non-UTF-8 console (e.g. cp1252) must not crash the suite on CJK details.
    enc = sys.stdout.encoding or "ascii"
    print(line.encode(enc, "backslashreplace").decode(enc))
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
    """Start a throwaway localhost HTTP server returning `body` for any GET.

    Uses a *threading* server with daemon worker threads: Chrome keeps the
    iframe socket alive (HTTP keep-alive), and a single-threaded server's
    ``shutdown()`` would then block behind that held connection — an intermittent
    deadlock at teardown. Daemon worker threads let ``shutdown()`` return at once.
    """
    import http.server
    import threading

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"  # no persistent connection to wait on

        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # silence
            pass

    http.server.ThreadingHTTPServer.allow_reuse_address = True
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
    httpd.daemon_threads = True
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


def round_canvas_pixel(b: Browser, offline: bool) -> None:
    print("R14: canvas target via the pixel channel (F050) — osctl")
    # A target painted on <canvas> has NO DOM node: deep_query / click_text are
    # blind to it. The only way in is to *see* the pixels and click the screen.
    html = fixture("canvas.html",
                   "<!doctype html><title>canvas</title>"
                   "<style>html,body{margin:0}</style>"
                   "<canvas id=c width=400 height=300 style='display:block'></canvas>"
                   "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                   "x.fillStyle='#ffffff';x.fillRect(0,0,400,300);"
                   "var RX=120,RY=90,RW=90,RH=70;"
                   "x.fillStyle='#ff00ff';x.fillRect(RX,RY,RW,RH);"
                   "c.addEventListener('click',function(e){"
                   "var r=c.getBoundingClientRect();"
                   "var px=e.clientX-r.left,py=e.clientY-r.top;"
                   "if(px>=RX&&px<=RX+RW&&py>=RY&&py<=RY+RH){"
                   "document.title='CANVAS-HIT';x.fillStyle='#00cc00';"
                   "x.fillRect(RX,RY,RW,RH);}else{"
                   "document.title='MISS';}});</script>")
    b.navigate(html)
    time.sleep(0.5)
    # Friction: nothing in the DOM marks the target — text/selector search fails.
    check("no DOM node for canvas-drawn target",
          b.eval("!window.__agentctl.byText('HIT') && "
                 "document.querySelectorAll('button,a').length===0"))
    check("click_text blind to pixel-only target", b.click_text("HIT") is False)
    # Pixel channel: capture the desktop, locate magenta, click its centroid.
    w, h, rgb = osctl.capture_rgb()
    check("capture matches click coordinate space", (w, h) == osctl.screen_size(),
          f"{(w, h)} vs {osctl.screen_size()}")
    hit = osctl.find_color((255, 0, 255), tol=40, rgb=rgb, size=(w, h))
    check("located magenta target by pixels", hit is not None and hit["count"] > 500,
          str(hit and {k: hit[k] for k in ("x", "y", "count")}))
    if hit:
        osctl.click(hit["x"], hit["y"])
        check("OS click on the seen pixel hit the canvas target",
              b.wait_for("document.title==='CANVAS-HIT'", timeout=3), b.title())
        time.sleep(0.3)
        # Confirm the state change *through the same pixel channel*: now green.
        green = osctl.find_color((0, 204, 0), tol=40)
        check("state change confirmed by pixels (target turned green)",
              green is not None and green["count"] > 500,
              str(green and green.get("count")))
    # A colour that isn't on screen is reported absent, not hallucinated.
    check("absent colour returns None",
          osctl.find_color((1, 2, 3), tol=0) is None)


def round_ime_compose(b: Browser, offline: bool) -> None:
    print("R15: CJK input via real IME composition (F051)")
    # A field gated on the composition lifecycle: it commits only on
    # compositionend and counts start/update/end. Atomic insertText sets the
    # value but fires none of these, so such a field never commits.
    html = fixture(
        "ime.html",
        "<!doctype html><meta charset=utf-8><title>ime</title>"
        "<input id=q><span id=out></span>"
        "<script>var q=document.getElementById('q'),o=document.getElementById('out'),"
        "S=0,U=0,E=0;"
        "q.addEventListener('compositionstart',function(){S++;});"
        "q.addEventListener('compositionupdate',function(){U++;});"
        "q.addEventListener('compositionend',function(e){E++;"
        "o.textContent='COMMITTED:'+e.data;});"
        "window.__ime=function(){return S+','+U+','+E;};</script>")
    b.navigate(html)
    time.sleep(0.3)
    val = lambda: b.eval("document.getElementById('q').value")  # noqa: E731
    out = lambda: b.eval("document.getElementById('out').textContent")  # noqa: E731
    cnt = lambda: b.eval("window.__ime()")  # noqa: E731
    # Friction: atomic insertText fills the value but skips composition entirely,
    # so the composition-gated field stays uncommitted.
    b.eval("document.getElementById('q').focus()")
    b.insert_text("\u4f60\u597d")
    time.sleep(0.15)
    check("insert_text fills value but fires no composition",
          val() == "\u4f60\u597d" and out() == "" and cnt() == "0,0,0", cnt())
    b.eval("var q=document.getElementById('q');q.value='';"
           "document.getElementById('out').textContent='';q.focus();")
    # Primitive: compose() drives the real IME lifecycle (romaji -> hanzi).
    ok = b.compose(None, "\u4f60\u597d", stages=["ni", "\u4f60", "\u4f60\u597d"])
    time.sleep(0.15)
    check("compose returns ok", ok is True)
    check("compose set the field value", val() == "\u4f60\u597d", repr(val()))
    s, u, e = (int(x) for x in cnt().split(","))
    check("composition lifecycle fired (start>=1, update>=1, end==1)",
          s >= 1 and u >= 1 and e == 1, cnt())
    check("field gated on compositionend now committed",
          out() == "COMMITTED:\u4f60\u597d", repr(out()))


def round_color_blobs(b: Browser, offline: bool) -> None:
    print("R16: disambiguate same-colour targets via segmentation (F052) — osctl")
    # Two identically-coloured squares. A flat colour locate averages all the
    # magenta into one centroid that lands in the gap between them — a target
    # that exists nowhere. Only segmentation recovers the two real regions.
    html = fixture(
        "blobs.html",
        "<!doctype html><title>blobs</title>"
        "<style>html,body{margin:0}</style>"
        "<canvas id=c width=600 height=260 style='display:block'></canvas>"
        "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
        "x.fillStyle='#ffffff';x.fillRect(0,0,600,260);"
        "var A=[60,90,80,80],B=[440,90,80,80];"  # decoy, target
        "x.fillStyle='#ff00ff';x.fillRect(A[0],A[1],A[2],A[3]);"
        "x.fillRect(B[0],B[1],B[2],B[3]);"
        "function inb(p,r){return p[0]>=r[0]&&p[0]<=r[0]+r[2]"
        "&&p[1]>=r[1]&&p[1]<=r[1]+r[3];}"
        "c.addEventListener('click',function(e){"
        "var r=c.getBoundingClientRect(),p=[e.clientX-r.left,e.clientY-r.top];"
        "if(inb(p,B)){document.title='TARGET-HIT';x.fillStyle='#00cc00';"
        "x.fillRect(B[0],B[1],B[2],B[3]);}"
        "else if(inb(p,A)){document.title='DECOY';}"
        "else{document.title='MISS';}});</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    merged = osctl.find_color((255, 0, 255), tol=40, rgb=rgb, size=(w, h))
    check("flat locate still finds the colour", merged is not None)
    blobs = osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rgb, size=(w, h),
                                   min_count=200)
    check("segmentation separates the two regions", len(blobs) == 2,
          str([bl["count"] for bl in blobs]))
    if merged and len(blobs) == 2:
        xs = sorted(bl["x"] for bl in blobs)
        # Friction: the flat centroid sits in the empty gap between the regions.
        check("flat centroid falls in the gap between the two regions",
              xs[0] < merged["x"] < xs[1], f"{xs} mid={merged['x']}")
        osctl.click(merged["x"], merged["y"])
        check("flat-centroid click hits neither target (lands in gap)",
              b.wait_for("document.title==='MISS'", timeout=3), b.title())
        # Primitive: choose the intended region (right-most) and click it.
        target = max(blobs, key=lambda bl: bl["x"])
        osctl.click(target["x"], target["y"])
        check("segmented click hits the intended right-most target",
              b.wait_for("document.title==='TARGET-HIT'", timeout=3), b.title())


def round_template_match(b: Browser, offline: bool) -> None:
    print("R17: pick same-colour target by appearance, not colour/position (F053) — osctl")
    # Two identically-coloured, identically-sized squares differing ONLY by the
    # black glyph inside. Colour-segmentation (F052) recovers both regions but
    # cannot say which is the target, and position is arbitrary — here the
    # target sits on the LEFT, so the R16 "right-most" heuristic picks the DECOY.
    # Only matching a reference patch by appearance resolves it.
    cross = ("x.fillStyle='#000';x.fillRect(X+34,Y+12,12,56);"
             "x.fillRect(X+12,Y+34,56,12);")
    tri = ("x.fillStyle='#000';x.beginPath();x.moveTo(X+40,Y+14);"
           "x.lineTo(X+66,Y+66);x.lineTo(X+14,Y+66);x.closePath();x.fill();")
    # Phase 1: render the target glyph ALONE and capture it as a reference patch.
    proto = fixture("proto.html",
                    "<!doctype html><title>proto</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=300 height=200 style='display:block'></canvas>"
                    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                    "x.fillStyle='#fff';x.fillRect(0,0,300,200);"
                    "var X=110,Y=60;x.fillStyle='#ff00ff';x.fillRect(X,Y,80,80);" + cross
                    + "</script>")
    b.navigate(proto)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    sq = osctl.find_color((255, 0, 255), tol=40, rgb=rgb, size=(w, h))
    check("captured a reference square", sq is not None and sq["count"] > 500)
    patch, pw, ph = osctl.crop_rgb(rgb, (w, h), sq["bbox"])
    check("reference patch cropped", pw > 40 and ph > 40, f"{pw}x{ph}")
    # Phase 2: target(cross) LEFT, decoy(triangle) RIGHT.
    scene = fixture("scene.html",
                    "<!doctype html><title>scene</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=600 height=260 style='display:block'></canvas>"
                    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                    "x.fillStyle='#fff';x.fillRect(0,0,600,260);"
                    "var TGT=[80,90,80,80],DEC=[440,90,80,80];"
                    "x.fillStyle='#ff00ff';x.fillRect(TGT[0],TGT[1],80,80);"
                    "x.fillRect(DEC[0],DEC[1],80,80);"
                    "var X=TGT[0],Y=TGT[1];" + cross + "X=DEC[0];Y=DEC[1];" + tri +
                    "function inb(p,r){return p[0]>=r[0]&&p[0]<=r[0]+r[2]"
                    "&&p[1]>=r[1]&&p[1]<=r[1]+r[3];}"
                    "c.addEventListener('click',function(e){"
                    "var r=c.getBoundingClientRect(),p=[e.clientX-r.left,e.clientY-r.top];"
                    "if(inb(p,TGT)){document.title='TARGET-HIT';}"
                    "else if(inb(p,DEC)){document.title='DECOY';}"
                    "else{document.title='MISS';}});</script>")
    b.navigate(scene)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    blobs = osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rgb, size=(w, h),
                                   min_count=200)
    check("two same-colour candidates found", len(blobs) == 2,
          str([bl["x"] for bl in blobs]))
    if len(blobs) == 2:
        # Friction: the position heuristic (right-most) lands on the DECOY.
        right = max(blobs, key=lambda bl: bl["x"])
        osctl.click(right["x"], right["y"])
        check("right-most heuristic picks the wrong (decoy) square",
              b.wait_for("document.title==='DECOY'", timeout=3), b.title())
        b.eval("document.title='scene'")
        # Primitive: score each candidate by appearance; lowest SAD wins.
        scored = []
        for bl in blobs:
            x0, y0, x1, y1 = bl["bbox"]
            m = osctl.match_template(patch, pw, ph, rgb=rgb, size=(w, h),
                                     search=(x0 - 6, y0 - 6, x1 + 6, y1 + 6), step=2)
            if m:
                scored.append((m, bl))
        check("template matched every candidate", len(scored) == 2)
        best, _bl = min(scored, key=lambda t: t[0]["score"])
        worst = max(scored, key=lambda t: t[0]["score"])[0]
        check("target (cross) scores far below decoy (triangle)",
              best["score"] * 4 < worst["score"],
              f"best={best['score']} worst={worst['score']}")
        check("best match is the left target, not the right-most",
              best["x"] < right["x"], f"match_x={best['x']} rightmost_x={right['x']}")
        osctl.click(best["x"], best["y"])
        check("appearance-matched click hits the intended target",
              b.wait_for("document.title==='TARGET-HIT'", timeout=3), b.title())


def round_settle(b: Browser, offline: bool) -> None:
    print("R18: act on a moving target only once it settles (F054) — osctl")
    # A magenta square toggles between two far-apart spots every 180ms for ~1.6s,
    # then comes to rest at a third. Every primitive so far reads ONE capture —
    # but a single snapshot is already stale by the time the OS click lands,
    # because the square has moved on. Only sampling until motion stops recovers
    # the real target. (Two non-overlapping spots make the miss deterministic:
    # once the square has moved, the old coordinate cannot hit it.)
    scene = fixture("settle.html",
                    "<!doctype html><title>settle</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=600 height=320 style='display:block'></canvas>"
                    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                    "var S=60,A=[40,40],B=[480,220],FINAL=[250,130],cur=A,t0=Date.now(),f=0;"
                    "function draw(p){cur=p;x.fillStyle='#fff';x.fillRect(0,0,600,320);"
                    "x.fillStyle='#ff00ff';x.fillRect(p[0],p[1],S,S);}draw(cur);"
                    "var iv=setInterval(function(){"
                    "if(Date.now()-t0>1600){draw(FINAL);clearInterval(iv);window.__settled=1;return;}"
                    "f^=1;draw(f?B:A);},180);"
                    "c.addEventListener('click',function(e){"
                    "var r=c.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;"
                    "if(px>=cur[0]&&px<=cur[0]+S&&py>=cur[1]&&py<=cur[1]+S){document.title='HIT';}"
                    "else{document.title='MISS';}});</script>")
    b.navigate(scene)
    time.sleep(0.25)
    # Friction: capture the target now, while it animates. Acting on that one
    # snapshot LATER (the unavoidable perceive→act gap; here we let the motion
    # finish) lands on where the target *was*, never where it came to rest.
    w, h, rgb = osctl.capture_rgb()
    loc = osctl.find_color((255, 0, 255), tol=40, rgb=rgb, size=(w, h))
    check("single capture located the moving target", loc is not None)
    if loc:
        b.wait_for("window.__settled===1", timeout=4)  # the target comes to rest
        osctl.click(loc["x"], loc["y"])
        check("stale single-capture click misses the now-rested target",
              b.wait_for("document.title==='MISS'", timeout=2), b.title())
    b.eval("document.title='settle'")
    b.navigate(scene)  # replay the animation from the start
    time.sleep(0.25)
    # Primitive: sample until the target stops moving, then act on the rest spot.
    st = osctl.wait_stable((255, 0, 255), tol=40, timeout=6.0)
    check("wait_stable reports the target settled", bool(st and st.get("settled")),
          f"samples={st.get('samples') if st else None}")
    check("animation had actually finished when we acted",
          bool(b.eval("window.__settled||0")))
    if st:
        osctl.click(st["x"], st["y"])
        check("settled click hits the now-stationary target",
              b.wait_for("document.title==='HIT'", timeout=2), b.title())


def round_structure_match(b: Browser, offline: bool) -> None:
    print("R19: pick a colour-shifted target by structure, not appearance (F055) — osctl")
    # Two magenta tiles (segmentable), each holding a black glyph drawn in a
    # DIFFERENT colour from the reference. The LEFT tile is the SAME shape as the
    # reference (a ring) but recoloured; the RIGHT tile is a DIFFERENT shape (a
    # disk) in the reference's own colour. Absolute-luma matching (R17) is
    # dominated by the colour shift, so it picks the wrong tile; only matching on
    # edges — where shape lives, invariant to fill colour — resolves it.
    ring = ("function ring(cx,cy,col){x.fillStyle=col;x.beginPath();"
            "x.arc(cx,cy,40,0,7);x.fill();x.fillStyle='#ff00ff';"
            "x.beginPath();x.arc(cx,cy,20,0,7);x.fill();}")
    disk = ("function disk(cx,cy,col){x.fillStyle=col;x.beginPath();"
            "x.arc(cx,cy,40,0,7);x.fill();}")
    # Phase 1: reference = a ring in WHITE on a magenta tile, captured alone.
    proto = fixture("estruct.html",
                    "<!doctype html><title>estruct</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=300 height=240 style='display:block'></canvas>"
                    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                    "x.fillStyle='#fff';x.fillRect(0,0,300,240);" + ring +
                    "x.fillStyle='#ff00ff';x.fillRect(60,50,120,120);ring(120,110,'#fff');"
                    "</script>")
    b.navigate(proto)
    time.sleep(0.5)
    rw, rh, rrgb = osctl.capture_rgb()
    rb = osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rrgb, size=(rw, rh),
                                min_count=200)
    rb = [bl for bl in rb if bl["bbox"][2] - bl["bbox"][0] > 80
          and bl["bbox"][3] - bl["bbox"][1] > 80]
    check("captured a reference tile", len(rb) == 1, str([bl["x"] for bl in rb]))
    if not rb:
        return
    ref = rb[0]
    patch, pw, ph = osctl.crop_rgb(rrgb, (rw, rh), ref["bbox"])
    ref_e, ew, eh = osctl.edge_map(rrgb, (rw, rh), ref["bbox"])
    check("reference edge mask has structure", sum(ref_e) > 100, str(sum(ref_e)))
    # Phase 2: target = ring in BLACK (same shape, shifted colour) LEFT;
    #          decoy  = disk in WHITE (different shape, reference colour) RIGHT.
    scene = fixture("escene.html",
                    "<!doctype html><title>escene</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=640 height=240 style='display:block'></canvas>"
                    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                    "x.fillStyle='#fff';x.fillRect(0,0,640,240);" + ring + disk +
                    "var TGT=[60,50,120,120],DEC=[460,50,120,120];"
                    "x.fillStyle='#ff00ff';x.fillRect(TGT[0],TGT[1],120,120);"
                    "x.fillStyle='#ff00ff';x.fillRect(DEC[0],DEC[1],120,120);"
                    "ring(120,110,'#000');disk(520,110,'#fff');"
                    "function inb(p,r){return p[0]>=r[0]&&p[0]<=r[0]+r[2]"
                    "&&p[1]>=r[1]&&p[1]<=r[1]+r[3];}"
                    "c.addEventListener('click',function(e){"
                    "var r=c.getBoundingClientRect(),p=[e.clientX-r.left,e.clientY-r.top];"
                    "if(inb(p,TGT)){document.title='TARGET-HIT';}"
                    "else if(inb(p,DEC)){document.title='DECOY';}"
                    "else{document.title='MISS';}});</script>")
    b.navigate(scene)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    blobs = osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rgb, size=(w, h),
                                   min_count=200)
    blobs = [bl for bl in blobs if bl["bbox"][2] - bl["bbox"][0] > 80
             and bl["bbox"][3] - bl["bbox"][1] > 80]
    check("two same-tile-colour candidates found", len(blobs) == 2,
          str([bl["x"] for bl in blobs]))
    if len(blobs) != 2:
        return
    blobs.sort(key=lambda bl: bl["x"])
    target_blob, decoy_blob = blobs[0], blobs[1]
    # Friction: appearance (luma SAD) is dominated by the colour shift, so the
    # target (same shape, recoloured) scores WORSE than the decoy.
    luma = []
    for bl in blobs:
        x0, y0, x1, y1 = bl["bbox"]
        m = osctl.match_template(patch, pw, ph, rgb=rgb, size=(w, h),
                                 search=(x0 - 4, y0 - 4, x1 + 4, y1 + 4), step=2)
        luma.append((m, bl))
    luma_best = min(luma, key=lambda t: t[0]["score"])[1]
    check("luma-match is fooled: it picks the decoy (wrong shape, right colour)",
          luma_best is decoy_blob,
          f"luma chose x={luma_best['x']} target_x={target_blob['x']}")
    # Primitive: edge (structure) matching survives the colour shift.
    edge = []
    for bl in blobs:
        x0, y0, x1, y1 = bl["bbox"]
        m = osctl.match_edges(ref_e, ew, eh, rgb=rgb, size=(w, h),
                              search=(x0 - 4, y0 - 4, x1 + 4, y1 + 4), step=2)
        edge.append((m, bl))
    check("edge matched every candidate", all(m for m, _ in edge))
    edge_best_m, edge_best = min(edge, key=lambda t: t[0]["score"])
    edge_worst = max(edge, key=lambda t: t[0]["score"])[0]
    check("target (same shape) scores below decoy on edges",
          edge_best_m["score"] < edge_worst["score"],
          f"best={edge_best_m['score']} worst={edge_worst['score']}")
    check("edge-match picks the colour-shifted target, not the decoy",
          edge_best is target_blob,
          f"edge chose x={edge_best['x']} target_x={target_blob['x']}")
    osctl.click(edge_best_m["x"], edge_best_m["y"])
    check("structure-matched click hits the colour-shifted target",
          b.wait_for("document.title==='TARGET-HIT'", timeout=3), b.title())


def round_scale_invariant(b: Browser, offline: bool) -> None:
    print("R20: pick a rescaled target by canonical signature, not fixed size (F056) — osctl")
    # The reference shape (a ring) reappears LARGER (a zoom / DPI / re-layout),
    # beside a DIFFERENT shape (a disk) at the reference's own size. match_edges
    # (R19) uses a fixed-size mask, so the bigger-but-correct shape no longer
    # aligns and the same-size-but-wrong shape wins. Reducing each candidate to a
    # canonical edge signature removes the size dependence.
    ring = ("function ring(cx,cy,r,col){x.fillStyle=col;x.beginPath();"
            "x.arc(cx,cy,r,0,7);x.fill();x.fillStyle='#ff00ff';"
            "x.beginPath();x.arc(cx,cy,r/2,0,7);x.fill();}")
    disk = ("function disk(cx,cy,r,col){x.fillStyle=col;x.beginPath();"
            "x.arc(cx,cy,r,0,7);x.fill();}")
    # Phase 1: reference ring on a 120 tile, captured alone.
    proto = fixture("scstruct.html",
                    "<!doctype html><title>scstruct</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=300 height=260 style='display:block'></canvas>"
                    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                    "x.fillStyle='#fff';x.fillRect(0,0,300,260);" + ring +
                    "x.fillStyle='#ff00ff';x.fillRect(60,60,120,120);ring(120,120,40,'#fff');"
                    "</script>")
    b.navigate(proto)
    time.sleep(0.5)
    rw, rh, rrgb = osctl.capture_rgb()
    rb = [bl for bl in osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rrgb,
                                              size=(rw, rh), min_count=200)
          if bl["bbox"][2] - bl["bbox"][0] > 80 and bl["bbox"][3] - bl["bbox"][1] > 80]
    check("captured a reference tile", len(rb) == 1, str([bl["x"] for bl in rb]))
    if not rb:
        return
    ref = rb[0]
    ref_e, ew, eh = osctl.edge_map(rrgb, (rw, rh), ref["bbox"])
    ref_sig = osctl.edge_signature(rrgb, (rw, rh), ref["bbox"])
    check("reference signature has structure", sum(ref_sig) > 80, str(sum(ref_sig)))
    # Phase 2: target = SAME ring, bigger (180 tile, r60) LEFT;
    #          decoy  = disk at the reference size (120 tile, r40) RIGHT.
    scene = fixture("scscene.html",
                    "<!doctype html><title>scscene</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=760 height=260 style='display:block'></canvas>"
                    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                    "x.fillStyle='#fff';x.fillRect(0,0,760,260);" + ring + disk +
                    "var TGT=[40,40,180,180],DEC=[560,70,120,120];"
                    "x.fillStyle='#ff00ff';x.fillRect(TGT[0],TGT[1],180,180);"
                    "x.fillStyle='#ff00ff';x.fillRect(DEC[0],DEC[1],120,120);"
                    "ring(130,130,60,'#fff');disk(620,130,40,'#fff');"
                    "function inb(p,r){return p[0]>=r[0]&&p[0]<=r[0]+r[2]"
                    "&&p[1]>=r[1]&&p[1]<=r[1]+r[3];}"
                    "c.addEventListener('click',function(e){"
                    "var r=c.getBoundingClientRect(),p=[e.clientX-r.left,e.clientY-r.top];"
                    "if(inb(p,TGT)){document.title='TARGET-HIT';}"
                    "else if(inb(p,DEC)){document.title='DECOY';}"
                    "else{document.title='MISS';}});</script>")
    b.navigate(scene)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    blobs = [bl for bl in osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rgb,
                                                 size=(w, h), min_count=200)
             if bl["bbox"][2] - bl["bbox"][0] > 80 and bl["bbox"][3] - bl["bbox"][1] > 80]
    check("two candidates of different sizes found", len(blobs) == 2,
          str([(bl["x"], bl["bbox"][2] - bl["bbox"][0] + 1) for bl in blobs]))
    if len(blobs) != 2:
        return
    blobs.sort(key=lambda bl: bl["x"])
    target_blob, decoy_blob = blobs[0], blobs[1]
    check("target is larger than the reference, decoy is reference-sized",
          (target_blob["bbox"][2] - target_blob["bbox"][0] + 1) > ew + 20
          and abs((decoy_blob["bbox"][2] - decoy_blob["bbox"][0] + 1) - ew) < 20,
          f"tgt={target_blob['bbox'][2]-target_blob['bbox'][0]+1} dec={decoy_blob['bbox'][2]-decoy_blob['bbox'][0]+1} ref={ew}")
    # Friction: a fixed-size edge mask cannot match the rescaled target.
    fixed = []
    for bl in blobs:
        cand, _, _ = osctl.edge_map(rgb, (w, h), bl["bbox"])
        n = min(len(ref_e), len(cand))
        fixed.append((osctl.edge_hamming(ref_e[:n], cand[:n]) + abs(len(ref_e) - len(cand)), bl))
    fixed_best = min(fixed, key=lambda t: t[0])[1]
    check("fixed-size edge-match is fooled: it picks the reference-sized decoy",
          fixed_best is decoy_blob,
          f"fixed chose x={fixed_best['x']} target_x={target_blob['x']}")
    # Primitive: canonical signature is size-independent.
    sig = []
    for bl in blobs:
        s = osctl.edge_signature(rgb, (w, h), bl["bbox"])
        sig.append((osctl.edge_hamming(ref_sig, s), bl))
    sig_best_score, sig_best = min(sig, key=lambda t: t[0])
    sig_worst = max(sig, key=lambda t: t[0])[0]
    check("rescaled target scores below decoy on signature",
          sig_best_score < sig_worst,
          f"best={sig_best_score} worst={sig_worst}")
    check("signature-match picks the rescaled target, not the decoy",
          sig_best is target_blob,
          f"sig chose x={sig_best['x']} target_x={target_blob['x']}")
    osctl.click(sig_best["x"], sig_best["y"])
    check("signature-matched click hits the rescaled target",
          b.wait_for("document.title==='TARGET-HIT'", timeout=3), b.title())


def round_rotation_invariant(b: Browser, offline: bool) -> None:
    print("R21: pick a rotated target by radial profile, not fixed orientation (F057) — osctl")
    # The reference glyph (a horizontal bar) reappears ROTATED 90° — now vertical
    # — beside a DIFFERENT glyph (a wide ellipse) left at the reference's own
    # orientation. edge_signature (R20) resamples to a fixed grid, so the turned
    # bar lands on entirely different cells and the same-orientation ellipse scores
    # a closer signature. A radial profile (edge mass vs distance-from-centroid) is
    # unchanged by rotation, so it recognises the turned bar.
    bar = ("function bar(cx,cy,hw,hh,rot,col){x.save();x.translate(cx,cy);x.rotate(rot);"
           "x.fillStyle=col;x.fillRect(-hw,-hh,2*hw,2*hh);x.restore();}")
    ell = ("function ell(cx,cy,rx,ry,col){x.save();x.translate(cx,cy);x.scale(rx/ry,1);"
           "x.fillStyle=col;x.beginPath();x.arc(0,0,ry,0,7);x.fill();x.restore();}")
    # Phase 1: reference horizontal bar on a 160 tile, captured alone.
    proto = fixture("rtstruct.html",
                    "<!doctype html><title>rtstruct</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=320 height=300 style='display:block'></canvas>"
                    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                    "x.fillStyle='#fff';x.fillRect(0,0,320,300);" + bar +
                    "x.fillStyle='#ff00ff';x.fillRect(50,50,160,160);bar(130,130,62,22,0,'#fff');"
                    "</script>")
    b.navigate(proto)
    time.sleep(0.5)
    rw, rh, rrgb = osctl.capture_rgb()
    rb = [bl for bl in osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rrgb,
                                              size=(rw, rh), min_count=200)
          if bl["bbox"][2] - bl["bbox"][0] > 90 and bl["bbox"][3] - bl["bbox"][1] > 90]
    check("captured a reference tile", len(rb) == 1, str([bl["x"] for bl in rb]))
    if not rb:
        return
    ref = rb[0]
    ref_sig = osctl.edge_signature(rrgb, (rw, rh), ref["bbox"])
    ref_rad = osctl.radial_profile(rrgb, (rw, rh), ref["bbox"])
    check("reference radial profile is populated", abs(sum(ref_rad) - 1.0) < 1e-6
          and max(ref_rad) > 0, f"sum={sum(ref_rad):.3f}")
    # Phase 2: target = SAME bar rotated 90° (vertical) LEFT; decoy = wide ellipse RIGHT.
    scene = fixture("rtscene.html",
                    "<!doctype html><title>rtscene</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=760 height=300 style='display:block'></canvas>"
                    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                    "x.fillStyle='#fff';x.fillRect(0,0,760,300);" + bar + ell +
                    "var TGT=[40,60,160,160],DEC=[520,60,160,160];"
                    "x.fillStyle='#ff00ff';x.fillRect(TGT[0],TGT[1],160,160);"
                    "x.fillStyle='#ff00ff';x.fillRect(DEC[0],DEC[1],160,160);"
                    "bar(120,140,62,22,Math.PI/2,'#fff');ell(600,140,62,22,'#fff');"
                    "function inb(p,r){return p[0]>=r[0]&&p[0]<=r[0]+r[2]"
                    "&&p[1]>=r[1]&&p[1]<=r[1]+r[3];}"
                    "c.addEventListener('click',function(e){"
                    "var r=c.getBoundingClientRect(),p=[e.clientX-r.left,e.clientY-r.top];"
                    "if(inb(p,TGT)){document.title='TARGET-HIT';}"
                    "else if(inb(p,DEC)){document.title='DECOY';}"
                    "else{document.title='MISS';}});</script>")
    b.navigate(scene)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    blobs = [bl for bl in osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rgb,
                                                 size=(w, h), min_count=200)
             if bl["bbox"][2] - bl["bbox"][0] > 90 and bl["bbox"][3] - bl["bbox"][1] > 90]
    check("two same-size candidates found", len(blobs) == 2, str([bl["x"] for bl in blobs]))
    if len(blobs) != 2:
        return
    blobs.sort(key=lambda bl: bl["x"])
    target_blob, decoy_blob = blobs[0], blobs[1]
    # Friction: a fixed-orientation signature is fooled by the 90° turn.
    sig = []
    for bl in blobs:
        sig.append((osctl.edge_hamming(ref_sig, osctl.edge_signature(rgb, (w, h), bl["bbox"])), bl))
    sig_best = min(sig, key=lambda t: t[0])[1]
    check("signature-match is fooled: it picks the same-orientation decoy",
          sig_best is decoy_blob,
          f"sig chose x={sig_best['x']} target_x={target_blob['x']}")
    # Primitive: radial profile is rotation-invariant.
    rad = []
    for bl in blobs:
        rad.append((osctl.profile_l1(ref_rad, osctl.radial_profile(rgb, (w, h), bl["bbox"])), bl))
    rad_best_score, rad_best = min(rad, key=lambda t: t[0])
    rad_worst = max(rad, key=lambda t: t[0])[0]
    check("rotated target scores below decoy on radial profile",
          rad_best_score < rad_worst,
          f"best={rad_best_score:.3f} worst={rad_worst:.3f}")
    check("radial-profile-match picks the rotated target, not the decoy",
          rad_best is target_blob,
          f"radial chose x={rad_best['x']} target_x={target_blob['x']}")
    osctl.click(rad_best["x"], rad_best["y"])
    check("rotation-invariant click hits the rotated target",
          b.wait_for("document.title==='TARGET-HIT'", timeout=3), b.title())


def round_read_glyph(b: Browser, offline: bool) -> None:
    print("R22: pick the control that READS the right glyph, not just its colour/shape (F058) — osctl")
    # Two magenta buttons, same colour, same size, same outer shape. The ONLY
    # difference is the white GLYPH the page draws on each ("A" vs "B"). We hold a
    # reference ATLAS of candidate glyphs, but rendered SMALLER than the live
    # buttons. A fixed-size edge match against the atlas is fooled by the size gap
    # (reads every tile as the same letter); read_glyph classifies in the
    # scale-free frame and reads each button correctly.
    def tiles(rgb, w, h):
        return [bl for bl in osctl.find_color_blobs((255, 0, 255), tol=40, rgb=rgb,
                                                    size=(w, h), min_count=200)
                if bl["bbox"][2] - bl["bbox"][0] > 60 and bl["bbox"][3] - bl["bbox"][1] > 60]
    # Phase 1: atlas — candidate glyphs A and B rendered SMALL (110 tiles, 80px font).
    atlas_html = fixture("glyphatlas.html",
                         "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
                         "<canvas id=c width=520 height=200></canvas><script>"
                         "var x=document.getElementById('c').getContext('2d');"
                         "x.fillStyle='#fff';x.fillRect(0,0,520,200);"
                         "function t(ox,ch){x.fillStyle='#ff00ff';x.fillRect(ox,30,110,110);"
                         "x.fillStyle='#fff';x.font='bold 80px sans-serif';x.textAlign='center';"
                         "x.textBaseline='middle';x.fillText(ch,ox+55,88);}"
                         "t(40,'A');t(300,'B');</script>")
    b.navigate(atlas_html)
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    at = sorted(tiles(argb, aw, ah), key=lambda t: t["x"])
    check("atlas segments into two reference glyphs", len(at) == 2, str([t["x"] for t in at]))
    if len(at) != 2:
        return
    atlas = {"A": osctl.edge_signature(argb, (aw, ah), at[0]["bbox"]),
             "B": osctl.edge_signature(argb, (aw, ah), at[1]["bbox"])}
    atlas_edge = {}
    for ch, t in (("A", at[0]), ("B", at[1])):
        e, _ew, _eh = osctl.edge_map(argb, (aw, ah), t["bbox"])
        atlas_edge[ch] = e
    # Phase 2: scene — buttons LARGE (170 tiles, 120px font). LEFT='A' (target), RIGHT='B'.
    scene = fixture("glyphscene.html",
                    "<!doctype html><title>scene</title><style>html,body{margin:0}</style>"
                    "<canvas id=c width=760 height=320></canvas><script>"
                    "var c=document.getElementById('c'),x=c.getContext('2d');"
                    "x.fillStyle='#fff';x.fillRect(0,0,760,320);"
                    "var L=[40,70,170,170],R=[520,70,170,170];"
                    "function t(r,ch){x.fillStyle='#ff00ff';x.fillRect(r[0],r[1],r[2],r[3]);"
                    "x.fillStyle='#fff';x.font='bold 120px sans-serif';x.textAlign='center';"
                    "x.textBaseline='middle';x.fillText(ch,r[0]+r[2]/2,r[1]+r[3]/2);}"
                    "t(L,'A');t(R,'B');"
                    "function inb(p,r){return p[0]>=r[0]&&p[0]<=r[0]+r[2]&&p[1]>=r[1]&&p[1]<=r[1]+r[3];}"
                    "c.addEventListener('click',function(e){var b=c.getBoundingClientRect(),"
                    "p=[e.clientX-b.left,e.clientY-b.top];"
                    "document.title=inb(p,L)?'TARGET-HIT':inb(p,R)?'DECOY':'MISS';});</script>")
    b.navigate(scene)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    ts = sorted(tiles(rgb, w, h), key=lambda t: t["x"])
    check("two same-colour, same-size buttons found", len(ts) == 2, str([t["x"] for t in ts]))
    if len(ts) != 2:
        return
    target_tile, decoy_tile = ts[0], ts[1]
    check("buttons are larger than the atlas glyphs",
          (target_tile["bbox"][2] - target_tile["bbox"][0]) > (at[0]["bbox"][2] - at[0]["bbox"][0]) + 30,
          f"btn={target_tile['bbox'][2]-target_tile['bbox'][0]} atlas={at[0]['bbox'][2]-at[0]['bbox'][0]}")
    # Friction: fixed-size edge match against the atlas mis-reads the decoy.
    def fixed_read(tile):
        e, _ew, _eh = osctl.edge_map(rgb, (w, h), tile["bbox"])
        sc = {}
        for ch, ae in atlas_edge.items():
            n = min(len(ae), len(e))
            sc[ch] = osctl.edge_hamming(ae[:n], e[:n]) + abs(len(ae) - len(e))
        return min(sc, key=sc.get)
    check("fixed-size match mis-reads: it cannot tell the two glyphs apart",
          fixed_read(target_tile) == fixed_read(decoy_tile),
          f"target->{fixed_read(target_tile)} decoy->{fixed_read(decoy_tile)}")
    # Primitive: read_glyph classifies in the scale-free frame.
    check("read_glyph reads the target button as 'A'",
          osctl.read_glyph(rgb, (w, h), target_tile["bbox"], atlas) == "A",
          osctl.read_glyph(rgb, (w, h), target_tile["bbox"], atlas))
    check("read_glyph reads the decoy button as 'B'",
          osctl.read_glyph(rgb, (w, h), decoy_tile["bbox"], atlas) == "B",
          osctl.read_glyph(rgb, (w, h), decoy_tile["bbox"], atlas))
    pick = target_tile if osctl.read_glyph(rgb, (w, h), target_tile["bbox"], atlas) == "A" else decoy_tile
    osctl.click(pick["x"], pick["y"])
    check("glyph-read click hits the button that says 'A'",
          b.wait_for("document.title==='TARGET-HIT'", timeout=3), b.title())


def round_oop_iframe(b: Browser, offline: bool) -> None:
    print("R23: reach an out-of-process (cross-SITE) iframe by per-session routing (F059) — cdp")
    if offline:
        check("oop iframe skipped offline (needs public internet)", True)
        return
    # A cross-SITE child (real public origin) is put in its *own* renderer
    # process by Chrome site isolation — unlike R13's same-IP/different-port
    # child, which is merely cross-origin and shares the page's process. The
    # OOP child's execution context never appears on the page session, so the
    # F049 path (which only knows page-session contexts) is blind to it.
    parent = (b"<!doctype html><title>oop-parent</title><h1>parent</h1>"
              b"<iframe id=f src='https://example.com' "
              b"style='width:600px;height:400px'></iframe>")
    sp = _serve(8911, parent)
    try:
        try:
            b.navigate("http://127.0.0.1:8911/", timeout=20)
        except Exception as e:
            check("oop iframe skipped (no internet to load cross-site child)",
                  True, repr(e))
            return
        ok = b.wait_frame("example.com", timeout=8) is not None
        if not ok:
            check("oop iframe skipped (cross-site child did not load)", True)
            return
        # Precondition: the cross-site child really mounted in the parent.
        check("cross-site child present in parent",
              b.eval("window.frames.length") == 1,
              repr(b.eval("window.frames.length")))
        # Friction: parent JS is walled off, AND the child registered under its
        # own session — proof it is out-of-process, not merely cross-origin.
        reach = b.eval("(function(){var f=document.getElementById('f');"
                       "try{return f.contentDocument?'OPEN':null}"
                       "catch(e){return 'ERR'}})()")
        check("parent JS walled off from OOP child", reach is None, repr(reach))
        key = b._frame_context("example.com")
        check("OOP child lives in its own attached session",
              isinstance(key, str) and ":" in key, repr(key))
        # Primitive: auto-attach + per-session routing reaches into the child's
        # own renderer over the one connection.
        check("eval_in_frame reads across the process boundary",
              b.eval_in_frame("example.com",
                              "document.querySelector('h1').textContent")
              == "Example Domain")
        check("eval_in_frame acts across the process boundary",
              b.eval_in_frame("example.com",
                              "document.querySelector('h1').textContent='OOP-EDIT';true")
              is True)
        check("OOP child state changed by cross-process action",
              b.eval_in_frame("example.com",
                              "document.querySelector('h1').textContent")
              == "OOP-EDIT")
        # An absent frame still fails fast rather than hanging.
        check("absent OOP frame returns None fast",
              b.eval_in_frame("no-such-site.invalid", "1", timeout=0.5) is None)
    finally:
        sp.shutdown()


def round_new_tab(b: Browser, offline: bool) -> None:
    print("R24: drive a tab opened by a target=_blank click (F060) — cdp")
    import urllib.request
    tok = str(int(time.time() * 1000) % 1000000)
    opener = (b"<!doctype html><title>opener</title><h1>opener</h1>"
              b"<a id=lnk href='http://127.0.0.1:8932/s-" + tok.encode() +
              b"' target=_blank>open second</a>")
    second = (b"<!doctype html><title>tab-" + tok.encode() + b"</title>"
              b"<h1 id=h>SECOND-" + tok.encode() + b"</h1>"
              b"<button id=go onclick=\"document.title='SECOND-CLICKED'\">go</button>")
    sp = _serve(8931, opener)
    sc = _serve(8932, second)
    try:
        b.navigate("http://127.0.0.1:8931/")
        time.sleep(0.2)
        # Friction: the link opens a *new top-level tab*. The connection stays on
        # the opener; the new tab is a separate page target the opener session
        # cannot read or drive (site-isolation auto-attach reaches child frames,
        # not sibling tabs).
        b.click_text("open second")
        time.sleep(0.5)
        urls = [p["url"] for p in b.pages()]
        check("new tab target appears in the browser",
              any(f"s-{tok}" in u for u in urls), repr(urls))
        check("opener session still reads the opener, not the new tab",
              b.eval("document.title") == "opener", b.eval("document.title"))
        # Primitive: switch to (drive) the new tab, as a human clicks it.
        check("switch_page focuses the new tab", b.switch_page(f"s-{tok}"))
        check("new tab is now readable",
              b.eval("document.getElementById('h').textContent") == f"SECOND-{tok}",
              b.eval("document.title"))
        # And actable: helpers re-injected, click drives the switched tab.
        check("agentctl helpers present on the switched tab",
              b.eval("!!window.__agentctl"))
        b.click_text("go")
        check("click acts on the switched tab",
              b.wait_for("document.title==='SECOND-CLICKED'", timeout=3),
              b.eval("document.title"))
        # And we can switch back to the opener.
        check("switch_page returns to the opener", b.switch_page("8931/"))
        check("opener is driveable again",
              b.eval("document.title") == "opener", b.eval("document.title"))
        # A tab that never opened fails fast rather than hanging.
        check("switch to absent tab fails fast",
              b.switch_page("no-such-tab", timeout=0.5) is False)
    finally:
        # Close the spawned tab so repeated full-suite runs stay deterministic.
        try:
            for p in b.pages():
                if f"s-{tok}" in (p["url"] or ""):
                    urllib.request.urlopen(
                        f"http://127.0.0.1:{b.cdp.port}/json/close/{p['target_id']}",
                        timeout=5).read()
        except Exception:
            pass
        sp.shutdown()
        sc.shutdown()


def round_occlusion(b: Browser, offline: bool) -> None:
    print("R25: refuse to fire a click an overlay would swallow (F061) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>occlude</title><style>"
            b"#t{position:absolute;left:60px;top:200px;width:160px;height:48px}"
            b"#scrim{position:fixed;inset:0;background:rgba(0,0,0,0.001);z-index:9}"
            b"</style>"
            b"<button id=t onclick=\"window.__hit=(window.__hit||0)+1\">CONFIRM</button>"
            b"<div id=scrim onclick=\"window.__s=(window.__s||0)+1\"></div>")
    sp = _serve(8951, page)
    try:
        b.navigate("http://127.0.0.1:8951/")
        time.sleep(0.2)
        c = b._center_of("#t")
        # Friction: the element's own center hit-tests to the overlay, not it.
        top = b.eval(f"(function(){{var e=document.elementFromPoint({c['x']},{c['y']});"
                     f"return e?e.id:null;}})()")
        check("overlay sits on top of the target's center", top == "scrim", repr(top))
        # Primitive: hit-verified click sees full occlusion and refuses to fire.
        hp = b._hit_point_of("#t")
        check("hitPoint reports the target fully occluded",
              hp is not None and hp.get("occluded") is True
              and hp.get("blocker") == "scrim", repr(hp))
        check("click refuses to fire into the overlay", b.click("#t") is False)
        check("target never received the swallowed click",
              b.eval("window.__hit||0") == 0, repr(b.eval("window.__hit||0")))
        # Uncover the lower half: now a real spot on the target is reachable.
        b.eval("var s=document.getElementById('scrim');s.style.top='0px';"
               "s.style.height='224px';s.style.bottom='auto';true")
        hp2 = b._hit_point_of("#t")
        check("hitPoint finds a clear point once partly uncovered",
              hp2 is not None and hp2.get("occluded") is False, repr(hp2))
        check("click now reaches the target", b.click("#t") is True)
        check("target received exactly the real click",
              b.eval("window.__hit||0") == 1, repr(b.eval("window.__hit||0")))
        check("overlay never absorbed a stray click",
              b.eval("window.__s||0") == 0, repr(b.eval("window.__s||0")))
        # require_hit=False still allows a deliberate geometric click.
        b.eval("var s=document.getElementById('scrim');s.style.top='0px';"
               "s.style.height='100%';s.style.bottom='auto';true")
        check("geometric click is still available on request",
              b.click("#t", require_hit=False) is True)
    finally:
        sp.shutdown()


def round_native_select(b: Browser, offline: bool) -> None:
    print("R26: choose from a native <select> whose popup is OS-drawn (F062) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>select</title>"
            b"<select id=s onchange=\"window.__v=this.value;"
            b"window.__n=(window.__n||0)+1\">"
            b"<option value=red>Red</option>"
            b"<option value=green>Green</option>"
            b"<option value=blue>Blue</option></select>")
    sp = _serve(8952, page)
    try:
        b.navigate("http://127.0.0.1:8952/")
        time.sleep(0.2)
        check("select starts on its first option",
              b.eval("document.getElementById('s').value") == "red")
        # Friction: a coordinate click where the 'Blue' row visually appears lands
        # on the page, not the OS popup — the value never changes.
        c = b._center_of("#s")
        b.click("#s")
        time.sleep(0.2)
        b.click_xy(c["x"], c["y"] + 54)
        time.sleep(0.1)
        check("a coordinate click into the OS popup selects nothing",
              b.eval("document.getElementById('s').value") == "red"
              and b.eval("window.__v||null") is None)
        # Primitive: select_option picks by value and fires a real change.
        b.eval("window.__v=null;window.__n=0;true")
        check("select_option by value chooses Blue", b.select_option("#s", value="blue") is True)
        check("the select now reflects Blue",
              b.eval("document.getElementById('s').value") == "blue")
        check("a bubbling change fired exactly once",
              b.eval("window.__v") == "blue" and b.eval("window.__n") == 1,
              repr((b.eval("window.__v"), b.eval("window.__n"))))
        # By visible label and by index, too.
        check("select_option by label chooses Green",
              b.select_option("#s", label="Green") is True
              and b.eval("document.getElementById('s').value") == "green")
        check("select_option by index chooses the first option",
              b.select_option("#s", index=0) is True
              and b.eval("document.getElementById('s').value") == "red")
        # Truthful failure: an option that does not exist is not invented.
        check("select_option refuses an absent option",
              b.select_option("#s", value="purple") is False
              and b.eval("document.getElementById('s').value") == "red")
    finally:
        sp.shutdown()


def round_contenteditable(b: Browser, offline: bool) -> None:
    print("R27: replace text in a contenteditable editor with no .value (F063) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>editable</title>"
            b"<div id=e contenteditable oninput=\"window.__n=(window.__n||0)+1\">"
            b"OLD TEXT</div>")
    sp = _serve(8953, page)
    try:
        b.navigate("http://127.0.0.1:8953/")
        time.sleep(0.2)
        check("editor has no value property",
              b.eval("document.getElementById('e').value") is None)
        # Friction: type_text can't clear a div (el.value='' is a no-op) so the
        # old text survives and the new text merges into it.
        b.type_text("#e", "NEW")
        time.sleep(0.1)
        check("type_text merges into the old text instead of replacing",
              b.eval("document.getElementById('e').textContent") == "OLD TEXTNEW",
              repr(b.eval("document.getElementById('e').textContent")))
        # Primitive: set_editable selects-all then inserts — a clean replacement.
        b.eval("var e=document.getElementById('e');e.textContent='OLD TEXT';"
               "window.__n=0;true")
        check("set_editable replaces the editor's whole contents",
              b.set_editable("#e", "REPLACED") is True
              and b.eval("document.getElementById('e').textContent") == "REPLACED",
              repr(b.eval("document.getElementById('e').textContent")))
        check("a real input event fired during the replace",
              b.eval("window.__n||0") >= 1, repr(b.eval("window.__n||0")))
        # Truthful failure: a non-editable / absent target is refused.
        check("set_editable refuses an absent target",
              b.set_editable("#nope", "x") is False)
    finally:
        sp.shutdown()


def round_file_drop(b: Browser, offline: bool) -> None:
    print("R28: drop a file onto a dropzone with no <input type=file> (F064) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>drop</title>"
            b"<div id=z style='width:200px;height:120px'>drop here</div>"
            b"<script>var z=document.getElementById('z');"
            b"['dragenter','dragover'].forEach(function(t){"
            b"  z.addEventListener(t,function(e){e.preventDefault();});});"
            b"z.addEventListener('drop',function(e){e.preventDefault();"
            b"  var f=e.dataTransfer.files[0];window.__name=f?f.name:null;"
            b"  window.__type=f?f.type:null;"
            b"  var r=new FileReader();r.onload=function(){window.__body=r.result;};"
            b"  if(f)r.readAsText(f);window.__dropped=(window.__dropped||0)+1;});"
            b"</script>")
    sp = _serve(8954, page)
    try:
        b.navigate("http://127.0.0.1:8954/")
        time.sleep(0.2)
        check("the dropzone has no file input to set",
              b.eval("!document.querySelector('input[type=file]')"))
        check("no drop has happened yet", b.eval("window.__dropped||0") == 0)
        # Primitive: drop_file synthesizes a real File in a DataTransfer.
        check("drop_file reports it dropped",
              b.drop_file("#z", "hello.txt", "HELLO DROP", "text/plain") is True)
        check("the drop handler fired exactly once",
              b.wait_for("window.__dropped===1", timeout=2),
              repr(b.eval("window.__dropped||0")))
        check("the dropped file carries the right name and type",
              b.eval("window.__name") == "hello.txt"
              and b.eval("window.__type") == "text/plain",
              repr((b.eval("window.__name"), b.eval("window.__type"))))
        check("the file's bytes are real and readable",
              b.wait_for("window.__body==='HELLO DROP'", timeout=2),
              repr(b.eval("window.__body")))
        # Truthful failure: an absent dropzone is refused.
        check("drop_file refuses an absent target",
              b.drop_file("#nope", "x.txt", "x", "text/plain") is False)
    finally:
        sp.shutdown()


def _max_deviation(pts) -> float:
    """Greatest perpendicular distance of any interior point from the chord —
    0 for a straight line, large for a curve."""
    if not pts or len(pts) < 3:
        return 0.0
    (ax, ay), (bx, by) = pts[0], pts[-1]
    length = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5 or 1.0
    md = 0.0
    for px, py in pts[1:-1]:
        n = abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax)
        md = max(md, n / length)
    return md


def round_draw_path(b: Browser, offline: bool) -> None:
    print("R29: trace a freehand curve on a drawing canvas (F065) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>draw</title>"
            b"<canvas id=c width=300 height=200 "
            b"style='touch-action:none;border:1px solid #000'></canvas>"
            b"<script>var c=document.getElementById('c');window.__pts=[];var d=false;"
            b"function rel(e){var r=c.getBoundingClientRect();"
            b"  return [Math.round(e.clientX-r.left),Math.round(e.clientY-r.top)];}"
            b"c.addEventListener('pointerdown',function(e){d=true;window.__pts=[rel(e)];});"
            b"c.addEventListener('pointermove',function(e){if(d)window.__pts.push(rel(e));});"
            b"c.addEventListener('pointerup',function(e){d=false;window.__done=true;});"
            b"</script>")
    sp = _serve(8955, page)
    try:
        b.navigate("http://127.0.0.1:8955/")
        time.sleep(0.2)
        box = b._center_of("#c")
        ox, oy = box["x"] - 100, box["y"]
        # Friction: a straight drag traces a ruler line — zero bend.
        b.drag(ox, oy, ox + 200, oy, steps=20)
        time.sleep(0.2)
        straight = b.eval("window.__pts")
        check("a straight drag records a collinear (zero-bend) path",
              len(straight) >= 3 and _max_deviation(straight) < 2.0,
              repr((len(straight), round(_max_deviation(straight), 2))))
        # Primitive: draw_path traces a real arc.
        b.eval("window.__pts=[];window.__done=false;true")
        pts = [[ox + i, oy - int(60 * math.sin(math.pi * i / 200))]
               for i in range(0, 201, 8)]
        check("draw_path reports it traced the stroke", b.draw_path(pts) is True)
        check("the pointerup landed (stroke completed)",
              b.wait_for("window.__done===true", timeout=2))
        curve = b.eval("window.__pts")
        check("the recorded path is a real curve, not a line",
              len(curve) >= 10 and _max_deviation(curve) > 20.0,
              repr((len(curve), round(_max_deviation(curve), 2))))
        # Truthful failure: a path of fewer than two points is refused.
        check("draw_path refuses an empty path", b.draw_path([]) is False)
        check("draw_path refuses a single point", b.draw_path([[ox, oy]]) is False)
    finally:
        sp.shutdown()


def round_paste_pipeline(b: Browser, offline: bool) -> None:
    print("R30: paste through an editor's transform pipeline (F066) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>paste</title>"
            b"<div id=e contenteditable style='border:1px solid #000;"
            b"min-height:40px'></div>"
            b"<script>var e=document.getElementById('e');window.__n=0;"
            b"e.addEventListener('paste',function(ev){ev.preventDefault();"
            b"  window.__n++;"
            b"  var t=(ev.clipboardData||window.clipboardData)"
            b"        .getData('text/plain');window.__seen=t;"
            b"  if(/^https?:\\/\\//.test(t)){var a=document.createElement('a');"
            b"    a.href=t;a.textContent='[link]';e.appendChild(a);}"
            b"  else{e.appendChild(document.createTextNode(t));}});"
            b"</script>")
    sp = _serve(8956, page)
    try:
        b.navigate("http://127.0.0.1:8956/")
        time.sleep(0.2)
        check("no paste has happened yet", b.eval("window.__n||0") == 0)
        # Friction: set_editable writes raw text — the paste handler that turns a
        # URL into a chip never runs, so no <a> is produced.
        b.set_editable("#e", "https://example.com")
        time.sleep(0.1)
        check("writing text directly never triggers the paste transform",
              b.eval("window.__n||0") == 0
              and b.eval("!document.querySelector('#e a')"),
              repr(b.eval("document.getElementById('e').innerHTML")))
        # Primitive: paste_into dispatches a real paste with a DataTransfer, so the
        # editor's own paste logic runs and rewrites the URL into a chip.
        b.eval("document.getElementById('e').innerHTML='';window.__n=0;true")
        check("paste_into reports it pasted",
              b.paste_into("#e", "https://example.com") is True)
        check("the paste handler fired exactly once",
              b.wait_for("window.__n===1", timeout=2),
              repr(b.eval("window.__n||0")))
        check("the handler read the pasted text off the clipboard",
              b.eval("window.__seen") == "https://example.com",
              repr(b.eval("window.__seen")))
        check("the editor's transform ran (URL became a link chip)",
              b.eval("document.querySelector('#e a') && "
                     "document.querySelector('#e a').textContent") == "[link]",
              repr(b.eval("document.getElementById('e').innerHTML")))
        # Truthful failure: an absent target is refused.
        check("paste_into refuses an absent target",
              b.paste_into("#nope", "x") is False)
    finally:
        sp.shutdown()


def round_context_menu(b: Browser, offline: bool) -> None:
    print("R31: raise an app's own right-click context menu (F067) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>ctx</title>"
            b"<div id=t style='width:160px;height:100px;background:#cde'>row</div>"
            b"<ul id=m style='display:none;position:fixed;margin:0'>"
            b"<li id=del>Delete</li></ul>"
            b"<script>var t=document.getElementById('t'),"
            b"m=document.getElementById('m');window.__ctx=0;window.__left=0;"
            b"t.addEventListener('click',function(){window.__left++;});"
            b"t.addEventListener('contextmenu',function(e){e.preventDefault();"
            b"  window.__ctx++;m.style.display='block';"
            b"  m.style.left=e.clientX+'px';m.style.top=e.clientY+'px';});"
            b"document.getElementById('del').addEventListener('click',function(){"
            b"  window.__deleted=true;m.style.display='none';});"
            b"</script>")
    sp = _serve(8957, page)
    try:
        b.navigate("http://127.0.0.1:8957/")
        time.sleep(0.2)
        # Friction: a left click registers but never raises the contextmenu menu.
        check("left click registers on the row", b.click_text("row") is True)
        time.sleep(0.1)
        check("a left click never raises the context menu",
              b.eval("window.__left||0") >= 1 and b.eval("window.__ctx||0") == 0
              and b.eval("getComputedStyle(document.getElementById('m'))"
                         ".display") == "none")
        # Primitive: context_click fires a real right-button contextmenu.
        check("context_click reports it fired",
              b.context_click("#t") is True)
        check("the contextmenu event fired exactly once",
              b.wait_for("window.__ctx===1", timeout=2),
              repr(b.eval("window.__ctx||0")))
        check("the app's own menu is now visible",
              b.wait_for("getComputedStyle(document.getElementById('m'))"
                         ".display==='block'", timeout=2))
        # And its items are reachable.
        check("a menu item raised by the right-click is clickable",
              b.click_text("Delete") is True
              and b.wait_for("window.__deleted===true", timeout=2))
        # Truthful failure: an absent target is refused.
        check("context_click refuses an absent target",
              b.context_click("#nope") is False)
    finally:
        sp.shutdown()


def round_key_chord(b: Browser, offline: bool) -> None:
    print("R32: fire a keyboard shortcut chord (modifier + key) (F068) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>chord</title>"
            b"<input id=i>"
            b"<script>var i=document.getElementById('i');window.__saved=0;"
            b"window.__plain=0;window.__both=0;"
            b"i.addEventListener('keydown',function(e){"
            b"  if((e.key==='s'||e.key==='S')&&!e.ctrlKey)window.__plain++;"
            b"  if((e.key==='s'||e.key==='S')&&e.ctrlKey&&!e.shiftKey){"
            b"    e.preventDefault();window.__saved++;}"
            b"  if((e.key==='S'||e.key==='s')&&e.ctrlKey&&e.shiftKey){"
            b"    e.preventDefault();window.__both++;}});"
            b"</script>")
    sp = _serve(8958, page)
    try:
        b.navigate("http://127.0.0.1:8958/")
        time.sleep(0.2)
        b.click("#i")
        # Friction: a bare key carries no modifier, so a Ctrl+S binding is dead.
        b.press_key("s", "KeyS", 83)
        time.sleep(0.1)
        check("a bare key never triggers the Ctrl+S binding",
              b.eval("window.__plain||0") >= 1 and b.eval("window.__saved||0") == 0,
              repr((b.eval("window.__plain||0"), b.eval("window.__saved||0"))))
        # Primitive: key_chord holds Ctrl, so the single-modifier binding fires.
        check("key_chord(Ctrl+S) reports it fired",
              b.key_chord("s", ctrl=True, code="KeyS", key_code=83) is True)
        check("the Ctrl+S handler ran exactly once",
              b.wait_for("window.__saved===1", timeout=2),
              repr(b.eval("window.__saved||0")))
        # And a two-modifier chord is distinguished from the one-modifier one.
        check("key_chord(Ctrl+Shift+S) reports it fired",
              b.key_chord("S", ctrl=True, shift=True, code="KeyS",
                          key_code=83) is True)
        check("the Ctrl+Shift+S handler ran (and Ctrl+S did not re-fire)",
              b.wait_for("window.__both===1", timeout=2)
              and b.eval("window.__saved||0") == 1,
              repr((b.eval("window.__both||0"), b.eval("window.__saved||0"))))
    finally:
        sp.shutdown()


def round_per_key_type(b: Browser, offline: bool) -> None:
    print("R33: type a segmented OTP field with real per-key events (F069) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>otp</title>"
            b"<div id=otp>"
            b"<input class=d maxlength=1><input class=d maxlength=1>"
            b"<input class=d maxlength=1><input class=d maxlength=1></div>"
            b"<script>var ds=[].slice.call(document.querySelectorAll('.d'));"
            b"window.__keys=0;"
            b"ds.forEach(function(el,idx){el.addEventListener('keydown',"
            b"function(e){if(e.key.length===1&&/[0-9]/.test(e.key)){"
            b"  e.preventDefault();window.__keys++;el.value=e.key;"
            b"  if(ds[idx+1])ds[idx+1].focus();}});});"
            b"window.__code=function(){return ds.map(function(e){"
            b"return e.value||'_';}).join('');};</script>")
    sp = _serve(8959, page)
    try:
        b.navigate("http://127.0.0.1:8959/")
        time.sleep(0.2)
        # Friction: type_text -> one insertText, no keydown; focus never advances.
        b.type_text("#otp .d", "1234")
        time.sleep(0.1)
        check("type_text fills only the first box (no per-key advance)",
              b.eval("window.__code()") != "1234"
              and b.eval("window.__keys||0") == 0,
              repr((b.eval("window.__code()"), b.eval("window.__keys||0"))))
        b.eval("(function(){var ds=document.querySelectorAll('.d');"
               "ds.forEach(function(e){e.value='';});window.__keys=0;"
               "ds[0].focus();})()")
        # Primitive: per-key real events advance focus box to box.
        check("type_keys reports it fired",
              b.type_keys("1234") is True)
        check("every box filled in order via per-key keydown",
              b.wait_for("window.__code()==='1234'", timeout=2)
              and b.eval("window.__keys||0") == 4,
              repr((b.eval("window.__code()"), b.eval("window.__keys||0"))))
    finally:
        sp.shutdown()


def round_wheel_pane(b: Browser, offline: bool) -> None:
    print("R34: wheel a custom pane that ignores scrollTop (F070) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>wheel</title>"
            b"<div style='height:40px'></div>"
            b"<div id=pane style='position:absolute;left:500px;top:200px;"
            b"width:260px;height:160px;overflow:hidden;border:1px solid #888'>"
            b"<div id=inner style='transform:translateY(0px)'></div></div>"
            b"<script>var pane=document.getElementById('pane'),"
            b"inner=document.getElementById('inner');var off=0;"
            b"for(var i=0;i<40;i++){var r=document.createElement('div');"
            b"r.textContent='row'+i;r.style.height='30px';inner.appendChild(r);}"
            b"pane.addEventListener('wheel',function(e){e.preventDefault();"
            b"off=Math.max(0,off+e.deltaY);"
            b"inner.style.transform='translateY('+(-off)+'px)';},"
            b"{passive:false});window.__off=function(){return off;};</script>")
    sp = _serve(8960, page)
    try:
        b.navigate("http://127.0.0.1:8960/")
        time.sleep(0.2)
        # Friction A: scroll_until sets scrollTop, which this pane discards.
        b.scroll_until("window.__off()>=300", container="#pane",
                       step=120, max_steps=6)
        check("a scrollTop-based scroll never moves a wheel-only pane",
              b.eval("window.__off()") == 0, repr(b.eval("window.__off()")))
        # Friction B: scroll() wheels at the fixed page centre, missing the pane.
        for _ in range(5):
            b.scroll(120)
        check("a fixed-centre wheel misses an off-centre pane",
              b.eval("window.__off()") == 0, repr(b.eval("window.__off()")))
        # Primitive: wheel real events over the pane's own centre.
        check("wheel_until reports it reached the target",
              b.wheel_until("window.__off()>=300", "#pane", dy=120,
                            max_steps=10) is True)
        check("the pane advanced under real wheel events",
              b.eval("window.__off()") >= 300, repr(b.eval("window.__off()")))
        check("wheel_at on an absent pane returns False",
              b.wheel_at("#nope", 120) is False)
    finally:
        sp.shutdown()


def round_select_text(b: Browser, offline: bool) -> None:
    print("R35: select a word / paragraph, not just a caret (F071) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>select</title>"
            b"<p id=p style='font:16px monospace'>alpha beta gamma delta</p>"
            b"<button id=bold disabled>Bold</button>"
            b"<script>document.addEventListener('selectionchange',function(){"
            b"var s=String(getSelection());"
            b"document.getElementById('bold').disabled=(s.length===0);"
            b"window.__sel=s;});window.__sel='';</script>")
    sp = _serve(8961, page)
    try:
        b.navigate("http://127.0.0.1:8961/")
        time.sleep(0.2)
        # Friction: a plain click collapses the caret — no selection, Bold off.
        b.click("#p")
        time.sleep(0.05)
        check("a plain click leaves the selection empty",
              b.eval("window.__sel") == "", repr(b.eval("window.__sel")))
        check("the formatting button stays disabled after a click",
              b.eval("document.getElementById('bold').disabled") is True)
        # Primitive: double-click selects a word and flips the toolbar on.
        word = b.select_word("#p")
        time.sleep(0.05)
        check("select_word returns a single non-empty word",
              isinstance(word, str) and word.strip() != ""
              and " " not in word.strip(), repr(word))
        check("the word selection enables the formatting button",
              b.eval("document.getElementById('bold').disabled") is False)
        # Primitive: triple-click selects the whole paragraph.
        para = b.select_paragraph("#p")
        check("select_paragraph returns the full paragraph text",
              isinstance(para, str) and "alpha beta gamma delta" in para,
              repr(para))
        check("select_word on an absent target returns None",
              b.select_word("#nope") is None)
    finally:
        sp.shutdown()


def round_select_range(b: Browser, offline: bool) -> None:
    print("R36: drag-select an arbitrary character range (F072) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>range</title>"
            b"<p id=p style='font:16px monospace'>alpha beta gamma delta</p>"
            b"<script>window.__sel=function(){return String(getSelection());};"
            b"</script>")
    sp = _serve(8962, page)
    try:
        b.navigate("http://127.0.0.1:8962/")
        time.sleep(0.2)
        # Friction: word/paragraph granularity (F071) can't isolate a half-span.
        # Primitive: drag-select chars [6,16) of "alpha beta gamma delta".
        got = b.select_range("#p", 6, 16)
        time.sleep(0.05)
        check("select_range returns exactly the requested span",
              got == "beta gamma", repr(got))
        check("the live Selection matches the requested span",
              b.eval("window.__sel()") == "beta gamma",
              repr(b.eval("window.__sel()")))
        # A different span on the same node resolves independently.
        got2 = b.select_range("#p", 0, 5)
        check("a second range selects a different span",
              got2 == "alpha", repr(got2))
        check("select_range on an absent target returns None",
              b.select_range("#nope", 0, 3) is None)
    finally:
        sp.shutdown()


def round_set_slider(b: Browser, offline: bool) -> None:
    print("R37: drag a custom slider to a precise value (F073) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>slider</title>"
            b"<div id=track style='position:absolute;left:40px;top:80px;width:200px;"
            b"height:8px;background:#ccc'>"
            b"<div id=thumb style='position:absolute;left:0;top:-6px;width:20px;"
            b"height:20px;background:#08f;border-radius:50%'></div></div>"
            b"<script>(function(){"
            b"var track=document.getElementById('track'),thumb=document.getElementById('thumb'),"
            b"W=200,drag=false;"
            b"function setFromX(cx){var r=track.getBoundingClientRect();"
            b"var f=Math.max(0,Math.min(1,(cx-r.left)/W));"
            b"thumb.style.left=(f*W-10)+'px';window.__val=Math.round(f*100);}"
            b"thumb.addEventListener('pointerdown',function(e){drag=true;e.preventDefault();});"
            b"window.addEventListener('pointermove',function(e){if(drag)setFromX(e.clientX);});"
            b"window.addEventListener('pointerup',function(){drag=false;});"
            b"window.__val=0;})();</script>")
    sp = _serve(8963, page)
    try:
        b.navigate("http://127.0.0.1:8963/")
        time.sleep(0.2)
        # Friction: a div slider has no .value and ignores a plain click.
        raised = False
        try:
            b.set_value("#thumb", "73")
        except Exception:
            raised = True
        check("set_value cannot drive a div slider (no value property)", raised)
        b.click("#track")
        time.sleep(0.05)
        check("a plain click on the track moves nothing",
              b.eval("window.__val") == 0, repr(b.eval("window.__val")))
        # Primitive: drag the handle to a precise fraction of the rail.
        check("set_slider drives the handle to 73%",
              b.set_slider("#thumb", "#track", 0.73) is True)
        time.sleep(0.05)
        check("the live slider value reaches the requested fraction",
              b.eval("window.__val") == 73, repr(b.eval("window.__val")))
        check("set_slider can land a different fraction",
              b.set_slider("#thumb", "#track", 0.20) is True)
        time.sleep(0.05)
        check("the second fraction resolves independently",
              b.eval("window.__val") == 20, repr(b.eval("window.__val")))
        check("set_slider on an absent handle returns False",
              b.set_slider("#nope", "#track", 0.5) is False)
    finally:
        sp.shutdown()


def round_closed_shadow(b: Browser, offline: bool) -> None:
    print("R38: click an element sealed in a closed shadow root (F074) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>closed shadow</title>"
            b"<my-widget></my-widget>"
            b"<script>class W extends HTMLElement{constructor(){super();"
            b"var r=this.attachShadow({mode:'closed'});"
            b"r.innerHTML='<button id=go style=\"padding:8px\">Inner Go</button>';"
            b"r.getElementById('go').addEventListener('click',function(){"
            b"window.__clicked=true;});}}"
            b"customElements.define('my-widget',W);window.__clicked=false;</script>")
    sp = _serve(8964, page)
    try:
        b.navigate("http://127.0.0.1:8964/")
        time.sleep(0.2)
        # Friction: a closed shadow root hides the inner control from page JS.
        check("the host's shadowRoot is null (closed)",
              b.eval("document.querySelector('my-widget').shadowRoot") is None)
        check("deepQuery cannot find an element inside a closed root",
              b.eval("!!window.__agentctl.deepQuery('#go')") is False)
        check("a selector click misses the sealed element",
              b.click("#go") is False)
        # Primitive: pierce the closed root via CDP and click the real element.
        check("click_shadow reaches the sealed button",
              b.click_shadow("#go") is True)
        time.sleep(0.05)
        check("the sealed button's handler actually fired",
              b.eval("window.__clicked") is True)
        check("click_shadow on an absent selector returns False",
              b.click_shadow("#nope") is False)
    finally:
        sp.shutdown()


def round_type_closed_shadow(b: Browser, offline: bool) -> None:
    print("R39: type into an input sealed in a closed shadow root (F075) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>shadow input</title>"
            b"<my-field></my-field>"
            b"<script>class F extends HTMLElement{constructor(){super();"
            b"var r=this.attachShadow({mode:'closed'});"
            b"r.innerHTML='<input id=inp value=\"OLD\" style=\"padding:6px\">';"
            b"this._inp=r.getElementById('inp');"
            b"Object.defineProperty(this,'val',{get:()=>this._inp.value});}}"
            b"customElements.define('my-field',F);"
            b"window.__val=function(){return document.querySelector('my-field').val;};"
            b"</script>")
    sp = _serve(8965, page)
    try:
        b.navigate("http://127.0.0.1:8965/")
        time.sleep(0.2)
        check("deepQuery cannot reach the sealed input",
              b.eval("!!window.__agentctl.deepQuery('#inp')") is False)
        check("set_value cannot drive the sealed input",
              b.set_value("#inp", "hello") is False)
        check("type_text cannot drive the sealed input",
              b.type_text("#inp", "hello") is False)
        check("the sealed input still holds its original value",
              b.eval("window.__val()") == "OLD", repr(b.eval("window.__val()")))
        check("type_shadow drives the sealed input",
              b.type_shadow("#inp", "agent123") is True)
        time.sleep(0.05)
        check("the sealed input now holds exactly the typed text",
              b.eval("window.__val()") == "agent123", repr(b.eval("window.__val()")))
        check("type_shadow on an absent selector returns False",
              b.type_shadow("#nope", "x") is False)
    finally:
        sp.shutdown()


def round_marquee(b: Browser, offline: bool) -> None:
    print("R40: rubber-band (marquee) select a group of items (F076) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>marquee</title>"
            b"<div id=board style='position:absolute;left:0;top:0;width:400px;"
            b"height:300px;border:1px solid #999'>"
            b"<div class=item data-i=0 style='position:absolute;left:30px;top:30px;"
            b"width:40px;height:40px;background:#ccc'></div>"
            b"<div class=item data-i=1 style='position:absolute;left:120px;top:30px;"
            b"width:40px;height:40px;background:#ccc'></div>"
            b"<div class=item data-i=2 style='position:absolute;left:30px;top:120px;"
            b"width:40px;height:40px;background:#ccc'></div>"
            b"<div class=item data-i=3 style='position:absolute;left:250px;top:200px;"
            b"width:40px;height:40px;background:#ccc'></div>"
            b"</div>"
            b"<script>(function(){var board=document.getElementById('board');"
            b"var sx,sy,band=false;window.__selected=function(){return "
            b"[].slice.call(document.querySelectorAll('.item.sel')).map(function(e){"
            b"return +e.dataset.i;}).sort(function(a,b){return a-b;});};"
            b"board.addEventListener('pointerdown',function(e){"
            b"if(e.target!==board)return;band=true;var r=board.getBoundingClientRect();"
            b"sx=e.clientX-r.left;sy=e.clientY-r.top;"
            b"[].forEach.call(document.querySelectorAll('.item'),function(it){"
            b"it.classList.remove('sel');});});"
            b"window.addEventListener('pointermove',function(e){if(!band)return;"
            b"var r=board.getBoundingClientRect();var cx=e.clientX-r.left,"
            b"cy=e.clientY-r.top;var x0=Math.min(sx,cx),x1=Math.max(sx,cx),"
            b"y0=Math.min(sy,cy),y1=Math.max(sy,cy);"
            b"[].forEach.call(document.querySelectorAll('.item'),function(it){"
            b"var l=it.offsetLeft,t=it.offsetTop,w=it.offsetWidth,h=it.offsetHeight;"
            b"var hit=!(l>x1||l+w<x0||t>y1||t+h<y0);"
            b"it.classList.toggle('sel',hit);});});"
            b"window.addEventListener('pointerup',function(){band=false;});})();"
            b"</script>")
    sp = _serve(8966, page)
    try:
        b.navigate("http://127.0.0.1:8966/")
        time.sleep(0.2)
        b.click("#board")
        time.sleep(0.05)
        check("a plain click selects no items",
              b.eval("window.__selected()") == [], repr(b.eval("window.__selected()")))
        # Band from the empty top-left corner across items 0,1,2 (not 3, far away).
        check("marquee drags a selection rectangle",
              b.marquee("#board", 0.02, 0.03, 0.45, 0.6) is True)
        time.sleep(0.05)
        check("the band selects exactly the enclosed items",
              b.eval("window.__selected()") == [0, 1, 2],
              repr(b.eval("window.__selected()")))
        # A tighter band only catches the top-left item.
        check("a second, smaller band reselects independently",
              b.marquee("#board", 0.02, 0.03, 0.2, 0.3) is True)
        time.sleep(0.05)
        check("the smaller band selects only the corner item",
              b.eval("window.__selected()") == [0],
              repr(b.eval("window.__selected()")))
        check("marquee on an absent container returns False",
              b.marquee("#nope", 0, 0, 0.5, 0.5) is False)
    finally:
        sp.shutdown()


def round_ctrl_multi_select(b: Browser, offline: bool) -> None:
    print("R41: Ctrl+click toggles a discontiguous multi-selection (F077) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>ctrlclick</title>"
            b"<ul id=list style='list-style:none;font:14px sans-serif'></ul>"
            b"<script>window.__sel=new Set();var ul=document.getElementById('list');"
            b"for(var i=0;i<6;i++){(function(i){var li=document.createElement('li');"
            b"li.id='r'+i;li.textContent='row '+i;li.style.padding='4px';"
            b"li.addEventListener('click',function(e){"
            b"if(e.ctrlKey||e.metaKey){if(window.__sel.has(i))window.__sel.delete(i);"
            b"else window.__sel.add(i);}else{window.__sel.clear();window.__sel.add(i);}"
            b"li.style.background=window.__sel.has(i)?'#9cf':'';});ul.appendChild(li);"
            b"})(i);}"
            b"window.__picked=function(){return [...window.__sel].sort("
            b"function(a,b){return a-b;});};</script>")
    sp = _serve(8968, page)
    try:
        b.navigate("http://127.0.0.1:8968/")
        time.sleep(0.2)
        # Plain clicks collapse the selection to the last item.
        for i in (0, 2, 4):
            b.click("#r%d" % i)
        check("plain clicks collapse to a single item",
              b.eval("window.__picked()") == [4],
              repr(b.eval("window.__picked()")))
        b.eval("window.__sel.clear()")
        # Ctrl+click accumulates a discontiguous set.
        check("ctrl_click 0 toggles it in", b.ctrl_click("#r0") is True)
        check("ctrl_click 2 toggles it in", b.ctrl_click("#r2") is True)
        check("ctrl_click 4 toggles it in", b.ctrl_click("#r4") is True)
        check("the discontiguous set is exactly {0,2,4}",
              b.eval("window.__picked()") == [0, 2, 4],
              repr(b.eval("window.__picked()")))
        # Ctrl+click an already-selected item toggles it back out.
        check("ctrl_click 2 again toggles it out", b.ctrl_click("#r2") is True)
        check("the set is now {0,4}",
              b.eval("window.__picked()") == [0, 4],
              repr(b.eval("window.__picked()")))
        check("ctrl_click on an absent item returns False",
              b.ctrl_click("#nope") is False)
    finally:
        sp.shutdown()


def round_shift_range_select(b: Browser, offline: bool) -> None:
    print("R42: Shift+click selects a contiguous range from the anchor (F078) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>shiftclick</title>"
            b"<ul id=list style='list-style:none;font:14px sans-serif'></ul>"
            b"<script>window.__sel=new Set();window.__anchor=null;"
            b"var ul=document.getElementById('list');"
            b"function paint(){[].forEach.call(document.querySelectorAll('li'),"
            b"function(li){var i=+li.dataset.i;"
            b"li.style.background=window.__sel.has(i)?'#9cf':'';});}"
            b"for(var i=0;i<6;i++){(function(i){var li=document.createElement('li');"
            b"li.id='r'+i;li.dataset.i=i;li.textContent='row '+i;li.style.padding='4px';"
            b"li.addEventListener('click',function(e){"
            b"if(e.shiftKey&&window.__anchor!=null){window.__sel.clear();"
            b"var a=Math.min(window.__anchor,i),b=Math.max(window.__anchor,i);"
            b"for(var k=a;k<=b;k++)window.__sel.add(k);}"
            b"else{window.__sel.clear();window.__sel.add(i);window.__anchor=i;}"
            b"paint();});ul.appendChild(li);})(i);}"
            b"window.__picked=function(){return [...window.__sel].sort("
            b"function(a,b){return a-b;});};</script>")
    sp = _serve(8969, page)
    try:
        b.navigate("http://127.0.0.1:8969/")
        time.sleep(0.2)
        b.click("#r1")
        b.click("#r4")  # plain click only re-anchors
        check("a plain second click does not fill the range",
              b.eval("window.__picked()") == [4],
              repr(b.eval("window.__picked()")))
        # Anchor on r1, Shift+click r4 -> the whole run [1,2,3,4].
        check("anchor click on r1", b.click("#r1") is True)
        check("shift_click r4 selects the range",
              b.shift_click("#r4") is True)
        check("the range from anchor to target is filled",
              b.eval("window.__picked()") == [1, 2, 3, 4],
              repr(b.eval("window.__picked()")))
        # Shift+click backward (r1 anchor still set by last range op? re-anchor).
        check("re-anchor on r3", b.click("#r3") is True)
        check("shift_click r0 selects backward range",
              b.shift_click("#r0") is True)
        check("the backward range is filled",
              b.eval("window.__picked()") == [0, 1, 2, 3],
              repr(b.eval("window.__picked()")))
        check("shift_click on an absent item returns False",
              b.shift_click("#nope") is False)
    finally:
        sp.shutdown()


def round_nested_submenu(b: Browser, offline: bool) -> None:
    print("R43: walk a multi-level hover submenu and click the leaf (F079) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>submenu</title><style>"
            b"ul{list-style:none;margin:0;padding:0}"
            b"li{position:relative;padding:6px 12px;background:#eee;width:120px}"
            b"li>ul{display:none;position:absolute;left:120px;top:0}"
            b"li:hover>ul{display:block}</style>"
            b"<ul><li id=file>File<ul>"
            b"<li id=export>Export<ul>"
            b"<li id=pdf>PDF</li><li id=png>PNG</li>"
            b"</ul></li>"
            b"<li id=close>Close</li>"
            b"</ul></li></ul>"
            b"<script>window.__hit='';"
            b"document.getElementById('pdf').addEventListener('click',function(){"
            b"window.__hit='PDF';});"
            b"document.getElementById('png').addEventListener('click',function(){"
            b"window.__hit='PNG';});</script>")
    sp = _serve(8970, page)
    try:
        b.navigate("http://127.0.0.1:8970/")
        time.sleep(0.2)
        check("the depth-3 leaf is hidden until the path opens",
              b.is_visible("#pdf") is False)
        check("a direct click on the hidden leaf fails",
              b.click("#pdf") is False)
        check("nothing was activated by the failed click",
              b.eval("window.__hit") == "", repr(b.eval("window.__hit")))
        # hover_reveal (F046) opens only one level.
        check("hover_reveal opens the first level", b.hover_reveal("#file", "#export"))
        check("but the depth-3 leaf is still hidden one level down",
              b.is_visible("#pdf") is False)
        # menu_select walks the whole chain and clicks the leaf.
        check("menu_select walks File>Export>PDF and clicks it",
              b.menu_select(["#file", "#export", "#pdf"]) is True)
        check("the leaf handler fired", b.eval("window.__hit") == "PDF",
              repr(b.eval("window.__hit")))
        # hover_chain alone leaves the path open so a sibling leaf is reachable.
        b.navigate("http://127.0.0.1:8970/")
        time.sleep(0.2)
        check("hover_chain opens File>Export", b.hover_chain(["#file", "#export"]))
        check("the sibling leaf is now visible", b.is_visible("#png") is True)
        check("a wrong path returns False",
              b.hover_chain(["#file", "#nope"]) is False)
        check("menu_select on an empty path returns False",
              b.menu_select([]) is False)
    finally:
        sp.shutdown()


def round_drag_reorder(b: Browser, offline: bool) -> None:
    print("R44: pointer-driven drag-to-reorder of a sortable list (F080) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>sortable</title><style>"
            b"#list{width:200px;margin:0;padding:0;list-style:none}"
            b"#list li{height:40px;line-height:40px;padding-left:10px;"
            b"background:#dde;margin:2px;user-select:none}</style>"
            b"<ul id=list><li data-k=A>A</li><li data-k=B>B</li>"
            b"<li data-k=C>C</li><li data-k=D>D</li></ul>"
            b"<script>"
            b"var list=document.getElementById('list');var drag=null;"
            b"list.addEventListener('mousedown',function(e){"
            b"if(e.target.tagName==='LI'){drag=e.target;e.preventDefault();}});"
            b"document.addEventListener('mousemove',function(e){"
            b"if(!drag)return;"
            b"var sibs=[].slice.call(list.children);"
            b"for(var i=0;i<sibs.length;i++){var s=sibs[i];if(s===drag)continue;"
            b"var r=s.getBoundingClientRect();var mid=r.top+r.height/2;"
            b"if(e.clientY<mid){list.insertBefore(drag,s);return;}}"
            b"list.appendChild(drag);});"
            b"document.addEventListener('mouseup',function(){drag=null;});"
            b"window.__order=function(){return [].map.call(list.children,"
            b"function(li){return li.dataset.k;}).join('');};"
            b"</script>")
    sp = _serve(8971, page)
    try:
        b.navigate("http://127.0.0.1:8971/")
        time.sleep(0.2)
        check("the list starts in order ABCD",
              b.eval("window.__order()") == "ABCD", repr(b.eval("window.__order()")))
        # dnd (HTML5 DragEvents) does nothing to a pointer-driven sortable.
        b.dnd("li[data-k=A]", "li[data-k=C]")
        check("dnd (DragEvents) leaves the order unchanged",
              b.eval("window.__order()") == "ABCD", repr(b.eval("window.__order()")))
        # Pointer-drag A to *after* C -> BCAD.
        check("drag_reorder A after C returns True",
              b.drag_reorder("li[data-k=A]", "li[data-k=C]", after=True) is True)
        check("A landed after C (BCAD)",
              b.eval("window.__order()") == "BCAD", repr(b.eval("window.__order()")))
        # Re-load and drag D to *before* B -> ADBC.
        b.navigate("http://127.0.0.1:8971/")
        time.sleep(0.2)
        check("drag_reorder D before B returns True",
              b.drag_reorder("li[data-k=D]", "li[data-k=B]", after=False) is True)
        check("D landed before B (ADBC)",
              b.eval("window.__order()") == "ADBC", repr(b.eval("window.__order()")))
        check("drag_reorder with an absent source returns False",
              b.drag_reorder("li[data-k=Z]", "li[data-k=B]") is False)
        check("drag_reorder with an absent target returns False",
              b.drag_reorder("li[data-k=A]", "li[data-k=Z]") is False)
    finally:
        sp.shutdown()


def round_scroll_into_view(b: Browser, offline: bool) -> None:
    print("R45: reveal an element clipped out of a scroll container (F081) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>clip</title>"
            b"<div id=box style='height:120px;width:200px;overflow:auto;"
            b"border:1px solid'>"
            b"<ul id=list style='list-style:none;margin:0;padding:0'></ul></div>"
            b"<button id=after>after</button>"
            b"<script>window.__hit='';var ul=document.getElementById('list');"
            b"for(var i=0;i<20;i++){(function(i){var li=document.createElement('li');"
            b"li.id='row'+i;li.textContent='row '+i;li.style.height='30px';"
            b"li.addEventListener('click',function(){window.__hit='row'+i;});"
            b"ul.appendChild(li);})(i);}"
            b"document.getElementById('after').addEventListener('click',function(){"
            b"window.__hit='after';});</script>")
    sp = _serve(8972, page)
    try:
        b.navigate("http://127.0.0.1:8972/")
        time.sleep(0.2)
        # row15 is far below the 120px clip box -> clipped, click refuses.
        check("the clipped row's hit point is occluded",
              bool((b._hit_point_of("#row15") or {}).get("occluded")))
        check("a direct click on the clipped row fails",
              b.click("#row15") is False)
        check("nothing was activated", b.eval("window.__hit") == "",
              repr(b.eval("window.__hit")))
        # scroll_into_view brings it back into the clip, then click works.
        check("scroll_into_view exposes the clipped row",
              b.scroll_into_view("#row15") is True)
        check("the row is now clickable", b.click("#row15") is True)
        check("the row handler fired", b.eval("window.__hit") == "row15",
              repr(b.eval("window.__hit")))
        # An element already in view scrolls to itself and stays hittable.
        check("scroll_into_view on an already-visible element is True",
              b.scroll_into_view("#after") is True)
        check("scroll_into_view on an absent element returns False",
              b.scroll_into_view("#nope") is False)
    finally:
        sp.shutdown()


def round_double_click(b: Browser, offline: bool) -> None:
    print("R46: double-click to activate an element (F082) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>dbl</title>"
            b"<div id=file style='width:120px;height:40px;border:1px solid;"
            b"padding:8px'>report.txt</div>"
            b"<div id=veil style='position:fixed;inset:0;background:rgba(0,0,0,0);"
            b"display:none'></div>"
            b"<div id=log></div>"
            b"<script>window.__open=0;window.__single=0;"
            b"var f=document.getElementById('file');"
            b"f.addEventListener('click',function(){window.__single++;});"
            b"f.addEventListener('dblclick',function(){window.__open++;"
            b"document.getElementById('log').textContent='OPENED';});</script>")
    sp = _serve(8973, page)
    try:
        b.navigate("http://127.0.0.1:8973/")
        time.sleep(0.2)
        # A single click — even repeated — never raises the dblclick event.
        check("a single click fires no dblclick",
              b.click("#file") is True and b.eval("window.__open") == 0)
        b.click("#file")
        check("two separate clicks still fire no dblclick",
              b.eval("window.__open") == 0, repr(b.eval("window.__open")))
        # double_click escalates clickCount and Chrome synthesises dblclick.
        check("double_click activates the element", b.double_click("#file") is True)
        check("the dblclick handler fired exactly once",
              b.eval("window.__open") == 1, repr(b.eval("window.__open")))
        check("the element opened", b.eval(
            "document.getElementById('log').textContent") == "OPENED")
        # An honest refusal when a transparent veil covers the target.
        b.eval("document.getElementById('veil').style.display='block'")
        check("double_click refuses through an overlay",
              b.double_click("#file") is False)
        check("nothing opened while occluded",
              b.eval("window.__open") == 1, repr(b.eval("window.__open")))
        b.eval("document.getElementById('veil').style.display='none'")
        check("double_click on an absent element returns False",
              b.double_click("#nope") is False)
    finally:
        sp.shutdown()


def round_press_hold(b: Browser, offline: bool) -> None:
    print("R47: press-and-hold to confirm (F083) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>hold</title>"
            b"<button id=del style='width:160px;height:44px'>Hold to delete</button>"
            b"<div id=veil style='position:fixed;inset:0;background:rgba(0,0,0,0);"
            b"display:none'></div>"
            b"<div id=log></div>"
            b"<script>window.__done=0;var t=null;"
            b"var d=document.getElementById('del');"
            b"d.addEventListener('mousedown',function(){t=setTimeout(function(){"
            b"window.__done++;document.getElementById('log').textContent='DELETED';"
            b"},500);});"
            b"function cancel(){if(t){clearTimeout(t);t=null;}}"
            b"d.addEventListener('mouseup',cancel);"
            b"d.addEventListener('mouseleave',cancel);</script>")
    sp = _serve(8974, page)
    try:
        b.navigate("http://127.0.0.1:8974/")
        time.sleep(0.2)
        # An instant click presses and releases before the 500ms timer elapses.
        check("an instant click never commits the hold",
              b.click("#del") is True and b.eval("window.__done") == 0)
        # press_hold keeps the button down past the dwell, so the timer fires.
        check("press_hold completes the gesture",
              b.press_hold("#del", hold=0.8) is True)
        check("the dwell timer committed exactly once",
              b.eval("window.__done") == 1, repr(b.eval("window.__done")))
        check("the action confirmed", b.eval(
            "document.getElementById('log').textContent") == "DELETED")
        # A hold shorter than the dwell is released too early to commit.
        b.eval("window.__done=0;document.getElementById('log').textContent='';")
        check("a too-short hold does not commit",
              b.press_hold("#del", hold=0.15) is True
              and b.eval("window.__done") == 0, repr(b.eval("window.__done")))
        # Honest refusal under an overlay, and on an absent target.
        b.eval("document.getElementById('veil').style.display='block'")
        check("press_hold refuses through an overlay",
              b.press_hold("#del", hold=0.8) is False)
        b.eval("document.getElementById('veil').style.display='none'")
        check("press_hold on an absent element returns False",
              b.press_hold("#nope") is False)
    finally:
        sp.shutdown()


def round_zoom_pane(b: Browser, offline: bool) -> None:
    print("R48: pinch-zoom a pane with Ctrl+wheel (F084) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>zoom</title>"
            b"<div id=map style='width:300px;height:200px;border:1px solid'></div>"
            b"<div id=veil style='position:fixed;inset:0;background:rgba(0,0,0,0);"
            b"display:none'></div>"
            b"<div id=log></div>"
            b"<script>window.__pan=0;window.__zoom=0;window.__scale=1;"
            b"var m=document.getElementById('map');"
            b"m.addEventListener('wheel',function(e){e.preventDefault();"
            b"if(e.ctrlKey){window.__zoom++;window.__scale*=(e.deltaY<0?1.1:0.9);"
            b"document.getElementById('log').textContent="
            b"'ZOOM '+window.__scale.toFixed(2);}"
            b"else{window.__pan++;document.getElementById('log').textContent='PAN';}},"
            b"{passive:false});</script>")
    sp = _serve(8975, page)
    try:
        b.navigate("http://127.0.0.1:8975/")
        time.sleep(0.2)
        # A plain wheel reaches only the pan branch; the pane never scales.
        check("plain wheel_at pans, never zooms",
              b.wheel_at("#map", -120) is True
              and b.eval("window.__zoom") == 0
              and b.eval("window.__pan") == 1, repr(b.eval("window.__pan")))
        # zoom_at carries Ctrl, so the page routes it to its zoom path.
        check("zoom_at zooms the pane in",
              b.zoom_at("#map", steps=2) is True)
        check("the zoom branch fired twice, pan unchanged",
              b.eval("window.__zoom") == 2 and b.eval("window.__pan") == 1,
              repr((b.eval("window.__zoom"), b.eval("window.__pan"))))
        check("the pane scaled up", b.eval("window.__scale") > 1.0,
              repr(b.eval("window.__scale")))
        # Zooming out drives the scale back down.
        check("zoom_at out shrinks the pane",
              b.zoom_at("#map", steps=2, out=True) is True
              and b.eval("window.__zoom") == 4, repr(b.eval("window.__zoom")))
        # Honest refusal under an overlay, and on an absent target.
        b.eval("document.getElementById('veil').style.display='block'")
        check("zoom_at refuses through an overlay",
              b.zoom_at("#map") is False)
        check("nothing zoomed while occluded",
              b.eval("window.__zoom") == 4, repr(b.eval("window.__zoom")))
        b.eval("document.getElementById('veil').style.display='none'")
        check("zoom_at on an absent element returns False",
              b.zoom_at("#nope") is False)
    finally:
        sp.shutdown()


def round_key_activate(b: Browser, offline: bool) -> None:
    print("R49: keyboard-activate a keydown-only control (F085) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>kbd</title>"
            b"<div id=btn role=button tabindex=0 "
            b"style='width:160px;height:40px;border:1px solid;padding:8px'>Submit</div>"
            b"<div id=plain "
            b"style='width:160px;height:40px;border:1px solid;padding:8px'>NoTab</div>"
            b"<div id=veil style='position:fixed;inset:0;background:rgba(0,0,0,0);"
            b"display:none'></div>"
            b"<div id=log></div>"
            b"<script>window.__fire=0;var d=document.getElementById('btn');"
            b"d.addEventListener('keydown',function(e){"
            b"if(e.key==='Enter'||e.key===' '){window.__fire++;"
            b"document.getElementById('log').textContent='FIRED '+e.key;}});</script>")
    sp = _serve(8978, page)
    try:
        b.navigate("http://127.0.0.1:8978/")
        time.sleep(0.2)
        # A mouse click never reaches a keydown-only handler.
        check("a click leaves the keydown-only control dead",
              b.click("#btn") is True and b.eval("window.__fire") == 0,
              repr(b.eval("window.__fire")))
        # key_activate focuses and presses Enter, which the handler hears.
        check("key_activate fires the control with Enter",
              b.key_activate("#btn") is True)
        check("the keydown handler fired once with Enter",
              b.eval("window.__fire") == 1
              and b.eval("document.getElementById('log').textContent") == "FIRED Enter",
              repr(b.eval("document.getElementById('log').textContent")))
        # Space also activates it.
        check("key_activate with Space fires too",
              b.key_activate("#btn", key="Space") is True
              and b.eval("window.__fire") == 2, repr(b.eval("window.__fire")))
        # The keyboard reaches it even under a pointer-occluding overlay,
        # exactly where click() honestly refuses.
        b.eval("document.getElementById('veil').style.display='block'")
        check("click refuses through the overlay (F061)",
              b.click("#btn") is False)
        check("key_activate still reaches it through the overlay",
              b.key_activate("#btn") is True and b.eval("window.__fire") == 3,
              repr(b.eval("window.__fire")))
        b.eval("document.getElementById('veil').style.display='none'")
        # An element that cannot hold focus cannot be keyboard-activated.
        check("key_activate on a non-focusable element returns False",
              b.key_activate("#plain") is False)
        check("key_activate on an absent element returns False",
              b.key_activate("#nope") is False)
    finally:
        sp.shutdown()


def round_key_step(b: Browser, offline: bool) -> None:
    print("R50: arrow-key step a keyboard-only slider (F086) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>slider</title>"
            b"<div id=sld role=slider tabindex=0 aria-valuenow=5 aria-valuemin=0 "
            b"aria-valuemax=10 style='width:200px;height:30px;border:1px solid'>"
            b"val:5</div>"
            b"<div id=plain style='width:200px;height:30px;border:1px solid'>"
            b"notab</div>"
            b"<script>var v=5;var s=document.getElementById('sld');"
            b"s.addEventListener('keydown',function(e){"
            b"if(e.key==='ArrowRight'&&v<10){v++;}"
            b"else if(e.key==='ArrowLeft'&&v>0){v--;}else return;"
            b"s.setAttribute('aria-valuenow',v);s.textContent='val:'+v;});</script>")
    sp = _serve(8979, page)

    def now() -> int:
        return int(b.eval(
            "document.getElementById('sld').getAttribute('aria-valuenow')"))
    try:
        b.navigate("http://127.0.0.1:8979/")
        time.sleep(0.2)
        # Neither a click nor Enter/Space moves a keyboard-only slider.
        check("a click leaves the slider unmoved",
              b.click("#sld") is True and now() == 5, repr(now()))
        check("key_activate (Enter) also leaves it unmoved",
              b.key_activate("#sld") is True and now() == 5, repr(now()))
        # Arrow taps step it precisely.
        check("key_step ArrowRight x3 steps it up to 8",
              b.key_step("#sld", "ArrowRight", times=3) is True and now() == 8,
              repr(now()))
        check("key_step ArrowLeft x2 steps it back to 6",
              b.key_step("#sld", "ArrowLeft", times=2) is True and now() == 6,
              repr(now()))
        check("a single default ArrowRight tap reaches 7",
              b.key_step("#sld") is True and now() == 7, repr(now()))
        # Honest refusals.
        check("key_step on a non-focusable element returns False",
              b.key_step("#plain", "ArrowRight") is False)
        check("key_step on an absent element returns False",
              b.key_step("#nope", "ArrowRight") is False)
        check("key_step with an unknown key returns False and does nothing",
              b.key_step("#sld", "NotAKey") is False and now() == 7, repr(now()))
    finally:
        sp.shutdown()


def round_triple_click(b: Browser, offline: bool) -> None:
    print("R51: triple-click to select a paragraph (F087) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>triple</title>"
            b"<p id=para style='width:300px;font:16px monospace'>"
            b"alpha beta gamma delta</p>"
            b"<div id=veil style='position:fixed;inset:0;background:rgba(0,0,0,0);"
            b"display:none'></div>")
    sp = _serve(8980, page)

    def sel() -> str:
        return b.eval("String(window.getSelection())")
    try:
        b.navigate("http://127.0.0.1:8980/")
        time.sleep(0.2)
        b.eval("window.getSelection().removeAllRanges()")
        # A single click only drops a caret — selects nothing.
        check("a single click selects no text",
              b.click("#para") is True and sel() == "", repr(sel()))
        b.eval("window.getSelection().removeAllRanges()")
        # A double-click selects only one word.
        check("double_click selects just one word",
              b.double_click("#para") is True and sel() == "delta", repr(sel()))
        b.eval("window.getSelection().removeAllRanges()")
        # A triple-click selects the whole paragraph.
        check("triple_click selects the whole paragraph",
              b.triple_click("#para") is True
              and sel() == "alpha beta gamma delta", repr(sel()))
        b.eval("window.getSelection().removeAllRanges()")
        b.eval("document.getElementById('veil').style.display='block'")
        check("triple_click refuses through an overlay",
              b.triple_click("#para") is False)
        check("nothing was selected while occluded", sel() == "", repr(sel()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("triple_click on an absent element returns False",
              b.triple_click("#nope") is False)
    finally:
        sp.shutdown()


def round_drag_by(b: Browser, offline: bool) -> None:
    print("R52: drag a splitter handle by an exact pixel delta (F088) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>resize</title>"
            b"<style>#row{display:flex;width:600px;height:120px;font:14px monospace}"
            b"#panel{width:200px;background:#cde;overflow:hidden}"
            b"#grip{width:10px;background:#444;cursor:col-resize}"
            b"#rest{flex:1;background:#eee}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}</style>"
            b"<div id=row><div id=panel>panel</div><div id=grip></div>"
            b"<div id=rest>rest</div></div><div id=veil></div>"
            b"<script>var g=document.getElementById('grip'),p=document.getElementById('panel'),"
            b"drag=null;g.addEventListener('mousedown',function(e){"
            b"drag={x:e.clientX,w:p.getBoundingClientRect().width};e.preventDefault();});"
            b"window.addEventListener('mousemove',function(e){if(!drag)return;"
            b"p.style.width=Math.max(40,drag.w+(e.clientX-drag.x))+'px';});"
            b"window.addEventListener('mouseup',function(){drag=null;});</script>")
    sp = _serve(8981, page)

    def width() -> float:
        return b.eval("document.getElementById('panel').getBoundingClientRect().width")
    try:
        b.navigate("http://127.0.0.1:8981/")
        time.sleep(0.2)
        w0 = width()
        check("panel starts at its base width", abs(w0 - 200) < 2, w0)
        # A plain click on the grip presses+releases at one point — no travel,
        # no resize.
        check("click on the grip leaves the width unchanged",
              b.click("#grip") is True and abs(width() - w0) < 2, width())
        # drag_by carries the cursor a precise delta; the panel grows by it.
        check("drag_by(+120) widens the panel by ~120px",
              b.drag_by("#grip", 120, 0) is True
              and abs(width() - (w0 + 120)) < 6, width())
        w1 = width()
        # A negative delta shrinks it back by the same precise amount.
        check("drag_by(-80) narrows the panel by ~80px",
              b.drag_by("#grip", -80, 0) is True
              and abs(width() - (w1 - 80)) < 6, width())
        w2 = width()
        b.eval("document.getElementById('veil').style.display='block'")
        check("drag_by refuses through an overlay",
              b.drag_by("#grip", 60, 0) is False)
        check("nothing moved while the grip was occluded",
              abs(width() - w2) < 2, width())
        b.eval("document.getElementById('veil').style.display='none'")
        check("drag_by on an absent handle returns False",
              b.drag_by("#nope", 50, 0) is False)
    finally:
        sp.shutdown()


def round_middle_click(b: Browser, offline: bool) -> None:
    print("R53: middle-click to fire an auxclick handler (F089) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>aux</title>"
            b"<style>html,body{margin:0}"
            b"#t{width:160px;height:80px;background:#cdf;font:16px monospace}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=t>target</div><div id=veil></div>"
            b"<script>window.aux=0;window.lft=0;"
            b"var t=document.getElementById('t');"
            b"t.addEventListener('click',function(e){if(e.button===0)window.lft++;});"
            b"t.addEventListener('auxclick',function(e){if(e.button===1)window.aux++;});"
            b"</script>")
    sp = _serve(8982, page)

    def aux() -> int:
        return b.eval("window.aux")

    def lft() -> int:
        return b.eval("window.lft")
    try:
        b.navigate("http://127.0.0.1:8982/")
        time.sleep(0.2)
        check("no events fired yet", aux() == 0 and lft() == 0, f"{aux()},{lft()}")
        # Friction: a left click fires `click` (button 0), never the middle-only
        # `auxclick` handler — yet it cheerfully returns True.
        check("a left click fires click, not auxclick (but returns True)",
              b.click("#t") is True and lft() == 1 and aux() == 0,
              f"aux={aux()} lft={lft()}")
        # Primitive: a faithful middle press/release fires auxclick with button 1.
        check("middle_click fires auxclick (button 1)",
              b.middle_click("#t") is True and aux() == 1, repr(aux()))
        check("middle_click did not also fire a left click",
              lft() == 1, repr(lft()))
        # Honest refusals.
        b.eval("document.getElementById('veil').style.display='block'")
        check("middle_click refuses through an overlay",
              b.middle_click("#t") is False)
        check("no auxclick fired while occluded", aux() == 1, repr(aux()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("middle_click on an absent element returns False",
              b.middle_click("#nope") is False)
    finally:
        sp.shutdown()


def round_right_drag_by(b: Browser, offline: bool) -> None:
    print("R54: right-button drag to pan a viewport (F090) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>rdrag</title>"
            b"<style>html,body{margin:0}"
            b"#pad{width:320px;height:200px;background:#cdf}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=pad>pan</div><div id=veil></div>"
            b"<script>window.panx=0;window.lmoves=0;"
            b"var pad=document.getElementById('pad'),drag=false,sx=0,base=0;"
            b"pad.addEventListener('mousedown',function(e){if(e.button===2){"
            b"drag=true;sx=e.clientX;e.preventDefault();}});"
            b"window.addEventListener('mousemove',function(e){if(!drag)return;"
            b"if(e.buttons&2){window.panx=base+(e.clientX-sx);window.lmoves++;}});"
            b"window.addEventListener('mouseup',function(e){if(e.button===2){"
            b"drag=false;base=window.panx;}});"
            b"window.addEventListener('contextmenu',function(e){e.preventDefault();});"
            b"</script>")
    sp = _serve(8983, page)

    def panx() -> int:
        return b.eval("window.panx")
    try:
        b.navigate("http://127.0.0.1:8983/")
        time.sleep(0.2)
        check("pan starts at 0", panx() == 0, repr(panx()))
        # Friction: a left drag carries buttons:1 — the buttons&2 pan guard never
        # fires, so the viewport does not move at all.
        check("left drag_by does not pan a right-drag viewport (buttons mismatch)",
              b.drag_by("#pad", 80, 0) is True and panx() == 0, repr(panx()))
        # Primitive: a faithful right-button drag pans by exactly the delta.
        check("right_drag_by(+60) pans the viewport to exactly 60",
              b.right_drag_by("#pad", 60, 0) is True and panx() == 60, repr(panx()))
        check("right_drag_by(-25) pans back to exactly 35",
              b.right_drag_by("#pad", -25, 0) is True and panx() == 35, repr(panx()))
        # Honest refusals.
        b.eval("document.getElementById('veil').style.display='block'")
        check("right_drag_by refuses through an overlay",
              b.right_drag_by("#pad", 40, 0) is False)
        check("nothing panned while occluded", panx() == 35, repr(panx()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("right_drag_by on an absent element returns False",
              b.right_drag_by("#nope", 40, 0) is False)
    finally:
        sp.shutdown()


def round_tap(b: Browser, offline: bool) -> None:
    print("R55: touch tap to wake a touch-only handler (F091) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>tap</title>"
            b"<style>html,body{margin:0}"
            b"#b{width:160px;height:90px;background:#cfc}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=b>touch</div><div id=veil></div>"
            b"<script>window.ts=0;window.clk=0;"
            b"var el=document.getElementById('b');"
            b"el.addEventListener('touchstart',function(e){window.ts++;},{passive:true});"
            b"el.addEventListener('click',function(e){window.clk++;});"
            b"</script>")
    sp = _serve(8984, page)

    def ts() -> int:
        return b.eval("window.ts")

    def clk() -> int:
        return b.eval("window.clk")
    try:
        b.navigate("http://127.0.0.1:8984/")
        time.sleep(0.2)
        check("no touchstart yet", ts() == 0, repr(ts()))
        check("a mouse click never fires touchstart (but returns True)",
              b.click("#b") is True and clk() == 1 and ts() == 0,
              f"clk={clk()} ts={ts()}")
        check("tap fires a real touchstart", b.tap("#b") is True and ts() == 1,
              repr(ts()))
        b.eval("document.getElementById('veil').style.display='block'")
        check("tap refuses through an overlay", b.tap("#b") is False)
        check("no touchstart fired while occluded", ts() == 1, repr(ts()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("tap on an absent element returns False", b.tap("#nope") is False)
    finally:
        sp.shutdown()


def round_swipe(b: Browser, offline: bool) -> None:
    print("R56: touch swipe to drive a touchmove carousel (F092) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>swipe</title>"
            b"<style>html,body{margin:0}"
            b"#c{width:320px;height:160px;background:#fec}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=c>carousel</div><div id=veil></div>"
            b"<script>window.dist=0;window.moves=0;"
            b"var c=document.getElementById('c'),sx=0,on=false;"
            b"c.addEventListener('touchstart',function(e){on=true;sx=e.touches[0].clientX;},{passive:true});"
            b"c.addEventListener('touchmove',function(e){if(!on)return;"
            b"window.dist=e.touches[0].clientX-sx;window.moves++;},{passive:true});"
            b"c.addEventListener('touchend',function(e){on=false;},{passive:true});"
            b"</script>")
    sp = _serve(8985, page)

    def dist() -> int:
        return b.eval("window.dist")
    try:
        b.navigate("http://127.0.0.1:8985/")
        time.sleep(0.2)
        check("carousel starts at 0", dist() == 0, repr(dist()))
        # Friction: a left mouse drag is invisible to a touchmove listener.
        check("left drag_by does not drive a touch carousel (no touchmove)",
              b.drag_by("#c", 100, 0) is True and dist() == 0, repr(dist()))
        # Primitive: a faithful touch swipe travels exactly the delta.
        check("swipe(+120) drives the carousel to exactly 120",
              b.swipe("#c", 120, 0) is True and dist() == 120, repr(dist()))
        check("swipe(-60) drives the carousel to exactly -60",
              b.swipe("#c", -60, 0) is True and dist() == -60, repr(dist()))
        b.eval("document.getElementById('veil').style.display='block'")
        check("swipe refuses through an overlay",
              b.swipe("#c", 80, 0) is False)
        check("nothing moved while occluded", dist() == -60, repr(dist()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("swipe on an absent element returns False",
              b.swipe("#nope", 80, 0) is False)
    finally:
        sp.shutdown()


def round_pinch(b: Browser, offline: bool) -> None:
    print("R57: two-finger pinch to zoom a gesture view (F093) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>pinch</title>"
            b"<style>html,body{margin:0}"
            b"#m{width:320px;height:240px;background:#dfe}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=m>map</div><div id=veil></div>"
            b"<script>window.scale=1;window.tm=0;var base=null;"
            b"var m=document.getElementById('m');"
            b"function dist(t){var a=t[0],b=t[1];"
            b"return Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);}"
            b"m.addEventListener('touchstart',function(e){"
            b"if(e.touches.length===2){base=dist(e.touches);}},{passive:true});"
            b"m.addEventListener('touchmove',function(e){"
            b"if(e.touches.length===2&&base){window.scale=dist(e.touches)/base;"
            b"window.tm++;}},{passive:true});"
            b"m.addEventListener('touchend',function(e){"
            b"if(e.touches.length<2){base=null;}},{passive:true});"
            b"</script>")
    sp = _serve(8986, page)

    def scale() -> float:
        return b.eval("window.scale")
    try:
        b.navigate("http://127.0.0.1:8986/")
        time.sleep(0.2)
        check("view starts at scale 1", scale() == 1, repr(scale()))
        # Friction: a single travelling finger never satisfies a 2-touch handler.
        check("swipe (one finger) does not zoom a pinch view",
              b.swipe("#m", 100, 0) is True and scale() == 1, repr(scale()))
        # Primitive: a faithful two-finger spread zooms by the distance ratio.
        check("pinch(+60) spreads to exactly 4x (20px base -> 80px)",
              b.pinch("#m", 60) is True and scale() == 4, repr(scale()))
        check("pinch(-10) closes to exactly 0.5x (20px base -> 10px)",
              b.pinch("#m", -10) is True and scale() == 0.5, repr(scale()))
        b.eval("document.getElementById('veil').style.display='block'")
        check("pinch refuses through an overlay", b.pinch("#m", 40) is False)
        check("nothing zoomed while occluded", scale() == 0.5, repr(scale()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("pinch on an absent element returns False",
              b.pinch("#nope", 40) is False)
    finally:
        sp.shutdown()


def round_rotate(b: Browser, offline: bool) -> None:
    print("R58: two-finger rotate to twist a gesture view (F094) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>rotate</title>"
            b"<style>html,body{margin:0}"
            b"#m{width:320px;height:240px;background:#edf}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=m>map</div><div id=veil></div>"
            b"<script>window.rot=0;window.scl=1;window.tm=0;var a0=null,d0=null;"
            b"var m=document.getElementById('m');"
            b"function ang(t){var a=t[0],b=t[1];"
            b"return Math.atan2(b.clientY-a.clientY,b.clientX-a.clientX)*180/Math.PI;}"
            b"function dst(t){var a=t[0],b=t[1];"
            b"return Math.hypot(b.clientX-a.clientX,b.clientY-a.clientY);}"
            b"m.addEventListener('touchstart',function(e){"
            b"if(e.touches.length===2){a0=ang(e.touches);d0=dst(e.touches);}},{passive:true});"
            b"m.addEventListener('touchmove',function(e){"
            b"if(e.touches.length===2&&a0!==null){var d=ang(e.touches)-a0;"
            b"while(d>180)d-=360;while(d<-180)d+=360;window.rot=Math.round(d);"
            b"window.scl=dst(e.touches)/d0;window.tm++;}},{passive:true});"
            b"m.addEventListener('touchend',function(e){"
            b"if(e.touches.length<2){a0=null;}},{passive:true});"
            b"</script>")
    sp = _serve(8987, page)

    def rot() -> float:
        return b.eval("window.rot")

    def scl() -> float:
        return b.eval("window.scl")
    try:
        b.navigate("http://127.0.0.1:8987/")
        time.sleep(0.2)
        check("view starts unrotated", rot() == 0, repr(rot()))
        # Friction: a pinch changes the spread, not the angle — no twist.
        check("pinch does not rotate a twist view",
              b.pinch("#m", 60) is True and rot() == 0, repr(rot()))
        # Primitive: a faithful two-finger twist turns the line by the angle.
        check("rotate(+90) twists to exactly 90 degrees",
              b.rotate("#m", 90) is True and rot() == 90, repr(rot()))
        check("rotate holds the inter-finger distance (no zoom)",
              abs(scl() - 1.0) < 1e-6, repr(scl()))
        check("rotate(-45) twists to exactly -45 degrees",
              b.rotate("#m", -45) is True and rot() == -45, repr(rot()))
        b.eval("document.getElementById('veil').style.display='block'")
        check("rotate refuses through an overlay", b.rotate("#m", 30) is False)
        check("nothing twisted while occluded", rot() == -45, repr(rot()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("rotate on an absent element returns False",
              b.rotate("#nope", 30) is False)
    finally:
        sp.shutdown()


def round_touch_hold(b: Browser, offline: bool) -> None:
    print("R59: touch long-press to arm a dwell-gated handler (F095) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>lp</title>"
            b"<style>html,body{margin:0}"
            b"#b{width:220px;height:140px;background:#dde}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=b>hold</div><div id=veil></div>"
            b"<script>window.lp=0;window.ts=0;var t=null;"
            b"var el=document.getElementById('b');"
            b"el.addEventListener('touchstart',function(e){window.ts++;"
            b"t=setTimeout(function(){window.lp++;},350);},{passive:true});"
            b"el.addEventListener('touchmove',function(e){"
            b"if(t){clearTimeout(t);t=null;}},{passive:true});"
            b"el.addEventListener('touchend',function(e){"
            b"if(t){clearTimeout(t);t=null;}},{passive:true});"
            b"</script>")
    sp = _serve(8988, page)

    def lp() -> int:
        return b.eval("window.lp")

    def ts() -> int:
        return b.eval("window.ts")
    try:
        b.navigate("http://127.0.0.1:8988/")
        time.sleep(0.2)
        check("long-press starts unfired", lp() == 0 and ts() == 0,
              repr((lp(), ts())))
        # Friction: a mouse press sends no touchstart — the dwell never arms.
        check("mouse press_hold never arms a touch long-press",
              b.press_hold("#b", 0.6) is True and ts() == 0 and lp() == 0,
              repr((ts(), lp())))
        # Friction: a tap fires touchstart but lifts at once, cancelling the timer.
        check("tap fires touchstart but cancels the dwell timer",
              b.tap("#b") is True and ts() == 1 and lp() == 0,
              repr((ts(), lp())))
        # Primitive: a held, motionless touch lets the dwell timer elapse.
        check("touch_hold holds past the dwell and fires once",
              b.touch_hold("#b", 0.6) is True and lp() == 1, repr(lp()))
        check("touch_hold issues no move (timer never cancelled)",
              ts() == 2, repr(ts()))
        b.eval("document.getElementById('veil').style.display='block'")
        check("touch_hold refuses through an overlay",
              b.touch_hold("#b", 0.6) is False)
        check("nothing fired while occluded", lp() == 1, repr(lp()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("touch_hold on an absent element returns False",
              b.touch_hold("#nope", 0.6) is False)
    finally:
        sp.shutdown()


def round_double_tap(b: Browser, offline: bool) -> None:
    print("R60: touch double-tap to trip a fast double-tap gesture (F096) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>dt</title>"
            b"<style>html,body{margin:0}"
            b"#b{width:200px;height:120px;background:#dde}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=b>tap</div><div id=veil></div>"
            b"<script>window.dt=0;window.tc=0;window.lastT=-9999;"
            b"var el=document.getElementById('b');"
            b"el.addEventListener('touchend',function(e){window.tc++;"
            b"var n=Date.now();if(n-window.lastT<250){window.dt++;window.lastT=-9999;}"
            b"else{window.lastT=n;}},{passive:true});"
            b"</script>")
    sp = _serve(8989, page)

    def dt() -> int:
        return b.eval("window.dt")

    def tc() -> int:
        return b.eval("window.tc")

    def reset() -> None:
        b.eval("window.dt=0;window.tc=0;window.lastT=-9999;")
    try:
        b.navigate("http://127.0.0.1:8989/")
        time.sleep(0.2)
        check("double-tap starts unfired", dt() == 0 and tc() == 0,
              repr((dt(), tc())))
        # Friction: a mouse double_click sends no touch events at all.
        check("mouse double_click fires no touch double-tap",
              b.double_click("#b") is True and tc() == 0 and dt() == 0,
              repr((tc(), dt())))
        # Friction: two taps spaced past the window only re-arm, never commit.
        reset()
        check("first slow tap fires one touchend",
              b.tap("#b") is True and tc() == 1 and dt() == 0, repr((tc(), dt())))
        time.sleep(0.4)
        check("second tap past the window does not commit a double-tap",
              b.tap("#b") is True and tc() == 2 and dt() == 0, repr((tc(), dt())))
        # Primitive: two touch pairs inside the window commit exactly one double-tap.
        reset()
        check("double_tap commits one double-tap from two rapid touches",
              b.double_tap("#b") is True and dt() == 1, repr(dt()))
        check("double_tap fired exactly two touchends", tc() == 2, repr(tc()))
        b.eval("document.getElementById('veil').style.display='block'")
        check("double_tap refuses through an overlay",
              b.double_tap("#b") is False)
        check("nothing fired while occluded", dt() == 1, repr(dt()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("double_tap on an absent element returns False",
              b.double_tap("#nope") is False)
    finally:
        sp.shutdown()


def round_two_finger_tap(b: Browser, offline: bool) -> None:
    print("R61: two-finger tap that lands and lifts still (F097) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>tf</title>"
            b"<style>html,body{margin:0}"
            b"#b{width:240px;height:160px;background:#dde}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=b>two</div><div id=veil></div>"
            b"<script>window.tf=0;var saw=false,moved=false;"
            b"var el=document.getElementById('b');"
            b"el.addEventListener('touchstart',function(e){"
            b"if(e.touches.length===2){saw=true;}},{passive:true});"
            b"el.addEventListener('touchmove',function(e){moved=true;},{passive:true});"
            b"el.addEventListener('touchend',function(e){"
            b"if(e.touches.length===0){if(saw&&!moved){window.tf++;}saw=false;moved=false;}"
            b"},{passive:true});"
            b"</script>")
    sp = _serve(8990, page)

    def tf() -> int:
        return b.eval("window.tf")

    def reset() -> None:
        b.eval("window.tf=0;")
    try:
        b.navigate("http://127.0.0.1:8990/")
        time.sleep(0.2)
        check("two-finger tap starts unfired", tf() == 0, repr(tf()))
        # Friction: a single-finger tap never arms the two-finger detector.
        check("one-finger tap does not trip a two-finger tap",
              b.tap("#b") is True and tf() == 0, repr(tf()))
        # Friction: pinch lands two fingers but moves them, so a tap detector
        # that drops on touchmove refuses to commit.
        reset()
        check("pinch (two fingers that move) does not commit a two-finger tap",
              b.pinch("#b", 60) is True and tf() == 0, repr(tf()))
        # Friction: rotate also moves two fingers and so never taps.
        reset()
        check("rotate (two fingers that turn) does not commit a two-finger tap",
              b.rotate("#b", 45) is True and tf() == 0, repr(tf()))
        # Primitive: two fingers down, lifted still, commit exactly one tap.
        reset()
        check("two_finger_tap commits one two-finger tap",
              b.two_finger_tap("#b") is True and tf() == 1, repr(tf()))
        b.eval("document.getElementById('veil').style.display='block'")
        check("two_finger_tap refuses through an overlay",
              b.two_finger_tap("#b") is False)
        check("nothing fired while occluded", tf() == 1, repr(tf()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("two_finger_tap on an absent element returns False",
              b.two_finger_tap("#nope") is False)
    finally:
        sp.shutdown()


def round_touch_drag(b: Browser, offline: bool) -> None:
    print("R62: long-press-to-arm touch drag (F098) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>td</title>"
            b"<style>html,body{margin:0}"
            b"#b{width:240px;height:160px;background:#dde}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=b>drag</div><div id=veil></div>"
            b"<script>window.armed=false;window.dragged=0;window.dropped=0;"
            b"var arm=false,timer=null,sx=0;"
            b"var el=document.getElementById('b');"
            b"el.addEventListener('touchstart',function(e){"
            b"sx=e.touches[0].clientX;arm=false;"
            b"timer=setTimeout(function(){arm=true;window.armed=true;},200);"
            b"},{passive:true});"
            b"el.addEventListener('touchmove',function(e){"
            b"if(!arm){clearTimeout(timer);return;}"
            b"window.dragged=Math.round(e.touches[0].clientX-sx);"
            b"},{passive:true});"
            b"el.addEventListener('touchend',function(e){"
            b"clearTimeout(timer);if(arm&&window.dragged!==0){window.dropped++;}"
            b"arm=false;},{passive:true});"
            b"</script>")
    sp = _serve(8991, page)

    def st():
        return (b.eval("window.armed"), b.eval("window.dragged"),
                b.eval("window.dropped"))

    def reset() -> None:
        b.eval("window.armed=false;window.dragged=0;window.dropped=0;")
    try:
        b.navigate("http://127.0.0.1:8991/")
        time.sleep(0.2)
        a, d, dp = st()
        check("touch drag starts unfired", (a, d, dp) == (False, 0, 0),
              repr((a, d, dp)))
        # Friction: a swipe moves immediately, so the arm timer is cancelled
        # (early move reads as a scroll) and the drag never engages.
        check("swipe (immediate move) never arms the drag",
              b.swipe("#b", 80, 0) is True and st()[2] == 0, repr(st()))
        check("swipe left the handle un-armed", st()[0] is False, repr(st()))
        # Friction: touch_hold dwells and arms but never moves, so the handle
        # is picked up yet dropped in place — no reorder.
        reset()
        check("touch_hold arms but commits no drag",
              b.touch_hold("#b", 0.3) is True
              and st()[0] is True and st()[2] == 0, repr(st()))
        # Primitive: press, dwell past the arm threshold, then drag and lift.
        reset()
        check("touch_drag arms then commits exactly one drag",
              b.touch_drag("#b", 80, 0) is True
              and st()[1] == 80 and st()[2] == 1, repr(st()))
        b.eval("document.getElementById('veil').style.display='block'")
        check("touch_drag refuses through an overlay",
              b.touch_drag("#b", 80, 0) is False)
        check("nothing dropped while occluded", st()[2] == 1, repr(st()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("touch_drag on an absent element returns False",
              b.touch_drag("#nope", 80, 0) is False)
    finally:
        sp.shutdown()


def round_two_finger_pan(b: Browser, offline: bool) -> None:
    print("R63: two-finger pan / scroll (F099) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>pan</title>"
            b"<style>html,body{margin:0}"
            b"#b{width:260px;height:200px;background:#dde}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=b>pan</div><div id=veil></div>"
            b"<script>window.panned=0;window.rejected=0;"
            b"var d0=null,a0=0,mx0=0,my0=0;"
            b"function dist(t){return Math.hypot("
            b"t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);}"
            b"function ang(t){return Math.atan2("
            b"t[1].clientY-t[0].clientY,t[1].clientX-t[0].clientX);}"
            b"var el=document.getElementById('b');"
            b"el.addEventListener('touchstart',function(e){"
            b"if(e.touches.length===2){d0=dist(e.touches);a0=ang(e.touches);"
            b"mx0=(e.touches[0].clientX+e.touches[1].clientX)/2;"
            b"my0=(e.touches[0].clientY+e.touches[1].clientY)/2;}"
            b"},{passive:true});"
            b"el.addEventListener('touchmove',function(e){"
            b"if(e.touches.length!==2||d0===null)return;"
            b"var dd=Math.abs(dist(e.touches)-d0);"
            b"var da=Math.abs(ang(e.touches)-a0);"
            b"var mx=(e.touches[0].clientX+e.touches[1].clientX)/2;"
            b"var my=(e.touches[0].clientY+e.touches[1].clientY)/2;"
            b"var tr=Math.hypot(mx-mx0,my-my0);"
            b"if(dd>12||da>0.15){window.rejected=1;return;}"
            b"if(tr>8){window.panned=Math.round(tr);}"
            b"},{passive:true});"
            b"el.addEventListener('touchend',function(e){d0=null;},{passive:true});"
            b"</script>")
    sp = _serve(8996, page)

    def st():
        return (b.eval("window.panned"), b.eval("window.rejected"))

    def reset() -> None:
        b.eval("window.panned=0;window.rejected=0;")
    try:
        b.navigate("http://127.0.0.1:8996/")
        time.sleep(0.2)
        check("two-finger pan starts unfired", st() == (0, 0), repr(st()))
        # Friction: a one-finger swipe never reaches touches.length===2.
        check("swipe (one finger) never pans",
              b.swipe("#b", 80, 0) is True and st() == (0, 0), repr(st()))
        # Friction: a pinch changes the spread, so a pan handler that rejects
        # scale-change ignores it.
        reset()
        check("pinch (spread change) is rejected, not panned",
              b.pinch("#b", 80) is True
              and st()[0] == 0 and st()[1] == 1, repr(st()))
        # Friction: a rotate turns the line, so a pan handler that rejects
        # angle-change ignores it.
        reset()
        check("rotate (angle change) is rejected, not panned",
              b.rotate("#b", 45) is True
              and st()[0] == 0 and st()[1] == 1, repr(st()))
        # Primitive: two points translate together — spread and angle fixed.
        reset()
        check("two_finger_pan slides the rigid pair and commits one pan",
              b.two_finger_pan("#b", 80, 0) is True
              and st()[0] == 80 and st()[1] == 0, repr(st()))
        b.eval("document.getElementById('veil').style.display='block'")
        reset()
        check("two_finger_pan refuses through an overlay",
              b.two_finger_pan("#b", 80, 0) is False)
        check("nothing panned while occluded", st() == (0, 0), repr(st()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("two_finger_pan on an absent element returns False",
              b.two_finger_pan("#nope", 80, 0) is False)
    finally:
        sp.shutdown()


def round_three_finger_swipe(b: Browser, offline: bool) -> None:
    print("R64: three-finger swipe (F100) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>3f</title>"
            b"<style>html,body{margin:0}"
            b"#b{width:300px;height:220px;background:#dde}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=b>three</div><div id=veil></div>"
            b"<script>window.swiped3=0;window.maxn=0;"
            b"function mid(t){var x=0,y=0;for(var i=0;i<t.length;i++){"
            b"x+=t[i].clientX;y+=t[i].clientY;}return[x/t.length,y/t.length];}"
            b"var m0=null;"
            b"var el=document.getElementById('b');"
            b"el.addEventListener('touchstart',function(e){"
            b"window.maxn=Math.max(window.maxn,e.touches.length);"
            b"if(e.touches.length===3){m0=mid(e.touches);}},{passive:true});"
            b"el.addEventListener('touchmove',function(e){"
            b"window.maxn=Math.max(window.maxn,e.touches.length);"
            b"if(e.touches.length!==3||!m0)return;"
            b"var m=mid(e.touches);var tr=Math.hypot(m[0]-m0[0],m[1]-m0[1]);"
            b"if(tr>8){window.swiped3=Math.round(tr);}},{passive:true});"
            b"el.addEventListener('touchend',function(e){"
            b"if(e.touches.length===0)m0=null;},{passive:true});"
            b"</script>")
    sp = _serve(8997, page)

    def st():
        return (b.eval("window.swiped3"), b.eval("window.maxn"))

    def reset() -> None:
        b.eval("window.swiped3=0;window.maxn=0;")
    try:
        b.navigate("http://127.0.0.1:8997/")
        time.sleep(0.2)
        check("three-finger swipe starts unfired", st() == (0, 0), repr(st()))
        # Friction: one finger never raises the touch count past one.
        check("swipe (one finger) never reaches three",
              b.swipe("#b", 80, 0) is True
              and st()[0] == 0 and st()[1] == 1, repr(st()))
        # Friction: two fingers reach two and stop — never the third.
        reset()
        check("two_finger_pan (two fingers) never reaches three",
              b.two_finger_pan("#b", 80, 0) is True
              and st()[0] == 0 and st()[1] == 2, repr(st()))
        # Primitive: three points abreast translate together.
        reset()
        check("three_finger_swipe slides a rigid trio and commits",
              b.three_finger_swipe("#b", 80, 0) is True
              and st()[0] == 80 and st()[1] == 3, repr(st()))
        b.eval("document.getElementById('veil').style.display='block'")
        reset()
        check("three_finger_swipe refuses through an overlay",
              b.three_finger_swipe("#b", 80, 0) is False)
        check("nothing swiped while occluded", st() == (0, 0), repr(st()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("three_finger_swipe on an absent element returns False",
              b.three_finger_swipe("#nope", 80, 0) is False)
    finally:
        sp.shutdown()


def round_edge_swipe(b: Browser, offline: bool) -> None:
    print("R65: edge swipe (F101) — cdp")
    page = (b"<!doctype html><meta charset=utf-8><title>edge</title>"
            b"<style>html,body{margin:0}"
            b"#b{width:320px;height:220px;background:#dde}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=b>edge</div><div id=veil></div>"
            b"<script>window.opened=0;window.midstart=0;var sx=null;"
            b"var el=document.getElementById('b');"
            b"el.addEventListener('touchstart',function(e){"
            b"sx=e.touches[0].clientX;},{passive:true});"
            b"el.addEventListener('touchmove',function(e){"
            b"if(sx===null)return;"
            b"if(sx>24){window.midstart=1;return;}"
            b"var dx=e.touches[0].clientX-sx;"
            b"if(dx>40){window.opened=Math.round(dx);}},{passive:true});"
            b"el.addEventListener('touchend',function(e){sx=null;},{passive:true});"
            b"</script>")
    sp = _serve(8998, page)

    def st():
        return (b.eval("window.opened"), b.eval("window.midstart"))

    def reset() -> None:
        b.eval("window.opened=0;window.midstart=0;")
    try:
        b.navigate("http://127.0.0.1:8998/")
        time.sleep(0.2)
        check("edge swipe starts unfired", st() == (0, 0), repr(st()))
        # Friction: a normal swipe starts mid-element, never on the rim.
        check("swipe (mid-start) never opens the edge gesture",
              b.swipe("#b", 120, 0) is True
              and st()[0] == 0 and st()[1] == 1, repr(st()))
        # Primitive: the stroke begins in the edge band and travels inward.
        reset()
        check("edge_swipe born on the rim opens the gesture",
              b.edge_swipe("#b", 120, 0) is True
              and st()[0] >= 40 and st()[1] == 0, repr(st()))
        b.eval("document.getElementById('veil').style.display='block'")
        reset()
        check("edge_swipe refuses through an overlay",
              b.edge_swipe("#b", 120, 0) is False)
        check("nothing opened while occluded", st() == (0, 0), repr(st()))
        b.eval("document.getElementById('veil').style.display='none'")
        check("edge_swipe on an absent element returns False",
              b.edge_swipe("#nope", 120, 0) is False)
    finally:
        sp.shutdown()


def round_touch_drag_to(b: Browser, offline: bool) -> None:
    print("R66: drag to a target zone (F102) — cdp")
    # A real drag surface claims the gesture: ``touch-action:none`` plus
    # non-passive ``preventDefault`` stops the browser from turning a long
    # horizontal stroke into an overscroll back-navigation. Without it Chrome
    # eats the drag and navigates away — an artifact of the surface, not the
    # primitive.
    page = (b"<!doctype html><meta charset=utf-8><title>dragto</title>"
            b"<style>html,body{margin:0;overscroll-behavior:none}"
            b"#card{position:absolute;left:20px;top:80px;width:80px;height:80px;"
            b"background:#7ad;touch-action:none}"
            b"#zone{position:absolute;left:380px;top:60px;width:120px;height:120px;"
            b"background:#efe;border:2px dashed #6a6}"
            b"#veil{position:fixed;inset:0;background:rgba(0,0,0,0);display:none}"
            b"</style><div id=card>card</div><div id=zone>zone</div><div id=veil></div>"
            b"<script>window.dropped=0;window.shortfall=0;var lx=null,ly=null;"
            b"var card=document.getElementById('card');"
            b"function inzone(x,y){var r=document.getElementById('zone').getBoundingClientRect();"
            b"return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;}"
            b"card.addEventListener('touchstart',function(e){e.preventDefault();"
            b"lx=e.touches[0].clientX;ly=e.touches[0].clientY;},{passive:false});"
            b"card.addEventListener('touchmove',function(e){e.preventDefault();"
            b"lx=e.touches[0].clientX;ly=e.touches[0].clientY;},{passive:false});"
            b"card.addEventListener('touchend',function(e){"
            b"if(lx===null)return;"
            b"if(inzone(lx,ly)){window.dropped=1;}else{window.shortfall=1;}"
            b"lx=null;ly=null;},{passive:false});"
            b"</script>")
    sp = _serve(8999, page)

    def st():
        return (b.eval("window.dropped"), b.eval("window.shortfall"))

    def reset() -> None:
        b.eval("window.dropped=0;window.shortfall=0;")
    try:
        b.navigate("http://127.0.0.1:8999/")
        time.sleep(0.2)
        check("drag-to-zone starts unfired", st() == (0, 0), repr(st()))
        # Friction: a blind touch_drag by a guessed delta releases short of the zone.
        check("touch_drag (blind delta) springs back short of the zone",
              b.touch_drag("#card", 30, 0) is True
              and st()[0] == 0 and st()[1] == 1, repr(st()))
        # Primitive: resolve the target and release inside it.
        reset()
        check("touch_drag_to drops the card inside the resolved zone",
              b.touch_drag_to("#card", "#zone") is True
              and st()[0] == 1 and st()[1] == 0, repr(st()))
        # Occluded source refuses.
        b.eval("document.getElementById('veil').style.display='block'")
        reset()
        check("touch_drag_to refuses when the source is occluded",
              b.touch_drag_to("#card", "#zone") is False)
        check("nothing dropped while occluded", st() == (0, 0), repr(st()))
        b.eval("document.getElementById('veil').style.display='none'")
        # Absent endpoints refuse on either side.
        check("touch_drag_to with an absent source returns False",
              b.touch_drag_to("#nope", "#zone") is False)
        check("touch_drag_to with an absent target returns False",
              b.touch_drag_to("#card", "#nope") is False)
    finally:
        sp.shutdown()


def round_read_text(b: Browser, offline: bool) -> None:
    print("R67: read a multi-glyph WORD off the canvas, not just one letter (F103) — osctl")
    # F058 read_glyph reads ONE pre-isolated character. A word the page draws
    # straight onto a canvas ("BOXCAB") is one ink run with no per-letter node;
    # point read_glyph at the whole run and it reduces it to a single signature
    # and returns ONE wrong letter. read_text must first SEGMENT the run into
    # per-glyph cells (column projection over the foreground colour), then read
    # each cell in the scale-free frame and join them in reading order.
    MAG = (255, 0, 255)

    def blobs(rgb, w, h):
        bs = osctl.find_color_blobs(MAG, tol=60, rgb=rgb, size=(w, h), min_count=120)
        return sorted(bs, key=lambda t: t["x"])
    # Phase 1: atlas — candidate glyphs A B C O K X rendered SMALL (90px),
    # spaced so each is its own colour blob.
    chars = "ABCOKX"
    draws = "".join("x.fillText('%s',%d,100);" % (ch, 40 + i * 120)
                    for i, ch in enumerate(chars))
    atlas_html = fixture("rt_atlas.html",
                         "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
                         "<canvas id=c width=760 height=160></canvas><script>"
                         "var x=document.getElementById('c').getContext('2d');"
                         "x.fillStyle='#fff';x.fillRect(0,0,760,160);"
                         "x.fillStyle='#f0f';x.font='bold 90px monospace';"
                         "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>")
    b.navigate(atlas_html)
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = blobs(argb, aw, ah)
    check("atlas segments into six reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def scene(word, font_px=150):
        html = fixture("rt_word.html",
                       "<!doctype html><title>w</title><style>html,body{margin:0}</style>"
                       "<canvas id=c width=1100 height=240></canvas><script>"
                       "var x=document.getElementById('c').getContext('2d');"
                       "x.fillStyle='#fff';x.fillRect(0,0,1100,240);"
                       "x.fillStyle='#f0f';x.font='bold %dpx monospace';"
                       "x.textAlign='left';x.textBaseline='middle';"
                       "x.fillText(%r,30,120);</script>" % (font_px, word))
        b.navigate(html)
        time.sleep(0.4)
        w, h, rgb = osctl.capture_rgb()
        loc = osctl.find_color(MAG, tol=60, rgb=rgb, size=(w, h))
        return rgb, (w, h), (loc["bbox"] if loc else None)

    word = "BOXCAB"
    rgb, sz, run = scene(word)
    check("word run located on the canvas", run is not None, repr(run))
    if run is None:
        return
    # The scene is drawn LARGER than the atlas — a fixed-size match would be
    # fooled; read_glyph/read_text classify scale-free.
    check("scene word is larger than the atlas glyphs",
          (run[3] - run[1]) > (ab[0]["bbox"][3] - ab[0]["bbox"][1]) + 20,
          f"word_h={run[3]-run[1]} atlas_h={ab[0]['bbox'][3]-ab[0]['bbox'][1]}")
    # Friction: a single-glyph read of the whole run yields ONE letter, not the word.
    whole = osctl.read_glyph(rgb, sz, run, atlas)
    check("read_glyph over the whole run returns a single letter, not the word",
          len(whole) == 1 and whole != word, repr(whole))
    # Segmentation cuts the run into one cell per glyph, in reading order.
    cells = osctl.segment_run(rgb, sz, run, MAG)
    check("segment_run cuts the run into one cell per glyph",
          len(cells) == len(word), f"{len(cells)} cells vs {len(word)} glyphs")
    check("segmented cells are in left-to-right reading order",
          all(cells[i][0] < cells[i + 1][0] for i in range(len(cells) - 1)),
          str([c[0] for c in cells]))
    # Primitive: read_text segments then reads each cell, joining in order.
    check("read_text reads the whole word 'BOXCAB'",
          osctl.read_text(rgb, sz, run, atlas, MAG) == word,
          osctl.read_text(rgb, sz, run, atlas, MAG))
    # A different word reads correctly too (no per-word special-casing).
    word2 = "OK"
    rgb2, sz2, run2 = scene(word2)
    check("read_text reads a different word 'OK'",
          run2 is not None and osctl.read_text(rgb2, sz2, run2, atlas, MAG) == word2,
          osctl.read_text(rgb2, sz2, run2, atlas, MAG) if run2 else "no run")
    # A single-glyph run degenerates to read_glyph (one cell, one letter).
    word3 = "X"
    rgb3, sz3, run3 = scene(word3)
    check("read_text on a single-glyph run reads that one glyph",
          run3 is not None and osctl.read_text(rgb3, sz3, run3, atlas, MAG) == word3,
          osctl.read_text(rgb3, sz3, run3, atlas, MAG) if run3 else "no run")
    # Empty (blank) region: nothing inked → segment finds no cells, read is "".
    blank = (5, 5, 25, 25)
    check("segment_run on a blank region finds no glyphs",
          osctl.segment_run(rgb3, sz3, blank, MAG) == [], repr(blank))
    check("read_text on a blank region returns the empty string",
          osctl.read_text(rgb3, sz3, blank, atlas, MAG) == "")


def round_read_kerned(b: Browser, offline: bool) -> None:
    print("R68: read a word whose letters TOUCH — valley split by glyph count (F104) — osctl")
    # segment_run (F103) parts letters only where blank columns separate them.
    # Draw glyphs that OVERLAP (negative kerning) so adjacent letters share a
    # column: segment_run merges them into one wide cell and read_text reads one
    # wrong letter. split_run uses the glyph COUNT n to cut at the n-1 shallowest
    # column-ink valleys (the pinch where only the overlap inks the column).
    MAG = (255, 0, 255)

    def blobs(rgb, w, h):
        bs = osctl.find_color_blobs(MAG, tol=60, rgb=rgb, size=(w, h), min_count=120)
        return sorted(bs, key=lambda t: t["x"])
    chars = "ABCOKX"
    draws = "".join("x.fillText('%s',%d,100);" % (ch, 40 + i * 120)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("rk_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=760 height=160></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,760,160);"
               "x.fillStyle='#f0f';x.font='bold 90px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = blobs(argb, aw, ah)
    check("atlas segments into six reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def kerned(word, ov=40, font_px=130):
        # advance each glyph by (100-ov)px at 130px so neighbours overlap
        x, d = 30, []
        for ch in word:
            d.append("x.fillText('%s',%d,120);" % (ch, x))
            x += 100 - ov
        b.navigate(fixture("rk_word.html",
                   "<!doctype html><title>w</title><style>html,body{margin:0}</style>"
                   "<canvas id=c width=900 height=240></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   "x.fillStyle='#fff';x.fillRect(0,0,900,240);"
                   "x.fillStyle='#f0f';x.font='bold %dpx monospace';"
                   "x.textAlign='left';x.textBaseline='middle';" % font_px
                   + "".join(d) + "</script>"))
        time.sleep(0.4)
        w, h, rgb = osctl.capture_rgb()
        loc = osctl.find_color(MAG, tol=60, rgb=rgb, size=(w, h))
        return rgb, (w, h), (loc["bbox"] if loc else None)

    word = "CAB"
    rgb, sz, run = kerned(word)
    check("kerned word run located on the canvas", run is not None, repr(run))
    if run is None:
        return
    # Friction: blank-column segmentation merges the touching letters.
    seg = osctl.segment_run(rgb, sz, run, MAG)
    check("segment_run merges touching letters into too-few cells",
          len(seg) < len(word), f"{len(seg)} cells for {len(word)} glyphs")
    check("read_text WITHOUT a count misreads the touching run",
          osctl.read_text(rgb, sz, run, atlas, MAG) != word,
          osctl.read_text(rgb, sz, run, atlas, MAG))
    # split_run uses the count to part them at the ink valleys.
    cut = osctl.split_run(rgb, sz, run, MAG, len(word))
    check("split_run parts the touching run into one cell per glyph",
          len(cut) == len(word), f"{len(cut)} cells")
    check("split cells are in left-to-right reading order",
          all(cut[i][0] < cut[i + 1][0] for i in range(len(cut) - 1)),
          str([c[0] for c in cut]))
    check("read_text WITH the count reads the touching word 'CAB'",
          osctl.read_text(rgb, sz, run, atlas, MAG, n=len(word)) == word,
          osctl.read_text(rgb, sz, run, atlas, MAG, n=len(word)))
    # A different touching pair reads correctly too.
    rgb2, sz2, run2 = kerned("AB")
    check("read_text WITH the count reads a different touching word 'AB'",
          run2 is not None and osctl.read_text(rgb2, sz2, run2, atlas, MAG, n=2) == "AB",
          osctl.read_text(rgb2, sz2, run2, atlas, MAG, n=2) if run2 else "no run")
    # n=1 returns the whole run as a single tightened cell (no false seam).
    check("split_run with n=1 returns a single cell",
          len(osctl.split_run(rgb, sz, run, MAG, 1)) == 1)
    # A blank region yields no cut at all (refuses to invent seams).
    check("split_run on a blank region returns no cells",
          osctl.split_run(rgb, sz, (5, 5, 25, 25), MAG, 3) == [])


def round_read_block(b: Browser, offline: bool) -> None:
    print("R69: read a multi-LINE text block — row bands then per-line read (F105) — osctl")
    # read_text projects ink down columns over the whole bbox, assuming ONE line.
    # Stack two lines and every column is inked by both at once: the rows fuse
    # vertically and the block reads as garbage. segment_lines parts them by the
    # blank leading between lines (orthogonal, row-ink projection); read_block
    # reads each band as its own run, top-to-bottom.
    MAG = (255, 0, 255)

    def blobs(rgb, w, h):
        bs = osctl.find_color_blobs(MAG, tol=60, rgb=rgb, size=(w, h), min_count=120)
        return sorted(bs, key=lambda t: t["x"])
    chars = "ABCOKX"
    draws = "".join("x.fillText('%s',%d,100);" % (ch, 40 + i * 120)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("rb_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=760 height=160></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,760,160);"
               "x.fillStyle='#f0f';x.font='bold 90px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = blobs(argb, aw, ah)
    check("atlas segments into six reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def block(lines, lead=130, font_px=110):
        d = []
        for li, word in enumerate(lines):
            y = 90 + li * lead
            for ci, ch in enumerate(word):
                d.append("x.fillText('%s',%d,%d);" % (ch, 40 + ci * 110, y))
        b.navigate(fixture("rb_word.html",
                   "<!doctype html><title>w</title><style>html,body{margin:0}</style>"
                   "<canvas id=c width=560 height=360></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   "x.fillStyle='#fff';x.fillRect(0,0,560,360);"
                   "x.fillStyle='#f0f';x.font='bold %dpx monospace';"
                   "x.textAlign='left';x.textBaseline='middle';" % font_px
                   + "".join(d) + "</script>"))
        time.sleep(0.4)
        w, h, rgb = osctl.capture_rgb()
        loc = osctl.find_color(MAG, tol=60, rgb=rgb, size=(w, h))
        return rgb, (w, h), (loc["bbox"] if loc else None)

    lines = ["OK", "CAB"]
    rgb, sz, blk = block(lines)
    check("two-line block located on the canvas", blk is not None, repr(blk))
    if blk is None:
        return
    # Friction: a single-run read over the whole block fuses the two lines.
    flat = osctl.read_text(rgb, sz, blk, atlas, MAG)
    check("read_text over the whole block does NOT read either line",
          flat != "OK" and flat != "CAB" and flat != "OKCAB", repr(flat))
    # segment_lines parts the block into one band per line.
    bands = osctl.segment_lines(rgb, sz, blk, MAG)
    check("segment_lines parts the block into two line bands",
          len(bands) == len(lines), f"{len(bands)} bands")
    check("line bands are in top-to-bottom order",
          all(bands[i][1] < bands[i + 1][1] for i in range(len(bands) - 1)),
          str([bd[1] for bd in bands]))
    check("each band is narrower in height than the whole block",
          all((bd[3] - bd[1]) < (blk[3] - blk[1]) for bd in bands),
          str([(bd[3] - bd[1]) for bd in bands]))
    # read_block reads each line correctly, top-to-bottom.
    out = osctl.read_block(rgb, sz, blk, atlas, MAG)
    check("read_block reads the two lines in order ['OK','CAB']",
          out == lines, repr(out))
    # A three-line block reads too — no per-block special-casing.
    lines3 = ["OK", "AB", "OK"]
    rgb3, sz3, blk3 = block(lines3, lead=110)
    out3 = osctl.read_block(rgb3, sz3, blk3, atlas, MAG) if blk3 else []
    check("read_block reads a three-line block ['OK','AB','OK']",
          out3 == lines3, repr(out3))
    # A single-line block yields a one-element list (read_text of the line).
    rgb1, sz1, blk1 = block(["OK"])
    out1 = osctl.read_block(rgb1, sz1, blk1, atlas, MAG) if blk1 else []
    check("read_block on a single line returns one element ['OK']",
          out1 == ["OK"], repr(out1))
    # A blank region refuses: no bands, empty list.
    check("segment_lines on a blank region returns no bands",
          osctl.segment_lines(rgb, sz, (5, 5, 25, 25), MAG) == [])
    check("read_block on a blank region returns the empty list",
          osctl.read_block(rgb, sz, (5, 5, 25, 25), atlas, MAG) == [])


def round_read_words(b: Browser, offline: bool) -> None:
    print("R70: read a line WITH word spaces — gap-bimodality (F106) — osctl")
    # read_text joins per-glyph cells with nothing between them: it records WHERE
    # the cells are, never the WIDTH of the blank between them, so a line with a
    # real word gap ("OK  CAB") reads "OKCAB" — the space is dropped. The gaps are
    # bimodal: letter gaps cluster small, the word gap is markedly wider.
    # read_words takes the median gap as the letter spacing and inserts ' ' where
    # a gap is >= space_k x that median.
    MAG = (255, 0, 255)

    def blobs(rgb, w, h):
        bs = osctl.find_color_blobs(MAG, tol=60, rgb=rgb, size=(w, h), min_count=120)
        return sorted(bs, key=lambda t: t["x"])
    chars = "ABCOKX"
    draws = "".join("x.fillText('%s',%d,100);" % (ch, 40 + i * 120)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("rw_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=760 height=160></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,760,160);"
               "x.fillStyle='#f0f';x.font='bold 90px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = blobs(argb, aw, ah)
    check("atlas segments into six reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def line(words, letter_adv=70, word_gap=130, font_px=64):
        d, x = [], 40
        for word in words:
            for ch in word:
                d.append("x.fillText('%s',%d,100);" % (ch, x))
                x += letter_adv
            x += word_gap
        b.navigate(fixture("rw_line.html",
                   "<!doctype html><title>w</title><style>html,body{margin:0}</style>"
                   "<canvas id=c width=900 height=200></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   "x.fillStyle='#fff';x.fillRect(0,0,900,200);"
                   "x.fillStyle='#f0f';x.font='bold %dpx monospace';"
                   "x.textAlign='left';x.textBaseline='middle';" % font_px
                   + "".join(d) + "</script>"))
        time.sleep(0.4)
        w, h, rgb = osctl.capture_rgb()
        loc = osctl.find_color(MAG, tol=60, rgb=rgb, size=(w, h))
        return rgb, (w, h), (loc["bbox"] if loc else None)

    rgb, sz, ln = line(["OK", "CAB"])
    check("two-word line located on the canvas", ln is not None, repr(ln))
    if ln is None:
        return
    # The gaps are bimodal: the inter-word gap is wider than the letter gaps.
    cells = osctl.segment_run(rgb, sz, ln, MAG)
    gaps = [cells[i + 1][0] - cells[i][2] for i in range(len(cells) - 1)]
    check("line segments into five glyph cells", len(cells) == 5, f"{len(cells)} cells")
    check("the word gap is markedly wider than the letter gaps",
          len(gaps) == 4 and max(gaps) >= 1.8 * sorted(gaps)[len(gaps) // 2],
          str(gaps))
    # Friction: read_text drops the space.
    flat = osctl.read_text(rgb, sz, ln, atlas, MAG)
    check("read_text drops the word space (reads 'OKCAB')", flat == "OKCAB", repr(flat))
    # read_words recovers it.
    out = osctl.read_words(rgb, sz, ln, atlas, MAG)
    check("read_words reads 'OK CAB' with the space restored", out == "OK CAB", repr(out))
    check("read_words inserts exactly one space (two words)",
          out.count(" ") == 1, repr(out))
    # A single word gets no spurious space.
    rgb1, sz1, ln1 = line(["CAB"])
    out1 = osctl.read_words(rgb1, sz1, ln1, atlas, MAG) if ln1 else None
    check("read_words on a single word reads 'CAB' (no invented space)",
          out1 == "CAB", repr(out1))
    # Three words read with two spaces, in order.
    rgb3, sz3, ln3 = line(["OK", "AB", "OK"])
    out3 = osctl.read_words(rgb3, sz3, ln3, atlas, MAG) if ln3 else None
    check("read_words reads three words 'OK AB OK'", out3 == "OK AB OK", repr(out3))
    check("read_words inserts exactly two spaces (three words)",
          out3 is not None and out3.count(" ") == 2, repr(out3))
    # A demanding space_k refuses to split the same line (knows its threshold).
    strict = osctl.read_words(rgb, sz, ln, atlas, MAG, space_k=99.0)
    check("a high space_k refuses to split (reads 'OKCAB')", strict == "OKCAB", repr(strict))
    # A blank region reads the empty string.
    check("read_words on a blank region returns ''",
          osctl.read_words(rgb, sz, (5, 5, 25, 25), atlas, MAG) == "")


def round_read_glyph_conf(b: Browser, offline: bool) -> None:
    print("R71: read a glyph only when it CLEARLY fits — refuse unknowns (F107) — osctl")
    # read_glyph returns min(atlas, key=...) — the nearest label, always. Point it
    # at a glyph the atlas never held and it returns the closest WRONG letter; it
    # cannot say "I do not know this". read_glyph_conf admits the best label only
    # when it is both a good absolute fit (best <= max_dist x live ink) AND a clear
    # winner (runner-up >= conf_k x farther); otherwise it returns '' (refuses).
    MAG = (255, 0, 255)

    def blobs(rgb, w, h):
        bs = osctl.find_color_blobs(MAG, tol=60, rgb=rgb, size=(w, h), min_count=120)
        return sorted(bs, key=lambda t: t["x"])
    # Atlas of six glyphs; Z M W 5 8 are deliberately NOT in it.
    chars = "ABCOKX"
    draws = "".join("x.fillText('%s',%d,100);" % (ch, 40 + i * 120)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("rc_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=760 height=160></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,760,160);"
               "x.fillStyle='#f0f';x.font='bold 90px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = blobs(argb, aw, ah)
    check("atlas segments into six reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def one(ch, font_px=120):
        b.navigate(fixture("rc_one.html",
                   "<!doctype html><title>g</title><style>html,body{margin:0}</style>"
                   "<canvas id=c width=240 height=240></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   "x.fillStyle='#fff';x.fillRect(0,0,240,240);"
                   "x.fillStyle='#f0f';x.font='bold %dpx monospace';"
                   "x.textAlign='center';x.textBaseline='middle';"
                   "x.fillText('%s',120,120);</script>" % (font_px, ch)))
        time.sleep(0.4)
        w, h, rgb = osctl.capture_rgb()
        loc = osctl.find_color(MAG, tol=60, rgb=rgb, size=(w, h))
        return rgb, (w, h), (loc["bbox"] if loc else None)

    def dist_stats(rgb, sz, bb):
        sig = osctl.edge_signature(rgb, sz, bb)
        on = sum(sig)
        scored = sorted(osctl.edge_hamming(atlas[k], sig) for k in atlas)
        return on, scored[0], scored[1]

    # A KNOWN glyph (in atlas), drawn at a DIFFERENT size than the atlas: both the
    # old reader and the honest reader name it, and it is a tight, decisive fit.
    rgb, sz, bb = one("A")
    check("known glyph 'A' located", bb is not None, repr(bb))
    if bb is None:
        return
    on, best, second = dist_stats(rgb, sz, bb)
    check("known 'A' is a good absolute fit (best <= 0.6 x ink)", best <= 0.6 * on,
          f"best={best} on={on} frac={best / max(on, 1):.3f}")
    check("known 'A' is a clear winner (runner-up >= 2x farther)", second >= 2 * max(best, 1),
          f"best={best} second={second} margin={second / max(best, 1):.2f}")
    check("read_glyph names known 'A' correctly",
          osctl.read_glyph(rgb, sz, bb, atlas) == "A")
    check("read_glyph_conf names known 'A' correctly",
          osctl.read_glyph_conf(rgb, sz, bb, atlas) == "A")
    # An UNKNOWN glyph (never in the atlas): the friction, then the refusal.
    rgbz, szz, bbz = one("Z")
    check("unknown glyph 'Z' located", bbz is not None, repr(bbz))
    if bbz is None:
        return
    onz, bestz, secondz = dist_stats(rgbz, szz, bbz)
    misread = osctl.read_glyph(rgbz, szz, bbz, atlas)
    check("FRICTION: read_glyph names unknown 'Z' as some atlas letter",
          misread in atlas, repr(misread))
    check("unknown 'Z' is a poor absolute fit (best > 0.6 x ink)", bestz > 0.6 * onz,
          f"best={bestz} on={onz} frac={bestz / max(onz, 1):.3f}")
    check("unknown 'Z' has no clear winner (runner-up < 2x farther)",
          secondz < 2 * max(bestz, 1),
          f"best={bestz} second={secondz} margin={secondz / max(bestz, 1):.2f}")
    check("read_glyph_conf REFUSES unknown 'Z' (returns '')",
          osctl.read_glyph_conf(rgbz, szz, bbz, atlas) == "", repr(misread))
    # Two more unknowns refused, confirming it is not a one-off.
    for u in ("M", "5"):
        ru, su, bu = one(u)
        got = osctl.read_glyph_conf(ru, su, bu, atlas) if bu else None
        check("read_glyph_conf refuses unknown '%s'" % u, got == "", repr(got))
        old = osctl.read_glyph(ru, su, bu, atlas) if bu else None
        check("read_glyph still misreads unknown '%s' as %r" % (u, old),
              old in atlas, repr(old))
    # The refusal sentinel is caller-chosen.
    check("read_glyph_conf returns the chosen unknown sentinel",
          osctl.read_glyph_conf(rgbz, szz, bbz, atlas, unknown="?") == "?")
    # A blank region is unknown, not a letter.
    check("read_glyph_conf on a blank region returns ''",
          osctl.read_glyph_conf(rgb, sz, (5, 5, 25, 25), atlas) == "")
    # Loosening the gates accepts the nearest match again (knows its own threshold).
    forced = osctl.read_glyph_conf(rgbz, szz, bbz, atlas, max_dist=9.0, conf_k=1.0)
    check("loosened gates accept the nearest match (no longer refuses)",
          forced in atlas, repr(forced))


def round_read_text_conf(b: Browser, offline: bool) -> None:
    print("R72: read a LINE, marking glyphs the atlas cannot name (F108) — osctl")
    # read_text classifies each cell with read_glyph — the nearest label, always —
    # so a line holding a glyph the atlas never carried is silently rewritten as the
    # closest known letter ("CZB" -> "CCB"). read_text_conf classifies each cell with
    # read_glyph_conf, writing '?' (caller-chosen) where no atlas entry honestly fits.
    MAG = (255, 0, 255)

    def blobs(rgb, w, h):
        bs = osctl.find_color_blobs(MAG, tol=60, rgb=rgb, size=(w, h), min_count=120)
        return sorted(bs, key=lambda t: t["x"])
    chars = "ABCOKX"
    draws = "".join("x.fillText('%s',%d,100);" % (ch, 40 + i * 120)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("tc_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=760 height=160></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,760,160);"
               "x.fillStyle='#f0f';x.font='bold 90px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = blobs(argb, aw, ah)
    check("atlas segments into six reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def line(text, font_px=64, dx=90):
        draw, x = [], 40
        for ch in text:
            draw.append("x.fillText('%s',%d,100);" % (ch, x))
            x += dx
        b.navigate(fixture("tc_line.html",
                   "<!doctype html><title>l</title><style>html,body{margin:0}</style>"
                   "<canvas id=c width=%d height=200></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   "x.fillStyle='#fff';x.fillRect(0,0,%d,200);"
                   "x.fillStyle='#f0f';x.font='bold %dpx monospace';"
                   "x.textAlign='left';x.textBaseline='middle';"
                   % (x + 80, x + 80, font_px) + "".join(draw) + "</script>"))
        time.sleep(0.4)
        w, h, rgb = osctl.capture_rgb()
        loc = osctl.find_color(MAG, tol=60, rgb=rgb, size=(w, h))
        return rgb, (w, h), (loc["bbox"] if loc else None)

    # An all-KNOWN line: both readers agree and read it whole, no marks.
    rgb, sz, bb = line("CAB")
    check("known line 'CAB' located", bb is not None, repr(bb))
    if bb is None:
        return
    check("read_text reads all-known line 'CAB'",
          osctl.read_text(rgb, sz, bb, atlas, MAG) == "CAB",
          repr(osctl.read_text(rgb, sz, bb, atlas, MAG)))
    check("read_text_conf reads all-known line 'CAB' (no marks)",
          osctl.read_text_conf(rgb, sz, bb, atlas, MAG) == "CAB",
          repr(osctl.read_text_conf(rgb, sz, bb, atlas, MAG)))
    # A line with ONE unknown glyph (Z absent from atlas): the friction, then the mark.
    rgbz, szz, bbz = line("CZB")
    check("mixed line 'CZB' located", bbz is not None, repr(bbz))
    if bbz is None:
        return
    cells = osctl.segment_run(rgbz, szz, bbz, MAG)
    check("mixed line parts into three cells", len(cells) == 3, str(len(cells)))
    misread = osctl.read_text(rgbz, szz, bbz, atlas, MAG)
    check("FRICTION: read_text rewrites unknown 'Z' as a known letter (not 'CZB')",
          len(misread) == 3 and misread[1] in atlas and misread != "CZB", repr(misread))
    check("read_text_conf marks the unknown middle glyph as 'C?B'",
          osctl.read_text_conf(rgbz, szz, bbz, atlas, MAG) == "C?B",
          repr(osctl.read_text_conf(rgbz, szz, bbz, atlas, MAG)))
    # The known glyphs around the mark are still read correctly.
    got = osctl.read_text_conf(rgbz, szz, bbz, atlas, MAG)
    check("read_text_conf keeps the known glyphs ('C' _ 'B')",
          len(got) == 3 and got[0] == "C" and got[2] == "B", repr(got))
    # The mark sentinel is caller-chosen.
    check("read_text_conf marks with a caller-chosen sentinel ('C#B')",
          osctl.read_text_conf(rgbz, szz, bbz, atlas, MAG, unknown="#") == "C#B",
          repr(osctl.read_text_conf(rgbz, szz, bbz, atlas, MAG, unknown="#")))
    # unknown="" drops the unreadable cell instead of marking it.
    check("read_text_conf with unknown='' drops the unreadable cell ('CB')",
          osctl.read_text_conf(rgbz, szz, bbz, atlas, MAG, unknown="") == "CB",
          repr(osctl.read_text_conf(rgbz, szz, bbz, atlas, MAG, unknown="")))
    # A line of TWO unknowns marks both.
    rgb2, sz2, bb2 = line("ZW")
    if bb2 is not None:
        g2 = osctl.read_text_conf(rgb2, sz2, bb2, atlas, MAG)
        check("read_text_conf marks an all-unknown line ('ZW' -> '??')",
              g2 == "??", repr(g2))
        old2 = osctl.read_text(rgb2, sz2, bb2, atlas, MAG)
        check("read_text still rewrites both unknowns to known letters",
              len(old2) == 2 and all(c in atlas for c in old2), repr(old2))
    # Loosening the gates lets read_text_conf accept the nearest match like read_text.
    loose = osctl.read_text_conf(rgbz, szz, bbz, atlas, MAG, max_dist=9.0, conf_k=1.0)
    check("loosened gates: read_text_conf matches read_text (no marks)",
          loose == misread and "?" not in loose, repr(loose))


def round_detect_fg(b: Browser, offline: bool) -> None:
    print("R73: recover a region's ink colour from its pixels (F109) — osctl")
    # Every reader (segment_run/read_text/read_block) needs the caller to pass fg.
    # A control found by layout has bounds but no colour, so the whole reading stack
    # is blind to text whose colour it was not told. detect_fg recovers (bg, fg) from
    # the region: bg = the dominant bucket, fg = the dominant bucket far from it; a
    # uniform region yields fg=None. The atlas (magenta) reads lines drawn in *other*
    # colours once detect_fg supplies the right fg — wrong fg reads nothing.
    MAG = (255, 0, 255)

    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    def close(a, b, t=48):
        return bool(a) and bool(b) and all(abs(x - y) <= t for x, y in zip(a, b))

    # Build the reference atlas in magenta on white (same shapes as R71/R72).
    def blobs(rgb, w, h):
        bs = osctl.find_color_blobs(MAG, tol=60, rgb=rgb, size=(w, h), min_count=120)
        return sorted(bs, key=lambda t: t["x"])
    chars = "ABCOKX"
    draws = "".join("x.fillText('%s',%d,100);" % (ch, 40 + i * 120)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("df_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=760 height=160></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,760,160);"
               "x.fillStyle='#f0f';x.font='bold 90px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = blobs(argb, aw, ah)
    check("atlas segments into six reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def colored(text, fg_hex, bg_hex, font_px=64):
        # Draw text in fg_hex on a solid bg_hex field; locate the field as its
        # largest blob and inset 20% so browser chrome never enters the region.
        b.navigate(fixture("df_line.html",
                   "<!doctype html><title>l</title><style>html,body{margin:0}"
                   "body{background:%s}</style>"
                   "<canvas id=c width=1000 height=500></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   "x.fillStyle='%s';x.fillRect(0,0,1000,500);"
                   "x.fillStyle='%s';x.font='bold %dpx monospace';"
                   "x.textAlign='center';x.textBaseline='middle';"
                   "x.fillText('%s',500,250);</script>"
                   % (bg_hex, bg_hex, fg_hex, font_px, text)))
        time.sleep(0.4)
        w, h, rgb = osctl.capture_rgb()
        bl = osctl.find_color_blobs(hx(bg_hex), tol=50, rgb=rgb, size=(w, h),
                                    min_count=5000)
        if not bl:
            return rgb, (w, h), None
        x0, y0, x1, y1 = max(bl, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // 5, (y1 - y0) // 5
        return rgb, (w, h), (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    # Case 1: yellow ink on navy — detect_fg must recover both, then read with it.
    rgb, sz, bb = colored("CAB", "#ffeb3b", "#0d2860")
    check("yellow-on-navy region located", bb is not None, repr(bb))
    if bb is None:
        return
    dbg, dfg = osctl.detect_fg(rgb, sz, bb)
    check("detect_fg recovers the navy background", close(dbg, hx("#0d2860")),
          repr(dbg))
    check("detect_fg recovers the yellow ink", close(dfg, hx("#ffeb3b")), repr(dfg))
    # FRICTION: the magenta atlas reader, told the WRONG fg, sees no ink and reads "".
    wrong = osctl.read_text(rgb, sz, bb, atlas, MAG)
    check("FRICTION: read_text with the wrong fg reads nothing (not 'CAB')",
          wrong != "CAB", repr(wrong))
    # Hand the detected fg to the very same reader and the line resolves.
    got = osctl.read_text(rgb, sz, bb, atlas, dfg)
    check("read_text with detect_fg's colour reads 'CAB'", got == "CAB", repr(got))

    # Case 2: near-white ink on maroon — a different scheme recovers and reads.
    rgb2, sz2, bb2 = colored("BACK", "#f5f5f5", "#5a0f14")
    if bb2 is not None:
        b2bg, b2fg = osctl.detect_fg(rgb2, sz2, bb2)
        check("detect_fg recovers maroon bg and near-white ink",
              close(b2bg, hx("#5a0f14")) and close(b2fg, hx("#f5f5f5")),
              "%s/%s" % (b2bg, b2fg))
        check("read_text with detect_fg reads 'BACK'",
              osctl.read_text(rgb2, sz2, bb2, atlas, b2fg) == "BACK",
              repr(osctl.read_text(rgb2, sz2, bb2, atlas, b2fg)))

    # Case 3: black ink on green — the darkest-on-light scheme also recovers.
    rgb3, sz3, bb3 = colored("OK", "#101010", "#b4eba0")
    if bb3 is not None:
        b3bg, b3fg = osctl.detect_fg(rgb3, sz3, bb3)
        check("detect_fg recovers green bg and black ink",
              close(b3bg, hx("#b4eba0")) and close(b3fg, hx("#101010")),
              "%s/%s" % (b3bg, b3fg))
        check("read_text with detect_fg reads 'OK'",
              osctl.read_text(rgb3, sz3, bb3, atlas, b3fg) == "OK",
              repr(osctl.read_text(rgb3, sz3, bb3, atlas, b3fg)))

    # A UNIFORM region (a solid fill, no ink): detect_fg refuses — fg is None.
    rgbu, szu, bbu = colored("", "#0d2860", "#0d2860")
    if bbu is not None:
        ubg, ufg = osctl.detect_fg(rgbu, szu, bbu)
        check("detect_fg returns the field colour as bg on a uniform region",
              close(ubg, hx("#0d2860")), repr(ubg))
        check("detect_fg refuses (fg=None) when the region holds no ink",
              ufg is None, repr(ufg))
    # The gate is the distance: demanding an impossibly far ink refuses real ink too.
    _, far = osctl.detect_fg(rgb, sz, bb, min_dist=10 ** 6)
    check("detect_fg with an unreachable min_dist refuses (fg=None)",
          far is None, repr(far))


def round_palette(b: Browser, offline: bool) -> None:
    print("R74: recover EVERY distinct colour in a region (F110) — osctl")
    # detect_fg answers "the one ink colour"; a region with TWO inks (a red word
    # beside a green one, syntax highlighting) keeps only the most frequent and
    # silently drops the rest. Since every reader segments by a single fg, the
    # other-coloured word is then unreadable. palette walks the region's buckets
    # in frequency order, admitting each colour far from those already kept and
    # above a population floor — the full palette (bg first, then every ink),
    # each ready to hand to read_text. detect_fg names one; palette names all.
    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    def close(a, c, t=48):
        return bool(a) and bool(c) and all(abs(x - y) <= t for x, y in zip(a, c))

    # Build a magenta-on-white atlas (magenta is rare on screen, unlike black
    # chrome): read_glyph matches structure, not colour, so one atlas reads runs
    # drawn in any ink once the right fg is supplied.
    MAG = (255, 0, 255)
    chars = "REDGN"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 30 + i * 110)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("pal_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=640 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,640,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("atlas segments into five reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    RED, GRN, WHT = "#d32020", "#1f9d35", "#ffffff"
    # Two inks in one region: 'RED' (red) and 'GRN' (green) on a white field.
    b.navigate(fixture("pal_two.html",
               "<!doctype html><title>p</title><style>html,body{margin:0}"
               "body{background:#fff}</style>"
               "<canvas id=c width=1100 height=300></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,300);"
               "x.font='bold 84px monospace';x.textBaseline='middle';"
               "x.textAlign='left';"
               "x.fillStyle='%s';x.fillText('RED',120,150);"
               "x.fillStyle='%s';x.fillText('GRN',640,150);</script>"
               % (RED, GRN)))
    time.sleep(0.4)
    w, h, rgb = osctl.capture_rgb()
    sz = (w, h)
    bl = osctl.find_color_blobs(hx(WHT), tol=30, rgb=rgb, size=sz, min_count=5000)
    check("two-ink region located", bool(bl), str(len(bl)))
    if not bl:
        return
    x0, y0, x1, y1 = max(bl, key=lambda t: t["count"])["bbox"]
    iw, ih = (x1 - x0) // 8, (y1 - y0) // 8
    bb = (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    # FRICTION: detect_fg can name exactly one of the two inks, never both.
    dbg, dfg = osctl.detect_fg(rgb, sz, bb)
    check("detect_fg recovers the white background", close(dbg, hx(WHT)), repr(dbg))
    r_red, r_grn = close(dfg, hx(RED)), close(dfg, hx(GRN))
    check("FRICTION: detect_fg names exactly one of the two inks (drops the other)",
          r_red != r_grn, "%s red=%s grn=%s" % (dfg, r_red, r_grn))

    # RESOLUTION: palette recovers the background and BOTH inks, nothing else.
    pal = osctl.palette(rgb, sz, bb)
    check("palette's first colour is the white background", close(pal[0], hx(WHT)),
          repr(pal[0]) if pal else "[]")
    p_red = next((c for c in pal[1:] if close(c, hx(RED))), None)
    p_grn = next((c for c in pal[1:] if close(c, hx(GRN))), None)
    check("palette recovers the red ink", p_red is not None, repr(pal))
    check("palette recovers the green ink", p_grn is not None, repr(pal))
    check("palette is exactly background + two inks (no fringe admitted)",
          len(pal) == 3, repr(pal))

    # Each recovered colour actually reads its word (union of that ink's glyphs).
    # Confine to blobs inside the located white field: the live screen carries
    # stray red/green specks in browser chrome that would otherwise balloon the
    # union far beyond the canvas.
    def word_bbox(col):
        bs = [t for t in osctl.find_color_blobs(col, tol=60, rgb=rgb, size=sz,
                                                min_count=80)
              if x0 <= t["x"] <= x1 and y0 <= t["y"] <= y1]
        if not bs:
            return None
        return (min(t["bbox"][0] for t in bs), min(t["bbox"][1] for t in bs),
                max(t["bbox"][2] for t in bs), max(t["bbox"][3] for t in bs))
    rb, gb = word_bbox(hx(RED)), word_bbox(hx(GRN))
    check("read 'RED' with palette's red colour",
          rb is not None and osctl.read_text(rgb, sz, rb, atlas, p_red) == "RED",
          repr(osctl.read_text(rgb, sz, rb, atlas, p_red)) if rb else "None")
    check("read 'GRN' with palette's green colour",
          gb is not None and osctl.read_text(rgb, sz, gb, atlas, p_grn) == "GRN",
          repr(osctl.read_text(rgb, sz, gb, atlas, p_grn)) if gb else "None")
    # The cost of detect_fg's single colour: the other-coloured word reads "".
    other_bb, other_txt = (gb, "GRN") if r_red else (rb, "RED")
    if other_bb is not None:
        check("FRICTION: detect_fg's lone colour cannot read the other-coloured word",
              osctl.read_text(rgb, sz, other_bb, atlas, dfg) != other_txt,
              repr(osctl.read_text(rgb, sz, other_bb, atlas, dfg)))

    # THREE inks: three coloured bars on white — palette recovers all three.
    BLU = "#1565c0"
    b.navigate(fixture("pal_three.html",
               "<!doctype html><title>p3</title><style>html,body{margin:0}"
               "body{background:#fff}</style>"
               "<canvas id=c width=900 height=300></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,900,300);"
               "x.fillStyle='%s';x.fillRect(100,110,80,80);"
               "x.fillStyle='%s';x.fillRect(410,110,80,80);"
               "x.fillStyle='%s';x.fillRect(720,110,80,80);</script>"
               % (RED, GRN, BLU)))
    time.sleep(0.4)
    w3, h3, rgb3 = osctl.capture_rgb()
    bl3 = osctl.find_color_blobs(hx(WHT), tol=30, rgb=rgb3, size=(w3, h3),
                                 min_count=5000)
    if bl3:
        a0, b0, a1, b1 = max(bl3, key=lambda t: t["count"])["bbox"]
        jw, jh = (a1 - a0) // 8, (b1 - b0) // 8
        bb3 = (a0 + jw, b0 + jh, a1 - jw, b1 - jh)
        pal3 = osctl.palette(rgb3, (w3, h3), bb3)
        inks3 = pal3[1:]
        all3 = (any(close(c, hx(RED)) for c in inks3)
                and any(close(c, hx(GRN)) for c in inks3)
                and any(close(c, hx(BLU)) for c in inks3))
        check("palette recovers all three inks from a three-colour region", all3,
              repr(pal3))

    # A UNIFORM region holds no ink: palette is just the one field colour.
    b.navigate(fixture("pal_uni.html",
               "<!doctype html><title>u</title><style>html,body{margin:0}"
               "body{background:#0d2860}</style>"
               "<canvas id=c width=900 height=300></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#0d2860';x.fillRect(0,0,900,300);</script>"))
    time.sleep(0.4)
    wu, hu, rgbu = osctl.capture_rgb()
    blu = osctl.find_color_blobs(hx("#0d2860"), tol=40, rgb=rgbu, size=(wu, hu),
                                 min_count=5000)
    if blu:
        u0, v0, u1, v1 = max(blu, key=lambda t: t["count"])["bbox"]
        kw, kh = (u1 - u0) // 8, (v1 - v0) // 8
        palu = osctl.palette(rgbu, (wu, hu), (u0 + kw, v0 + kh, u1 - kw, v1 - kh))
        check("palette of a uniform region is a single colour (no inks)",
              len(palu) == 1 and close(palu[0], hx("#0d2860")), repr(palu))
    # The floor is honest: demanding an unreachable min_pop drops the inks too.
    palf = osctl.palette(rgb, sz, bb, min_pop=0.9)
    check("palette with an unreachable min_pop keeps only the background",
          len(palf) == 1 and close(palf[0], hx(WHT)), repr(palf))


def round_read_region(b: Browser, offline: bool) -> None:
    print("R75: read EVERY colour's text in a region, in order (F111) — osctl")
    # read_text segments by ONE fg, so a region with a red word beside a green
    # one comes back half-read: the other colour is background to it. palette now
    # names every ink, but naming is not reading. read_region asks palette for the
    # colours, segments the region by each ink, then sorts every glyph cell by its
    # left edge — the whole multi-coloured region read back in the order the eye
    # sees, regardless of which colour drew each word.
    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    def close(a, c, t=48):
        return sum(abs(p - q) for p, q in zip(a, c)) <= t

    MAG = (255, 0, 255)
    WHT = "#ffffff"
    RED, GRN, BLU = "#d32020", "#1f9d35", "#1565c0"
    # One magenta-on-white atlas (magenta is rare on screen) reads runs of any
    # ink. Cover every letter the scenes draw: O K G R E D N B L U.
    chars = "OKGREDNBLU"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("rr_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1000 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1000,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("atlas segments into ten reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, bg=WHT, frac=12):
        bls = osctl.find_color_blobs(hx(bg), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    def two_word(name, w1, c1, w2, c2):
        b.navigate(fixture(name,
                   "<!doctype html><title>p</title><style>html,body{margin:0}"
                   "body{background:#fff}</style>"
                   "<canvas id=c width=1100 height=300></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   "x.fillStyle='#fff';x.fillRect(0,0,1100,300);"
                   "x.font='bold 84px monospace';x.textBaseline='middle';"
                   "x.textAlign='left';"
                   "x.fillStyle='%s';x.fillText('%s',150,150);"
                   "x.fillStyle='%s';x.fillText('%s',620,150);</script>"
                   % (c1, w1, c2, w2)))
        time.sleep(0.4)
        return osctl.capture_rgb()

    # Scene A: 'OK' (red) beside 'GO' (green) on white.
    w, h, rgb = two_word("rr_two.html", "OK", RED, "GO", GRN)
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("two-ink region located", bb is not None, repr(bb))
    if bb is None:
        return
    pal = osctl.palette(rgb, sz, bb)
    inks = pal[1:]
    two = (any(close(c, hx(RED)) for c in inks)
           and any(close(c, hx(GRN)) for c in inks))
    check("palette recovers background + both inks", len(pal) == 3 and two, repr(pal))

    # FRICTION: read_text over the whole region with ONE ink reads only its word.
    rt_red = osctl.read_text(rgb, sz, bb, atlas, hx(RED))
    rt_grn = osctl.read_text(rgb, sz, bb, atlas, hx(GRN))
    check("FRICTION: read_text with the red ink reads only 'OK' (green dropped)",
          rt_red == "OK", repr(rt_red))
    check("FRICTION: read_text with the green ink reads only 'GO' (red dropped)",
          rt_grn == "GO", repr(rt_grn))

    # RESOLUTION: read_region reads both words, in left-to-right order.
    rr = osctl.read_region(rgb, sz, bb, atlas)
    check("read_region reads BOTH words across colours ('OKGO')", rr == "OKGO",
          repr(rr))

    # Scene C: order follows geometry, not palette frequency — swap the sides.
    w2, h2, rgb2 = two_word("rr_swap.html", "GO", GRN, "OK", RED)
    bb2 = field_bbox(rgb2, (w2, h2))
    if bb2 is not None:
        rr2 = osctl.read_region(rgb2, (w2, h2), bb2, atlas)
        check("read_region orders by geometry not palette ('GOOK')", rr2 == "GOOK",
              repr(rr2))

    # Scene B: THREE coloured words 'RED' 'GRN' 'BLU' — all read, in order.
    b.navigate(fixture("rr_three.html",
               "<!doctype html><title>p3</title><style>html,body{margin:0}"
               "body{background:#fff}</style>"
               "<canvas id=c width=1300 height=300></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1300,300);"
               "x.font='bold 80px monospace';x.textBaseline='middle';"
               "x.textAlign='left';"
               "x.fillStyle='%s';x.fillText('RED',80,150);"
               "x.fillStyle='%s';x.fillText('GRN',540,150);"
               "x.fillStyle='%s';x.fillText('BLU',1000,150);</script>"
               % (RED, GRN, BLU)))
    time.sleep(0.4)
    w3, h3, rgb3 = osctl.capture_rgb()
    bb3 = field_bbox(rgb3, (w3, h3), frac=16)
    if bb3 is not None:
        rr3 = osctl.read_region(rgb3, (w3, h3), bb3, atlas)
        check("read_region reads all three coloured words ('REDGRNBLU')",
              rr3 == "REDGRNBLU", repr(rr3))

    # Scene D: a single-colour region — read_region agrees with read_text.
    w4, h4, rgb4 = two_word("rr_one.html", "RED", RED, "", RED)
    bb4 = field_bbox(rgb4, (w4, h4))
    if bb4 is not None:
        rr4 = osctl.read_region(rgb4, (w4, h4), bb4, atlas)
        rt4 = osctl.read_text(rgb4, (w4, h4), bb4, atlas, hx(RED))
        check("read_region of a single-ink region equals read_text ('RED')",
              rr4 == "RED" and rr4 == rt4, "%r/%r" % (rr4, rt4))

    # Scene E: a uniform region holds no ink — read_region reads "".
    b.navigate(fixture("rr_uni.html",
               "<!doctype html><title>u</title><style>html,body{margin:0}"
               "body{background:#0d2860}</style>"
               "<canvas id=c width=900 height=300></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#0d2860';x.fillRect(0,0,900,300);</script>"))
    time.sleep(0.4)
    wu, hu, rgbu = osctl.capture_rgb()
    bbu = field_bbox(rgbu, (wu, hu), bg="#0d2860")
    if bbu is not None:
        rru = osctl.read_region(rgbu, (wu, hu), bbu, atlas)
        check("read_region of a uniform region is '' (no ink)", rru == "", repr(rru))


def round_read_block_region(b: Browser, offline: bool) -> None:
    print("R76: read a multi-LINE, multi-COLOUR block line by line (F112) — osctl")
    # read_block parts lines but by ONE fg, so a block whose lines are different
    # colours drops every line that one colour does not ink. read_region reads
    # every colour but flattens the whole bbox into one x-sorted run, so two
    # stacked lines interleave by column. read_block_region keeps both: it bands
    # rows by ANY ink (palette), then read_regions each band top-to-bottom.
    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    def close(a, c, t=48):
        return sum(abs(p - q) for p, q in zip(a, c)) <= t

    MAG = (255, 0, 255)
    RED, GRN, BLU = "#d32020", "#1f9d35", "#1565c0"
    # One magenta-on-white atlas reads runs of any ink: O K G R E D N B L U Y.
    chars = "OKGREDNBLUY"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("br_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1100 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("atlas segments into eleven reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, bg="#ffffff", frac=16):
        # capture_rgb grabs the whole desktop, so the white field abuts the
        # browser chrome; crop a generous //8 off top/bottom (as R75) to keep
        # the bookmarks-bar fringe out of the band.
        bls = osctl.find_color_blobs(hx(bg), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    def two_line(name, l1, l2):
        # l1/l2 are [(word, colour, x), ...]; line 1 at y=180, line 2 at y=380,
        # well clear of the chrome fringe at the field's top edge.
        body = ("x.fillStyle='#fff';x.fillRect(0,0,900,520);"
                "x.font='bold 80px monospace';x.textBaseline='middle';"
                "x.textAlign='left';")
        for word, col, x in l1:
            body += "x.fillStyle='%s';x.fillText('%s',%d,180);" % (col, word, x)
        for word, col, x in l2:
            body += "x.fillStyle='%s';x.fillText('%s',%d,380);" % (col, word, x)
        b.navigate(fixture(name,
                   "<!doctype html><title>b</title><style>html,body{margin:0;"
                   "background:#fff}</style>"
                   "<canvas id=c width=900 height=520></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   + body + "</script>"))
        time.sleep(0.4)
        return osctl.capture_rgb()

    # Scene A: two lines, two colours each. L1: OK(red) GO(grn). L2: NO(blu) BY(red).
    w, h, rgb = two_line("br_two.html",
                         [("OK", RED, 80), ("GO", GRN, 520)],
                         [("NO", BLU, 80), ("BY", RED, 520)])
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("two-line two-colour block located", bb is not None, repr(bb))
    if bb is None:
        return
    pal = osctl.palette(rgb, sz, bb)
    inks = pal[1:]
    three = (any(close(c, hx(RED)) for c in inks)
             and any(close(c, hx(GRN)) for c in inks)
             and any(close(c, hx(BLU)) for c in inks))
    check("palette recovers background + the three inks", len(pal) == 4 and three,
          repr(pal))

    # FRICTION: read_region flattens both lines into one x-scramble — a line-2
    # word (NO, blue, left) intrudes before a line-1 word (GO, green, right).
    flat = osctl.read_region(rgb, sz, bb, atlas)
    scrambled = ("N" in flat and "G" in flat
                 and flat.index("N") < flat.index("G") and flat != "OKGONOBY")
    check("FRICTION: read_region x-scrambles the two lines (not 'OKGONOBY')",
          scrambled, repr(flat))

    # RESOLUTION: read_block_region reads each line, every colour, top-to-bottom.
    rbr = osctl.read_block_region(rgb, sz, bb, atlas)
    check("read_block_region reads both lines across colours (['OKGO','NOBY'])",
          rbr == ["OKGO", "NOBY"], repr(rbr))

    # Scene B: lines of a SINGLE colour each — read_block(red) drops the green one.
    w2, h2, rgb2 = two_line("br_mono.html",
                            [("RED", RED, 80)], [("GRN", GRN, 80)])
    bb2 = field_bbox(rgb2, (w2, h2))
    if bb2 is not None:
        rb_red = osctl.read_block(rgb2, (w2, h2), bb2, atlas, hx(RED))
        check("FRICTION: read_block with the red ink drops the green line (['RED'])",
              rb_red == ["RED"], repr(rb_red))
        rbr2 = osctl.read_block_region(rgb2, (w2, h2), bb2, atlas)
        check("read_block_region reads both mono-coloured lines (['RED','GRN'])",
              rbr2 == ["RED", "GRN"], repr(rbr2))

    # Scene C: order follows geometry top-to-bottom — swap the two lines.
    w3, h3, rgb3 = two_line("br_swap.html",
                           [("NO", BLU, 80), ("BY", RED, 520)],
                           [("OK", RED, 80), ("GO", GRN, 520)])
    bb3 = field_bbox(rgb3, (w3, h3))
    if bb3 is not None:
        rbr3 = osctl.read_block_region(rgb3, (w3, h3), bb3, atlas)
        check("read_block_region orders lines top-to-bottom (['NOBY','OKGO'])",
              rbr3 == ["NOBY", "OKGO"], repr(rbr3))

    # Scene D: a single line — read_block_region is a one-element list = read_region.
    w4, h4, rgb4 = two_line("br_one.html",
                           [("OK", RED, 80), ("GO", GRN, 520)], [])
    bb4 = field_bbox(rgb4, (w4, h4))
    if bb4 is not None:
        rbr4 = osctl.read_block_region(rgb4, (w4, h4), bb4, atlas)
        rr4 = osctl.read_region(rgb4, (w4, h4), bb4, atlas)
        check("read_block_region of one line equals [read_region] (['OKGO'])",
              rbr4 == ["OKGO"] and rbr4 == [rr4], "%r/%r" % (rbr4, rr4))

    # Scene E: a uniform block holds no ink — read_block_region reads [].
    b.navigate(fixture("br_uni.html",
               "<!doctype html><title>u</title><style>html,body{margin:0;"
               "background:#0d2860}</style>"
               "<canvas id=c width=900 height=520></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#0d2860';x.fillRect(0,0,900,520);</script>"))
    time.sleep(0.4)
    wu, hu, rgbu = osctl.capture_rgb()
    bbu = field_bbox(rgbu, (wu, hu), bg="#0d2860")
    if bbu is not None:
        rbru = osctl.read_block_region(rgbu, (wu, hu), bbu, atlas)
        check("read_block_region of a uniform block is [] (no ink)", rbru == [],
              repr(rbru))


def round_read_region_words(b, offline):
    # F113 read_region_words: read a multi-COLOUR line WITH its word spaces.
    # read_region (F111) joins every ink's glyphs with nothing between -> "OKGO";
    # read_words (F106) keeps the seam but reads a single fg -> "OK". This reads
    # every colour AND the seam: "OK GO".
    if offline:
        return

    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    def close(a, c, t=48):
        return sum(abs(p - q) for p, q in zip(a, c)) <= t

    MAG = (255, 0, 255)
    RED, GRN, BLU = "#d32020", "#1f9d35", "#1565c0"
    chars = "OKGREDNBLUY"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("rw_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1100 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("rw atlas segments into eleven reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, bg="#ffffff", frac=16):
        bls = osctl.find_color_blobs(hx(bg), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    def one_line(name, glyphs):
        # glyphs: [(char, colour, x), ...] drawn on one line at y=200, well clear
        # of the chrome fringe at the white field's top edge.
        body = ("x.fillStyle='#fff';x.fillRect(0,0,900,360);"
                "x.font='bold 80px monospace';x.textBaseline='middle';"
                "x.textAlign='left';")
        for ch, col, x in glyphs:
            body += "x.fillStyle='%s';x.fillText('%s',%d,200);" % (col, ch, x)
        b.navigate(fixture(name,
                   "<!doctype html><title>l</title><style>html,body{margin:0;"
                   "background:#fff}</style>"
                   "<canvas id=c width=900 height=360></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   + body + "</script>"))
        time.sleep(0.4)
        return osctl.capture_rgb()

    # Scene A: "OK GO" — OK red, wide gap, GO green. One line.
    w, h, rgb = one_line("rw_a.html",
                         [("O", RED, 80), ("K", RED, 152),
                          ("G", GRN, 400), ("O", GRN, 472)])
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("rw two-colour word-gap line located", bb is not None, repr(bb))
    if bb is None:
        return
    pal = osctl.palette(rgb, sz, bb)
    inks = pal[1:]
    two = (any(close(c, hx(RED)) for c in inks)
           and any(close(c, hx(GRN)) for c in inks))
    check("rw palette recovers background + the two inks",
          len(pal) == 3 and two, repr(pal))

    # FRICTION: read_region joins with nothing -> the word seam is dropped.
    flat = osctl.read_region(rgb, sz, bb, atlas)
    check("FRICTION: read_region drops the word space ('OKGO')",
          flat == "OKGO", repr(flat))
    # FRICTION: read_words by a single fg reads only that colour's word.
    rw_red = osctl.read_words(rgb, sz, bb, atlas, hx(RED))
    check("FRICTION: read_words(red) reads only the red word ('OK')",
          rw_red == "OK", repr(rw_red))
    rw_grn = osctl.read_words(rgb, sz, bb, atlas, hx(GRN))
    check("FRICTION: read_words(grn) reads only the green word ('GO')",
          rw_grn == "GO", repr(rw_grn))
    # RESOLUTION: every colour AND the seam.
    rrw = osctl.read_region_words(rgb, sz, bb, atlas)
    check("read_region_words reads the line with its seam ('OK GO')",
          rrw == "OK GO", repr(rrw))

    # Scene B: three words, three colours — "RED" "OK" "BY".
    w2, h2, rgb2 = one_line("rw_b.html",
                            [("R", RED, 80), ("E", RED, 152), ("D", RED, 224),
                             ("O", GRN, 420), ("K", GRN, 492),
                             ("B", BLU, 680), ("Y", BLU, 752)])
    bb2 = field_bbox(rgb2, (w2, h2))
    if bb2 is not None:
        rrw2 = osctl.read_region_words(rgb2, (w2, h2), bb2, atlas)
        check("read_region_words reads three words across three colours "
              "('RED OK BY')", rrw2 == "RED OK BY", repr(rrw2))

    # Scene C: order follows geometry — green word left, red word right.
    w3, h3, rgb3 = one_line("rw_c.html",
                            [("G", GRN, 80), ("O", GRN, 152),
                             ("O", RED, 400), ("K", RED, 472)])
    bb3 = field_bbox(rgb3, (w3, h3))
    if bb3 is not None:
        rrw3 = osctl.read_region_words(rgb3, (w3, h3), bb3, atlas)
        check("read_region_words orders words by geometry ('GO OK')",
              rrw3 == "GO OK", repr(rrw3))

    # Scene D: single-colour line — read_region_words equals read_words(fg).
    w4, h4, rgb4 = one_line("rw_d.html",
                            [("O", RED, 80), ("K", RED, 152),
                             ("G", RED, 400), ("O", RED, 472)])
    bb4 = field_bbox(rgb4, (w4, h4))
    if bb4 is not None:
        rrw4 = osctl.read_region_words(rgb4, (w4, h4), bb4, atlas)
        rwd = osctl.read_words(rgb4, (w4, h4), bb4, atlas, hx(RED))
        check("read_region_words of a single-colour line equals read_words "
              "('OK GO')", rrw4 == "OK GO" and rrw4 == rwd, "%r/%r" % (rrw4, rwd))

    # Scene E: evenly-tracked block (no wide gap) invents no space.
    w5, h5, rgb5 = one_line("rw_e.html",
                            [("O", RED, 80), ("K", RED, 152),
                             ("G", GRN, 224), ("O", GRN, 296)])
    bb5 = field_bbox(rgb5, (w5, h5))
    if bb5 is not None:
        rrw5 = osctl.read_region_words(rgb5, (w5, h5), bb5, atlas)
        check("read_region_words of an evenly-tracked block invents no space "
              "('OKGO')", rrw5 == "OKGO", repr(rrw5))

    # Scene F: a uniform region holds no ink — read_region_words reads ''.
    b.navigate(fixture("rw_uni.html",
               "<!doctype html><title>u</title><style>html,body{margin:0;"
               "background:#0d2860}</style>"
               "<canvas id=c width=900 height=360></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#0d2860';x.fillRect(0,0,900,360);</script>"))
    time.sleep(0.4)
    wu, hu, rgbu = osctl.capture_rgb()
    bbu = field_bbox(rgbu, (wu, hu), bg="#0d2860")
    if bbu is not None:
        rrwu = osctl.read_region_words(rgbu, (wu, hu), bbu, atlas)
        check("read_region_words of a uniform region is '' (no ink)",
              rrwu == "", repr(rrwu))


def round_read_block_region_words(b, offline):
    print("R78: read a multi-LINE, multi-COLOUR block WITH its word spaces "
          "(F114) — osctl")
    # read_block_region (F112) keeps rows + colours but reads each band with
    # read_region, dropping every line's word seam -> ['OKGO','NOBY'].
    # read_region_words (F113) keeps the seam but flattens the whole bbox into
    # one x-sorted run, so two stacked lines scramble together. This bands the
    # rows like read_block_region, then reads each band with read_region_words:
    # rows AND seams -> ['OK GO','NO BY'].
    if offline:
        return

    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    def close(a, c, t=48):
        return sum(abs(p - q) for p, q in zip(a, c)) <= t

    MAG = (255, 0, 255)
    RED, GRN, BLU = "#d32020", "#1f9d35", "#1565c0"
    chars = "OKGREDNBLUY"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("bw_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1100 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("bw atlas segments into eleven reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, bg="#ffffff", frac=16):
        bls = osctl.find_color_blobs(hx(bg), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    def two_line(name, l1, l2):
        # l1/l2 are [(word, colour, x), ...]; line 1 at y=180, line 2 at y=380.
        body = ("x.fillStyle='#fff';x.fillRect(0,0,900,520);"
                "x.font='bold 80px monospace';x.textBaseline='middle';"
                "x.textAlign='left';")
        for word, col, x in l1:
            body += "x.fillStyle='%s';x.fillText('%s',%d,180);" % (col, word, x)
        for word, col, x in l2:
            body += "x.fillStyle='%s';x.fillText('%s',%d,380);" % (col, word, x)
        b.navigate(fixture(name,
                   "<!doctype html><title>b</title><style>html,body{margin:0;"
                   "background:#fff}</style>"
                   "<canvas id=c width=900 height=520></canvas><script>"
                   "var x=document.getElementById('c').getContext('2d');"
                   + body + "</script>"))
        time.sleep(0.4)
        return osctl.capture_rgb()

    # Scene A: two lines, each a word seam. L1: OK(red) GO(grn). L2: NO(blu) BY(red).
    w, h, rgb = two_line("bw_two.html",
                         [("OK", RED, 80), ("GO", GRN, 520)],
                         [("NO", BLU, 80), ("BY", RED, 520)])
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("bw two-line word-seam block located", bb is not None, repr(bb))
    if bb is None:
        return
    pal = osctl.palette(rgb, sz, bb)
    inks = pal[1:]
    three = (any(close(c, hx(RED)) for c in inks)
             and any(close(c, hx(GRN)) for c in inks)
             and any(close(c, hx(BLU)) for c in inks))
    check("bw palette recovers background + the three inks",
          len(pal) == 4 and three, repr(pal))

    # FRICTION: read_block_region keeps the rows but drops each line's word seam.
    rbr = osctl.read_block_region(rgb, sz, bb, atlas)
    check("FRICTION: read_block_region drops the per-line word seam "
          "(['OKGO','NOBY'])", rbr == ["OKGO", "NOBY"], repr(rbr))
    # FRICTION: read_region_words keeps the seam but scrambles the two rows into
    # one x-sorted string — a line-2 glyph (N) intrudes before a line-1 glyph (G).
    flat = osctl.read_region_words(rgb, sz, bb, atlas)
    scrambled = (isinstance(flat, str) and "N" in flat and "G" in flat
                 and flat.index("N") < flat.index("G")
                 and flat not in ("OK GO", "NO BY"))
    check("FRICTION: read_region_words x-scrambles the two rows together",
          scrambled, repr(flat))
    # RESOLUTION: rows AND seams, line by line.
    rbw = osctl.read_block_region_words(rgb, sz, bb, atlas)
    check("read_block_region_words reads both lines with seams "
          "(['OK GO','NO BY'])", rbw == ["OK GO", "NO BY"], repr(rbw))

    # Scene B: order follows geometry top-to-bottom — swap the two lines.
    w2, h2, rgb2 = two_line("bw_swap.html",
                            [("NO", BLU, 80), ("BY", RED, 520)],
                            [("OK", RED, 80), ("GO", GRN, 520)])
    bb2 = field_bbox(rgb2, (w2, h2))
    if bb2 is not None:
        rbw2 = osctl.read_block_region_words(rgb2, (w2, h2), bb2, atlas)
        check("read_block_region_words orders lines top-to-bottom "
              "(['NO BY','OK GO'])", rbw2 == ["NO BY", "OK GO"], repr(rbw2))

    # Scene C: three words / three colours on each line.
    w3, h3, rgb3 = two_line("bw_three.html",
                            [("RED", RED, 80), ("OK", GRN, 400), ("BY", BLU, 640)],
                            [("GO", GRN, 80), ("NO", BLU, 340), ("RED", RED, 560)])
    bb3 = field_bbox(rgb3, (w3, h3))
    if bb3 is not None:
        rbw3 = osctl.read_block_region_words(rgb3, (w3, h3), bb3, atlas)
        check("read_block_region_words reads three words per line across colours "
              "(['RED OK BY','GO NO RED'])",
              rbw3 == ["RED OK BY", "GO NO RED"], repr(rbw3))

    # Scene D: a single line — read_block_region_words is [read_region_words].
    w4, h4, rgb4 = two_line("bw_one.html",
                            [("OK", RED, 80), ("GO", GRN, 520)], [])
    bb4 = field_bbox(rgb4, (w4, h4))
    if bb4 is not None:
        rbw4 = osctl.read_block_region_words(rgb4, (w4, h4), bb4, atlas)
        rrw4 = osctl.read_region_words(rgb4, (w4, h4), bb4, atlas)
        check("read_block_region_words of one line equals [read_region_words] "
              "(['OK GO'])", rbw4 == ["OK GO"] and rbw4 == [rrw4],
              "%r/%r" % (rbw4, rrw4))

    # Scene E: evenly-tracked lines (no wide gap) invent no space. Glyphs are
    # placed one-by-one at an even 72px advance, as R77's evenly-tracked scene.
    w5, h5, rgb5 = two_line("bw_even.html",
                            [("O", RED, 80), ("K", RED, 152),
                             ("G", GRN, 224), ("O", GRN, 296)],
                            [("N", BLU, 80), ("O", BLU, 152),
                             ("B", RED, 224), ("Y", RED, 296)])
    bb5 = field_bbox(rgb5, (w5, h5))
    if bb5 is not None:
        rbw5 = osctl.read_block_region_words(rgb5, (w5, h5), bb5, atlas)
        check("read_block_region_words of an evenly-tracked block invents no "
              "space (['OKGO','NOBY'])", rbw5 == ["OKGO", "NOBY"], repr(rbw5))

    # Scene F: a uniform block holds no ink — read_block_region_words reads [].
    b.navigate(fixture("bw_uni.html",
               "<!doctype html><title>u</title><style>html,body{margin:0;"
               "background:#0d2860}</style>"
               "<canvas id=c width=900 height=520></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#0d2860';x.fillRect(0,0,900,520);</script>"))
    time.sleep(0.4)
    wu, hu, rgbu = osctl.capture_rgb()
    bbu = field_bbox(rgbu, (wu, hu), bg="#0d2860")
    if bbu is not None:
        rbwu = osctl.read_block_region_words(rgbu, (wu, hu), bbu, atlas)
        check("read_block_region_words of a uniform block is [] (no ink)",
              rbwu == [], repr(rbwu))


def round_locate_word(b, offline):
    print("R79: find a word by its TEXT and click it (F115) — osctl")
    # Every reader F103+ returns WHAT the text says and drops WHERE it sat, so an
    # agent that reads 'GO' off a <canvas> button still cannot press it (no DOM
    # node; the pixel finders locate by colour/bitmap, not by word). locate_word
    # gathers the glyph cells, groups them into words, reads each, and returns the
    # matching word's bbox — in the same screen coords capture_rgb/click share.
    # Hand its centre to osctl.click and the agent presses the word it read.
    if offline:
        return

    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    MAG = (255, 0, 255)
    RED, GRN, BLU = "#d32020", "#1f9d35", "#1565c0"
    chars = "OKGREDNBLUY"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("lw_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1100 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("lw atlas segments into eleven reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, frac=16):
        bls = osctl.find_color_blobs(hx("#ffffff"), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    # Three coloured text "buttons" on a canvas. Each carries no DOM node; the
    # canvas reports which word's drawn x-range a click landed in.
    b.navigate(fixture("lw_btn.html",
               "<!doctype html><title>btn</title><style>html,body{margin:0;"
               "background:#fff}</style>"
               "<canvas id=c width=900 height=360></canvas><script>"
               "var c=document.getElementById('c'),x=c.getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,900,360);"
               "x.font='bold 80px monospace';x.textBaseline='middle';"
               "x.textAlign='left';"
               "var W=[['OK','#d32020',100],['GO','#1f9d35',420],"
               "['BY','#1565c0',700]];var R=[];"
               "for(var i=0;i<W.length;i++){x.fillStyle=W[i][1];"
               "x.fillText(W[i][0],W[i][2],200);"
               "R.push([W[i][0],W[i][2],W[i][2]+x.measureText(W[i][0]).width]);}"
               "c.addEventListener('click',function(e){"
               "var r=c.getBoundingClientRect();"
               "var px=e.clientX-r.left,py=e.clientY-r.top,hit='MISS';"
               "for(var i=0;i<R.length;i++){if(px>=R[i][1]&&px<=R[i][2]"
               "&&py>=160&&py<=240)hit=R[i][0];}"
               "document.title='HIT:'+hit;});</script>"))
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("lw button row located", bb is not None, repr(bb))
    if bb is None:
        return

    # The reader names the words but hands back no place to click them.
    txt = osctl.read_region_words(rgb, sz, bb, atlas)
    check("read_region_words names the words but yields no position ('OK GO BY')",
          txt == "OK GO BY", repr(txt))

    # locate_word returns WHERE each word sits, in reading order, absent -> None.
    box_ok = osctl.locate_word(rgb, sz, bb, atlas, "OK")
    box_go = osctl.locate_word(rgb, sz, bb, atlas, "GO")
    box_by = osctl.locate_word(rgb, sz, bb, atlas, "BY")
    have = box_ok is not None and box_go is not None and box_by is not None
    check("locate_word returns a bbox for each present word", have,
          "%r/%r/%r" % (box_ok, box_go, box_by))
    if not have:
        return
    ordered = box_ok[0] < box_go[0] < box_by[0]
    check("locate_word boxes fall in reading order (OK<GO<BY by x)", ordered,
          "%d/%d/%d" % (box_ok[0], box_go[0], box_by[0]))
    check("locate_word of an absent word is None",
          osctl.locate_word(rgb, sz, bb, atlas, "ZZ") is None)

    # READ -> ACT: click the centre of the located word; the canvas (no DOM node
    # for the text) confirms the press landed on that very word.
    cx, cy = (box_go[0] + box_go[2]) // 2, (box_go[1] + box_go[3]) // 2
    osctl.click(cx, cy)
    check("clicking the located word 'GO' presses it (read->act closed)",
          b.wait_for("document.title==='HIT:GO'", timeout=3), b.title())

    # Not hard-wired to one word: locating and clicking 'OK' presses 'OK'.
    b.eval("document.title='btn'")
    cx2, cy2 = (box_ok[0] + box_ok[2]) // 2, (box_ok[1] + box_ok[3]) // 2
    osctl.click(cx2, cy2)
    check("clicking the located word 'OK' presses it (distinct target)",
          b.wait_for("document.title==='HIT:OK'", timeout=3), b.title())


def round_locate_block_word(b, offline):
    print("R80: find a word anywhere in a multi-LINE block and click it "
          "(F116) — osctl")
    # locate_word (F115) reaches a word in ONE line; hand it a two-line block and
    # the lines interleave by column (the pre-F114 scramble), so no word's run
    # forms and every locate_word returns None. locate_block_word bands the rows
    # first (like read_block_region_words), runs locate_word within each band, and
    # returns the matching word's bbox — found where it sits in the paragraph.
    if offline:
        return

    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    MAG = (255, 0, 255)
    chars = "OKGREDNBLUY"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("bl_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1100 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("bl atlas segments into eleven reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, frac=16):
        bls = osctl.find_color_blobs(hx("#ffffff"), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    # Two lines of coloured text "buttons"; the canvas reports which word's drawn
    # rect a click landed in. L1: OK(red) GO(grn). L2: NO(blue) BY(red).
    b.navigate(fixture("bl_btn.html",
               "<!doctype html><title>btn</title><style>html,body{margin:0;"
               "background:#fff}</style>"
               "<canvas id=c width=900 height=560></canvas><script>"
               "var c=document.getElementById('c'),x=c.getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,900,560);"
               "x.font='bold 80px monospace';x.textBaseline='middle';"
               "x.textAlign='left';"
               "var W=[['OK','#d32020',100,180],['GO','#1f9d35',520,180],"
               "['NO','#1565c0',100,400],['BY','#d32020',520,400]];var R=[];"
               "for(var i=0;i<W.length;i++){x.fillStyle=W[i][1];"
               "x.fillText(W[i][0],W[i][2],W[i][3]);"
               "R.push([W[i][0],W[i][2],W[i][2]+x.measureText(W[i][0]).width,"
               "W[i][3]-40,W[i][3]+40]);}"
               "c.addEventListener('click',function(e){"
               "var r=c.getBoundingClientRect();"
               "var px=e.clientX-r.left,py=e.clientY-r.top,hit='MISS';"
               "for(var i=0;i<R.length;i++){if(px>=R[i][1]&&px<=R[i][2]"
               "&&py>=R[i][3]&&py<=R[i][4])hit=R[i][0];}"
               "document.title='HIT:'+hit;});</script>"))
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("bl two-line button block located", bb is not None, repr(bb))
    if bb is None:
        return

    # The block reads as lines, but the line-deep locator cannot find a word in it.
    lines = osctl.read_block_region_words(rgb, sz, bb, atlas)
    check("read_block_region_words names the two lines (['OK GO','NO BY'])",
          lines == ["OK GO", "NO BY"], repr(lines))
    flat = [osctl.locate_word(rgb, sz, bb, atlas, t) for t in ("OK", "GO", "NO", "BY")]
    check("FRICTION: flat locate_word finds no word in a two-line block "
          "(lines interleave by column)", all(f is None for f in flat), repr(flat))

    # The block locator finds each word where it sits, in reading order.
    box = {t: osctl.locate_block_word(rgb, sz, bb, atlas, t)
           for t in ("OK", "GO", "NO", "BY")}
    have = all(v is not None for v in box.values())
    check("locate_block_word returns a bbox for every word in the block", have,
          repr(box))
    if not have:
        return
    rows_ok = (box["OK"][1] < box["NO"][1] and box["GO"][1] < box["BY"][1])
    cols_ok = (box["OK"][0] < box["GO"][0] and box["NO"][0] < box["BY"][0])
    check("locate_block_word boxes sit in their lines (L1 above L2)", rows_ok,
          "%d/%d vs %d/%d" % (box["OK"][1], box["GO"][1], box["NO"][1], box["BY"][1]))
    check("locate_block_word boxes order left-to-right within a line", cols_ok,
          "%d<%d / %d<%d" % (box["OK"][0], box["GO"][0], box["NO"][0], box["BY"][0]))
    check("locate_block_word of an absent word is None",
          osctl.locate_block_word(rgb, sz, bb, atlas, "ZZ") is None)

    # READ -> ACT across rows: click a word on the SECOND line.
    by = box["BY"]
    osctl.click((by[0] + by[2]) // 2, (by[1] + by[3]) // 2)
    check("clicking located 'BY' on line two presses it (read->act, block scope)",
          b.wait_for("document.title==='HIT:BY'", timeout=3), b.title())
    # And a word on the FIRST line, to prove it is not row-hardwired.
    b.eval("document.title='btn'")
    ok = box["OK"]
    osctl.click((ok[0] + ok[2]) // 2, (ok[1] + ok[3]) // 2)
    check("clicking located 'OK' on line one presses it (distinct row)",
          b.wait_for("document.title==='HIT:OK'", timeout=3), b.title())


def round_locate_phrase(b, offline):
    print("R81: find a multi-WORD phrase and click its span (F117) — osctl")
    # locate_word/locate_block_word (F115/F116) reach a SINGLE word, so a button
    # labelled across a space ('OK GO') is unfindable: ask for 'OK GO' and nothing
    # matches; ask for 'OK' and the box covers half the control. locate_phrase
    # bands rows, reads each line's words in order, and slides a window for the
    # consecutive run equal to the phrase, returning the bbox spanning exactly
    # those words — whose centre is the control's true middle.
    if offline:
        return

    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    MAG = (255, 0, 255)
    chars = "OKGREDNBLUY"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("ph_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1100 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("ph atlas segments into eleven reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, frac=16):
        bls = osctl.find_color_blobs(hx("#ffffff"), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    # A multi-word button 'OK GO' (red OK beside green GO, one clickable span) on
    # line 1; a single 'NO' button on line 2.
    b.navigate(fixture("ph_btn.html",
               "<!doctype html><title>btn</title><style>html,body{margin:0;"
               "background:#fff}</style>"
               "<canvas id=c width=900 height=560></canvas><script>"
               "var c=document.getElementById('c'),x=c.getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,900,560);"
               "x.font='bold 80px monospace';x.textBaseline='middle';"
               "x.textAlign='left';"
               "x.fillStyle='#d32020';x.fillText('OK',100,180);"
               "x.fillStyle='#1f9d35';x.fillText('GO',300,180);"
               "x.fillStyle='#1565c0';x.fillText('NO',100,400);"
               "var BX=100,BX2=300+x.measureText('GO').width;"
               "c.addEventListener('click',function(e){"
               "var r=c.getBoundingClientRect();"
               "var px=e.clientX-r.left,py=e.clientY-r.top;"
               "if(px>=BX&&px<=BX2&&py>=140&&py<=220)document.title='HIT:OKGO';"
               "else if(px>=100&&px<=100+x.measureText('NO').width&&py>=360"
               "&&py<=440)document.title='HIT:NO';else document.title='MISS';"
               "});</script>"))
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("ph button block located", bb is not None, repr(bb))
    if bb is None:
        return

    lines = osctl.read_block_region_words(rgb, sz, bb, atlas)
    check("read_block_region_words reads the 'OK GO' label as one line "
          "(['OK GO','NO'])", lines == ["OK GO", "NO"], repr(lines))

    # FRICTION: the single-word locator cannot match a phrase that holds a space.
    check("FRICTION: locate_block_word('OK GO') is None (single-word locator)",
          osctl.locate_block_word(rgb, sz, bb, atlas, "OK GO") is None)
    box_ok = osctl.locate_block_word(rgb, sz, bb, atlas, "OK")
    box_go = osctl.locate_block_word(rgb, sz, bb, atlas, "GO")
    have1 = box_ok is not None and box_go is not None
    check("the two words are locatable singly", have1,
          "%r/%r" % (box_ok, box_go))
    if not have1:
        return

    # locate_phrase spans exactly the run of words.
    ph = osctl.locate_phrase(rgb, sz, bb, atlas, "OK GO")
    check("locate_phrase('OK GO') returns a bbox", ph is not None, repr(ph))
    if ph is None:
        return
    spans = ph[0] <= box_ok[0] and ph[2] >= box_go[2] and ph[2] > box_ok[2]
    check("locate_phrase spans OK's left through GO's right (the whole label)",
          spans, "%r vs OK %r GO %r" % (ph, box_ok, box_go))
    cx = (ph[0] + ph[2]) // 2
    ok_c = (box_ok[0] + box_ok[2]) // 2
    go_c = (box_go[0] + box_go[2]) // 2
    check("the phrase centre is the control's middle (between the two words)",
          ok_c < cx < go_c, "%d < %d < %d" % (ok_c, cx, go_c))

    # A phrase no line carries in order is None; one word is locate_block_word.
    check("locate_phrase of an absent phrase is None",
          osctl.locate_phrase(rgb, sz, bb, atlas, "NO BY") is None)
    check("locate_phrase of a single word equals locate_block_word ('NO')",
          osctl.locate_phrase(rgb, sz, bb, atlas, "NO")
          == osctl.locate_block_word(rgb, sz, bb, atlas, "NO"))

    # READ -> ACT: clicking the phrase centre presses the multi-word control.
    osctl.click(cx, (ph[1] + ph[3]) // 2)
    check("clicking the located phrase 'OK GO' presses the multi-word button",
          b.wait_for("document.title==='HIT:OKGO'", timeout=3), b.title())


def round_wait_for_phrase(b, offline):
    print("R82: wait for a result word to APPEAR, then click it "
          "(act->observe->act, F118) — osctl")
    # Every locator reads a single frame; the capture an agent takes the instant
    # it clicks catches the screen BEFORE the delayed result paints, so
    # locate_phrase honestly returns None for text a heartbeat from existing.
    # wait_for_phrase re-captures on a cadence and returns the moment the target
    # first appears (or None at the deadline) — closing act->observe->act.
    if offline:
        return

    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    MAG = (255, 0, 255)
    chars = "OKGREDNBLUY"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("wt_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1100 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("wt atlas segments into eleven reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, frac=16):
        bls = osctl.find_color_blobs(hx("#ffffff"), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    # A blue 'GO' button; clicking it paints the red result 'OK' ~700ms later.
    b.navigate(fixture("wt_btn.html",
               "<!doctype html><title>btn</title><style>html,body{margin:0;"
               "background:#fff}</style>"
               "<canvas id=c width=900 height=560></canvas><script>"
               "var c=document.getElementById('c'),x=c.getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,900,560);"
               "x.font='bold 80px monospace';x.textBaseline='middle';"
               "x.textAlign='left';"
               "x.fillStyle='#1565c0';x.fillText('GO',100,160);"
               "var GW=x.measureText('GO').width,DR=null;"
               "function go(){setTimeout(function(){x.fillStyle='#d32020';"
               "x.fillText('OK',100,400);DR=[100,100+x.measureText('OK').width,"
               "360,440];document.title='DRAWN';},700);}"
               "c.addEventListener('click',function(e){"
               "var r=c.getBoundingClientRect();"
               "var px=e.clientX-r.left,py=e.clientY-r.top;"
               "if(px>=100&&px<=100+GW&&py>=120&&py<=200){go();return;}"
               "if(DR&&px>=DR[0]&&px<=DR[1]&&py>=DR[2]&&py<=DR[3])"
               "document.title='HIT:OK';});</script>"))
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("wt button field located", bb is not None, repr(bb))
    if bb is None:
        return
    gobox = osctl.locate_phrase(rgb, sz, bb, atlas, "GO")
    check("the 'GO' button is locatable", gobox is not None, repr(gobox))
    if gobox is None:
        return

    # Click GO, then capture immediately — the result has not painted yet.
    osctl.click((gobox[0] + gobox[2]) // 2, (gobox[1] + gobox[3]) // 2)
    w2, h2, rgb2 = osctl.capture_rgb()
    check("FRICTION: a single locate right after the click misses the delayed "
          "result", osctl.locate_phrase(rgb2, (w2, h2), bb, atlas, "OK") is None)

    # Wait for the result to appear; it does, and its bbox is returned.
    box = osctl.wait_for_phrase(bb, atlas, "OK", timeout=5.0)
    check("wait_for_phrase returns the result's bbox once it appears",
          box is not None, repr(box))
    if box is None:
        return
    check("wait_for_phrase of a word that never appears is None (deadline)",
          osctl.wait_for_phrase(bb, atlas, "NOPE", timeout=0.6) is None)

    # READ -> ACT after observing: click the result that we waited for.
    osctl.click((box[0] + box[2]) // 2, (box[1] + box[3]) // 2)
    check("clicking the awaited result 'OK' presses it (act->observe->act)",
          b.wait_for("document.title==='HIT:OK'", timeout=3), b.title())


def round_scroll(b, offline):
    print("R83: scroll a below-the-fold button into view and click it "
          "(F119) — osctl")
    # capture_rgb is one screenful; every reader/locator searches within it, so
    # content past the fold is simply not in the pixels and locate_phrase returns
    # None for text that exists but is scrolled away. scroll() rolls the wheel so a
    # fresh capture shows what came into the frame — the window can move across a
    # surface larger than itself.
    if offline:
        return

    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    MAG = (255, 0, 255)
    chars = "OKGREDNBLUY"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("sc_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1100 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("sc atlas segments into eleven reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, frac=16):
        bls = osctl.find_color_blobs(hx("#ffffff"), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    # A tall page whose only button, a blue 'GO' canvas, sits far below the fold.
    b.navigate(fixture("sc_tall.html",
               "<!doctype html><title>t</title><style>html,body{margin:0;"
               "background:#fff}#sp{height:3000px}"
               "#c{position:absolute;top:2600px;left:40px}</style>"
               "<div id=sp></div><canvas id=c width=400 height=160></canvas>"
               "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,400,160);"
               "x.font='bold 80px monospace';x.textBaseline='middle';"
               "x.textAlign='left';"
               "x.fillStyle='#1565c0';x.fillText('GO',60,90);"
               "var GW=x.measureText('GO').width;"
               "c.addEventListener('click',function(e){"
               "var r=c.getBoundingClientRect();"
               "var px=e.clientX-r.left,py=e.clientY-r.top;"
               "if(px>=60&&px<=60+GW&&py>=50&&py<=130)document.title='HIT:GO';"
               "});</script>"))
    time.sleep(0.5)
    check("the tall page starts at the top (scrollY 0)",
          b.eval("window.scrollY") == 0, repr(b.eval("window.scrollY")))
    w, h, rgb = osctl.capture_rgb()
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("sc field located", bb is not None, repr(bb))
    if bb is None:
        return
    check("FRICTION: the below-fold 'GO' is not on screen (locate_phrase None)",
          osctl.locate_phrase(rgb, sz, bb, atlas, "GO") is None)

    # Roll the wheel down; the page moves and 'GO' comes into the frame.
    osctl.scroll(dy=-40, x=w // 2, y=h // 2)
    time.sleep(0.4)
    sy_down = b.eval("window.scrollY")
    check("scroll(dy<0) moves the page down (scrollY grows)", sy_down > 500,
          repr(sy_down))
    w2, h2, rgb2 = osctl.capture_rgb()
    bb2 = field_bbox(rgb2, (w2, h2))
    gob = osctl.locate_phrase(rgb2, (w2, h2), bb2, atlas, "GO") if bb2 else None
    check("'GO' is now on screen after scrolling (locate_phrase finds it)",
          gob is not None, repr(gob))
    if gob is None:
        return

    # READ -> ACT on content that was beyond the fold.
    osctl.click((gob[0] + gob[2]) // 2, (gob[1] + gob[3]) // 2)
    check("clicking the scrolled-in 'GO' presses it (reach past the fold)",
          b.wait_for("document.title==='HIT:GO'", timeout=3), b.title())

    # Roll the wheel back up; the page returns toward the top.
    osctl.scroll(dy=40, x=w // 2, y=h // 2)
    time.sleep(0.4)
    sy_up = b.eval("window.scrollY")
    check("scroll(dy>0) moves the page back up (scrollY shrinks)", sy_up < sy_down,
          "%r -> %r" % (sy_down, sy_up))


def round_scroll_to_phrase(b, offline):
    print("R84: walk a long page to a target by text alone, then click it "
          "(F120) — osctl")
    # scroll() (F119) reaches past the fold only by a guessed amount — a fixed roll
    # under- or over-shoots. scroll_to_phrase searches and scrolls together: it
    # rolls a step at a time, looking for the target each frame, up to max_steps,
    # so the window walks itself to the text instead of the caller counting
    # notches.
    if offline:
        return

    def hx(s):
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))

    MAG = (255, 0, 255)
    chars = "OKGREDNBLUY"
    draws = "".join("x.fillText('%s',%d,80);" % (ch, 24 + i * 96)
                    for i, ch in enumerate(chars))
    b.navigate(fixture("s2_atlas.html",
               "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
               "<canvas id=c width=1100 height=140></canvas><script>"
               "var x=document.getElementById('c').getContext('2d');"
               "x.fillStyle='#fff';x.fillRect(0,0,1100,140);"
               "x.fillStyle='#f0f';x.font='bold 80px monospace';"
               "x.textAlign='left';x.textBaseline='middle';" + draws + "</script>"))
    time.sleep(0.5)
    aw, ah, argb = osctl.capture_rgb()
    ab = sorted(osctl.find_color_blobs(MAG, tol=60, rgb=argb, size=(aw, ah),
                                       min_count=120), key=lambda t: t["x"])
    check("s2 atlas segments into eleven reference glyphs", len(ab) == len(chars),
          str([t["x"] for t in ab]))
    if len(ab) != len(chars):
        return
    atlas = {chars[i]: osctl.edge_signature(argb, (aw, ah), ab[i]["bbox"])
             for i in range(len(chars))}

    def field_bbox(rgbX, szX, frac=16):
        bls = osctl.find_color_blobs(hx("#ffffff"), tol=30, rgb=rgbX, size=szX,
                                     min_count=5000)
        if not bls:
            return None
        x0, y0, x1, y1 = max(bls, key=lambda t: t["count"])["bbox"]
        iw, ih = (x1 - x0) // frac, (y1 - y0) // 8
        return (x0 + iw, y0 + ih, x1 - iw, y1 - ih)

    tall = ("<!doctype html><title>t</title><style>html,body{margin:0;"
            "background:#fff}#sp{height:3000px}"
            "#c{position:absolute;top:2600px;left:40px}</style>"
            "<div id=sp></div><canvas id=c width=400 height=160></canvas>"
            "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
            "x.fillStyle='#fff';x.fillRect(0,0,400,160);"
            "x.font='bold 80px monospace';x.textBaseline='middle';"
            "x.textAlign='left';"
            "x.fillStyle='#1565c0';x.fillText('GO',60,90);"
            "var GW=x.measureText('GO').width;"
            "c.addEventListener('click',function(e){"
            "var r=c.getBoundingClientRect();"
            "var px=e.clientX-r.left,py=e.clientY-r.top;"
            "if(px>=60&&px<=60+GW&&py>=50&&py<=130)document.title='HIT:GO';"
            "});</script>")

    b.navigate(fixture("s2_tall.html", tall))
    time.sleep(0.5)
    check("the tall page starts at the top (scrollY 0)",
          b.eval("window.scrollY") == 0, repr(b.eval("window.scrollY")))
    w, h, rgb = osctl.capture_rgb()
    sz = (w, h)
    bb = field_bbox(rgb, sz)
    check("s2 field located", bb is not None, repr(bb))
    if bb is None:
        return

    # FRICTION: one fixed roll undershoots — 'GO' is still off-screen.
    osctl.scroll(dy=-6, x=w // 2, y=h // 2)
    time.sleep(0.3)
    w1, h1, rgb1 = osctl.capture_rgb()
    bbf = field_bbox(rgb1, (w1, h1))
    check("FRICTION: a single fixed scroll undershoots ('GO' not yet visible)",
          osctl.locate_phrase(rgb1, (w1, h1), bbf, atlas, "GO") is None
          if bbf else False)

    # scroll_to_phrase walks the rest of the way and finds it.
    box = osctl.scroll_to_phrase(bb, atlas, "GO", step=6, max_steps=8)
    check("scroll_to_phrase walks the page and returns the target's bbox",
          box is not None, repr(box))
    sy = b.eval("window.scrollY")
    check("the page scrolled to bring 'GO' into view", sy > 500, repr(sy))
    if box is None:
        return

    # READ -> ACT: press a button found by text alone, anywhere down the page.
    osctl.click((box[0] + box[2]) // 2, (box[1] + box[3]) // 2)
    check("clicking the walked-to 'GO' presses it (find by text, then act)",
          b.wait_for("document.title==='HIT:GO'", timeout=3), b.title())

    # A word on no reachable screenful: walk to the end, then None.
    b.navigate(fixture("s2_tall.html", tall))
    time.sleep(0.5)
    w3, h3, rgb3 = osctl.capture_rgb()
    bb3 = field_bbox(rgb3, (w3, h3))
    check("scroll_to_phrase of an absent word returns None (walked to the end)",
          osctl.scroll_to_phrase(bb3, atlas, "ZZ", step=6, max_steps=8) is None)


def round_drag_stroke(b: Browser, offline: bool) -> None:
    print("R85: OS-level drag — carry a canvas handle to a dropzone (F121) — osctl")
    # A handle (magenta) and a dropzone (cyan) painted on <canvas>: no DOM node
    # marks either, so the only channel is OS input on the seen pixels. osctl
    # could press a point (click) and roll the wheel (scroll), but had no held
    # stroke — it could not *carry* the handle across to the zone. Every prior
    # drag round drove CDP's b.drag; the pure OS channel had no drag at all.
    html = fixture("drag_stroke.html",
                   "<!doctype html><meta charset=utf-8><title>drag</title>"
                   "<style>html,body{margin:0}</style>"
                   "<canvas id=c width=700 height=460 style='display:block'></canvas>"
                   "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                   "var HX=80,HY=180,HW=90,HH=90,DX=520,DY=150,DW=140,DH=150;"
                   "function paint(hx,hy,ok){x.fillStyle='#ffffff';x.fillRect(0,0,700,460);"
                   "x.fillStyle=ok?'#00cc00':'#00cccc';x.fillRect(DX,DY,DW,DH);"
                   "x.fillStyle='#ff00ff';x.fillRect(hx,hy,HW,HH);}"
                   "var hx=HX,hy=HY,drag=null;paint(hx,hy,false);"
                   "window.__moves=0;window.__down=null;window.__end=null;"
                   "c.addEventListener('contextmenu',function(e){e.preventDefault();});"
                   "c.addEventListener('mousedown',function(e){if(e.button!==0)return;"
                   "var r=c.getBoundingClientRect();"
                   "var px=e.clientX-r.left,py=e.clientY-r.top;"
                   "if(px>=hx&&px<=hx+HW&&py>=hy&&py<=hy+HH){drag={dx:px-hx,dy:py-hy};"
                   "window.__down=[Math.round(px),Math.round(py)];window.__moves=0;}});"
                   "c.addEventListener('mousemove',function(e){if(!drag)return;"
                   "var r=c.getBoundingClientRect();hx=e.clientX-r.left-drag.dx;"
                   "hy=e.clientY-r.top-drag.dy;window.__moves++;paint(hx,hy,false);});"
                   "c.addEventListener('mouseup',function(e){if(!drag)return;drag=null;"
                   "var r=c.getBoundingClientRect();var px=e.clientX-r.left,py=e.clientY-r.top;"
                   "window.__end=[Math.round(px),Math.round(py)];"
                   "var cx=hx+HW/2,cy=hy+HH/2;var ok=(cx>=DX&&cx<=DX+DW&&cy>=DY&&cy<=DY+DH);"
                   "paint(hx,hy,ok);document.title=ok?'DROP-OK':'DROP-MISS';});</script>")
    b.navigate(html)
    time.sleep(0.5)
    # Friction: nothing in the DOM marks the handle or the zone.
    check("no DOM node for the canvas handle/dropzone",
          b.eval("document.querySelectorAll('button,a,[draggable]').length===0"))
    w, h, rgb = osctl.capture_rgb()
    check("capture matches click coordinate space", (w, h) == osctl.screen_size(),
          f"{(w, h)} vs {osctl.screen_size()}")
    handle = osctl.find_color((255, 0, 255), tol=40, rgb=rgb, size=(w, h))
    drop = osctl.find_color((0, 204, 204), tol=45, rgb=rgb, size=(w, h))
    check("located the magenta handle by pixels",
          handle is not None and handle["count"] > 3000,
          str(handle and {k: handle[k] for k in ("x", "y", "count")}))
    check("the cyan dropzone is painted (present on screen)",
          drop is not None and drop["count"] > 300,
          str(drop and {k: drop[k] for k in ("x", "y", "count")}))
    if handle is None or drop is None:
        return
    # The handle is a solid 90x90 block, so find_color returns its exact centre;
    # the dropzone centre sits a known canvas delta away (drop_centre -
    # handle_centre = (590-125, 225-225) = (465, 0)) and the canvas maps 1:1 to
    # the screen, so the screen target is the handle anchor plus that delta. We
    # do not trust the cyan centroid for the endpoint: a hollow/!thin colour can
    # pick up stray same-hue pixels elsewhere and drift, whereas the solid
    # magenta anchor is unambiguous.
    tx, ty = handle["x"] + 465, handle["y"]
    # Friction: a click presses the handle but carries it nowhere.
    osctl.click(handle["x"], handle["y"])
    time.sleep(0.3)
    check("click alone cannot carry the handle (no DROP-OK)",
          b.title() != "DROP-OK", b.title())
    check("click produced no held travel (moves==0)",
          b.eval("window.__moves") == 0, repr(b.eval("window.__moves")))
    # Primitive: drag holds the button down and glides the handle across.
    osctl.drag(handle["x"], handle["y"], tx, ty, steps=28)
    check("drag carried the handle into the dropzone (DROP-OK)",
          b.wait_for("document.title==='DROP-OK'", timeout=3), b.title())
    check("drag was a continuous stroke, not a teleport (moves>1)",
          b.eval("window.__moves") > 1, repr(b.eval("window.__moves")))
    down = b.eval("window.__down")
    check("press landed inside the handle",
          down is not None and 80 <= down[0] <= 170 and 180 <= down[1] <= 270,
          repr(down))
    end = b.eval("window.__end")
    check("release landed inside the dropzone",
          end is not None and 520 <= end[0] <= 660 and 150 <= end[1] <= 300,
          repr(end))
    time.sleep(0.3)
    green = osctl.find_color((0, 204, 0), tol=45)
    check("state change confirmed by pixels (dropzone turned green)",
          green is not None and green["count"] > 5000,
          str(green and green.get("count")))
    # Honest: a right-button drag does not trip the left-button handler.
    b.navigate(html)
    time.sleep(0.4)
    w2, h2, rgb2 = osctl.capture_rgb()
    hd2 = osctl.find_color((255, 0, 255), tol=40, rgb=rgb2, size=(w2, h2))
    if hd2:
        osctl.drag(hd2["x"], hd2["y"], hd2["x"] + 465, hd2["y"], steps=20, right=True)
        time.sleep(0.3)
        check("a right-button drag leaves the left-drag handler untriggered",
              b.title() != "DROP-OK", b.title())


def round_double_click(b: Browser, offline: bool) -> None:
    print("R86: OS-level double_click — open a dblclick-only pad (F122) — osctl")
    # A pad counts single clicks and opens only on dblclick. A single click()
    # call fires exactly one click and can never reach the dblclick handler;
    # and two clicks spaced past the OS double-click window stay two unrelated
    # singles. double_click pairs two presses inside that window at one point.
    html = fixture("double_click.html",
                   "<!doctype html><meta charset=utf-8><title>start</title>"
                   "<style>html,body{margin:0}#p{position:absolute;left:120px;"
                   "top:140px;width:260px;height:160px;background:#3344ff}</style>"
                   "<div id=p></div><script>window.__clicks=0;window.__dbl=0;"
                   "var p=document.getElementById('p');"
                   "p.addEventListener('click',function(){window.__clicks++;});"
                   "p.addEventListener('dblclick',function(){window.__dbl++;"
                   "p.style.background='#11bb33';document.title='OPENED';});</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    check("capture matches click coordinate space", (w, h) == osctl.screen_size(),
          f"{(w, h)} vs {osctl.screen_size()}")
    pad = osctl.find_color((51, 68, 255), tol=40, rgb=rgb, size=(w, h))
    check("located the blue pad by pixels",
          pad is not None and pad["count"] > 20000,
          str(pad and {k: pad[k] for k in ("x", "y", "count")}))
    if pad is None:
        return
    # Friction: a single click fires one click, never a dblclick.
    osctl.click(pad["x"], pad["y"])
    time.sleep(0.3)
    check("a single click does not open the dblclick-only pad",
          b.title() != "OPENED" and b.eval("window.__dbl") == 0,
          f"title={b.title()} dbl={b.eval('window.__dbl')}")
    check("the single click did register (one click, not zero)",
          b.eval("window.__clicks") == 1, repr(b.eval("window.__clicks")))
    # Primitive: double_click pairs two presses inside the window → dblclick.
    osctl.double_click(pad["x"], pad["y"])
    check("double_click opens the pad (dblclick fired)",
          b.wait_for("document.title==='OPENED'", timeout=3), b.title())
    check("exactly one dblclick fired from the pair",
          b.eval("window.__dbl") == 1, repr(b.eval("window.__dbl")))
    time.sleep(0.3)
    green = osctl.find_color((17, 187, 51), tol=45)
    check("state change confirmed by pixels (pad turned green)",
          green is not None and green["count"] > 20000,
          str(green and green.get("count")))
    # A double_click on empty page background opens nothing (no false trigger).
    # The point is well inside the viewport, clear of the pad and the browser
    # chrome — a corner like (20,20) lands on the window frame, not the page.
    b.navigate(html)
    time.sleep(0.4)
    osctl.double_click(pad["x"] + 380, pad["y"])
    time.sleep(0.3)
    check("double_click on empty page background opens nothing",
          b.title() != "OPENED" and b.eval("window.__dbl") == 0,
          f"title={b.title()} dbl={b.eval('window.__dbl')}")


def round_middle_click(b: Browser, offline: bool) -> None:
    print("R87: OS-level middle_click — the third mouse button (F123) — osctl")
    # A pad counts left clicks and middle (auxclick, button===1) separately,
    # and opens (green, title MIDDLE) only on a true middle click. click()
    # encodes only left/right, so a left click can never stand in for it.
    html = fixture("middle_click.html",
                   "<!doctype html><meta charset=utf-8><title>start</title>"
                   "<style>html,body{margin:0}#p{position:absolute;left:120px;"
                   "top:140px;width:260px;height:160px;background:#cc7a00}</style>"
                   "<div id=p></div><script>window.__left=0;window.__mid=0;"
                   "var p=document.getElementById('p');"
                   "p.addEventListener('click',function(e){"
                   "if(e.button===0)window.__left++;});"
                   "p.addEventListener('auxclick',function(e){if(e.button===1){"
                   "window.__mid++;p.style.background='#11bb33';"
                   "document.title='MIDDLE';}});"
                   "p.addEventListener('mousedown',function(e){"
                   "if(e.button===1)e.preventDefault();});</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    check("capture matches click coordinate space", (w, h) == osctl.screen_size(),
          f"{(w, h)} vs {osctl.screen_size()}")
    pad = osctl.find_color((204, 122, 0), tol=40, rgb=rgb, size=(w, h))
    check("located the amber pad by pixels",
          pad is not None and pad["count"] > 20000,
          str(pad and {k: pad[k] for k in ("x", "y", "count")}))
    if pad is None:
        return
    # Friction: a left click is not a middle click.
    osctl.click(pad["x"], pad["y"])
    time.sleep(0.3)
    check("a left click does not register as a middle click",
          b.title() != "MIDDLE" and b.eval("window.__mid") == 0,
          f"title={b.title()} mid={b.eval('window.__mid')}")
    check("the left click did register on its own button",
          b.eval("window.__left") == 1, repr(b.eval("window.__left")))
    # Primitive: middle_click fires a true aux click (button===1).
    osctl.middle_click(pad["x"], pad["y"])
    check("middle_click fires the middle button (auxclick)",
          b.wait_for("document.title==='MIDDLE'", timeout=3), b.title())
    check("exactly one middle click landed",
          b.eval("window.__mid") == 1, repr(b.eval("window.__mid")))
    check("middle_click did not add a left click",
          b.eval("window.__left") == 1, repr(b.eval("window.__left")))
    time.sleep(0.3)
    green = osctl.find_color((17, 187, 51), tol=45)
    check("state change confirmed by pixels (pad turned green)",
          green is not None and green["count"] > 20000,
          str(green and green.get("count")))
    # A middle_click on empty page background opens nothing.
    b.navigate(html)
    time.sleep(0.4)
    osctl.middle_click(pad["x"] + 380, pad["y"])
    time.sleep(0.3)
    check("middle_click on empty page background opens nothing",
          b.title() != "MIDDLE" and b.eval("window.__mid") == 0,
          f"title={b.title()} mid={b.eval('window.__mid')}")


def round_region_diff(b: Browser, offline: bool) -> None:
    print("R98: OS-level region_diff — tolerant pixel comparison vs exact (F134) — osctl")
    # The two visual waits judge sameness by exact byte-equality, which is
    # brittle: a +2/channel shift (invisible noise) makes an exact compare report
    # EVERY pixel as changed. region_diff with a tolerance looks past that noise
    # yet still catches a real color change. The measured form of equality.
    html = fixture("region_diff.html",
                   "<!doctype html><meta charset=utf-8><title>x</title>"
                   "<style>html,body{margin:0;height:100%;background:#fff}"
                   "#box{position:absolute;left:60px;top:140px;width:200px;"
                   "height:140px;background:#808080}</style><div id=box></div>"
                   "<script>window.__set=function(c){"
                   "document.getElementById('box').style.background=c;};"
                   "</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    blobs = osctl.find_color_blobs((128, 128, 128), tol=20, rgb=rgb,
                                   size=(w, h), min_count=2000)
    check("located the gray box as a blob", len(blobs) >= 1,
          f"blobs={len(blobs)}")
    if not blobs:
        return
    x0, y0, x1, y1 = blobs[0]["bbox"]
    bbox = (x0 + 8, y0 + 8, x1 - 8, y1 - 8)  # interior, past edge antialiasing
    base, pw, ph = osctl.crop_rgb(rgb, (w, h), bbox)
    # A re-capture of the unchanged box is clean: zero difference at tol 0.
    _w, _h, r0 = osctl.capture_rgb()
    same, _, _ = osctl.crop_rgb(r0, (_w, _h), bbox)
    d_same = osctl.region_diff(base, same, tol=0)
    check("an unchanged re-capture has zero exact difference",
          d_same["pixels"] == 0, repr(d_same))
    # Friction: a +2/channel shift is invisible noise, but exact compare flags
    # essentially the whole box; a tolerant compare ignores it.
    b.eval("window.__set('#828282')")
    time.sleep(0.3)
    _w, _h, r1 = osctl.capture_rgb()
    noise, _, _ = osctl.crop_rgb(r1, (_w, _h), bbox)
    d_noise_exact = osctl.region_diff(base, noise, tol=0)
    d_noise_tol = osctl.region_diff(base, noise, tol=8)
    check("exact compare over-fires on a +2 noise shift (most pixels 'changed')",
          d_noise_exact["frac"] > 0.5, repr(d_noise_exact))
    check("tolerant compare ignores the noise shift (no pixels exceed tol)",
          d_noise_tol["pixels"] == 0, repr(d_noise_tol))
    # Signal: a real color change is caught even under the same tolerance.
    b.eval("window.__set('#22cc44')")
    time.sleep(0.3)
    _w, _h, r2 = osctl.capture_rgb()
    sig, _, _ = osctl.crop_rgb(r2, (_w, _h), bbox)
    d_sig_tol = osctl.region_diff(base, sig, tol=8)
    check("tolerant compare still catches a real color change",
          d_sig_tol["frac"] > 0.5, repr(d_sig_tol))


def round_wait_for_change(b: Browser, offline: bool) -> None:
    print("R97: OS-level wait_for_change — wait for a region to first differ (F133) — osctl")
    # A gray box turns green 600ms after the trigger (delayed onset). Reading the
    # region immediately still sees the gray baseline, so an eager agent concludes
    # nothing happened; wait_for_change keeps sampling until the box first differs
    # from the captured baseline and reports the onset. The onset twin of
    # wait_until_stable.
    html = fixture("wait_change.html",
                   "<!doctype html><meta charset=utf-8><title>x</title>"
                   "<style>html,body{margin:0;height:100%;background:#fff}"
                   "#box{position:absolute;left:60px;top:140px;width:160px;"
                   "height:120px;background:#888}</style><div id=box></div>"
                   "<script>window.__go=function(){setTimeout(function(){"
                   "document.getElementById('box').style.background='#22cc44';"
                   "document.title='ON';},600);};</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    box = osctl.find_color((136, 136, 136), tol=30, rgb=rgb, size=(w, h))
    check("located the gray box by pixels",
          box is not None and box["count"] > 5000,
          str(box and {k: box[k] for k in ("x", "y", "count")}))
    if box is None:
        return
    bbox = box["bbox"]
    base, _, _ = osctl.crop_rgb(rgb, (w, h), bbox)
    # Fire the delayed change, then prove the friction: an immediate read still
    # equals the baseline and the title has not flipped yet.
    b.eval("window.__go()")
    _w, _h, r2 = osctl.capture_rgb()
    p2, _, _ = osctl.crop_rgb(r2, (_w, _h), bbox)
    check("an immediate read still matches the baseline (change not yet here)",
          p2 == base, f"equal={p2 == base}")
    check("the onset has not flipped the title yet", b.title() != "ON",
          b.title())
    # Primitive: wait until the region first differs from the baseline.
    res = osctl.wait_for_change(bbox, baseline=base, interval=0.05, timeout=5.0)
    check("wait_for_change reports the onset arrived", res["changed"] is True,
          repr(res))
    check("it actually waited for the delayed onset (elapsed>=0.3s)",
          res["elapsed"] >= 0.3, repr(res["elapsed"]))
    check("it sampled more than once before the change (captures>=2)",
          res["captures"] >= 2, repr(res["captures"]))
    # After the onset, the region truly differs from the baseline and ON is set.
    _w, _h, r3 = osctl.capture_rgb()
    p3, _, _ = osctl.crop_rgb(r3, (_w, _h), bbox)
    check("the region now differs from the baseline", p3 != base,
          f"equal={p3 == base}")
    check("the change committed (title ON)", b.title() == "ON", b.title())


def round_wait_until_stable(b: Browser, offline: bool) -> None:
    print("R96: OS-level wait_until_stable — wait for a region to stop moving (F132) — osctl")
    # A red block slides across a band for ~1.2s then rests. Sampling the band
    # right after the trigger catches it mid-flight (two quick captures differ);
    # wait_until_stable keeps sampling until the band stops changing, reports it
    # settled with a positive change count, and only then is REST true. The
    # visual twin of wait_for_phrase.
    html = fixture("wait_stable.html",
                   "<!doctype html><meta charset=utf-8><title>x</title>"
                   "<style>html,body{margin:0;height:100%;background:#fff}"
                   "#blk{position:absolute;top:160px;left:20px;width:80px;"
                   "height:80px;background:#dd2222}</style><div id=blk></div>"
                   "<script>var b=document.getElementById('blk');"
                   "var t0=0,dur=1200,x0=20,x1=600,id=null;"
                   "window.__go=function(){t0=performance.now();"
                   "if(id)cancelAnimationFrame(id);(function step(now){"
                   "var k=Math.min(1,(now-t0)/dur);b.style.left=(x0+(x1-x0)*k)"
                   "+'px';if(k<1){id=requestAnimationFrame(step);}else{"
                   "document.title='REST';}})(t0);};</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    blk = osctl.find_color((221, 34, 34), tol=40, rgb=rgb, size=(w, h))
    check("located the block by pixels at rest-start",
          blk is not None and blk["count"] > 3000,
          str(blk and {k: blk[k] for k in ("x", "y", "count")}))
    if blk is None:
        return
    y = blk["y"]
    bbox = (0, max(0, y - 50), min(w - 1, 740), min(h - 1, y + 50))
    # Fire the slide, then prove the friction in pure pixels: two captures a beat
    # apart differ, so a single snapshot would read a position still in flight.
    b.eval("window.__go()")
    _w, _h, r1 = osctl.capture_rgb()
    p1, _, _ = osctl.crop_rgb(r1, (_w, _h), bbox)
    time.sleep(0.15)
    _w, _h, r2 = osctl.capture_rgb()
    p2, _, _ = osctl.crop_rgb(r2, (_w, _h), bbox)
    check("the region is still moving just after the trigger (snapshots differ)",
          p1 != p2, f"equal={p1 == p2}")
    check("the slide has not rested yet (title not REST)",
          b.title() != "REST", b.title())
    # Primitive: wait until the region stops changing, then it is safe to read.
    res = osctl.wait_until_stable(bbox, settle=3, interval=0.08, timeout=6.0)
    check("wait_until_stable reports the region settled",
          res["stable"] is True, repr(res))
    check("it observed real motion before settling (changes>=3)",
          res["changes"] >= 3, repr(res["changes"]))
    check("the slide had finished by the time it settled (REST)",
          b.title() == "REST", b.title())
    # And once judged stable, a fresh capture matches the settled frame.
    _w, _h, r3 = osctl.capture_rgb()
    p3, _, _ = osctl.crop_rgb(r3, (_w, _h), bbox)
    time.sleep(0.15)
    _w, _h, r4 = osctl.capture_rgb()
    p4, _, _ = osctl.crop_rgb(r4, (_w, _h), bbox)
    check("the settled region stays unchanged on re-capture",
          p3 == p4, f"equal={p3 == p4}")


def round_mod_taps(b: Browser, offline: bool) -> None:
    print("R95: OS-level mod_taps — one modifier held across a tap sequence (F131) — osctl")
    # A page appends each letter typed while Shift is held to a buffer, and
    # commits the buffer (to the title) on Shift's keyup. A loop of chord
    # releases Shift after every letter, so each commits alone and only the last
    # survives; mod_taps holds Shift across the whole run, so it commits as one
    # word on a single keyup. The sequence twin of chord.
    html = fixture("mod_taps.html",
                   "<!doctype html><meta charset=utf-8><title>x</title>"
                   "<style>html,body{margin:0;height:100%}#p{position:absolute;"
                   "left:0;top:0;width:320px;height:220px;background:#22aa66}"
                   "</style><div id=p></div><script>window.__buf='';"
                   "window.__commits=0;addEventListener('keydown',function(e){"
                   "if(e.shiftKey&&e.key.length===1){window.__buf+=e.key;"
                   "e.preventDefault();}});addEventListener('keyup',"
                   "function(e){if(e.key==='Shift'){window.__commits++;"
                   "document.title='WORD:'+window.__buf;window.__buf='';}});"
                   "</script>")

    def focus() -> bool:
        b.navigate(html)
        time.sleep(0.5)
        w, h, rgb = osctl.capture_rgb()
        pad = osctl.find_color((34, 170, 102), tol=40, rgb=rgb, size=(w, h))
        if pad is None or pad["count"] < 20000:
            return False
        osctl.click(pad["x"], pad["y"])  # give the document keyboard focus
        time.sleep(0.2)
        return True

    A, B, C = 0x41, 0x42, 0x43
    check("focused the typing pad by pixels", focus())
    # Friction: a loop of chord releases Shift after each letter, so each commits
    # on its own keyup and only the final letter remains.
    for k in (A, B, C):
        osctl.chord(osctl.VK_SHIFT, k)
        time.sleep(0.05)
    time.sleep(0.2)
    check("a chord loop releases Shift between keys (3 separate commits)",
          b.eval("window.__commits") == 3, repr(b.eval("window.__commits")))
    check("the run never cohered under chord (only the last letter survived)",
          b.title() == "WORD:C", b.title())
    # Primitive: one sustained hold across the whole sequence commits once.
    check("re-focused the pad for the held sequence", focus())
    osctl.mod_taps(osctl.VK_SHIFT, keys=(A, B, C))
    time.sleep(0.2)
    check("mod_taps held Shift across the run (a single keyup commit)",
          b.eval("window.__commits") == 1, repr(b.eval("window.__commits")))
    check("the whole sequence cohered into one word (WORD:ABC)",
          b.title() == "WORD:ABC", b.title())


def round_glide(b: Browser, offline: bool) -> None:
    print("R94: OS-level glide — a button-less continuous mousemove path (F130) — osctl")
    # A path-dependent hover menu: the target only "opens" if the cursor's path
    # crossed the parent gate first (a nested-menu rule). A teleport (move) onto
    # the target skips the gate and never opens it; a glide traces the path
    # through the gate and opens it. The hover twin of drag.
    html = fixture("glide.html",
                   "<!doctype html><meta charset=utf-8><title>x</title>"
                   "<style>html,body{margin:0;height:100%}#g{position:fixed;"
                   "left:330px;top:120px;width:140px;height:300px;"
                   "background:#cc8800}#t{position:fixed;left:560px;top:120px;"
                   "width:140px;height:300px;background:#3366cc}</style>"
                   "<div id=g></div><div id=t></div><script>window.__moves=0;"
                   "window.__gate=0;addEventListener('mousemove',function(){"
                   "window.__moves++;});var g=document.getElementById('g'),"
                   "t=document.getElementById('t');g.addEventListener("
                   "'mouseenter',function(){window.__gate++;});"
                   "t.addEventListener('mouseenter',function(){"
                   "document.title=window.__gate>0?'REACHED':'SKIPPED';});"
                   "</script>")

    def fresh() -> tuple[int, int, int, int] | None:
        b.navigate(html)
        time.sleep(0.5)
        w, h, rgb = osctl.capture_rgb()
        gate = osctl.find_color((204, 136, 0), tol=40, rgb=rgb, size=(w, h))
        tgt = osctl.find_color((51, 102, 204), tol=40, rgb=rgb, size=(w, h))
        if gate is None or tgt is None:
            return None
        return gate["x"], gate["y"], tgt["x"], tgt["y"]

    pts = fresh()
    check("located the gate and target by pixels", pts is not None, repr(pts))
    if pts is None:
        return
    gx, gy, tx, ty = pts
    # Friction: a teleport jumps straight onto the target, skipping the gate —
    # the path is never traced, so the hover menu does not open.
    osctl.move(100, ty)
    time.sleep(0.1)
    osctl.move(tx, ty)
    time.sleep(0.3)
    check("a teleport skips the gate (no path) — menu stays shut (SKIPPED)",
          b.title() == "SKIPPED", b.title())
    check("a teleport crossed no gate (gate count 0)",
          b.eval("window.__gate") == 0, repr(b.eval("window.__gate")))
    tele_moves = b.eval("window.__moves")
    # Primitive: glide traces a continuous path that passes through the gate.
    pts = fresh()
    check("gate/target re-located for the glide", pts is not None, repr(pts))
    if pts is None:
        return
    gx, gy, tx, ty = pts
    osctl.glide(100, ty, tx, ty, steps=40)
    time.sleep(0.3)
    check("glide traced the path through the gate — menu opens (REACHED)",
          b.wait_for("document.title==='REACHED'", timeout=3), b.title())
    check("glide crossed the gate exactly on the way (gate count 1)",
          b.eval("window.__gate") == 1, repr(b.eval("window.__gate")))
    glide_moves = b.eval("window.__moves")
    check("glide emitted a continuous stream, the teleport did not",
          glide_moves > 10 and tele_moves <= 3,
          f"glide={glide_moves} teleport={tele_moves}")


def round_mod_drag(b: Browser, offline: bool) -> None:
    print("R93: OS-level mod_drag — a modifier held across the whole stroke (F129) — osctl")
    # A canvas drag where Shift constrains the handle to its starting Y (a
    # straight horizontal move). The dropzone sits horizontally from the handle,
    # but the endpoint passed to the drag overshoots upward in Y: a plain drag
    # follows the diagonal and misses; a Shift-drag locks Y and lands in it.
    # Drag twin of mod_click/mod_scroll.
    html = fixture("mod_drag.html",
                   "<!doctype html><meta charset=utf-8><title>drag</title>"
                   "<style>html,body{margin:0}</style>"
                   "<canvas id=c width=700 height=460 style='display:block'></canvas>"
                   "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
                   "var HX=80,HY=180,HW=90,HH=90,DX=520,DY=170,DW=140,DH=120;"
                   "function paint(hx,hy,ok){x.fillStyle='#ffffff';"
                   "x.fillRect(0,0,700,460);x.fillStyle=ok?'#00cc00':'#00cccc';"
                   "x.fillRect(DX,DY,DW,DH);x.fillStyle='#ff00ff';"
                   "x.fillRect(hx,hy,HW,HH);}var hx=HX,hy=HY,drag=null;"
                   "paint(hx,hy,false);window.__moves=0;window.__shift=0;"
                   "c.addEventListener('mousedown',function(e){if(e.button!==0)"
                   "return;var r=c.getBoundingClientRect();var px=e.clientX-r.left,"
                   "py=e.clientY-r.top;if(px>=hx&&px<=hx+HW&&py>=hy&&py<=hy+HH){"
                   "drag={dx:px-hx,dy:py-hy,sy:hy};window.__moves=0;"
                   "window.__shift=0;}});c.addEventListener('mousemove',"
                   "function(e){if(!drag)return;var r=c.getBoundingClientRect();"
                   "hx=e.clientX-r.left-drag.dx;var ny=e.clientY-r.top-drag.dy;"
                   "hy=e.shiftKey?drag.sy:ny;window.__moves++;if(e.shiftKey)"
                   "window.__shift++;paint(hx,hy,false);});"
                   "c.addEventListener('mouseup',function(e){if(!drag)return;"
                   "drag=null;var cx=hx+HW/2,cy=hy+HH/2;var ok=(cx>=DX&&cx<=DX+DW"
                   "&&cy>=DY&&cy<=DY+DH);paint(hx,hy,ok);"
                   "document.title=ok?'DROP-OK':'DROP-MISS';});</script>")

    def setup() -> tuple[int, int, int, int] | None:
        b.navigate(html)
        time.sleep(0.5)
        w, h, rgb = osctl.capture_rgb()
        handle = osctl.find_color((255, 0, 255), tol=40, rgb=rgb, size=(w, h))
        if handle is None or handle["count"] < 3000:
            return None
        # Endpoint overshoots upward in Y so only a Y-locked (Shift) stroke lands.
        return handle["x"], handle["y"], handle["x"] + 465, handle["y"] - 120

    pts = setup()
    check("located the magenta handle by pixels", pts is not None, repr(pts))
    if pts is None:
        return
    x0, y0, tx, ty = pts
    # Friction: a plain drag follows the diagonal endpoint and misses the zone,
    # and no move carried the modifier.
    osctl.drag(x0, y0, tx, ty, steps=28)
    time.sleep(0.3)
    check("a plain drag to the diagonal endpoint misses (DROP-MISS)",
          b.title() == "DROP-MISS", b.title())
    check("a plain drag carried no modifier (shift count 0)",
          b.eval("window.__shift") == 0, repr(b.eval("window.__shift")))
    # Primitive: Shift held across the stroke locks Y, so the same endpoint lands.
    pts = setup()
    check("handle re-located for the modifier stroke", pts is not None, repr(pts))
    if pts is None:
        return
    x0, y0, tx, ty = pts
    osctl.mod_drag(x0, y0, tx, ty, osctl.VK_SHIFT, steps=28)
    check("mod_drag with Shift constrains Y and lands in the zone (DROP-OK)",
          b.wait_for("document.title==='DROP-OK'", timeout=3), b.title())
    moves = b.eval("window.__moves")
    shift = b.eval("window.__shift")
    check("the stroke was continuous (moves>1)", moves > 1, repr(moves))
    check("Shift was held on every move of the stroke (not merely tapped)",
          shift == moves and moves > 1, f"shift={shift} moves={moves}")


def round_mod_scroll(b: Browser, offline: bool) -> None:
    print("R92: OS-level mod_scroll — a modifier held through the wheel (F128) — osctl")
    # A page treats Ctrl+wheel as zoom (adjusts __zoom, preventDefault) and a
    # plain wheel as ordinary scroll. A plain scroll leaves __zoom at 0; a
    # mod_scroll with Ctrl moves it. Wheel twin of mod_click.
    html = fixture("mod_scroll.html",
                   "<!doctype html><meta charset=utf-8><title>z</title>"
                   "<style>html,body{margin:0;height:3000px}#p{position:fixed;"
                   "left:60px;top:140px;width:260px;height:160px;"
                   "background:#7744cc}</style><div id=p></div><script>"
                   "window.__zoom=0;window.__plain=0;addEventListener('wheel',"
                   "function(e){if(e.ctrlKey){e.preventDefault();window.__zoom+="
                   "(e.deltaY<0?1:-1);document.title='Z'+window.__zoom;}else{"
                   "window.__plain++;}},{passive:false});</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    check("capture matches click coordinate space", (w, h) == osctl.screen_size(),
          f"{(w, h)} vs {osctl.screen_size()}")
    p = osctl.find_color((119, 68, 204), tol=40, rgb=rgb, size=(w, h))
    check("located the zoom pad by pixels",
          p is not None and p["count"] > 20000,
          str(p and {k: p[k] for k in ("x", "y", "count")}))
    if p is None:
        return
    # Friction: a plain scroll is read as ordinary scroll, never zoom.
    # A wide pause keeps notches from coalescing so the counts are stable.
    osctl.scroll(dy=-3, x=p["x"], y=p["y"], pause=0.05)
    time.sleep(0.3)
    plain_before = b.eval("window.__plain")
    check("a plain scroll never reaches the Ctrl+wheel zoom path",
          b.eval("window.__zoom") == 0 and plain_before >= 1,
          f"zoom={b.eval('window.__zoom')} plain={plain_before}")
    # Primitive: the modifier rides every notch, so the wheel becomes zoom.
    osctl.mod_scroll(3, 0, osctl.VK_CONTROL, x=p["x"], y=p["y"], pause=0.05)
    time.sleep(0.3)
    check("mod_scroll carries Ctrl through the wheel (zoom fired all 3 notches)",
          b.eval("window.__zoom") == 3, repr(b.eval("window.__zoom")))
    check("no mod_scroll notch leaked to the plain-scroll path",
          b.eval("window.__plain") == plain_before,
          f"{b.eval('window.__plain')} vs {plain_before}")
    check("title reflects the zoom level reached only via the modifier",
          b.title() == "Z3", b.title())
    # The modifier released afterward: a plain scroll again does not zoom.
    osctl.scroll(dy=-2, x=p["x"], y=p["y"])
    time.sleep(0.3)
    check("the modifier was released after mod_scroll (plain scroll again)",
          b.eval("window.__zoom") == 3, repr(b.eval("window.__zoom")))


def round_key_hold(b: Browser, offline: bool) -> None:
    print("R91: OS-level key_hold — a sustained key press (F127) — osctl")
    # A game-style control: ArrowRight held sets a flag; a 50ms interval advances
    # __pos while held. An instant tap accrues ~nothing; key_hold holds the key
    # down long enough for the integrator to accumulate. Keyboard twin of R90.
    html = fixture("key_hold.html",
                   "<!doctype html><meta charset=utf-8><title>0</title>"
                   "<style>html,body{margin:0;height:100%}#f{position:absolute;"
                   "left:0;top:0;width:300px;height:200px;background:#4488dd}"
                   "</style><div id=f></div><script>window.__pos=0;var held=false;"
                   "addEventListener('keydown',function(e){if(e.key==='ArrowRight'"
                   "){held=true;e.preventDefault();}});"
                   "addEventListener('keyup',function(e){if(e.key==='ArrowRight'){"
                   "held=false;}});setInterval(function(){if(held){window.__pos++;"
                   "document.title=String(window.__pos);}},50);</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    check("capture matches click coordinate space", (w, h) == osctl.screen_size(),
          f"{(w, h)} vs {osctl.screen_size()}")
    pad = osctl.find_color((68, 136, 221), tol=40, rgb=rgb, size=(w, h))
    check("located the focus pad by pixels",
          pad is not None and pad["count"] > 20000,
          str(pad and {k: pad[k] for k in ("x", "y", "count")}))
    if pad is None:
        return
    osctl.click(pad["x"], pad["y"])  # focus the page so key events land
    time.sleep(0.2)
    # Friction: an instant tap is down for ~0ms — the integrator never advances.
    osctl.tap(osctl.VK_RIGHT)
    time.sleep(0.4)
    base = b.eval("window.__pos")
    check("an instant tap accrues nothing on a held-key control",
          base == 0, repr(base))
    # Primitive: a sustained hold lets the time-in-state accumulate.
    osctl.key_hold(osctl.VK_RIGHT, duration=0.8)
    time.sleep(0.2)
    pos = b.eval("window.__pos")
    check("key_hold accrues many steps while the key is down",
          pos - base >= 5, f"delta={pos - base}")
    time.sleep(0.4)
    check("the key released after the hold (integrator stopped advancing)",
          b.eval("window.__pos") == pos, f"{b.eval('window.__pos')} vs {pos}")
    check("title reflects the accrued position",
          b.title() == str(pos) and pos > 0, f"title={b.title()} pos={pos}")


def round_press_hold(b: Browser, offline: bool) -> None:
    print("R90: OS-level press_hold — a sustained stationary press (F126) — osctl")
    # A button arms a 500ms timer on mousedown; releasing before it fires
    # cancels it. An instant click can never let the timer fire; press_hold
    # keeps the button down past the threshold so it confirms (green, CONFIRMED).
    html = fixture("press_hold.html",
                   "<!doctype html><meta charset=utf-8><title>idle</title>"
                   "<style>html,body{margin:0}#b{position:absolute;left:120px;"
                   "top:150px;width:240px;height:150px;background:#3366cc}</style>"
                   "<div id=b></div><script>window.__conf=0;var t=null;"
                   "var b=document.getElementById('b');"
                   "b.addEventListener('mousedown',function(){t=setTimeout("
                   "function(){window.__conf++;b.style.background='#11bb33';"
                   "document.title='CONFIRMED';},500);});"
                   "function cancel(){if(t){clearTimeout(t);t=null;}}"
                   "b.addEventListener('mouseup',cancel);"
                   "b.addEventListener('mouseleave',cancel);</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    check("capture matches click coordinate space", (w, h) == osctl.screen_size(),
          f"{(w, h)} vs {osctl.screen_size()}")
    btn = osctl.find_color((51, 102, 204), tol=40, rgb=rgb, size=(w, h))
    check("located the hold button by pixels",
          btn is not None and btn["count"] > 20000,
          str(btn and {k: btn[k] for k in ("x", "y", "count")}))
    if btn is None:
        return
    # Friction: an instant click releases before the timer fires.
    osctl.click(btn["x"], btn["y"])
    time.sleep(0.7)
    check("an instant click never confirms a press-and-hold control",
          b.title() != "CONFIRMED" and b.eval("window.__conf") == 0,
          f"title={b.title()} conf={b.eval('window.__conf')}")
    # Primitive: a sustained hold past the threshold confirms.
    osctl.press_hold(btn["x"], btn["y"], duration=0.8)
    check("press_hold holds long enough to confirm",
          b.wait_for("document.title==='CONFIRMED'", timeout=3), b.title())
    check("exactly one confirmation fired from the hold",
          b.eval("window.__conf") == 1, repr(b.eval("window.__conf")))
    time.sleep(0.3)
    green = osctl.find_color((17, 187, 51), tol=45)
    check("state change confirmed by pixels (button turned green)",
          green is not None and green["count"] > 20000,
          str(green and green.get("count")))
    # A short hold below the threshold still does not confirm (the line is real).
    b.navigate(html)
    time.sleep(0.4)
    btn2 = osctl.find_color((51, 102, 204), tol=40)
    osctl.press_hold(btn2["x"], btn2["y"], duration=0.15)
    time.sleep(0.7)
    check("a hold shorter than the threshold does not confirm",
          b.title() != "CONFIRMED" and b.eval("window.__conf") == 0,
          f"title={b.title()} conf={b.eval('window.__conf')}")


def round_triple_click(b: Browser, offline: bool) -> None:
    print("R89: OS-level triple_click — select a whole line/paragraph (F125) — osctl")
    # The click-multiplicity ladder: one click places the caret (empty
    # selection), double_click grabs the word under it, triple_click takes the
    # whole paragraph. Each gesture runs on a fresh load so the clicks do not
    # chain across gestures (three clicks at one point inside the OS window are
    # exactly what makes a triple).
    text = "alpha beta gamma delta epsilon zeta"
    html = ("<!doctype html><meta charset=utf-8><title>sel</title>"
            "<style>html,body{margin:0}#t{position:absolute;left:60px;top:170px;"
            "width:560px;background:#d8b14a;font:28px monospace;padding:18px}"
            "</style><p id=t>" + text + "</p>")
    fx = fixture("triple_click.html", html)

    def band_word_point():
        w, h, rgb = osctl.capture_rgb()
        band = osctl.find_color((216, 177, 74), tol=40, rgb=rgb, size=(w, h))
        return band, (w, h)

    b.navigate(fx)
    time.sleep(0.5)
    band, size = band_word_point()
    check("capture matches click coordinate space", size == osctl.screen_size(),
          f"{size} vs {osctl.screen_size()}")
    check("located the text band by pixels",
          band is not None and band["count"] > 20000,
          str(band and {k: band[k] for k in ("x", "y", "count")}))
    if band is None:
        return
    # A word sits left of centre; the centroid can land on a space.
    wx, wy = band["x"] - 220, band["y"]

    # Caret only: a single click selects nothing.
    osctl.click(wx, wy)
    time.sleep(0.2)
    check("a single click leaves the selection empty (caret only)",
          b.eval("window.getSelection().toString()") == "",
          repr(b.eval("window.getSelection().toString()")))

    # Word: double_click grabs exactly one token (the second rung).
    b.navigate(fx)
    time.sleep(0.4)
    osctl.double_click(wx, wy)
    time.sleep(0.2)
    sel2 = (b.eval("window.getSelection().toString()") or "").strip()
    check("double_click selects a single word, not the whole line",
          sel2 != "" and " " not in sel2 and sel2 in text and sel2 != text,
          repr(sel2))

    # Line/paragraph: triple_click takes the whole text (the third rung).
    b.navigate(fx)
    time.sleep(0.4)
    osctl.triple_click(wx, wy)
    time.sleep(0.2)
    sel3 = (b.eval("window.getSelection().toString()") or "").strip()
    check("triple_click selects the entire paragraph",
          sel3 == text, repr(sel3))
    check("triple_click reaches a rung double_click cannot (more than a word)",
          len(sel3) > len(sel2), f"{len(sel3)} vs {len(sel2)}")


def round_mod_click(b: Browser, offline: bool) -> None:
    print("R88: OS-level mod_click — Ctrl/Shift-click multi & range select (F124) — osctl")
    # Four items. A plain click selects one and drops the rest; Ctrl-click adds
    # one (toggles), Shift-click takes a contiguous range. The modifier must be
    # held while the mouse goes down so the page reads e.ctrlKey/e.shiftKey.
    # Each selected item shows a green inner block, so the count is also pixels.
    html = fixture("mod_click.html",
                   "<!doctype html><meta charset=utf-8><title>none</title>"
                   "<style>html,body{margin:0}.b{position:absolute;top:160px;"
                   "width:110px;height:110px}.m{position:absolute;top:185px;"
                   "width:60px;height:60px;background:#11bb33;display:none}"
                   ".on .m{display:block}</style><div id=wrap></div><script>"
                   "var cols=['#e6194b','#f58231','#4363d8','#911eb4'];"
                   "var lefts=[40,180,320,460];"
                   "var w=document.getElementById('wrap');window.__sel=[];var anchor=0;"
                   "for(var i=0;i<4;i++){var d=document.createElement('div');"
                   "d.className='b';d.style.left=lefts[i]+'px';"
                   "d.style.background=cols[i];d.dataset.i=i;"
                   "var m=document.createElement('div');m.className='m';"
                   "m.style.left=(lefts[i]+25)+'px';d.appendChild(m);w.appendChild(d);"
                   "d.addEventListener('click',function(e){var k=+this.dataset.i;"
                   "if(e.ctrlKey){var p=window.__sel.indexOf(k);"
                   "if(p<0)window.__sel.push(k);else window.__sel.splice(p,1);anchor=k;}"
                   "else if(e.shiftKey){var lo=Math.min(anchor,k),hi=Math.max(anchor,k);"
                   "window.__sel=[];for(var j=lo;j<=hi;j++)window.__sel.push(j);}"
                   "else{window.__sel=[k];anchor=k;}var on={};"
                   "window.__sel.forEach(function(v){on[v]=1;});"
                   "[].forEach.call(document.querySelectorAll('.b'),function(el){"
                   "el.className=on[+el.dataset.i]?'b on':'b';});"
                   "document.title=window.__sel.slice().sort(function(a,b){"
                   "return a-b;}).join(',')||'none';});}</script>")
    b.navigate(html)
    time.sleep(0.5)
    w, h, rgb = osctl.capture_rgb()
    check("capture matches click coordinate space", (w, h) == osctl.screen_size(),
          f"{(w, h)} vs {osctl.screen_size()}")
    cols = [(230, 25, 75), (245, 130, 49), (67, 99, 216), (145, 30, 180)]
    cen = [osctl.find_color(c, tol=40, rgb=rgb, size=(w, h)) for c in cols]
    check("located all four items by pixels",
          all(c is not None and c["count"] > 8000 for c in cen),
          str([c and c["count"] for c in cen]))
    if not all(cen):
        return
    pts = [(c["x"], c["y"]) for c in cen]
    osctl.click(*pts[0])
    time.sleep(0.2)
    check("a plain click selects exactly one item",
          b.title() == "0" and b.eval("window.__sel.length") == 1,
          f"title={b.title()}")
    # Friction: a plain click on another item drops the first.
    osctl.click(*pts[2])
    time.sleep(0.2)
    check("a second plain click replaces, not extends, the selection",
          b.title() == "2" and b.eval("window.__sel.length") == 1,
          f"title={b.title()}")
    # Primitive: Ctrl-click adds without dropping.
    osctl.mod_click(pts[0][0], pts[0][1], osctl.VK_CONTROL)
    time.sleep(0.2)
    check("Ctrl-click extends the selection to two items",
          b.title() == "0,2" and b.eval("window.__sel.length") == 2,
          f"title={b.title()}")
    # Primitive: Shift-click takes the contiguous range from the anchor.
    osctl.mod_click(pts[3][0], pts[3][1], osctl.VK_SHIFT)
    time.sleep(0.2)
    check("Shift-click selects the contiguous range to the anchor",
          b.title() == "0,1,2,3" and b.eval("window.__sel.length") == 4,
          f"title={b.title()}")
    time.sleep(0.2)
    green = osctl.find_color((17, 187, 51), tol=45)
    check("all four selections confirmed by pixels (four green markers)",
          green is not None and green["count"] > 11000,
          str(green and green.get("count")))
    # The modifiers were released: a plain click collapses to one again.
    osctl.click(*pts[1])
    time.sleep(0.2)
    check("a plain click after mod_click collapses to one (modifiers released)",
          b.title() == "1" and b.eval("window.__sel.length") == 1,
          f"title={b.title()}")


def main() -> int:
    offline = "--offline" in sys.argv
    b = Browser()
    rounds = [round_navigate_read, round_atomic_type, round_click_text, round_dialog,
              round_frame, round_file_input, round_shadow, round_async, round_omnibox,
              round_hover_menu, round_dnd, round_virtual_scroll, round_xorigin_iframe,
              round_canvas_pixel, round_ime_compose, round_color_blobs,
              round_template_match, round_settle, round_structure_match,
              round_scale_invariant, round_rotation_invariant, round_read_glyph,
              round_oop_iframe, round_new_tab, round_occlusion,
              round_native_select, round_contenteditable, round_file_drop,
              round_draw_path, round_paste_pipeline, round_context_menu,
              round_key_chord, round_per_key_type, round_wheel_pane,
              round_select_text, round_select_range, round_set_slider,
              round_closed_shadow, round_type_closed_shadow, round_marquee,
              round_ctrl_multi_select, round_shift_range_select,
              round_nested_submenu, round_drag_reorder,
              round_scroll_into_view, round_double_click,
              round_press_hold, round_zoom_pane, round_key_activate,
              round_key_step, round_triple_click, round_drag_by,
              round_middle_click, round_right_drag_by,
              round_tap, round_swipe, round_pinch, round_rotate,
              round_touch_hold, round_double_tap, round_two_finger_tap,
              round_touch_drag, round_two_finger_pan,
              round_three_finger_swipe, round_edge_swipe,
              round_touch_drag_to, round_read_text, round_read_kerned,
              round_read_block, round_read_words, round_read_glyph_conf,
              round_read_text_conf, round_detect_fg, round_palette,
              round_read_region, round_read_block_region,
              round_read_region_words, round_read_block_region_words,
              round_locate_word, round_locate_block_word,
              round_locate_phrase, round_wait_for_phrase, round_scroll,
              round_scroll_to_phrase, round_drag_stroke, round_double_click,
              round_middle_click, round_mod_click, round_triple_click,
              round_press_hold, round_key_hold, round_mod_scroll,
              round_mod_drag, round_glide, round_mod_taps,
              round_wait_until_stable, round_wait_for_change,
              round_region_diff]
    for r in rounds:
        try:
            r(b, offline)
        except Exception as e:
            check(r.__name__ + " (exception)", False, repr(e))
    b.close()

    passed = sum(1 for _, ok, _ in _results if ok)
    total = len(_results)
    print(f"\n=== {passed}/{total} checks passed ===")
    enc = sys.stdout.encoding or "ascii"
    for name, ok, detail in _results:
        if not ok:
            s = f"  FAILED: {name} :: {detail}"
            print(s.encode(enc, "backslashreplace").decode(enc))
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
