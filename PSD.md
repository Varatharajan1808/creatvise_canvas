# Adobe Photoshop (.psd) — Engine Specification & Deep Dive

> Comprehensive architectural reference for Adobe Photoshop (`.psd`) parsing, dynamic 2D compositing, real-time adjustment layer simulation, canvas hit-testing, and non-destructive patch export in Creatvise Canvas.

---

## 1. Executive Summary

Creatvise Canvas implements a production-ready, browser-first engine for Adobe Photoshop (`.psd`) files. Rather than flattening documents into simple static images or regenerating the complex binary PSD format from scratch, the system operates on a **non-destructive "patch-original" pipeline**:

- **Native Fidelity**: Documents open on Photoshop's embedded merged composite (`fileComposite`) whenever possible, ensuring 100% pixel parity with Adobe Photoshop upon import.
- **Dynamic Footprint Patching**: When layers are moved, transformed, or restyled, the engine patches only the affected layer's import footprint via `file-base-overlay` mode, keeping untouched regions 100% faithful to Photoshop's native rasterizer.
- **Real-Time Adjustment Layers**: Nine Photoshop adjustment types are simulated on the GPU/CPU in real time, with exact mathematical models for curves, levels, vibrance, photo filter, 3D LUT color lookup, hue/saturation, color balance, black & white, and brightness/contrast.
- **Layer Effects & Blending**: In-browser simulation of Drop Shadow, Outer Glow, and Stroke, alongside 10+ custom per-pixel blend mode algorithms.
- **Non-Destructive Export**: Edits are surgically patched back into the in-memory `ag-psd` data structure. Smart objects, unmodeled vector masks, proprietary descriptors, and native layer effects remain 100% preserved.

---

## 2. Module Architecture (`src/psd/`)

All Photoshop-related logic is organized under `src/psd/`:

```
src/psd/
├── index.ts                     # Public API barrel export
├── psd.ts                       # High-level import, export, sample generator
├── psdComposite.ts              # Multi-layer canvas compositor & dirty-patch engine
├── psdCompositeRule.ts          # Decision engine for embedded composite vs 2D canvas
├── psdBlend.ts                  # Per-pixel Photoshop blend mode equations
├── psdLayerEffects.ts           # Drop Shadow, Outer Glow, and Stroke renderers
├── psdLayerInfo.ts              # Layer classification, bounds & editability guards
├── psdAdjustment.ts             # Master adjustment layer pipeline & shader dispatch
├── psdAdjustmentCurves.ts       # Curves spline & LUT generator
├── psdAdjustmentHueSaturation.ts# Hue/Saturation & Colorize algorithms
├── psdAdjustmentColorBalance.ts # Shadows/Midtones/Highlights balance with luminosity lock
├── psdAdjustmentBlackAndWhite.ts# 6-channel color weight simulation
├── psdAdjustmentColorLookup.ts  # 3D LUT parser (.cube) & sampler
├── psdAdjustmentPhotoFilter.ts  # Photo filter tinting with CIE L*a*b* conversion
└── psdAdjustmentVibrance.ts     # Smart saturation with skin-tone protection
```

---

## 3. Ingestion & Document Translation (`src/psd/psd.ts`)

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
Upon read, the raw `ag-psd` layer hierarchy is translated into Creatvise Canvas's unified `Doc` and `Node` scene graph (`src/core/model.ts`):

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
- `kind`: `'raster' | 'text' | 'shape' | 'group'`.
- `x`, `y`, `width`, `height`: Layer bounding box in canvas coordinates.
- `opacity`: Normalized layer opacity ($0.0 \dots 1.0$).
- `visible`: Boolean visibility toggle.
- `blendMode`: Photoshop blend mode string (`'normal' | 'multiply' | 'screen' | ...`).
- `psd`: Pointer to the underlying raw `ag-psd` layer object for lossless re-export.

---

## 4. Dual-Mode Preview Engine (`src/psd/psdComposite.ts`, `src/psd/psdCompositeRule.ts`)

Photoshop documents frequently feature complex visual properties (smart filters, vector masks, specialty layer effects) that cannot be 100% matched in a generic 2D canvas context. Creatvise Canvas solves this with a **dual-mode composite strategy**:

### 1. `embeddedComposite` Mode (Zero-Edit Baseline)
- When a document is first opened, the engine checks whether Photoshop stored a pre-rendered composite image.
- If present, the document renders directly from this embedded composite, guaranteeing **100% pixel parity** with Photoshop upon initial view.

### 2. `file-base-overlay` Mode (Surgical Footprint Patching)
- When a layer is edited (moved, transformed, or opacity adjusted), switching to a full manual composite from scratch would risk losing fidelity on un-modeled layers.
- Instead, the engine:
  1. Identifies the bounding box footprint of the moved layer in its original imported location.
  2. Clears that footprint on the base composite.
  3. Paints the layer at its new interactive position with its current opacity and blend mode.
  4. Keeps all surrounding untouched layers identical to the native Photoshop render.

---

## 5. Real-Time Adjustment Layer Simulation (`src/psd/psdAdjustment*.ts`)

The engine provides mathematical implementations for **9 Photoshop adjustment layers**:

| Adjustment Type | Implementation Details | Key Parameters |
|---|---|---|
| **Curves** | Natural cubic spline interpolation generating 256-entry RGB and composite lookup tables. | Input/Output control points for RGB, Red, Green, Blue |
| **Levels** | Non-linear gamma correction with input/output black and white clipping. | Input Black, Input White, Gamma, Output Black, Output White |
| **Hue / Saturation** | RGB $\to$ HSL conversion with optional Colorize mode and range-specific hue rotation. | Hue ($\pm 180^\circ$), Saturation ($\pm 100\%$), Lightness ($\pm 100\%$) |
| **Color Balance** | Independent tonal range shifts (Shadows, Midtones, Highlights) with luminosity preservation. | Cyan-Red, Magenta-Green, Yellow-Blue offsets |
| **Black & White** | Six-channel color weighting algorithm (Red, Yellow, Green, Cyan, Blue, Magenta) with optional tinting. | Channel coefficients, Tint color, Tint saturation |
| **Vibrance** | Adaptive saturation scaling targeting undersaturated pixels while protecting human skin tones. | Vibrance ($\pm 100\%$), Saturation ($\pm 100\%$) |
| **Photo Filter** | CIE L\*a\*b\* color shift simulating photographic optical filters. | Filter color / preset, Density ($1 \dots 100\%$), Preserve Luminosity |
| **Color Lookup** | 3D LUT cube parser and tetrahedral/trilinear interpolation sampler. | `.cube` file stream, 3D LUT dimension ($16^3, 33^3, 64^3$) |
| **Brightness / Contrast** | Standard linear slope-intercept curve or Photoshop legacy mode. | Brightness ($\pm 150$), Contrast ($\pm 100$) |

---

## 6. Per-Pixel Blend Mode Mathematics (`src/psd/psdBlend.ts`)

All standard Photoshop blend modes are executed in typed array pixel buffers:

$$\begin{aligned}
\text{Multiply}(B, S) &= \frac{B \cdot S}{255} \\
\text{Screen}(B, S) &= 255 - \frac{(255 - B)(255 - S)}{255} \\
\text{Overlay}(B, S) &= \begin{cases} \frac{2 \cdot B \cdot S}{255} & B < 128 \\ 255 - \frac{2 \cdot (255 - B)(255 - S)}{255} & B \ge 128 \end{cases} \\
\text{Soft Light}(B, S) &= \text{Pegtop / Photoshop non-linear soft light equation}
\end{aligned}$$

---

## 7. Interactive Canvas Hit-Testing (`src/canvas/canvasHitTest.ts`)

- **Alpha Discrimination**: Transparent areas ($\alpha \le 8$) are ignored during hit-testing, allowing users to select layers behind transparent holes.
- **Smallest-Area Tie Breaking**: When multiple layers overlap a click coordinate, the system selects the layer with the smallest bounding box area for precise targeting.
- **Clipping Mask Propagation**: Clicking a clipping mask child delegates selection to the clipping base layer or selects the specific sub-layer based on user preference.

---

## 8. Non-Destructive Export Pipeline (`src/psd/psd.ts`)

On export (`exportPsd`):
1. The original in-memory `Psd` object parsed by `ag-psd` is cloned.
2. Modified layer properties (coordinates, names, opacity, visibility, point text, shape vector colors) are patched directly into their corresponding `Layer` handles.
3. Unmodified layers, smart object bytecode, vector masks, and layer effects remain **100% untouched**.
4. `writePsd` serializes the document back into a binary `.psd` file ready for opening in Adobe Photoshop.

---

## 9. Test Suites & Verification

Run all PSD regression suites:

```bash
# Full PSD test pipeline (28 chained suites)
npm run test:psd

# Specific feature verifications
npm run test:psd:opacity
npm run psd:bench
npm run psd:baseline
```
