"""F067 probe: a custom right-click (contextmenu) menu.

Web apps (file managers, editors, data grids) replace the OS menu with their own
DOM menu, shown on the `contextmenu` event. A left `click` never raises it; the
menu stays hidden and its items are unreachable. Reproduce, then show
`context_click` dispatching a real right-button press that Chrome surfaces as a
`contextmenu` event at the target's hit point.
"""
import http.server
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser import Browser

PAGE = (b"<!doctype html><meta charset=utf-8><title>ctx</title>"
        b"<div id=t style='width:160px;height:100px;background:#cde'>row</div>"
        b"<ul id=m style='display:none;position:fixed'><li id=del>Delete</li></ul>"
        b"<script>var t=document.getElementById('t'),m=document.getElementById('m');"
        b"window.__ctx=0;"
        b"t.addEventListener('click',function(){window.__left=(window.__left||0)+1;});"
        b"t.addEventListener('contextmenu',function(e){e.preventDefault();"
        b"  window.__ctx++;m.style.display='block';"
        b"  m.style.left=e.clientX+'px';m.style.top=e.clientY+'px';});"
        b"document.getElementById('del').addEventListener('click',function(){"
        b"  window.__deleted=true;m.style.display='none';});"
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
    srv = serve(8991)
    try:
        b.navigate("http://127.0.0.1:8991/")
        time.sleep(0.2)
        # Friction: a left click never raises the contextmenu menu.
        b.click_text("row")
        time.sleep(0.1)
        print("after left click: ctx=", b.eval("window.__ctx||0"),
              "menu visible=", b.eval("getComputedStyle(document.getElementById('m')).display"))
        # Primitive: context_click fires a real right-button contextmenu.
        ok = b.context_click("#t")
        time.sleep(0.15)
        print("context_click returned:", ok)
        print("ctx fired:", b.eval("window.__ctx||0"))
        print("menu visible:", b.eval("getComputedStyle(document.getElementById('m')).display"))
        # And the menu item is now clickable.
        b.click_text("Delete")
        time.sleep(0.1)
        print("deleted:", b.eval("window.__deleted||false"))
        print("absent target ->", b.context_click("#nope"))
    finally:
        srv.shutdown()
        b.close()


if __name__ == "__main__":
    main()
