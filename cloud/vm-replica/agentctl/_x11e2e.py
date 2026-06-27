"""End-to-end check of the X11 prototype against the live Chrome."""
import os, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _x11proto as o
from browser import Browser

def fixture(name, html):
    p = os.path.join(tempfile.gettempdir(), name)
    open(p, "w", encoding="utf-8").write(html)
    return "file://" + p

def find_color(target, tol, rgb, w, h):
    tr, tg, tb = target; sx=sy=n=0; stride=w*3
    for y in range(h):
        row=y*stride
        for x in range(w):
            i=row+x*3
            if abs(rgb[i]-tr)<=tol and abs(rgb[i+1]-tg)<=tol and abs(rgb[i+2]-tb)<=tol:
                sx+=x; sy+=y; n+=1
    if not n: return None
    return (sx//n, sy//n, n)

b = Browser()
VK_CONTROL, VK_V, VK_A = 0x11, 0x56, 0x41

# 1) pixel click
html = fixture("_x11_box.html",
  "<!doctype html><meta charset=utf-8><title>box</title><style>html,body{margin:0}"
  "#sq{position:absolute;left:200px;top:200px;width:160px;height:120px;background:#ff00ff}</style>"
  "<div id=sq></div><input id=q style='position:absolute;left:200px;top:400px;width:300px'>"
  "<script>document.getElementById('sq').addEventListener('click',()=>document.title='HIT');</script>")
b.navigate(html); time.sleep(0.4)
w,h,rgb = o.capture_rgb()
hit = find_color((255,0,255),40,rgb,w,h)
print("magenta centroid", hit)
assert hit and hit[2]>500, "magenta not found"
o.click(hit[0], hit[1])
time.sleep(0.3)
print("title after click:", b.title(), "(expect HIT)")
assert b.title()=="HIT"

# 2) unicode typing
b.eval("var q=document.getElementById('q');q.value='';q.focus();")
time.sleep(0.1)
o.type_unicode("hello 中文 123")
time.sleep(0.2)
val = b.eval("document.getElementById('q').value")
print("typed value:", repr(val))
assert val=="hello 中文 123", val

# 3) clipboard paste
o.set_clipboard("paste-载荷-42")
time.sleep(0.2)
b.eval("var q=document.getElementById('q');q.value='';q.focus();")
time.sleep(0.1)
# Ctrl+A then Ctrl+V
o.key_down(VK_CONTROL); o.key_down(VK_A); o.key_up(VK_A); o.key_up(VK_CONTROL)
time.sleep(0.05)
o.key_down(VK_CONTROL); o.key_down(VK_V); o.key_up(VK_V); o.key_up(VK_CONTROL)
time.sleep(0.3)
val2 = b.eval("document.getElementById('q').value")
print("pasted value:", repr(val2))
assert val2=="paste-载荷-42", val2

print("ALL X11 E2E CHECKS PASSED")
