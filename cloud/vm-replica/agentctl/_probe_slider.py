"""F073 probe: set a custom slider to a precise value.

A custom slider (volume/brightness/price-range UI built from <div>s) has no
`.value` to set and no native scrollbar. It listens to pointerdown on the thumb,
then pointermove along the track, mapping the cursor's fraction of the track
width to a value. `set_value` (F00x) throws / no-ops (no value property). A single
`click` at the track centre snaps it to 50% only — you cannot reach 73 by
clicking. A human presses the thumb and drags it to the right fraction of the
track. Reproduce: set_value fails, click only reaches ~50, then show a press +
drag along the track lands an arbitrary value.
"""
import http.server
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser

PAGE = (b"<!doctype html><meta charset=utf-8><title>slider</title>"
        b"<div id=track style='position:absolute;left:40px;top:80px;width:200px;"
        b"height:8px;background:#ccc'>"
        b"<div id=thumb style='position:absolute;left:0;top:-6px;width:20px;"
        b"height:20px;background:#08f;border-radius:50%'></div></div>"
        b"<div id=out>0</div>"
        b"<script>(function(){"
        b"var track=document.getElementById('track'),thumb=document.getElementById('thumb'),"
        b"out=document.getElementById('out'),W=200,drag=false;"
        b"function setFromX(cx){var r=track.getBoundingClientRect();"
        b"var f=Math.max(0,Math.min(1,(cx-r.left)/W));"
        b"thumb.style.left=(f*W-10)+'px';var v=Math.round(f*100);"
        b"out.textContent=v;window.__val=v;}"
        b"thumb.addEventListener('pointerdown',function(e){drag=true;e.preventDefault();});"
        b"window.addEventListener('pointermove',function(e){if(drag)setFromX(e.clientX);});"
        b"window.addEventListener('pointerup',function(){drag=false;});"
        b"window.__val=0;})();</script>")


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
    srv = serve(8997)
    try:
        b.navigate("http://127.0.0.1:8997/")
        time.sleep(0.2)
        try:
            print("set_value on a div slider:", b.set_value("#thumb", "73"))
        except Exception as e:
            print("set_value on a div slider raised:", type(e).__name__, str(e)[:60])
        print("val after set_value:", b.eval("window.__val"))
        # A click at the thumb start does nothing useful.
        b.click("#track")
        time.sleep(0.05)
        print("val after a plain click:", b.eval("window.__val"))
        # What we want: a primitive that lands an arbitrary fraction.
        # Manual drag along the track: press thumb (~left), drag to 0.73 of 200px.
        print("set_slider to 0.73:", b.set_slider("#thumb", "#track", 0.73))
        time.sleep(0.1)
        print("val after set_slider(0.73):", b.eval("window.__val"))
        print("set_slider to 0.20:", b.set_slider("#thumb", "#track", 0.20))
        time.sleep(0.1)
        print("val after set_slider(0.20):", b.eval("window.__val"))
        print("set_slider absent thumb:", b.set_slider("#nope", "#track", 0.5))
    finally:
        srv.shutdown()
        b.close()


if __name__ == "__main__":
    main()
