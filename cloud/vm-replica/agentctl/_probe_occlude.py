"""F061 probe — a click swallowed by an invisible overlay.

We compute an element's center and synthesize a click there. But a fixed overlay
(cookie banner, sticky header, transparent modal scrim) covers that point, so the
trusted click lands on the OVERLAY, not the target. A human sees the overlay and
deals with it; our click silently does nothing to the intended control.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser
import http.server
import threading


def serve(port, body):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


PAGE = b"""<!doctype html><meta charset=utf-8><title>occlude</title>
<style>
  #t{position:absolute;left:60px;top:200px;width:160px;height:48px}
  /* a transparent fixed scrim covering the whole viewport, like a modal/cookie
     wall that visually lets the button show through but eats every click */
  #scrim{position:fixed;inset:0;background:rgba(0,0,0,0.001);z-index:9999}
</style>
<button id=t onclick="window.__hit=(window.__hit||0)+1">CONFIRM</button>
<div id=scrim onclick="window.__scrim=(window.__scrim||0)+1"></div>
"""


def main():
    b = Browser()
    s = serve(8941, PAGE)
    try:
        b.navigate("http://127.0.0.1:8941/")
        time.sleep(0.2)
        c = b._center_of("#t")
        print("center of button:", c)
        # what does the browser actually hit at that point?
        top = b.eval(f"(function(){{var e=document.elementFromPoint({c['x']},{c['y']});"
                     f"return e?e.id||e.tagName:null;}})()")
        print("elementFromPoint at center ->", top)
        # Primitive: hit-verified click refuses to fire into the overlay.
        hp = b._hit_point_of("#t")
        print("hitPoint (full overlay):", hp)
        clicked = b.click("#t")
        time.sleep(0.2)
        print("click() returned:", clicked)
        print("button hit count:", b.eval("window.__hit||0"))
        print("FRICTION:", "fully occluded, click refused" if (clicked is False and b.eval("window.__hit||0") == 0) else "UNEXPECTED")

        # Now partial occlusion: shrink the scrim to cover only the top half.
        b.eval("document.getElementById('scrim').style.top='0px';"
               "document.getElementById('scrim').style.height='224px';"
               "document.getElementById('scrim').style.bottom='auto';true")
        hp2 = b._hit_point_of("#t")
        print("hitPoint (top half covered):", hp2)
        clicked2 = b.click("#t")
        time.sleep(0.2)
        print("click() returned:", clicked2, "button hit:", b.eval("window.__hit||0"))
        print("PRIMITIVE:", "found clear lower point" if (clicked2 and b.eval("window.__hit||0") == 1) else "FAILED")
    finally:
        s.shutdown()


if __name__ == "__main__":
    main()
