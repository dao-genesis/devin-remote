"""F071 probe: selecting text (a word / a paragraph), not just placing a caret.

Formatting toolbars, "copy selection", highlight/annotate, and define-on-select
popovers all key off a *non-collapsed* Selection. A single `click` collapses the
caret to a zero-width point — `getSelection().toString()` is empty — so the Bold
button stays disabled and no popover appears. A human double-clicks to grab a
word, triple-clicks for the whole line/paragraph. Chrome makes that selection only
when the mouse press carries `clickCount` 2 or 3. Reproduce the empty selection
after a plain click, then show `select_word`/`select_paragraph` producing a real
selection that flips the toolbar on.
"""
import http.server
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser

PAGE = (b"<!doctype html><meta charset=utf-8><title>select</title>"
        b"<p id=p style='font:16px monospace'>alpha beta gamma delta</p>"
        b"<button id=bold disabled>Bold</button>"
        b"<script>document.addEventListener('selectionchange',function(){"
        b"var s=String(getSelection());"
        b"document.getElementById('bold').disabled=(s.length===0);"
        b"window.__sel=s;});window.__sel='';</script>")


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
    srv = serve(8995)
    try:
        b.navigate("http://127.0.0.1:8995/")
        time.sleep(0.2)
        # Friction: a plain click collapses the caret, no selection, Bold disabled.
        b.click("#p")
        time.sleep(0.1)
        print("after click: sel=", repr(b.eval("window.__sel||''")),
              "bold_disabled=", b.eval("document.getElementById('bold').disabled"))
        # Primitive: double-click selects the word under the point.
        ok = b.select_word("#p")
        time.sleep(0.1)
        print("select_word returned:", ok)
        print("after select_word: sel=", repr(b.eval("window.__sel||''")),
              "bold_disabled=", b.eval("document.getElementById('bold').disabled"))
        # Triple-click selects the whole paragraph.
        ok2 = b.select_paragraph("#p")
        time.sleep(0.1)
        print("select_paragraph returned:", ok2)
        print("after select_paragraph: sel=", repr(b.eval("window.__sel||''")))
    finally:
        srv.shutdown()
        b.close()


if __name__ == "__main__":
    main()
