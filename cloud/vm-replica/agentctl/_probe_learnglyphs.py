"""Live proof for F198 — learn_glyphs: build a glyph atlas from a region whose
text is *already known* (a live rendering), then read *different*, unknown drawn
text in that same font purely from pixels. This closes the R-next frontier: the
perception ladder no longer needs a hand-built fixture atlas — a known on-screen
rendering teaches the reader to read the rest.

Surface: a Chrome <canvas> (a real app drawing text with NO DOM node — the exact
"drawn, not in the tree" target). Three runs in one monospace font:
  teacher  = 'DAOFLOOR2197'  (the run whose string we know -> atlas)
  student  = 'ROOF1729'      (different text, all glyphs subset of teacher)
  student2 = 'ZONE17'        (holds Z,N,E the atlas was never taught)
The atlas is learned ONLY from the teacher's pixels; the readers then touch only
pixels. read_text must return the student exactly; read_text_conf must mark the
untaught glyphs rather than fabricate them.
"""
import sys
import time

sys.path.insert(0, ".")
import osctl
from browser import Browser

BG = (192, 192, 192)   # page background (distinct from the white canvas)
INK = (0, 0, 0)        # black text
TEACHER = "DAOFLOOR2197"
STUDENT = "ROOF1729"
STUDENT2 = "ZONE17"


def _canvas_html():
    lines = [(TEACHER, 90), (STUDENT, 220), (STUDENT2, 350)]
    draws = "".join("x.fillText('%s',24,%d);" % (s, y) for s, y in lines)
    return (
        "data:text/html,"
        "<!doctype html><title>atlas</title>"
        "<style>html,body{margin:0;background:%23c0c0c0}</style>"
        "<canvas id=c width=760 height=440></canvas><script>"
        "var x=document.getElementById('c').getContext('2d');"
        "x.fillStyle='%23fff';x.fillRect(0,0,760,440);"
        "x.fillStyle='%23000';x.font='bold 64px monospace';"
        "x.textBaseline='top';x.textAlign='left';" + draws + "</script>"
    )


def main():
    b = Browser()
    b.navigate(_canvas_html())
    time.sleep(1.0)
    w, h, rgb = osctl.capture_rgb()
    sz = (w, h)

    # locate the white canvas field on screen, inset slightly off its border
    blobs = osctl.find_color_blobs((255, 255, 255), tol=20, rgb=rgb, size=sz,
                                   min_count=4000)
    if not blobs:
        print("FAIL: no white canvas field found on screen")
        return 1
    fx0, fy0, fx1, fy1 = max(blobs, key=lambda t: t["count"])["bbox"]
    ins = 4
    field = (fx0 + ins, fy0 + ins, fx1 - ins, fy1 - ins)

    bands = osctl.segment_lines(rgb, sz, field, INK, tol=80, gap=6)
    print("text bands found:", len(bands))
    if len(bands) < 3:
        print("FAIL: expected 3 text lines, got", len(bands))
        return 1
    t_band, s_band, s2_band = bands[0], bands[1], bands[2]

    passed = 0
    total = 5

    # [1] build the atlas from the teacher's LIVE rendering (string known)
    atlas = osctl.learn_glyphs(rgb, sz, t_band, TEACHER, fg=INK)
    uniq = set(c for c in TEACHER if not c.isspace())
    ok1 = set(atlas.keys()) == uniq
    print("[1] learn_glyphs from live teacher -> %d glyphs %s" % (len(atlas), sorted(atlas)),
          "PASS" if ok1 else "FAIL")
    passed += ok1

    # [2] CORE: read the *unknown* student run from pixels with the learned atlas
    got = osctl.read_text(rgb, sz, s_band, atlas, INK, tol=80)
    ok2 = got == STUDENT
    print("[2] read unknown student via learned atlas -> %r (want %r)" % (got, STUDENT),
          "PASS" if ok2 else "FAIL")
    passed += ok2

    # [3] auto-recover ink colour (omit fg) -> detect_fg -> identical read
    atlas_auto = osctl.learn_glyphs(rgb, sz, t_band, TEACHER)  # fg=None
    got_auto = osctl.read_text(rgb, sz, s_band, atlas_auto, INK, tol=80)
    ok3 = got_auto == STUDENT and len(atlas_auto) == len(uniq)
    print("[3] auto-fg learn+read -> %r" % got_auto, "PASS" if ok3 else "FAIL")
    passed += ok3

    # [4] honesty: a run holding untaught glyphs (Z,N,E) is MARKED, not faked
    conf = osctl.read_text_conf(rgb, sz, s2_band, atlas, INK, tol=80,
                                max_dist=0.6, conf_k=1.6, unknown="?")
    # taught glyphs (O,1,7) should still read; untaught (Z,N,E) should be '?'
    ok4 = "?" in conf and conf.count("?") >= 2 and "1" in conf and "7" in conf
    print("[4] read_text_conf on untaught run -> %r" % conf, "PASS" if ok4 else "FAIL")
    passed += ok4

    # [5] alignment guard: a label longer than the run can possibly hold -> {}
    bad = osctl.learn_glyphs(rgb, sz, t_band, "X" * 40, fg=INK)
    ok5 = bad == {}
    print("[5] over-long label refused (no mislabeled atlas) -> %r" % (bad == {}),
          "PASS" if ok5 else "FAIL")
    passed += ok5

    print("\nF198 learn_glyphs: %d/%d PASS" % (passed, total))
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
