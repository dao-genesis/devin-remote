"""F066 probe: paste into an editor that transforms on the paste pipeline.

Many editors intercept `paste` to transform content (sanitize HTML, turn a bare
URL into a link chip, convert markdown). Writing text directly (type_text /
set_editable) never runs that pipeline, so the transform never happens.
Reproduce, then show `paste_into` dispatching a real paste with a DataTransfer.
"""
import http.server
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser

PAGE = (b"<!doctype html><meta charset=utf-8><title>paste</title>"
        b"<div id=e contenteditable style='border:1px solid #000;min-height:40px'></div>"
        b"<script>var e=document.getElementById('e');window.__pasted=0;"
        b"e.addEventListener('paste',function(ev){ev.preventDefault();"
        b"  window.__pasted++;"
        b"  var t=(ev.clipboardData||window.clipboardData).getData('text/plain');"
        b"  window.__seen=t;"
        b"  if(/^https?:\\/\\//.test(t)){var a=document.createElement('a');"
        b"    a.href=t;a.textContent='[link]';e.appendChild(a);}"
        b"  else{e.appendChild(document.createTextNode(t));}});"
        b"</script>")


def serve(port):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(PAGE)))
            self.end_headers()
            self.wfile.write(PAGE)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    b = Browser()
    srv = serve(8984)
    try:
        b.navigate("http://127.0.0.1:8984/")
        time.sleep(0.2)
        # Friction: set_editable writes text directly; the paste handler that turns
        # a URL into a chip never runs.
        b.set_editable("#e", "https://example.com")
        time.sleep(0.1)
        print("after set_editable pasted count:", b.eval("window.__pasted||0"))
        print("after set_editable html:", repr(b.eval("document.getElementById('e').innerHTML")))
        # Primitive: paste_into dispatches a real paste with a DataTransfer.
        b.eval("document.getElementById('e').innerHTML='';window.__pasted=0;true")
        ok = b.paste_into("#e", "https://example.com")
        time.sleep(0.1)
        print("paste_into returned:", ok)
        print("paste fired count:", b.eval("window.__pasted||0"))
        print("handler saw text:", repr(b.eval("window.__seen")))
        print("transformed html:", repr(b.eval("document.getElementById('e').innerHTML")))
        print("absent target ->", b.paste_into("#nope", "x"))
    finally:
        srv.shutdown()
        b.close()


if __name__ == "__main__":
    main()
