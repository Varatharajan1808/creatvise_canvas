# Adobe Photoshop (.psd) — Engine Specification & Deep Dive

> Comprehensive architectural reference for Adobe Photoshop (`.psd`) parsing, dynamic 2D compositing, real-time adjustment layer simulation, canvas hit-testing, and non-destructive patch export in Creatvise Canvas.

---

## 1. Executive Summary

Creatvise Canvas implements a production-ready, browser-first engine for Adobe Photoshop (`.psd`) files. Rather than flattening documents into simple static images or regenerating the complex binary PSD format from scratch, the system operates on a **non-destructive "patch-original" pipeline**:

- **Native Fidelity**: Documents open on Photoshop's embedded merged composite (`fileComposite`) whenever possible, ensuring 100% pixel parity with Adobe Photoshop upon import.
- **Dynamic Footprint Patching**: When layers are moved, transformed, or restyled, the engine patches only the affected layer's import footprint via `file-base-overlay` mode, keeping untouched regions 100% faithful to Photoshop's native rasterizer.
- **Real-Time Adjustment Layers**: Nine Photoshop adjustment types are simulated on the GPU/CPU in real time, with exact mathematical models for curves, levels, vibrance, photo filter, 3D LUT color lookup, hue/saturation, color balance, black & white, and brightness/contrast.
- **Non-Destructive Export**: Edits are surgically patched back into the in-memory `ag-psd` data structure. Smart objects, unmodeled vector masks, proprietary descriptors, and layer effects remain 100% preserved.

---

## 2. File Ingestion & Parsing (`src/psd.ts`)

### Library: `ag-psd`
PSD parsing and serialization are driven by `ag-psd` configured to retain composite images, layer thumbnails, mask channels, and resource blocks:

```typescript
const psd = readPsd(buffer, {
  skipCompositeImageData: false,
  skipLayerImageData: false,
  skipThumbnail: true,
  loadMethod: 'all',
});
```

### Document Model Translation
Upon read, the raw `ag-psd` layer hierarchy is translated into Creatvise Canvas's unified `Doc` and `Node` scene graph (`src/model.ts`):

```
ag-psd Root
├── Layer 1 (Smart Object)      ──> Node (type: 'raster', leaf.canvas, protected)
├── Group: Adjustments          ──> Node (type: 'group', children: [...])
│   ├── Curves 1                ──> Node (type: 'adjustment', subtype: 'curves')
│   └── Vibrance 1              ──> Node (type: 'adjustment', subtype: 'vibrance')
├── Layer 2 (Text)              ──> Node (type: 'text', leaf.text, leaf.fontSize)
└── Background (Raster)         ──> Node (type: 'raster', leaf.canvas)
```

Each `Node` maintains:
- `id`: Unique node identifier.
- `name`: Layer name (displayed in the Layers panel).
- `type`: `'raster' | 'text' | 'shape' | 'adjustment' | 'group'`.
- `x`, `y`, `width`, `height`: Layer bounding box in canvas coordinates.
- `opacity`: Normalized layer opacity ($0.0 \dots 1.0$).
- `visible`: Boolean visibility toggle.
- `blendMode`: Photoshop blend mode string (`'normal' | 'multiply' | 'screen' | ...`).
- `sourceLayer`: Pointer to the underlying raw `ag-psd` layer object for lossless re-export.
- `leaf`: Raster canvas, vector fill parameters, text attributes, or adjustment settings.

---

## 3. Dual-Mode Preview Engine (`src/psdComposite.ts`, `src/psdCompositeRule.ts`)

Photoshop files contain complex features (smart filters, gradient map overlays, complex vector clipping paths) that cannot be perfectly reproduced by a naive 2D canvas stack. Creatvise Canvas solves this with a **dual-mode composite strategy**:

```
                  ┌─────────────────────────────────────┐
                  │          Import PSD Buffer          │
                  └──────────────────┬──────────────────┘
                                     │
                  ┌──────────────────▼──────────────────┐
                  │ Does document have valid, non-blank │
                  │     fileComposite from Photoshop?   │
                  └─────────┬─────────────────┬─────────┘
                            │ Yes             │ No / Stale
            ┌───────────────▼───────────────┐ ┌─────────▼─────────┐
            │  Check unsupported features: │ │ Fall back to 2D   │
            │  - Layer effects (glow/stroke)│ │ full stack        │
            │  - Adjustment layers          │ │ compositor        │
            │  - Advanced blend modes       │ └───────────────────┘
            └───────────────┬───────────────┘
                            │ Unsupported features found?
            ┌───────────────┴───────────────┐
            │ Yes                           │ No
┌───────────▼───────────┐       ┌───────────▼───────────┐
│ Mode: 'file-composite' │       │ Mode: 'layers'        │
│ (Photoshop's bake     │       │ (Real-time dynamic    │
│  is source of truth)  │       │  2D canvas restack)   │
└───────────┬───────────┘       └───────────────────────┘
            │ User moves / edits a layer
┌───────────▼───────────────────────────────────────────┐
│ Mode: 'file-base-overlay'                             │
│ 1. Render unchanged base embedded composite           │
│ 2. Patch affected layer's import footprint via 2D     │
│    restack (omitting edited leaves to avoid ghosting) │
│ 3. Draw dirty edited layers at their CURRENT coords   │
└───────────────────────────────────────────────────────┘
```

### 1. `file-composite` Mode
- Used when Photoshop's embedded merged composite (`fileComposite`) is present and valid.
- The composite canvas is kept **immutable** in `doc.fileComposite`.
- Guarantees that opening even the most complex 100-layer PSD with smart filters and 3D effects looks 100% identical to Adobe Photoshop.

### 2. `file-base-overlay` Mode (Dirty Footprint Patching)
When a user edits, moves, or hides a layer:
1. **Dirty Tracking**: `previewContentEpoch` and `dirtyLeaves` track layers whose coordinates, opacity, visibility, or pixels differ from import state.
2. **Footprint Erasure & Patch**: The engine computes the bounding box of the edited layer at its **import pose**. It then paints a 2D restack of the layers beneath it inside that clipped region, cleanly filling in what was originally behind the layer without creating transparent holes or leaving ghost artifacts.
3. **Dirty Layer Painting**: The edited layer is rendered at its **current pose** on top of the patched canvas.
4. **Untouched Regions**: All parts of the canvas outside the edited layer's footprint continue rendering the native Photoshop composite.

### 3. Reconciling to Native
When a user performs `Undo` (`Ctrl+Z`) or resets transforms back to the import state, `reconcilePsdPreviewMode` automatically restores `file-composite` mode and re-attaches the original pristine `fileComposite`.

---

## 4. Real-Time Adjustment Layers (`src/psdAdjustment.ts`)

Creatvise Canvas features custom mathematical pipelines for nine Photoshop adjustment types. Adjustments affect all layers underneath them in the stack, but strictly respect clipping masks (isolating their effect to the base layer).

| Adjustment Type | Implementation File | Mathematical Algorithm & Features | Panel Edit Status |
|---|---|---|:---:|
| **Brightness / Contrast** | `psdAdjustment.ts` | CS3+ non-linear S-curve contrast and legacy linear additive contrast; master brightness shifting. | **Full UI Controls** |
| **Levels** | `psdAdjustment.ts` | Master RGB & per-channel (R, G, B) transfer curves; black/white input clipping, midtone gamma ($V = (\frac{I - InBlack}{InWhite - InBlack})^{1/\gamma}$), black/white output remap. | Preview Simulation |
| **Curves** | `psdAdjustmentCurves.ts` | Tridiagonal cubic spline interpolation per-channel (R, G, B) and master RGB; natural boundary second-derivative resolution. | Preview Simulation |
| **Vibrance** | `psdAdjustmentVibrance.ts` | Adaptive non-linear saturation boosting for muted colors; warm skin-tone hue protection window ($10^\circ - 50^\circ$); master linear saturation scaling. | Preview Simulation |
| **Photo Filter** | `psdAdjustmentPhotoFilter.ts` | Optical transmission tinting; CIE $L^*a^*b^*$ to sRGB color space conversion; Rec. 709 luminance preservation ($L = 0.2126R + 0.7152G + 0.0722B$). | Preview Simulation |
| **Color Lookup** | `psdAdjustmentColorLookup.ts` | 3D Look-Up Table parser for Adobe `.cube` and Autodesk `.3dl` files; 3D lattice trilinear interpolation across RGB channels. | Preview Simulation |
| **Hue / Saturation** | `psdAdjustmentHueSaturation.ts` | HSL cylindrical model; master adjustments; 6 targeted color range sectors (Reds, Yellows, Greens, Cyans, Blues, Magentas) with smooth boundary feathering ramps; Colorize mode. | Preview Simulation |
| **Color Balance** | `psdAdjustmentColorBalance.ts` | Independent Shadows, Midtones, and Highlights adjustments across Cyan-Red, Magenta-Green, and Yellow-Blue axes; optional luminosity preservation. | Preview Simulation |
| **Black & White** | `psdAdjustmentBlackAndWhite.ts` | 6-channel luminance weighting (Reds, Yellows, Greens, Cyans, Blues, Magentas); customizable monochrome tinting (Sepia, Cyanotype). | Preview Simulation |

### Clipping Mask Isolation
When an adjustment layer is clipped (`node.clipping = true`):
- The adjustment algorithm only reads and writes pixels within the non-zero alpha footprint of the nearest underlying sibling layer.
- Pixels outside that base layer's mask remain 100% untouched.

---

## 5. Blend Modes & Mathematics (`src/psdBlend.ts`)

In addition to standard HTML5 canvas composite operations (`source-over`, `multiply`, `screen`, `overlay`), Creatvise Canvas implements per-pixel mathematical routines for Photoshop's specialized blend modes:

- **Linear Burn**: $B(D, S) = \max(0, D + S - 1)$
- **Linear Dodge (Add)**: $B(D, S) = \min(1, D + S)$
- **Vivid Light**: Combines Color Burn ($S \le 0.5$) and Color Dodge ($S > 0.5$).
- **Linear Light**: Combines Linear Burn ($S \le 0.5$) and Linear Dodge ($S > 0.5$).
- **Pin Light**: Conditionally replaces pixels based on $S > 0.5$ or $S \le 0.5$.
- **Hard Mix**: Quantizes the result of Vivid Light to binary $0$ or $1$.
- **Subtract**: $B(D, S) = \max(0, D - S)$
- **Divide**: $B(D, S) = \min(1, \frac{D}{S})$
- **Darker Color / Lighter Color**: Evaluates Rec. 709 luminance between source and destination and retains the darker or lighter pixel.

---

## 6. Layer Masks & Effects

### Raster Layer Masks
- Decoded raster masks are stored in `maskAlphaCanvas`.
- Masks are evaluated as 8-bit alpha channels applied to layer pixels.
- Boundary conditions: `defaultColor` (white or black) determines whether pixels outside the mask bounding rectangle are shown or hidden.
- Masks maintain their import coordinates when layers move unless explicitly linked.

### Layer Effects (`src/psdLayerEffects.ts`)
- **Drop Shadow**: Evaluates distance, blur/size, color, opacity, blend mode, and global light angle.
- **Outer Glow**: Generates uniform edge dilation with customizable spread, size, color, and opacity.
- **Stroke**: Solid color border with customizable width, opacity, and positioning (**Inside**, **Center**, **Outside**).
- **Export Preservation**: On export, native Photoshop effect descriptor blocks (`lrFX` / `lfx2`) are preserved untouched in `ag-psd`.

---

## 7. Canvas Selection & Hit-Testing (`src/canvasHitTest.ts`)

Canvas hit-testing translates screen pointer coordinates into the top-most interactive layer:

1. **Depth Order**: Iterates documents front-to-back, and inside each document, evaluates leaves in reverse paint order (top-most layer first).
2. **Alpha Discrimination**: Queries the layer's backing offscreen canvas. Pixels with $\alpha \le 8$ (transparent or semi-transparent background noise) are ignored.
3. **Smart Object & Placeholder Suppression**:
   - Layers with `0%` opacity (e.g. template placeholder boxes) are suppressed from stealing canvas clicks.
   - Full-canvas background fills ($\ge 99\%$ width and height) are suppressed from click-selection so interior art can be clicked directly.
4. **Smallest-Area Tie-Breaking**: When multiple overlapping layers have valid opaque pixels under the cursor, the engine prioritizes the layer with the smallest bounding box area, allowing easy selection of small badges, text labels, and icons over large raster artwork.
5. **Interactive Handles**: Selected layers display an on-canvas bounding box with 8 scale handles and a top rotation anchor.

---

## 8. Non-Destructive Export (`src/psd.ts`)

When exporting a modified PSD (`writePsd`):

1. **Surgical Property Patching**:
   - Layer coordinates: `layer.left`, `layer.top`, `layer.right`, `layer.bottom`.
   - Layer visibility: `layer.hidden = !node.visible`.
   - Layer opacity: `layer.opacity = node.opacity`.
   - Layer name: `layer.name = node.name`.
   - Typography: In-place updates to `layer.text.text` while preserving `TySh` font style runs.
   - Vector shapes: Solid fills updated in the `vscg` descriptor block.
   - Raster replacement: Swaps `layer.canvas` with newly uploaded image data.
2. **Byte-Level Preservation**:
   - Smart Objects (`SoLd`, `SoLE`) and embedded data streams remain 100% intact.
   - Vector masks, path records, and clipping hierarchies remain intact.
   - Unmodeled layer effects (`lrFX`, `lfx2`) and proprietary XMP metadata are untouched.
3. **Composite Serialization**:
   - If no layers were edited, the pristine `fileComposite` is serialized as the embedded preview.
   - If layers were edited, the `file-base-overlay` render is serialized as the new composite so third-party viewers see the updated artwork.

---

## 9. Test Suites & Benchmarks

The repository includes a comprehensive automated test battery for PSD operations:

```bash
# Run all PSD regression tests (28 scripts chained)
npm run test:psd

# Measure luminance correlation against Photoshop embedded composites
npm run psd:baseline

# Profile adjustment layer computation & caching speed
npm run psd:bench

# Inspect supported and unsupported features across PSD test fixtures
npm run psd:inventory

# Test adjustment layer editing and roundtrip fidelity
npm run test:psd:adjustment

# Playwright browser tests for visual effects
npm run test:psd:drop-shadow-browser
npm run test:psd:outer-glow-browser
npm run test:psd:stroke-browser
npm run test:psd:adjustment-browser
```

### Verified Fixture Assets (`public/`)
- `11330937.psd`: Multi-layer composition with layer masks, adjustment layers, text, and vector shapes.
