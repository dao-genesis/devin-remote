"""Probe (F141): why does the leftmost glyph of a multi-colour region misread on
this Linux box? Reproduces R75 scene B (RED/GRN/BLU), then dumps the segmentation
cells, each cell's classification, and the leading glyph's distance to every atlas
label.

Finding — it is NOT font rasterisation; it is harness geometry. The R75 fixtures
locate the white "field" with find_color_blobs(white), which on a window WIDER than
the canvas is the whole viewport (~280px wider than the 1300px canvas when the
window is maximised at 1600). The fixture then insets a fixed fraction (width/16
here, width/8 in palette) from each side — and on the oversized field that left
inset lands inside the left-aligned first word, clipping its leading glyph.

Run it maximised (1600 wide): the leading 'R' is captured ~30px (left stem clipped)
and reads 'L' -> 'LEDGRNBLU'. Run it with the window sized to the canvas (~1320
wide): the leading 'R' is captured ~42px and matches 'R' at Hamming distance ~5 ->
'REDGRNBLU'. The 27 OCR deltas are this one effect; nothing in the floor or the
perception primitives is wrong. (wmctrl -ir <chrome> -e 0,0,0,1320,1040 to size.)"""
import os, sys, time, tempfile
from browser import Browser
import osctl
from osctl import edge_signature, edge_hamming, palette, segment_run

FIX = tempfile.mkdtemp(prefix="diag_")
def fixture(name, html):
    p = os.path.join(FIX, name)
    open(p, "w", encoding="utf-8").write(html)
    return "file:///" + p.replace("\\", "/")

def hx(s):
    s = s.lstrip("#"); return (int(s[0:2],16), int(s[2:4],16), int(s[4:6],16))

b = Browser()
MAG = (255,0,255); WHT="#ffffff"
RED,GRN,BLU = "#d32020","#1f9d35","#1565c0"
chars = "OKGREDNBLU"
draws = "".join("x.fillText('%s',%d,80);" % (ch,24+i*96) for i,ch in enumerate(chars))
b.navigate(fixture("rr_atlas.html",
   "<!doctype html><title>atlas</title><style>html,body{margin:0}</style>"
   "<canvas id=c width=1000 height=140></canvas><script>"
   "var x=document.getElementById('c').getContext('2d');"
   "x.fillStyle='#fff';x.fillRect(0,0,1000,140);"
   "x.fillStyle='#f0f';x.font='bold 80px monospace';"
   "x.textAlign='left';x.textBaseline='middle';"+draws+"</script>"))
time.sleep(0.5)
aw,ah,argb = osctl.capture_rgb()
ab = sorted(osctl.find_color_blobs(MAG,tol=60,rgb=argb,size=(aw,ah),min_count=120),key=lambda t:t["x"])
print("atlas blobs:", len(ab))
atlas = {chars[i]: edge_signature(argb,(aw,ah),ab[i]["bbox"]) for i in range(len(chars))}

b.navigate(fixture("rr_three.html",
   "<!doctype html><title>p3</title><style>html,body{margin:0}body{background:#fff}</style>"
   "<canvas id=c width=1300 height=300></canvas><script>"
   "var x=document.getElementById('c').getContext('2d');"
   "x.fillStyle='#fff';x.fillRect(0,0,1300,300);"
   "x.font='bold 80px monospace';x.textBaseline='middle';x.textAlign='left';"
   "x.fillStyle='%s';x.fillText('RED',80,150);"
   "x.fillStyle='%s';x.fillText('GRN',540,150);"
   "x.fillStyle='%s';x.fillText('BLU',1000,150);</script>" % (RED,GRN,BLU)))
time.sleep(0.4)
w,h,rgb = osctl.capture_rgb()
sz=(w,h)
bls = osctl.find_color_blobs(hx(WHT),tol=30,rgb=rgb,size=sz,min_count=5000)
x0,y0,x1,y1 = max(bls,key=lambda t:t["count"])["bbox"]
frac=16; iw,ih=(x1-x0)//frac,(y1-y0)//8
bb=(x0+iw,y0+ih,x1-iw,y1-ih)
print("field bbox:", (x0,y0,x1,y1), "-> cropped:", bb)
pal = palette(rgb,sz,bb)
print("palette:", pal)
inks = pal[1:]
cells=[]
for ink in inks:
    runs = segment_run(rgb,sz,bb,ink,60,2)
    print("ink",ink,"-> %d cells"%len(runs), [c for c in runs])
    for c in runs:
        cells.append((c[0],c,ink))
cells.sort(key=lambda t:t[0])
out=""
for left,c,ink in cells:
    g = osctl.read_glyph(rgb,sz,c,atlas)
    out+=g
    # leading-glyph deep dive
    if left==cells[0][0]:
        sig=edge_signature(rgb,sz,c)
        scored=sorted((edge_hamming(atlas[k],sig),k) for k in atlas)
        print("LEADING cell",c,"ink",ink,"-> '%s'"%g,"top3:",scored[:3],"on=",sum(sig))
print("read_region =", repr(out))
