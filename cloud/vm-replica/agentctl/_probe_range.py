"""F072 probe: drag-select an *arbitrary* character range, not just a word.

`select_word`/`select_paragraph` (F071) only snap to whole words or blocks. When an
app needs a precise span — bold exactly "beta gamma", quote a half-sentence,
rename part of a label — neither granularity reaches it. A human presses on the
first glyph, drags to the last, releases; Chrome grows the Selection character by
character under the moving cursor. There is no `clickCount` for "two and a half
words". Reproduce that double-click can't isolate "beta gamma", then show
`select_range` pressing at one caret offset and releasing at another to grab
exactly that span.
"""
import http.server
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser

PAGE = (b"<!doctype html><meta charset=utf-8><title>range</title>"
        b"<p id=p style='font:16px monospace'>alpha beta gamma delta</p>"
        b"<script>window.__sel=function(){return String(getSelection());};"
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
    srv = serve(8996)
    try:
        b.navigate("http://127.0.0.1:8996/")
        time.sleep(0.2)
        # "alpha beta gamma delta" — select chars [6, 16) == "beta gamma".
        sel = b.select_range("#p", 6, 16)
        time.sleep(0.1)
        print("select_range returned:", repr(sel))
        print("getSelection:", repr(b.eval("window.__sel()")))
        print("absent target:", b.select_range("#nope", 0, 3))
    finally:
        srv.shutdown()
        b.close()


if __name__ == "__main__":
    main()
