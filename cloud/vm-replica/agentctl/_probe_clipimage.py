"""F203 — the **image clipboard** (CF_DIB): the third clipboard tongue.

F202 gave the floor the *file* clipboard; the clipboard's third native format is a
**bitmap**. When an app does "Copy" of a picture — a chart from a spreadsheet, a
region from a screenshot tool, a selection in an image editor — the payload is an
image (`CF_DIB`), invisible to both the text clipboard (`get_clipboard()`→"") and
the file clipboard (`get_clipboard_files()`→[]). The floor could neither *see* such
a copy nor *originate* one to paste into Paint / a document. This proves:

  1. friction — with an image on the clipboard, text and file channels are both empty;
  2. ``get_clipboard_image(path)`` materialises an image an *external* app copied as a
     PNG the floor's own perception can read (correct dimensions + sampled colour);
  3. ``set_clipboard_image(path)`` originates one, and it round-trips pixel-exact.

Run: ``C:\\devin\\python\\python.exe _probe_clipimage.py``
"""
import os
import sys
import tempfile
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
import osctl

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")


base = tempfile.mkdtemp(prefix="daoimg_")
try:
    # ---- our own image, set -> get, pixel-exact round trip --------------------
    W, H = 5, 4
    pat = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (0, 255, 255),
           (255, 0, 255), (10, 20, 30), (40, 50, 60), (70, 80, 90), (100, 110, 120),
           (130, 140, 150), (160, 170, 180), (190, 200, 210), (1, 2, 3), (4, 5, 6),
           (7, 8, 9), (11, 22, 33), (44, 55, 66), (77, 88, 99), (123, 231, 132)]
    src_rgb = b"".join(bytes(c) for c in pat)
    src = os.path.join(base, "made.png")
    with open(src, "wb") as f:
        f.write(osctl._png(W, H, src_rgb))

    check("set_clipboard_image() originates a bitmap on the clipboard",
          osctl.set_clipboard_image(src))
    # with an image present, text and file clipboards are blind (the friction)
    check("friction: text + file clipboards are blind to a copied image",
          osctl.get_clipboard() == "" and osctl.get_clipboard_files() == [],
          f"text={osctl.get_clipboard()!r} files={osctl.get_clipboard_files()}")
    out = os.path.join(base, "got.png")
    got = osctl.get_clipboard_image(out)
    check("get_clipboard_image() materialises it as a PNG", got == out and os.path.exists(out))
    if got:
        w, h, rgb = osctl._decode_png_rgb(open(out, "rb").read())
        check("round-trip is pixel-exact (dims + every pixel)",
              (w, h) == (W, H) and rgb == src_rgb, f"dims=({w},{h})")

    # ---- an EXTERNAL app copies an image; the floor must SEE it ---------------
    # Windows PowerShell (STA) builds a solid-colour bitmap and Clipboard.SetImage.
    EW, EH = 40, 24
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
        f"$b=New-Object System.Drawing.Bitmap {EW},{EH};"
        "$g=[System.Drawing.Graphics]::FromImage($b);"
        "$g.Clear([System.Drawing.Color]::FromArgb(18,52,86));"
        "[System.Windows.Forms.Clipboard]::SetImage($b);"
    )
    subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], check=False)
    ext = os.path.join(base, "ext.png")
    p = osctl.get_clipboard_image(ext)
    check("get_clipboard_image() reads an image copied by an external app", bool(p))
    if p:
        w, h, rgb = osctl._decode_png_rgb(open(ext, "rb").read())
        mid = ((h // 2) * w + w // 2) * 3
        sampled = (rgb[mid], rgb[mid + 1], rgb[mid + 2])
        check("external image has the right dimensions and colour",
              (w, h) == (EW, EH) and sampled == (18, 52, 86),
              f"dims=({w},{h}) centre={sampled}")
finally:
    import shutil
    shutil.rmtree(base, ignore_errors=True)

print(f"\n==== {len(PASS)} PASS / {len(FAIL)} FAIL ====")
sys.exit(1 if FAIL else 0)
