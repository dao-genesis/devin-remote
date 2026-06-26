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
              round_press_hold]
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
