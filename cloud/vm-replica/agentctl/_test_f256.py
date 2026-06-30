"""F256 — cluster_boxes: group boxes into discovered classes with no library.

The unsupervised sibling of classify_boxes. classify_boxes/classify_grid answer
*what* each box is, but only once you have harvested a labelled template per
class. On a board whose alphabet you do not know in advance you cannot -- a
mid-game chess position, an unfamiliar mahjongg tileset, the change-regions of a
never-seen game offer no known frame to crop labels from. But the cheaper
question the library hand-rolling was always answering -- *which boxes look the
same?* -- needs no labels. F254 already hand-rolled this leader-clustering loop
inline for mahjongg (seed a library on first sight, start a new entry when the
best match exceeds a radius); this is that loop made a primitive, sharing the
exact pixel core (_box_signature) so a clustering and a later classification of
the same boxes agree pixel-for-pixel.

Pure-Python, no display: cluster_boxes is self-contained pixel maths, so the
test paints buffers and asserts on the cluster ids directly. The sprites are
drawn on *different background shades* so the test proves what matters -- that
the same shape clusters together across backgrounds (the chess piece on a light
vs a dark square), which over-splits only when the merge radius is set too tight.
"""
import osctl


def _draw(buf, w, cx, cy, shape, ink=(20, 20, 20)):
    """Paint one sprite centred on (cx, cy) with both ink and background inside
    the inset window, so the ink gate trips and the signature has contrast: a
    vertical bar, a horizontal bar, or a hollow ring."""
    def px(xx, yy):
        i = (yy * w + xx) * 3
        buf[i], buf[i + 1], buf[i + 2] = ink

    if shape == "vbar":
        for yy in range(cy - 14, cy + 14):
            for xx in range(cx - 5, cx + 6):
                px(xx, yy)
    elif shape == "hbar":
        for yy in range(cy - 5, cy + 6):
            for xx in range(cx - 14, cx + 14):
                px(xx, yy)
    elif shape == "ring":
        for yy in range(cy - 13, cy + 14):
            for xx in range(cx - 13, cx + 14):
                if xx < cx - 7 or xx > cx + 7 or yy < cy - 7 or yy > cy + 7:
                    px(xx, yy)


def _fillbg(buf, w, box, v):
    x0, y0, x1, y1 = box
    for yy in range(y0, y1 + 1):
        for xx in range(x0, x1 + 1):
            i = (yy * w + xx) * 3
            buf[i] = buf[i + 1] = buf[i + 2] = v


def main():
    w, h = 260, 200
    tw = th = 40
    light, dark = 205, 185  # two square shades, like a chessboard

    # Scatter two of each shape, deliberately split across the two backgrounds:
    # vbar on dark then light, hbar on light then dark, ring on dark then light.
    # A correct clustering must group by *shape* and ignore the background.
    placed = [
        ("vbar", 30, 30, dark), ("hbar", 90, 30, light), ("ring", 150, 30, dark),
        ("vbar", 210, 30, light), ("hbar", 30, 110, dark), ("ring", 110, 110, light),
    ]
    buf = bytearray(bytes((200,)) * (w * h * 3))
    boxes = []
    for shape, cx, cy, bgv in placed:
        box = (cx - tw // 2, cy - th // 2, cx + tw // 2 - 1, cy + th // 2 - 1)
        _fillbg(buf, w, box, bgv)
        _draw(buf, w, cx, cy, shape)
        boxes.append(box)
    buf = bytes(buf)

    # 1) the default merge radius groups by shape, ignoring background, with ids
    #    in first-appearance order (first box is cluster 0). The interleaving
    #    vbar/hbar/ring,vbar/hbar/ring must come back [0,1,2,0,1,2] -- so the
    #    second vbar (on the *opposite* background) lands in cluster 0, not a new
    #    one. This is the chess "same piece, different square" invariant.
    ids = osctl.cluster_boxes(boxes, rgb=buf, size=(w, h))
    assert ids == [0, 1, 2, 0, 1, 2], f"group by shape, bg-invariant: {ids}"

    # 2) the radius is a real knob: too tight and the background variation alone
    #    splits a shape into per-background clusters (here every box becomes its
    #    own), while a wide plateau is stable. Mirrors the live chess result
    #    (12 classes across a broad range, over-split only at a tiny radius).
    tight = osctl.cluster_boxes(boxes, rgb=buf, size=(w, h), max_score=4)
    assert len(set(tight)) == 6, f"tight radius over-splits by background: {tight}"
    for ms in (16, 32, 48):
        plateau = osctl.cluster_boxes(boxes, rgb=buf, size=(w, h), max_score=ms)
        assert plateau == [0, 1, 2, 0, 1, 2], f"plateau ms={ms}: {plateau}"

    # 3) a blank box (no ink, gated out before scoring) is the blank sentinel,
    #    never clustered -- and the sentinel is configurable.
    eb = bytes(bytes((200,)) * (w * h * 3))
    blank_box = [(200, 150, 200 + tw - 1, 150 + th - 1)]  # an empty corner
    mixed = [boxes[0], blank_box[0], boxes[2]]
    g = osctl.cluster_boxes(mixed, rgb=buf, size=(w, h))
    assert g[1] == -1, f"blank box -> -1 sentinel, never clustered: {g}"
    assert g[0] == 0 and g[2] == 1, f"blanks don't consume cluster ids: {g}"
    gb = osctl.cluster_boxes(blank_box, rgb=eb, size=(w, h), blank=-9)
    assert gb == [-9], f"blank sentinel is configurable: {gb}"

    # 4) deterministic and order-stable: same input, same output every call.
    assert osctl.cluster_boxes(boxes, rgb=buf, size=(w, h)) == ids, "non-deterministic"

    # 5) parity with classify_boxes: cluster, then harvest one exemplar per
    #    discovered cluster (labelled by its id) into a template library and
    #    classify_boxes the same boxes -- they share the one pixel core, so the
    #    rediscovered labels must reproduce the clustering exactly. This is the
    #    "cluster to discover the alphabet, then classify with it" workflow.
    first_box = {}
    for cid, box in zip(ids, boxes):
        first_box.setdefault(cid, box)
    templates = []
    for cid, box in sorted(first_box.items()):
        patch, pw, ph = osctl.crop_rgb(buf, (w, h), box)
        templates.append((str(cid), patch, pw, ph))
    labels = osctl.classify_boxes(boxes, templates, rgb=buf, size=(w, h))
    assert labels == [str(i) for i in ids], \
        f"classify with cluster exemplars reproduces clustering: {labels} vs {ids}"

    # 6) empty box list returns [], and arg validation mirrors classify_boxes.
    assert osctl.cluster_boxes([], rgb=buf, size=(w, h)) == []
    bad = [
        dict(boxes=boxes, inset=0.5),
        dict(boxes=boxes, ink_min=0),
        dict(boxes=boxes, norm=0),
        dict(boxes=boxes, max_score=-1),
        dict(boxes=[(1, 2, 3)]),                       # box not a 4-tuple
        dict(boxes=boxes, rgb=buf, size=None),         # rgb without size
    ]
    for kw in bad:
        try:
            osctl.cluster_boxes(**kw)
            assert False, f"expected ValueError for {kw}"
        except ValueError:
            pass

    print("F256 OK: cluster_boxes groups boxes into discovered classes with no "
          "library (leader clustering on the shared signature core), is "
          "background-invariant on a wide radius plateau and over-splits only "
          "when the radius is set too tight, ids in first-appearance order, "
          "blanks gated to a configurable sentinel, deterministic, reproduces "
          "its grouping when its exemplars are fed back to classify_boxes, and "
          "validates args")


if __name__ == "__main__":
    main()
