# PSD canvas selection UX — Stage 2 investigation

## Why the large artwork layer wins hit-tests

Canvas picking in `main.ts` uses `hitTest(sx, sy)`:

1. Walk documents top-to-bottom (stack order).
2. For each doc, iterate `leaves(doc).reverse()` — **topmost paint order first**.
3. First leaf that passes `canvasPickTarget`, visibility, opacity, bounds, and **alpha > 8** on the local canvas wins.

Full-document fills (≥99% width/height) are excluded in `isPsdCanvasPickTarget`, but **large non-full layers** (e.g. ~90% of the frame) remain fully eligible. Any click in the puzzle area hits that layer before lower layers are considered.

**Re-select without changing hit order:** If a layer is already selected and the pointer-down is inside `pointInNode` for that layer, move starts on **that** layer even when a larger layer sits above elsewhere — but a click **outside** the selection box on the puzzle still runs `hitTest` and can switch to the large raster.

**Panel selection** bypasses spatial hit-test and is the reliable way to select small upper/lower bands.

## Proposed low-risk improvements (review before implementation)

| Option | Behavior | Pros | Cons |
|--------|----------|------|------|
| **A. Smallest-area tie-break** | At `(x,y)`, collect all pickable hits; prefer the **smallest bbox area** among hits (or smallest canvas area). | Clicks on overlapping art favor text/badges over full-frame rasters; no layer disabled. | Clicks on empty margin of large layer may select a smaller layer underneath; needs alpha test on all candidates. |
| **B. Cycle pick (Alt+click or repeated click)** | First click = topmost; next click same spot cycles through hit stack. | Matches Photoshop muscle memory. | Discoverability; implementation + UI hint. |
| **C. “Active layer lock”** | While a layer is selected, optional **lock selection** mode: canvas hits only move selection if inside `pointInNode(selected)`; otherwise pan or no-op. | Prevents accidental layer switch mid-edit. | Extra toggle; pan-only when clicking outside selection. |
| **D. Status / hover hint** | On pointer move (no drag), show **which layer would be selected** in the status bar. | No policy change; reduces surprise. | Does not fix wrong pick alone. |
| **E. Large-layer pick threshold (panel only default)** | Layers with `w*h > k × doc area` (e.g. k=0.25) are **not** canvas-pick targets unless already selected or chosen from panel. | Stops accidental puzzle drags. | **Restricts** legitimate canvas move of large layers unless selected first — requires explicit product approval. |

**Implemented:** **D** — status bar shows `Would select: …` on hover (`main.ts` + shared `canvasHitTest.ts`). Click/drag selection unchanged.

**Recommended next (review before coding):** **A** — see proposal below. **B** as follow-up. Defer **E** unless product accepts “select large layers from panel first.”

---

## Proposal: smallest-area hit selection (A) — not implemented

### Behavior

At document point `(x,y)`, collect every leaf that would pass today’s gates (`isCanvasPickTarget`, visibility, effective opacity, bounds, alpha > 8). If multiple hits, return the leaf with the **smallest axis-aligned bounds area** (`w × h`); tie-break by paint order (topmost among equals).

### Implementation sketch

- Add `hitTestCanvasLayerSmallestArea(ctx, sx, sy)` beside existing top-first `hitTestCanvasLayer` (keep top-first for hover “current behavior” until A ships, or switch both click + hover together after review).
- Single pass: iterate leaves top-first, accumulate candidates, pick min area; or bottom-first collect all then reduce.

### Benefits

- Clicks on overlapping opaque art favor badges, text bands, and icons over large effect rasters.
- No layer disabled; panel selection unchanged.

### Risks

| Risk | Detail |
|------|--------|
| **Overlap intent** | User clicking a large layer’s interior (meant to select that layer) may get a smaller layer underneath if the top layer has a soft edge or semi-transparent pixel (alpha > 8). |
| **Nested groups** | Only **leaves** are tested today; smallest-area among leaves matches current flat stack, but group names never appear in hit-test (unchanged). |
| **Large partial layers** | Deliberate selection of a big raster may require panel first or clicking a region with no smaller hit — same as today for empty margins. |
| **Multi-document** | Must run per doc front-to-back; first doc with any candidate wins (preserve current doc ordering). |
| **Hover vs click** | If hover stays top-first but click uses A, status bar misleads — **must update both** when A lands. |

### Tests to add with A

- Re-run `canvas-hit-test.test.ts` with A enabled: overlap case expects **small** (already top-first today); add case where top is large semi-transparent hole and bottom small opaque — top-first vs A differ.
- Fixture: puzzle center with A might select smaller clip layer if one exists under cursor.

### Rollout

1. Review this proposal.  
2. Implement A behind one code path used by click **and** hover.  
3. Optional setting “Prefer smaller layers under cursor” default on for PSD only.

## Ghost removal (unchanged by Stage 2)

- Root cause remains **file-base-overlay** (embedded merge + dirty overlay).
- Approximate erasure is **not** enabled (`scripts/psd-ghost-erase-experiment.ts`).
- Future options: validated `displayBase`, full-stack overlay with clip chain, or export-time truth in Photoshop.
