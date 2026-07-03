# Operating discipline for agents driving this floor

The floor exists to beat the screenshot→reason→click loop on cost as
well as capability. The rules below are the token-economy distilled
from the F-series arcs (see JOURNAL.md, esp. F195, F231, F365, F367).

## The priced perception ladder

Climb from the cheap end; only a rung's *failure* promotes you.

1. **Window titles** (`list_windows`) — near-free. Programs narrate
   state through them (`Untitled` → `Untitled *` → filename).
2. **`screen_observe()`** — one a11y scan; windows + focus + named
   actionable controls of the foreground window. Decision-ready text.
3. **Region OCR / atlas reads** (`ocr_text`, `read_text`, whitelisted)
   — pixels, but only the pixels that matter, returned as text.
4. **Full-frame vision** — last resort, for surfaces that draw
   everything and name nothing (KCalc's display, SDL games).

## Rules

- Do not save full-screen PNGs and re-read them through the vision
  channel as a routine checkpoint. That is the official loop's cost
  profile. Screenshots are for humans and for genuinely opaque
  surfaces.
- Verify on the artifact floor whenever one exists: files, dpkg,
  process state, clipboard bytes. It is cheaper *and* truer than any
  pixel (F364: a wizard can close without doing anything).
- Batch an entire act (perceive → act → verify) into one python
  invocation instead of one process per step; imports and X
  connections are paid once.
- Capture regions (`capture_patch`, `crop_rgb`), never the root
  window, when pixels are unavoidable. Note: capture space is the
  real root resolution, not any scaled screenshot you may have saved.
- Let receipts be text: titles, `screen_observe` diffs, OCR strings,
  file bytes. An image should appear in the record only when it *is*
  the evidence.
