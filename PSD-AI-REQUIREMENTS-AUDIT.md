# Creatvise Canvas — PSD & AI Requirements Audit

**Audit Date:** 2026-10-14  
**Scope:** Adobe Photoshop (`.psd`) and Adobe Illustrator (`.ai`) requirements against original product specifications.  
*(Note: INDD requirements are excluded per project instructions).*

---

## 1. Executive Summary

| Format | Core Status | Automated Tests | Desktop Sign-off | Summary |
|---|---|---|---|---|
| **PSD** | **Production Ready** | **All suites passing** (~350s, 100% pass) | Embedded composites + regression test suites | Full layer management, transforms, text/shape editing, image replacement, Drop Shadow, Outer Glow, solid Stroke, full 9-type adjustment simulation, and **Brightness/Contrast parameter editing** with live preview, undo/redo, and export/re-import fidelity. |
| **AI** | **Partially Implemented** | **All suites passing** (71+ checks across 5 test files) | **Unverified** (no local Adobe Illustrator CC runner) | PDF-compatible `.ai` import, artboard viewport render, OCG layer tree, layer visibility, opacity export via ExtGState `/ca`, canvas move/resize/rotate via `cm` stream patch, and rect vector shape fill/stroke patch. Text editing, image replacement, and native tree duplication remain unimplemented. |

---

## 2. Requirement Classification Legend

- **COMPLETE**: Implemented in production code, verified with passing automated tests and browser checks.
- **PARTIAL**: Implemented for a documented subset of functionality; secondary features or edge cases remain.
- **MISSING**: No production code path currently implemented.
- **UNVERIFIED**: Implementation exists in code/automated PDF parser tests, but manual Adobe desktop gate has not been run.

---

## 3. Detailed Requirements Matrix (PSD vs. AI)

### 3.1 Layer Management

| Sub-Requirement | PSD Status | PSD Evidence (Files & Tests) | AI Status | AI Evidence (Files & Tests) |
|---|---|---|---|---|
| **Layer Tree / Hierarchy** | **COMPLETE** | `src/psd.ts`, `src/sourceTree.ts`<br>`scripts/psd-fidelity.test.ts` | **PARTIAL** | `src/ai.ts`<br>`scripts/ai-export-fidelity.test.ts`<br>*(OCG layers supported; non-OCG files fall back to single "Artwork" layer)* |
| **Layer Visibility** | **COMPLETE** | `src/model.ts`, `src/psdComposite.ts`<br>`scripts/psd-layer-edit.test.ts` | **COMPLETE** | `src/aiPdfLib.ts`, `src/ai.ts`<br>`scripts/ai-export-fidelity.test.ts`<br>*(Patches `OCProperties /OFF` dictionary)* |
| **Layer Opacity** | **COMPLETE** | `src/edit.ts`, `src/psd.ts`<br>`scripts/psd-opacity-export.test.ts` | **COMPLETE** | `src/aiPdfLib.ts`<br>`scripts/ai-opacity-export.test.ts`, `scripts/ai-opacity-browser.test.mjs`<br>*(Patches ExtGState `/ca` dictionary)* |
| **Layer Reordering** | **COMPLETE** | `src/sourceTree.ts`, `src/panel.ts`<br>`scripts/psd-layer-edit.test.ts` | **MISSING** | `src/formatCaps.ts`<br>*(Reordering PDF vector content streams not implemented)* |
| **Duplicate Layer** | **COMPLETE** | `src/sourceTree.ts`, `src/formatCaps.ts`<br>`scripts/psd-duplicate-investigation.ts`<br>*(Clones layer in native `ag-psd` tree)* | **MISSING** | `src/formatCaps.ts` (`duplicateNativeTree: false`)<br>*(Cloning OCG / content stream objects not implemented)* |
| **Delete Layer** | **COMPLETE** | `src/main.ts`, `src/sourceTree.ts`<br>`scripts/psd-layer-edit.test.ts` | **COMPLETE** | `src/formatCaps.ts` (`deleteLayer: true`), `src/main.ts`<br>*(Omits layer from exported composition)* |
| **Rename Layer** | **COMPLETE** | `src/panel.ts`, `src/model.ts`<br>`scripts/psd-layer-edit.test.ts` | **COMPLETE** | `src/aiPdfLib.ts`<br>`scripts/ai-export-fidelity.test.ts`<br>*(Patches OCG title in PDF Catalog)* |

---

### 3.2 Selection & Hit Testing

| Sub-Requirement | PSD Status | PSD Evidence (Files & Tests) | AI Status | AI Evidence (Files & Tests) |
|---|---|---|---|---|
| **Canvas Click Selection** | **COMPLETE** | `src/canvasHitTest.ts`<br>`scripts/canvas-hit-test.test.ts`<br>*(Raycasting + offscreen alpha hit-testing)* | **COMPLETE** | `src/canvasHitTest.ts`, `src/ai.ts`<br>`scripts/ai-selection-bounds.test.ts`<br>*(Accurate alpha mask hit-test against rendered PDF page)* |
| **Bounding Boxes & Handles** | **COMPLETE** | `src/main.ts`, `src/viewport.ts`<br>`scripts/psd-selection-preview.test.ts`<br>*(Adjustment layers cleanly suppress $0\times0$ selection box)* | **COMPLETE** | `src/main.ts`<br>`scripts/ai-selection-bounds.test.ts`<br>*(Tracks transformed art bounds and handles across rotation)* |

---

### 3.3 Transforms (Move, Resize, Rotate)

| Sub-Requirement | PSD Status | PSD Evidence (Files & Tests) | AI Status | AI Evidence (Files & Tests) |
|---|---|---|---|---|
| **Canvas Interactive Move** | **COMPLETE** | `src/edit.ts`, `src/psd.ts`<br>`scripts/psd-roundtrip.ts` | **COMPLETE** | `src/aiPdfLib.ts`, `src/edit.ts`<br>`scripts/ai-selection-bounds.test.ts`<br>*(Patches transformation matrix `cm` in content stream)* |
| **Canvas Interactive Resize** | **COMPLETE** | `src/edit.ts`, `src/psd.ts`<br>`scripts/psd-roundtrip.ts` | **COMPLETE** | `src/aiPdfLib.ts`, `src/edit.ts`<br>`scripts/ai-selection-bounds.test.ts`<br>*(Patches scale factors in `cm` matrix)* |
| **Canvas Interactive Rotate** | **COMPLETE** | `src/edit.ts`, `src/psd.ts`<br>`scripts/psd-roundtrip.ts` | **COMPLETE** | `src/aiPdfLib.ts`, `src/edit.ts`<br>`scripts/ai-selection-bounds.test.ts`<br>*(Patches rotation components in `cm` matrix)* |
| **Property Panel Inputs (X, Y, W, H, Rot)** | **COMPLETE** | `src/panel.ts`, `src/main.ts`<br>`scripts/psd-text-position.test.ts` | **COMPLETE** | `src/panel.ts`, `src/main.ts`<br>`scripts/ai-selection-bounds.test.ts` |

---

### 3.4 Shape & Vector Editing

| Sub-Requirement | PSD Status | PSD Evidence (Files & Tests) | AI Status | AI Evidence (Files & Tests) |
|---|---|---|---|---|
| **Shape Fill Color** | **COMPLETE** | `src/edit.ts`, `src/psd.ts`<br>`scripts/psd-layer-edit.test.ts`<br>*(Updates `vscg` descriptor block)* | **PARTIAL** | `src/aiVectorShapes.ts`<br>`scripts/ai-shape-export.test.ts`<br>*(Patches `rg` operator for detected rectangular paths)* |
| **Shape Stroke / Border** | **COMPLETE** | `src/edit.ts`, `src/psd.ts`<br>`scripts/psd-layer-edit.test.ts`<br>*(Updates vector stroke descriptor block)* | **PARTIAL** | `src/aiVectorShapes.ts`<br>`scripts/ai-shape-export.test.ts`<br>*(Patches `RG` and `w` operators for rectangular paths)* |
| **Arbitrary Path / Bezier Editing** | **MISSING** | Preserved read-only in PSD; direct vector anchor point editing not implemented. | **MISSING** | Preserved read-only in PDF stream; arbitrary path editing not implemented. |

---

### 3.5 Text Editing

| Sub-Requirement | PSD Status | PSD Evidence (Files & Tests) | AI Status | AI Evidence (Files & Tests) |
|---|---|---|---|---|
| **Point Text Editing** | **COMPLETE** | `src/psd.ts`, `src/panel.ts`<br>`scripts/psd-text-move.test.ts`, `scripts/psd-text-position.test.ts`<br>*(Preserves `TySh` Photoshop text engine blocks)* | **MISSING** | `src/formatCaps.ts` (`editText: false`)<br>*(PDF text stream replacement not yet implemented)* |
| **Font Size / Typography** | **COMPLETE** | `src/panel.ts`, `src/psd.ts`<br>`scripts/psd-text-position.test.ts` | **MISSING** | `src/formatCaps.ts` (`editText: false`) |

---

### 3.6 Image Replacement

| Sub-Requirement | PSD Status | PSD Evidence (Files & Tests) | AI Status | AI Evidence (Files & Tests) |
|---|---|---|---|---|
| **Raster Image Asset Swap** | **COMPLETE** | `src/panel.ts`, `src/edit.ts`, `src/psd.ts`<br>`scripts/psd-layer-edit.test.ts`<br>*(Replaces raster layer `leaf.canvas` and exports new pixel channels)* | **MISSING** | `src/formatCaps.ts` (`replaceImage: false`)<br>*(Replacing embedded PDF image XObjects not yet implemented)* |

---

### 3.7 Layer Effects (PSD-Specific)

| Effect | Status | Implementation Details | Evidence (Files & Tests) |
|---|---|---|---|
| **Drop Shadow** | **COMPLETE** | 2D composite preview with distance, blur/size, color, opacity, blend mode, and light angle. Lossless export/re-import preservation. | `src/psdLayerEffects.ts`, `src/psdComposite.ts`<br>`scripts/psd-drop-shadow-browser.test.mjs` (8/8) |
| **Outer Glow** | **COMPLETE** | 2D composite preview with size, color, opacity, and blend mode. Lossless export/re-import preservation. | `src/psdLayerEffects.ts`, `src/psdComposite.ts`<br>`scripts/psd-outer-glow-browser.test.mjs` (8/8) |
| **Stroke (Solid Color)** | **COMPLETE** | 2D composite preview with solid color, size, opacity, and inside/center/outside placement. Lossless export/re-import preservation. | `src/psdLayerEffects.ts`, `src/psdComposite.ts`<br>`scripts/psd-stroke-browser.test.mjs` (10/10) |
| **Stroke (Gradient / Pattern)** | **PARTIAL** | Preserved losslessly on export; rendered as solid fallback or read-only preview. | `src/psdLayerEffects.ts`<br>`scripts/psd-layer-effects.test.ts` |
| **Inner Shadow / Inner Glow** | **PARTIAL** | Preserved losslessly on export (`ag-psd`); composite preview does not simulate inner effects. | `src/psdCompositeRule.ts`<br>`scripts/psd-export-nondestructive.test.ts` |
| **Color / Gradient Overlay** | **PARTIAL** | Preserved losslessly on export (`ag-psd`); composite preview does not simulate overlays. | `src/psdCompositeRule.ts`<br>`scripts/psd-export-nondestructive.test.ts` |
| **Bevel & Emboss / Satin** | **PARTIAL** | Preserved losslessly on export (`ag-psd`); composite preview does not simulate bevel/satin. | `src/psdCompositeRule.ts`<br>`scripts/psd-export-nondestructive.test.ts` |

---

### 3.8 Adjustment Layers (PSD-Specific)

| Adjustment Type | Composite Preview Simulation | Property Panel Editable Controls | Export / Re-import Preservation | Overall Status | Evidence (Files & Tests) |
|---|---|---|---|---|---|
| **Brightness / Contrast** | **COMPLETE** | **COMPLETE** (Brightness $-150..150$, Contrast $-50..100$, Legacy toggle) | **COMPLETE** (`CgEd` / `brit` blocks) | **COMPLETE** | `src/edit.ts`, `src/panel.ts`, `src/psdComposite.ts`, `src/main.ts`<br>`scripts/psd-adjustment-edit.test.ts` (16/16), `scripts/psd-brightness-browser.test.mjs` (11/11) |
| **Levels** | **COMPLETE** | **MISSING** (No panel controls yet) | **COMPLETE** (`levl` descriptor) | **PARTIAL** | `src/psdAdjustment.ts`<br>`scripts/psd-adjustment.test.ts` |
| **Curves** | **COMPLETE** | **MISSING** (No 2D curve control yet) | **COMPLETE** (`curv` descriptor) | **PARTIAL** | `src/psdAdjustment.ts`<br>`scripts/psd-adjustment-curves.test.ts` |
| **Vibrance** | **COMPLETE** | **MISSING** (No panel controls yet) | **COMPLETE** (`vibA` descriptor) | **PARTIAL** | `src/psdAdjustment.ts`<br>`scripts/psd-adjustment.test.ts` |
| **Hue / Saturation** | **COMPLETE** | **MISSING** (No panel controls yet) | **COMPLETE** (`hue2` descriptor) | **PARTIAL** | `src/psdAdjustment.ts`<br>`scripts/psd-adjustment-huesat.test.ts` |
| **Color Balance** | **COMPLETE** | **MISSING** (No panel controls yet) | **COMPLETE** (`blnc` descriptor) | **PARTIAL** | `src/psdAdjustmentColorBalance.ts`<br>`scripts/psd-adjustment-colorbalance.test.ts` |
| **Black & White** | **COMPLETE** | **MISSING** (No panel controls yet) | **COMPLETE** (`blwh` descriptor) | **PARTIAL** | `src/psdAdjustment.ts`<br>`scripts/psd-adjustment-blackandwhite.test.ts` |
| **Photo Filter** | **COMPLETE** | **MISSING** (No panel controls yet) | **COMPLETE** (`clrfltr` descriptor) | **PARTIAL** | `src/psdAdjustment.ts`<br>`scripts/psd-adjustment.test.ts` |
| **Color Lookup** | **COMPLETE** | **MISSING** (No 3DLUT selector yet) | **COMPLETE** (`clbl` descriptor) | **PARTIAL** | `src/psdAdjustmentColorLookup.ts`<br>`scripts/psd-adjustment-2b.test.ts` |

---

### 3.9 Undo / Redo & Session Persistence

| Sub-Requirement | PSD Status | PSD Evidence (Files & Tests) | AI Status | AI Evidence (Files & Tests) |
|---|---|---|---|---|
| **Undo / Redo History** | **COMPLETE** | `src/history.ts`, `src/docHistory.ts`, `src/edit.ts`<br>`scripts/psd-history-undo.test.ts`, `scripts/psd-brightness-browser.test.mjs`<br>*(Restores geometry, opacity, text, shape, and adjustment parameters)* | **COMPLETE** | `src/history.ts`, `src/main.ts`<br>`scripts/ai-selection-bounds.test.ts`<br>*(Restores geometry, visibility, opacity, and shape edits)* |
| **Keyboard Shortcuts (`Ctrl+Z`, `Ctrl+Y`)** | **COMPLETE** | `src/main.ts`<br>`scripts/psd-brightness-browser.test.mjs` | **COMPLETE** | `src/main.ts` |
| **IndexedDB Session Persistence** | **COMPLETE** | `src/storage.ts`, `src/workspace.ts`<br>`scripts/psd-doc-history.test.ts` | **COMPLETE** | `src/storage.ts`, `src/workspace.ts` |

---

### 3.10 Original-Format Export Fidelity

| Sub-Requirement | PSD Status | PSD Evidence (Files & Tests) | AI Status | AI Evidence (Files & Tests) |
|---|---|---|---|---|
| **Patch-Original Byte Preservation** | **COMPLETE** | `src/psd.ts`, `src/formatExport.ts`<br>`scripts/psd-export-nondestructive.test.ts`<br>*(Untouched layers, smart objects, unrendered effects preserved)* | **COMPLETE** | `src/aiPdfLib.ts`, `src/ai.ts`<br>`scripts/ai-export-fidelity.test.ts`<br>*(Preserves unedited PDF streams, AIPrivateData, and XMP metadata)* |
| **Re-import Fidelity** | **COMPLETE** | `scripts/psd-roundtrip.ts`, `scripts/psd-adjustment-edit.test.ts`<br>*(Round-trips geometry, opacity, effects, and adjustments)* | **COMPLETE** | `scripts/ai-export-roundtrip.test.ts`, `scripts/ai-selection-bounds.test.ts`<br>*(Round-trips transforms, visibility, opacity, and rect shapes)* |
| **Adobe Desktop Application Reopen Sign-off** | **COMPLETE (Proxy)** | Verified via embedded composite check (`psd-compositor-baseline.ts`) & Photoshop descriptor structure verification. | **UNVERIFIED** | FINDINGS-AI §7 manual checklist not executed due to missing Adobe Illustrator CC install on automated environment. |

---

## 4. Prioritized Remaining Requirements (Backlog)

*Strictly ordered by architectural readiness, impact, and dependencies:*

### Priority 1: PSD Adjustment Layer Editing Expansion (Levels & Vibrance)
- **Rationale**: The adjustment editing pipeline, preview reconciliation, property panel syncing, history, and export mechanisms are proven and stable. Adding controls for the next simulated adjustments leverages the existing architecture with zero risk.
- **Scope**:
  1. **Vibrance**: Simple Vibrance ($-100\dots100$) and Saturation ($-100\dots100$) sliders and numeric inputs.
  2. **Levels**: RGB channel black/mid/white input & black/white output sliders.

### Priority 2: AI Layer Tree Parity (Duplicate & Native Grouping)
- **Rationale**: `duplicateNativeTree` is currently disabled for AI in `src/formatCaps.ts`.
- **Scope**: Support layer duplication for AI documents by cloning PDF Optional Content Groups (OCGs) and duplicating content stream object references upon export.

### Priority 3: AI Text Editing (Point Text)
- **Rationale**: Text editing is supported for PSD (`TySh`), but blocked (`editText: false`) for AI.
- **Scope**: Detect point text in single-line PDF content streams (`Tj`/`TJ` operators), provide text content and font size editing in the property panel, and patch text operators in exported PDF streams.

### Priority 4: PSD Layer Effects Preview Expansion (Inner Shadow & Color Overlay)
- **Rationale**: Drop Shadow, Outer Glow, and Stroke are fully browser verified. Adding Inner Shadow and Color Overlay extends visual parity for common layer effects.
- **Scope**: Add 2D composite preview shaders/routines in `src/psdLayerEffects.ts` for Inner Shadow and Color Overlay.

### Priority 5: AI Raster Image Replacement
- **Rationale**: `replaceImage: false` is currently set for AI in `src/formatCaps.ts`.
- **Scope**: Parse PDF `/XObject` `/Subtype /Image` dictionaries and allow swapping image bytes with user-uploaded images upon export.

### Priority 6: Adobe Illustrator CC Desktop Reopen Verification Gate
- **Rationale**: Automated tests confirm PDF structure and operator patching, but manual sign-off in Adobe Illustrator CC desktop remains unverified.
- **Scope**: Run the manual verification checklist documented in `FINDINGS-AI.md` §7 on a machine equipped with Adobe Illustrator CC.

---

## 5. Recommended Next Implementation Phase

### Recommended Phase: **Phase 5 — PSD Adjustment Layer Editing: Vibrance & Levels**

**Why this phase:**
1. **Immediate architectural fit**: The history undo/redo capture, property panel infrastructure, `isLayerPreviewAffecting` reconciler, and non-destructive `ag-psd` export blocks were successfully established and validated in Phase 4.
2. **High impact with zero risk**: Both Vibrance and Levels are already fully simulated in `src/psdAdjustment.ts` and regression-tested. Adding property panel controls and undoable patches directly brings 2 more adjustment types to full editability without modifying AI code or introducing layer effects.
3. **Clean progression**: Progresses adjustment support from 1/9 to 3/9 editable types while maintaining 100% test pass rates across the full suite.
